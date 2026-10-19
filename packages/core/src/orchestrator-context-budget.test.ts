/**
 * 上下文预算接线(§9.8,orchestrator × context-budget × compaction 集成)。
 *
 * 覆盖两条动态阈值路径(纯函数口径见 context-budget.test.ts / compaction.test.ts):
 * 1. 收尾双保险②:强制总结轮发送前先按动态阈值压缩 —— 此前 wrap-up 原样
 *    发送全量历史,历史顶爆窗口时最需要成功收口的调用反而先 400;
 * 2. 实测校准(精版):上一步真实 promptTokens − 消息估算 = 固定开销实测值,
 *    下一步 in-loop 压缩阈值据此收紧(估算口径漂移不再靠安全系数硬扛)。
 *
 * harness 复用 orchestrator-session.test.ts 的 cordis stub 模式;
 * 窗口/预留 env 在调用时读取(context-budget.ts 函数式默认值),测试内即设即生效。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Context } from '@deepseek-ai/cordis';
import { AgentService, OrchestratorService } from './index';
import type { ModelGateway, PlannerNotifier, ToolDefinition } from './index';

const ENV_KEYS = ['AGTPILOT_CONTEXT_WINDOW', 'AGTPILOT_COMPACT_OUTPUT_RESERVE', 'AGTPILOT_COMPACT_SAFETY_PCT'];
const savedEnv = ENV_KEYS.map((k) => [k, process.env[k]] as const);
beforeEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
});
afterEach(() => {
  for (const [k, v] of savedEnv) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

/** n 对 tool 调用消息,每条结果 ≈ resultChars 个 CJK 字符(≈同数 tokens) */
function toolPairs(n: number, resultChars: number, idPrefix = 'c') {
  const msgs: Array<{ role: 'user' | 'assistant' | 'tool'; content: any }> = [];
  for (let i = 0; i < n; i++) {
    msgs.push({
      role: 'assistant',
      content: [{ type: 'tool-call', toolCallId: `${idPrefix}${i}`, toolName: 'probe_tool', input: { q: i } }],
    });
    msgs.push({
      role: 'tool',
      content: [{ type: 'tool-result', toolCallId: `${idPrefix}${i}`, output: '长'.repeat(resultChars) }],
    });
  }
  return msgs;
}

const isDigest = (m: any) => typeof m?.content === 'string' && m.content.startsWith('【历史会话纪要】');

describe('强制总结轮先压缩再发送(§9.8 双保险②)', () => {
  it('历史超动态阈值时 wrap-up invokeStep 收到压缩后的消息,且不二次蒸馏', async () => {
    // 窗口 12k、输出预留 2k → 收尾相位阈值 ≈ 9600 − system − 2000(远小于静态 30k)
    process.env.AGTPILOT_CONTEXT_WINDOW = '12000';
    process.env.AGTPILOT_COMPACT_OUTPUT_RESERVE = '2000';

    const ctx = new Context();
    new AgentService(ctx);
    const orch = new OrchestratorService(ctx);
    ctx.agent.registerTool({
      name: 'probe_tool',
      description: 'probe',
      parameters: { type: 'object', properties: {} },
      execute: async () => 'ok',
    } as ToolDefinition);

    let distillerCalls = 0;
    let wrapMessages: any[] | null = null;
    const stubModel: ModelGateway = {
      setPreferredModel: () => {},
      setBudget: () => {},
      // 主循环直接步数耗尽,带回超阈值的工具历史(20 对 ×≈420 tokens ≈ 8.4k)
      runAgentLoop: async () => ({
        text: '',
        finishReason: 'stop',
        stepsCount: 5,
        stepsExhausted: true,
        responseMessages: toolPairs(20, 400),
      }),
      invokeStep: async (req: any) => {
        if (String(req.system || '').includes('会话压缩器')) {
          distillerCalls++;
          return { text: '【已确立事实】蒸馏纪要', toolCalls: [], finishReason: 'stop', usage: { promptTokens: 10, completionTokens: 5 } };
        }
        wrapMessages = req.messages;
        return { text: '最终总结', toolCalls: [], finishReason: 'stop', usage: { promptTokens: 100, completionTokens: 20 } };
      },
    };
    ctx.reflect.provide('model', stubModel);
    ctx.reflect.provide('planner', { boardLagNotice: () => null } as PlannerNotifier);

    const r = await orch.runTask({ taskId: 'task_wrap_1', prompt: '测试任务', maxSteps: 5 });
    expect(r.success).toBe(true);
    expect(r.finalAnswer).toBe('最终总结');
    // wrap-up 收到的是压缩后的历史(纪要在场,巨型原始流水已蒸馏)
    expect(wrapMessages).not.toBeNull();
    expect(wrapMessages!.some(isDigest)).toBe(true);
    expect(wrapMessages!.length).toBeLessThan(41);
    // 蒸馏只发生一次:wrap-up 压缩后 task-end 相位低于阈值,不重复付费
    expect(distillerCalls).toBe(1);
    // 落盘续聊历史同为压缩版(下一轮重放不再全额重付)
    expect((r.messages as any[]).some(isDigest)).toBe(true);
  });

  it('历史低于阈值时 wrap-up 行为与旧版一致(不压缩、原样发送)', async () => {
    process.env.AGTPILOT_CONTEXT_WINDOW = '64000';
    const ctx = new Context();
    new AgentService(ctx);
    const orch = new OrchestratorService(ctx);
    ctx.agent.registerTool({
      name: 'probe_tool',
      description: 'probe',
      parameters: { type: 'object', properties: {} },
      execute: async () => 'ok',
    } as ToolDefinition);

    let distillerCalls = 0;
    let wrapMessages: any[] | null = null;
    const small = toolPairs(2, 50);
    const stubModel: ModelGateway = {
      setPreferredModel: () => {},
      setBudget: () => {},
      runAgentLoop: async () => ({
        text: '',
        finishReason: 'stop',
        stepsCount: 2,
        stepsExhausted: true,
        responseMessages: small,
      }),
      invokeStep: async (req: any) => {
        if (String(req.system || '').includes('会话压缩器')) {
          distillerCalls++;
          return { text: '纪要', toolCalls: [], finishReason: 'stop', usage: { promptTokens: 1, completionTokens: 1 } };
        }
        wrapMessages = req.messages;
        return { text: '总结', toolCalls: [], finishReason: 'stop', usage: { promptTokens: 1, completionTokens: 1 } };
      },
    };
    ctx.reflect.provide('model', stubModel);
    ctx.reflect.provide('planner', { boardLagNotice: () => null } as PlannerNotifier);

    const r = await orch.runTask({ taskId: 'task_wrap_2', prompt: '测试任务', maxSteps: 5 });
    expect(r.success).toBe(true);
    expect(distillerCalls).toBe(0);
    // 原样发送:base 消息(prompt + 内核注入的上下文前言共 2 条) + 4 条工具历史,无纪要
    expect(wrapMessages!.length).toBe(6);
    expect(wrapMessages!.some(isDigest)).toBe(false);
  });
});

