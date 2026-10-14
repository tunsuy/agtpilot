import { describe, it, expect } from 'vitest';
import { Context } from '@deepseek-ai/cordis';
import { AgentService, OrchestratorService, isEmptyToolOutput } from './index';
import type { ModelGateway, PlannerNotifier, ToolDefinition } from './index';

/**
 * 只读工具结果复用 + 空返回统计（生产实测驱动的两项修复）：
 * 1. 上下文压缩后模型失忆性重发同参数只读查询 → TTL 缓存复用,不重新执行;
 * 2. 「返回空」曾被当成功 → emptyCalls 单独计数,有效率收紧为 (总-失败-跳过-空)/总。
 * harness 复用 smoke.ts 的 cordis stub 模式（无真实模型,脚本化工具序列）。
 */

function buildHarness(callSeq: string[]) {
  const ctx = new Context();
  new AgentService(ctx);
  const orch = new OrchestratorService(ctx);

  const executed: Record<string, number> = {};
  const outputs: Record<string, any> = {
    read_x: { ok: true, data: '结果' },
    read_empty: {},
    write_x: { ok: true },
  };

  const register = (name: string, readOnly?: boolean) =>
    ctx.agent.registerTool({
      name,
      description: name,
      parameters: { type: 'object', properties: {} },
      readOnly,
      execute: async () => {
        executed[name] = (executed[name] || 0) + 1;
        return outputs[name];
      },
    } as ToolDefinition);
  register('read_x', true);
  register('read_empty', true);
  register('write_x', false);

  const dedupeEvents: any[] = [];
  ctx.on('agtpilot/event', (e: any) => {
    if (e.type === 'tool_result' && e.payload?.deduplicated) dedupeEvents.push(e.payload);
  });

  const stubModel: ModelGateway = {
    setPreferredModel: () => {},
    setBudget: () => {},
    runAgentLoop: async (opts: any) => {
      const tools = opts.tools as Array<{ name: string; execute: (args: any) => Promise<any> }>;
      const find = (n: string) => tools.find((t) => t.name === n)!;
      const responseMessages: any[] = [];
      let i = 0;
      while (i < callSeq.length) {
        const name = callSeq[i];
        const out = await find(name).execute({});
        responseMessages.push({
          role: 'assistant',
          content: [{ type: 'tool-call', toolCallId: `c${i}`, toolName: name, input: {} }],
        });
        responseMessages.push({
          role: 'tool',
          content: [{ type: 'tool-result', toolCallId: `c${i}`, output: out }],
        });
        i++;
      }
      return { text: '最终答复', finishReason: 'stop', stepsCount: callSeq.length, stepsExhausted: false, responseMessages };
    },
    invokeStep: async () => ({
      text: '【已确立事实】\n- 测试蒸馏事实',
      toolCalls: [],
      finishReason: 'stop',
      usage: { promptTokens: 0, completionTokens: 0 },
    }),
  };
  ctx.reflect.provide('model', stubModel);

  const stubPlanner: PlannerNotifier = { noteToolResult: () => {} };
  ctx.reflect.provide('planner', stubPlanner);

  return {
    run: () => orch.runTask({ prompt: '测试任务', maxSteps: 20 }),
    executed,
    dedupeEvents,
  };
}

describe('isEmptyToolOutput（空返回判定纯函数）', () => {
  it('null/undefined/空白串/空数组/空对象 = 空;报错/跳过/有数据对象 = 非空', () => {
    expect(isEmptyToolOutput(null)).toBe(true);
    expect(isEmptyToolOutput(undefined)).toBe(true);
    expect(isEmptyToolOutput('')).toBe(true);
    expect(isEmptyToolOutput('   ')).toBe(true);
    expect(isEmptyToolOutput([])).toBe(true);
    expect(isEmptyToolOutput({})).toBe(true);
    expect(isEmptyToolOutput({ error: 'x' })).toBe(false);
    expect(isEmptyToolOutput({ skipped: true })).toBe(false);
    expect(isEmptyToolOutput({ ok: true })).toBe(false);
    expect(isEmptyToolOutput('有内容')).toBe(false);
  });
});

describe('只读工具结果复用（TTL 缓存）', () => {
  it('同参数只读调用第二次复用:不重新执行,计 dedupedCalls 不计 toolCalls', async () => {
    const h = buildHarness(['read_x', 'read_x', 'read_x']);
    const result = await h.run();
    expect(h.executed.read_x).toBe(1);
    expect(result.efficiency?.toolCalls).toBe(1);
    expect(result.efficiency?.dedupedCalls).toBe(2);
    expect(result.efficiency?.effectiveRate).toBe(1);
    // 复用事件流照常广播,结果带 deduplicated 标记(UI 可如实展示)
    expect(h.dedupeEvents.length).toBe(2);
  });

  it('空返回不缓存:重试是合法意图,两次都真实执行', async () => {
    const h = buildHarness(['read_empty', 'read_empty']);
    const result = await h.run();
    expect(h.executed.read_empty).toBe(2);
    expect(result.efficiency?.dedupedCalls).toBe(0);
    expect(result.efficiency?.emptyCalls).toBe(2);
    // (2 - 0 - 0 - 2) / 2 = 0:空返回全面压低有效率,不再虚报 100%
    expect(result.efficiency?.effectiveRate).toBe(0);
  });

  it('非只读工具绝不复用:两次 email_send 可能都是合法的', async () => {
    const h = buildHarness(['write_x', 'write_x']);
    const result = await h.run();
    expect(h.executed.write_x).toBe(2);
    expect(result.efficiency?.dedupedCalls).toBe(0);
    expect(result.efficiency?.toolCalls).toBe(2);
  });

  it('混合序列:复用与真实执行的计数互不污染', async () => {
    const h = buildHarness(['read_x', 'write_x', 'read_x', 'read_empty', 'read_x']);
    const result = await h.run();
    expect(h.executed.read_x).toBe(1); // 3 次调用 1 次执行
    expect(h.executed.write_x).toBe(1);
    expect(h.executed.read_empty).toBe(1);
    expect(result.efficiency?.toolCalls).toBe(3);
    expect(result.efficiency?.dedupedCalls).toBe(2);
    expect(result.efficiency?.emptyCalls).toBe(1);
    // effectiveRate 保留两位小数:(3-0-0-1)/3 = 0.67
    expect(result.efficiency?.effectiveRate).toBe(0.67);
  });
});
