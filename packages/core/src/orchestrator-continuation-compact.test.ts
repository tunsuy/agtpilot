import { describe, it, expect, afterEach } from 'vitest';
import { Context } from '@deepseek-ai/cordis';
import { AgentService, OrchestratorService } from './index';
import type { ModelGateway, PlannerNotifier, ToolDefinition } from './index';

/**
 * 续聊轮入口强制蒸馏(闸0,§9.8):historyMessages 非空且估算超
 * continuationCompactThreshold 时,开轮前把「上一轮及更早」的工具流水/长文本
 * 折叠成一条【历史会话纪要】,本轮每一步不再全额重付(生产实测:公众号续聊轮
 * 首步 promptTokens 30.5k,其中 ~2/3 是上一轮工具消息重放)。
 * 覆盖:触发/首轮不触发/短历史自限跳过/保险丝关闭/蒸馏失败保底。
 * harness 复用 orchestrator-session.test.ts 的 cordis stub 模式。
 */

const BIG = 'x'.repeat(40_000); // 估算 ≈10k tokens(ASCII 4 字符 ≈ 1 token)

const mkTc = (id: string, name: string) => ({
  role: 'assistant' as const,
  content: [{ type: 'tool-call', toolCallId: id, toolName: name, input: { q: '测试' } }],
});
const mkTool = (id: string, output: string) => ({
  role: 'tool' as const,
  content: [{ type: 'tool-result', toolCallId: id, output }],
});

/** 上一轮落盘历史(9 条):两条巨型工具结果在中间区,尾部是近期窗口 */
function longHistory() {
  return [
    { role: 'user' as const, content: '初始任务' },
    mkTc('c1', 'search_web'),
    mkTool('c1', BIG),
    mkTc('c2', 'read_page'),
    mkTool('c2', BIG),
    { role: 'assistant' as const, content: '中间结论' },
    mkTc('c3', 'search_web'),
    mkTool('c3', 'ok'),
    { role: 'assistant' as const, content: '上一轮最终答复' },
  ];
}

function buildHarness(opts?: { summarizeError?: boolean }) {
  const ctx = new Context();
  new AgentService(ctx);
  const orch = new OrchestratorService(ctx);
  let captured: Array<{ role: string; content: any }> = [];
  let invokeCalls = 0;

  ctx.agent.registerTool({
    name: 'probe_tool',
    description: 'probe',
    parameters: { type: 'object', properties: {} },
    execute: async () => 'ok',
  } as ToolDefinition);

  const stubModel: ModelGateway = {
    setPreferredModel: () => {},
    setBudget: () => {},
    runAgentLoop: async (o: any) => {
      captured = [...(o.messages as Array<{ role: string; content: any }>)];
      return {
        text: '完成',
        finishReason: 'stop',
        stepsCount: 1,
        stepsExhausted: false,
        responseMessages: [],
      };
    },
    invokeStep: async () => {
      invokeCalls++;
      if (opts?.summarizeError) throw new Error('蒸馏调用失败');
      return {
        text: '【已确立事实】蒸馏纪要',
        toolCalls: [],
        finishReason: 'stop',
        usage: { promptTokens: 100, completionTokens: 50 },
      };
    },
  };
  ctx.reflect.provide('model', stubModel);
  ctx.reflect.provide('planner', { boardLagNotice: () => null } as PlannerNotifier);

  return {
    get captured() {
      return captured;
    },
    get invokeCalls() {
      return invokeCalls;
    },
    run: (o: Record<string, any> = {}) =>
      orch.runTask({ taskId: 'task_cont_1', prompt: '续聊提问', maxSteps: 5, ...o }),
  };
}

/** 消息 content 序列化(检巨型正文是否还在) */
const ser = (m: { content: any }) =>
  typeof m.content === 'string' ? m.content : JSON.stringify(m.content);

afterEach(() => {
  delete process.env.AGTPILOT_CONTINUATION_COMPACT;
  delete process.env.AGTPILOT_CONTINUATION_COMPACT_THRESHOLD;
});