describe('in-loop 实测校准(§9.8 精版阈值)', () => {
  it('上一步真实 promptTokens 校准固定开销后,下一步阈值收紧并触发 in-loop 压缩', async () => {
    const ctx = new Context();
    new AgentService(ctx);
    const orch = new OrchestratorService(ctx);
    ctx.agent.registerTool({
      name: 'probe_tool',
      description: 'probe',
      parameters: { type: 'object', properties: {} },
      execute: async () => 'ok',
    } as ToolDefinition);

    const stepAdjusts: Array<any> = [];
    let distillerCalls = 0;
    // 第 2 步发送的历史:6 对 ×≈720 tokens ≈ 4.4k —— 低于静态 30k,
    // 但校准后(promptTokens 45000 ≫ 窗口×0.8 − 预留)动态阈值钳到下限 4000 → 必压
    const grownHistory = toolPairs(6, 700);
    const stubModel: ModelGateway = {
      setPreferredModel: () => {},
      setBudget: () => {},
      runAgentLoop: async (o: any) => {
        // 第 1 步:无校准,阈值 = min(30k, 动态预算) —— 小历史不触发
        const r1 = await o.prepareStep({ stepNumber: 1, messages: o.messages });
        stepAdjusts.push(r1);
        // 真实账单回填:固定开销实测 ≈ 45000(远大于估算的 system+tools)
        o.onStepFinish({
          stepNumber: 1,
          text: '',
          finishReason: 'stop',
          usage: { promptTokens: 45_000, completionTokens: 10 },
        });
        // 第 2 步:校准生效 → 阈值钳至下限,4.4k 历史触发压缩
        const r2 = await o.prepareStep({ stepNumber: 2, messages: [...o.messages, ...grownHistory] });
        stepAdjusts.push(r2);
        return { text: '完成', finishReason: 'stop', stepsCount: 2, stepsExhausted: false, responseMessages: [] };
      },
      invokeStep: async () => {
        distillerCalls++;
        return { text: '【已确立事实】校准后蒸馏', toolCalls: [], finishReason: 'stop', usage: { promptTokens: 5, completionTokens: 5 } };
      },
    };
    ctx.reflect.provide('model', stubModel);
    ctx.reflect.provide('planner', { boardLagNotice: () => null } as PlannerNotifier);

    const r = await orch.runTask({ taskId: 'task_cal_1', prompt: '测试任务', maxSteps: 5 });
    expect(r.success).toBe(true);
    // 第 1 步:未校准、历史极小 → 无压缩重写
    expect(stepAdjusts[0]?.messages?.some?.(isDigest) ?? false).toBe(false);
    // 第 2 步:校准后阈值收紧 → adjust.messages 为压缩重写版(纪要在场)
    expect(stepAdjusts[1]).toBeTruthy();
    expect(stepAdjusts[1].messages.some(isDigest)).toBe(true);
    expect(distillerCalls).toBeGreaterThanOrEqual(1);
  });
});
