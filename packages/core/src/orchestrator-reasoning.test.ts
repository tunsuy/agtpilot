import { describe, it, expect, afterEach } from 'vitest';
import { Context } from '@deepseek-ai/cordis';
import { AgentService, OrchestratorService } from './index';
import type { ModelGateway, PlannerNotifier } from './index';

/**
 * reasoning 剥离三道闸的 orchestrator 级行为测试(纯函数单测见 reasoning.test.ts):
 * 闸1 入口(historyMessages 存量剥离)/ 闸2 循环内(prepareStep 步前剥离,压缩之前)
 * / 闸3 装配(responseMessages 并入 conversation 前剥离 → 落盘与跨轮重发干净)。
 * harness 复用 orchestrator-stats.test.ts 的 cordis stub 模式;stub 模型模拟 SDK
 * 语义:每步先调 prepareStep 采纳其 messages 改写,再产出带 reasoning 的 assistant 消息。
 */

afterEach(() => {
  delete process.env.AGTPILOT_STRIP_REASONING;
});

const reasoningPart = (tag: string) => ({ type: 'reasoning', text: `${tag}思考`.repeat(200) });
const textPart = (t: string) => ({ type: 'text', text: t });

function hasReasoning(messages: any[] | undefined): boolean {
  return (messages || []).some(
    (m) => Array.isArray(m?.content) && m.content.some((p: any) => p?.type === 'reasoning')
  );
}

function buildHarness(opts: { steps?: number; history?: any[] } = {}) {
  const steps = opts.steps ?? 2;
  const ctx = new Context();
  new AgentService(ctx);
  const orch = new OrchestratorService(ctx);

  // seen.input = runAgentLoop 收到的初始消息(验证闸1);
  // seen.perStep[i] = 第 i 步 prepareStep 之后、模型实际收到的消息(验证闸2)
  const seen: { input: any[]; perStep: any[][] } = { input: [], perStep: [] };

  const stubModel: ModelGateway = {
    setPreferredModel: () => {},
    setBudget: () => {},
    runAgentLoop: async (o: any) => {
      seen.input = o.messages as any[];
      let state: any[] = [...(o.messages as any[])];
      const responses: any[] = [];
      for (let step = 0; step < steps; step++) {
        const adjust = await o.prepareStep?.({ stepNumber: step, messages: state });
        if (adjust?.messages) state = adjust.messages;
        seen.perStep.push(state);
        const msg = {
          role: 'assistant' as const,
          content: [reasoningPart(`步${step}`), textPart(`步${step}答复`)],
        };
        responses.push(msg);
        state = [...state, msg];
      }
      return {
        text: '最终答复',
        finishReason: 'stop',
        stepsCount: steps,
        stepsExhausted: false,
        responseMessages: responses,
      };
    },
    invokeStep: async () => ({
      text: '总结',
      toolCalls: [],
      finishReason: 'stop',
      usage: { promptTokens: 0, completionTokens: 0 },
    }),
  };
  ctx.reflect.provide('model', stubModel);
  ctx.reflect.provide('planner', { boardLagNotice: () => null } as PlannerNotifier);

  return {
    run: () => orch.runTask({ prompt: '测试任务', maxSteps: 20, historyMessages: opts.history }),
    seen,
  };
}