describe('续聊轮入口强制蒸馏(闸0)', () => {
  it('续聊 + 长历史 → 开轮前蒸馏:巨型工具消息折叠为纪要,近期窗口与新消息原样保留', async () => {
    const h = buildHarness();
    const r = await h.run({ historyMessages: longHistory() });
    expect(r.success).toBe(true);
    expect(h.invokeCalls).toBe(1);
    // 10 条(9 历史 + 新 prompt)→ 7 条:首条 user + 纪要 + 中间区短文本 + 近期窗口 4 条
    expect(h.captured).toHaveLength(7);
    expect(h.captured[0].content).toBe('初始任务');
    const digest = String(h.captured[1].content);
    expect(digest).toContain('【历史会话纪要】');
    expect(digest).toContain('蒸馏纪要');
    // 台账不经蒸馏,系统精确统计(工具名/次数/参数摘要)
    expect(digest).toContain('【工具调用台账】');
    expect(digest).toContain('search_web');
    // 巨型正文整体消失(蒸馏路径不保留原文流水)
    expect(h.captured.some((m) => ser(m).includes('x'.repeat(1000)))).toBe(false);
    // 新消息永远是最后一条,原样保留
    expect(h.captured[h.captured.length - 1]).toEqual({ role: 'user', content: '续聊提问' });
    // 蒸馏产物随 result.messages 落盘(下一轮续聊从纪要起步,不再膨胀)
    expect(r.messages?.some((m: any) => ser(m).includes('【历史会话纪要】'))).toBe(true);
  });

  it('首轮(无历史)不蒸馏:入口只有一条新消息,零额外模型调用', async () => {
    const h = buildHarness();
    const r = await h.run();
    expect(r.success).toBe(true);
    expect(h.invokeCalls).toBe(0);
    expect(h.captured).toHaveLength(1);
    expect(h.captured[0].content).toBe('续聊提问');
  });

  it('短历史续聊自限跳过:低于阈值连蒸馏调用都不发生(不白烧一次模型)', async () => {
    const h = buildHarness();
    const shortHistory = [
      { role: 'user' as const, content: '初始任务' },
      { role: 'assistant' as const, content: '好的,已完成' },
    ];
    const r = await h.run({ historyMessages: shortHistory });
    expect(r.success).toBe(true);
    expect(h.invokeCalls).toBe(0);
    expect(h.captured).toHaveLength(3);
    expect(h.captured.some((m) => ser(m).includes('【历史会话纪要】'))).toBe(false);
  });

  it('保险丝 AGTPILOT_CONTINUATION_COMPACT=0:长历史也原样重放(单点回退不牵连其他相位)', async () => {
    process.env.AGTPILOT_CONTINUATION_COMPACT = '0';
    const h = buildHarness();
    const r = await h.run({ historyMessages: longHistory() });
    expect(r.success).toBe(true);
    expect(h.invokeCalls).toBe(0);
    expect(h.captured).toHaveLength(10);
    expect(h.captured.some((m) => ser(m).includes('x'.repeat(1000)))).toBe(true);
  });

  it('蒸馏调用失败 → 原文截断保底,续聊轮照常执行(不阻塞不报错)', async () => {
    const h = buildHarness({ summarizeError: true });
    const r = await h.run({ historyMessages: longHistory() });
    expect(r.success).toBe(true);
    expect(h.captured).toHaveLength(7);
    const digest = String(h.captured[1].content);
    expect(digest).toContain('【历史会话纪要】');
    expect(digest).toContain('原文截断保底');
  });

  it('阈值 env 可调:调高后同规模历史不再触发(守卫按估算总量判定)', async () => {
    process.env.AGTPILOT_CONTINUATION_COMPACT_THRESHOLD = '100000';
    const h = buildHarness();
    const r = await h.run({ historyMessages: longHistory() });
    expect(r.success).toBe(true);
    expect(h.invokeCalls).toBe(0);
    expect(h.captured).toHaveLength(10);
  });
});
