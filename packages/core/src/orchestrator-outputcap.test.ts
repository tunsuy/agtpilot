import { describe, it, expect } from 'vitest';
import { Context } from '@deepseek-ai/cordis';
import { AgentService, OrchestratorService } from './index';
import type { ModelGateway, PlannerNotifier, ToolDefinition } from './index';

/**
 * ToolDefinition.outputCap 的内核截断点行为(层1 源头裁剪 ②,
 * docs/design/token-consumption-and-tool-loading.md §9.3):
 * 生效限额 = min(outputCap, TOOL_OUTPUT_LIMIT)(text.effectiveOutputLimit);
 * 超限走既有治理管道 —— 先试 spill 全量落盘(cap 不牺牲无损性),回退头尾截断;
 * tool_result 广播始终带全量原文(UI 不受影响);未声明 outputCap 行为不变。
 * harness 复用 orchestrator-spill.test.ts 的 cordis stub 模式。
 */

function buildHarness(opts: {
  outputCap?: number;
  output: () => any;
  spill?: (info: any) => string | null | Promise<string | null>;
} = { output: () => 'ok' }) {
  const ctx = new Context();
  new AgentService(ctx);
  const orch = new OrchestratorService(ctx);

  ctx.agent.registerTool({
    name: 'capped_read',
    description: 'capped_read',
    parameters: { type: 'object', properties: {} },
    ...(opts.outputCap !== undefined ? { outputCap: opts.outputCap } : {}),
    execute: async () => opts.output(),
  } as ToolDefinition);

  const seenByModel: any[] = [];
  const broadcastResults: any[] = [];
  ctx.on('agtpilot/event', (e: any) => {
    if (e.type === 'tool_result') broadcastResults.push(e.payload);
  });
  const spillCalls: any[] = [];
  const spill = opts.spill
    ? async (info: any) => {
        spillCalls.push(info);
        return opts.spill!(info);
      }
    : undefined;

  const stubModel: ModelGateway = {
    setPreferredModel: () => {},
    setBudget: () => {},
    runAgentLoop: async (o: any) => {
      const tools = o.tools as Array<{ name: string; execute: (args: any) => Promise<any> }>;
      const out = await tools.find((t) => t.name === 'capped_read')!.execute({});
      seenByModel.push(out);
      return {
        text: '最终答复',
        finishReason: 'stop',
        stepsCount: 1,
        stepsExhausted: false,
        responseMessages: [],
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
    run: () =>
      orch.runTask({
        taskId: 'task_cap_1',
        prompt: '测试任务',
        maxSteps: 5,
        ...(spill ? { spillToolOutput: spill } : {}),
      }),
    seenByModel,
    broadcastResults,
    spillCalls,
  };
}

const midOutput = (n = 5000) => `HEAD_${'x'.repeat(n - 10)}_TAIL`; // < 16KB,> cap

describe('ToolDefinition.outputCap · 内核截断点', () => {
  it('cap 2000 + 无落盘回调 → 模型收 ~2000 头尾截断版,广播仍全量', async () => {
    const h = buildHarness({ outputCap: 2000, output: () => midOutput(5000) });
    const r = await h.run();
    expect(r.success).toBe(true);
    const seen = String(h.seenByModel[0]);
    expect(seen.length).toBeLessThan(2400); // 2000 + 截断标记
    expect(seen).toContain('输出过长已截断');
    expect(seen).toContain('5000');
    expect(seen.startsWith('HEAD_')).toBe(true);
    expect(seen.endsWith('_TAIL')).toBe(true);
    // 广播(UI 视角)不受 cap 影响:全量原文
    expect(h.broadcastResults).toHaveLength(1);
    expect(h.broadcastResults[0].output).toHaveLength(5000);
  });

  it('cap + 落盘回调 → spill 优先(全量落盘无损),模型收「预览+指针」', async () => {
    const h = buildHarness({
      outputCap: 2000,
      output: () => midOutput(5000),
      spill: (info) => info.callId,
    });
    await h.run();
    expect(h.spillCalls).toHaveLength(1);
    expect(h.spillCalls[0].fullText).toHaveLength(5000); // 落盘是全量,不因 cap 缩水
    const pointer = String(h.seenByModel[0]);
    expect(pointer).toContain(`ref=${h.spillCalls[0].callId}`);
    expect(pointer).toContain('read_tool_output');
    expect(h.broadcastResults[0].spilled).toMatchObject({ originalChars: 5000 });
  });

  it('未声明 cap → 5000 字符(<16KB)原样进模型,行为与改造前一致', async () => {
    const h = buildHarness({ output: () => midOutput(5000) });
    await h.run();
    expect(h.seenByModel[0]).toHaveLength(5000);
    expect(h.spillCalls).toHaveLength(0);
  });

  it('cap 低于输出但输出 ≤ cap → 不触发任何治理', async () => {
    const h = buildHarness({ outputCap: 2000, output: () => 'short-ok' });
    await h.run();
    expect(h.seenByModel[0]).toBe('short-ok');
  });

  it('cap 超 16KB 被压顶:20000 字符输出仍按 TOOL_OUTPUT_LIMIT 治理(与未声明一致)', async () => {
    const big = () => `HEAD_${'x'.repeat(20_000 - 10)}_TAIL`;
    const withCap = buildHarness({ outputCap: 999_999, output: big });
    await withCap.run();
    const seen = String(withCap.seenByModel[0]);
    expect(seen).toContain('输出过长已截断');
    expect(seen.length).toBeLessThan(17 * 1024);
  });
});