describe('reasoning 剥离 · 三道闸', () => {
  it('闸2(循环内):上一步 assistant 的 reasoning 不进下一步请求,text 部件保留', async () => {
    const h = buildHarness({ steps: 3 });
    const result = await h.run();
    expect(result.success).toBe(true);
    // 第 2 步模型收到的消息里,第 1 步产出的 assistant 消息已无 reasoning
    const step2 = h.seen.perStep[1];
    const assistantMsgs = step2.filter((m) => m.role === 'assistant');
    expect(assistantMsgs).toHaveLength(1);
    expect(hasReasoning([assistantMsgs[0]])).toBe(false);
    expect(assistantMsgs[0].content).toEqual([textPart('步0答复')]);
    // 第 3 步:前两步的 assistant 都已剥净(幂等,历史前缀字节稳定)
    expect(hasReasoning(h.seen.perStep[2].filter((m) => m.role === 'assistant'))).toBe(false);
  });

  it('闸3(装配):result.messages(落盘 + 跨轮重发源)不含任何 reasoning,最后一步也剥净', async () => {
    const h = buildHarness({ steps: 2 });
    const result = await h.run();
    expect(hasReasoning(result.messages)).toBe(false);
    // 最后一步的 assistant 产出没有后续 prepareStep 覆盖 → 必须由闸3 剥掉
    const lastAssistant = [...(result.messages || [])].reverse().find((m) => m.role === 'assistant');
    expect(lastAssistant?.content).toEqual([textPart('步1答复')]);
    // 计数可观测:闸2 剥步1 可见的 1 个 + 闸3 剥 responseMessages 里全部 2 个
    expect(result.efficiency?.reasoningPartsStripped).toBe(3);
  });

  it('闸1(入口):存量历史(剥离上线前落盘)进循环前剥净,且计数并入', async () => {
    const legacyHistory = [
      { role: 'user' as const, content: '上一轮问题' },
      {
        role: 'assistant' as const,
        content: [reasoningPart('历史'), textPart('上一轮回答')],
      },
    ];
    const h = buildHarness({ steps: 1, history: legacyHistory });
    const result = await h.run();
    // runAgentLoop 收到的初始消息已无 reasoning(闸1 在 baseMessages 装配前生效)
    expect(hasReasoning(h.seen.input)).toBe(false);
    expect(h.seen.input[1].content).toEqual([textPart('上一轮回答')]);
    // 原 historyMessages 未被就地修改(纯函数拷贝语义,落盘数据不动)
    expect(hasReasoning(legacyHistory)).toBe(true);
    // 落盘历史同样干净 + 计数含闸1 的 1 个部件
    expect(hasReasoning(result.messages)).toBe(false);
    expect(result.efficiency?.reasoningPartsStripped).toBe(2); // 闸1×1 + 闸2/3×1
  });

  it('闸2 前缀稳定:剥离改写只动最新一条 assistant,已剥历史跨步同引用(缓存只破尾部)', async () => {
    const h = buildHarness({ steps: 3 });
    await h.run();
    // 第 2 步与第 3 步的消息数组里,第 2 步的全部内容在第 3 步保持同引用 ——
    // 幂等剥离不重写已剥消息,provider 前缀缓存不因剥离反复失效
    const [s2, s3] = [h.seen.perStep[1], h.seen.perStep[2]];
    for (let i = 0; i < s2.length; i++) {
      expect(s3[i]).toBe(s2[i]);
    }
    expect(s3.length).toBeGreaterThan(s2.length); // 尾部才是新增(append-only)
  });

  it('保险丝:AGTPILOT_STRIP_REASONING=0 → 三道闸全关,reasoning 原样回传与落盘', async () => {
    process.env.AGTPILOT_STRIP_REASONING = '0';
    const legacyHistory = [
      { role: 'assistant' as const, content: [reasoningPart('历史'), textPart('上一轮回答')] },
    ];
    const h = buildHarness({ steps: 2, history: legacyHistory });
    const result = await h.run();
    expect(hasReasoning(h.seen.input)).toBe(true); // 闸1 关
    expect(hasReasoning(h.seen.perStep[1])).toBe(true); // 闸2 关
    expect(hasReasoning(result.messages)).toBe(true); // 闸3 关
    expect(result.efficiency?.reasoningPartsStripped).toBe(0);
  });

  it('工具调用消息不受影响:assistant 带 tool-call + reasoning 时只剥 reasoning(配对完好)', async () => {
    const history = [
      { role: 'user' as const, content: '查一下' },
      {
        role: 'assistant' as const,
        content: [
          reasoningPart('历史'),
          { type: 'tool-call' as const, toolCallId: 'c1', toolName: 'search_web', input: {} },
        ],
      },
      { role: 'tool' as const, content: [{ type: 'tool-result', toolCallId: 'c1', output: 'ok' }] },
    ];
    const h = buildHarness({ steps: 1, history });
    const result = await h.run();
    const assistantMsg = (result.messages || []).find((m) => m.role === 'assistant');
    expect(assistantMsg?.content).toEqual([
      { type: 'tool-call', toolCallId: 'c1', toolName: 'search_web', input: {} },
    ]);
    const toolMsg = (result.messages || []).find((m) => m.role === 'tool');
    expect(toolMsg).toBeDefined(); // tool 结果仍在,配对未破
  });
});
