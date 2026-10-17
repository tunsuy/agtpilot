import { describe, it, expect, afterEach } from 'vitest';
import { Context } from '@deepseek-ai/cordis';
import { AgentService, OrchestratorService } from './index';
import type { ModelGateway, PlannerNotifier, ToolDefinition } from './index';

/**
 * 超长工具输出 spill-to-file 的内核侧行为测试(docs/design/tool-output-spill.md):
 * 截断点先试落盘回调 → 成功回「预览+指针」/ 失败回退现行头尾截断;
 * tool_result 广播始终带全量原文(UI 不受影响)+ spilled 元数据;
 * 保险丝 AGTPILOT_TOOL_SPILL=0 全链路回退。
 * harness 复用 orchestrator-stats.test.ts 的 cordis stub 模式(脚本化直接调 loop 工具)。
 */

afterEach(() => {
  delete process.env.AGTPILOT_TOOL_SPILL;
});

const BIG = 20_000; // > TOOL_OUTPUT_LIMIT(16KB)
const bigOutput = () => `HEAD_${'x'.repeat(BIG - 10)}_TAIL`; // 恰好 BIG 字符(HEAD_/_TAIL 各 5)
const smallOutput = () => 'ok'.repeat(100); // 200 字符,远低于限额

function buildHarness(opts: {
  spill?: (info: any) => string | null | Promise<string | null>;
  output?: () => any;
  toolName?: string;
} = {}) {
  const ctx = new Context();
  new AgentService(ctx);
  const orch = new OrchestratorService(ctx);
  const toolName = opts.toolName ?? 'big_read';
  const makeOutput = opts.output ?? bigOutput;

  ctx.agent.registerTool({
    name: toolName,
    description: toolName,
    parameters: { type: 'object', properties: {} },
    execute: async () => makeOutput(),
  } as ToolDefinition);

  // 模型实际拿到的工具返回(= 编排器包装后的 finalOutput)
  const seenByModel: any[] = [];
  // tool_result 广播载荷(UI 视角)
  const broadcastResults: any[] = [];
  ctx.on('agtpilot/event', (e: any) => {
    if (e.type === 'tool_result') broadcastResults.push(e.payload);
  });
  // 落盘回调收到的入参
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
      const out = await tools.find((t) => t.name === toolName)!.execute({});
      seenByModel.push(out);
      return {
        text: '最终答复',
        finishReason: 'stop',
        stepsCount: 1,
        stepsExhausted: false,
        responseMessages: [
          { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'c0', toolName, input: {} }] },
          { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'c0', output: out }] },
        ],
      };
    },
    invokeStep: async () => ({ text: '总结', toolCalls: [], finishReason: 'stop', usage: { promptTokens: 0, completionTokens: 0 } }),
  };
  ctx.reflect.provide('model', stubModel);
  ctx.reflect.provide('planner', { boardLagNotice: () => null } as PlannerNotifier);

  return {
    run: () =>
      orch.runTask({
        taskId: 'task_spill_1',
        prompt: '测试任务',
        maxSteps: 20,
        ...(spill ? { spillToolOutput: spill } : {}),
      }),
    seenByModel,
    broadcastResults,
    spillCalls,
  };
}

describe('工具输出 spill-to-file · 内核截断点', () => {
  it('超限+回调成功 → 模型收「预览+指针」,回调收全量原文,广播仍带全量+spilled 元数据', async () => {
    const h = buildHarness({ spill: (info) => info.callId });
    const result = await h.run();
    expect(result.success).toBe(true);

    // 回调入参:taskId/callId/toolName/全量原文
    expect(h.spillCalls).toHaveLength(1);
    const info = h.spillCalls[0];
    expect(info.taskId).toBe('task_spill_1');
    expect(info.toolName).toBe('big_read');
    expect(typeof info.callId).toBe('string');
    expect(info.fullText).toHaveLength(BIG);

    // 模型拿到的是指针版:远小于原文、含 ref 与续读指引、保留头尾
    const pointer = String(h.seenByModel[0]);
    expect(pointer.length).toBeLessThan(6 * 1024);
    expect(pointer).toContain(`ref=${info.callId}`);
    expect(pointer).toContain('read_tool_output');
    expect(pointer).toContain(`原输出共 ${BIG} 字符`);
    expect(pointer.startsWith('HEAD_')).toBe(true);
    expect(pointer.endsWith('_TAIL')).toBe(true);

    // 广播(UI 视角)不受影响:全量原文 + spilled 元数据
    expect(h.broadcastResults).toHaveLength(1);
    expect(h.broadcastResults[0].output).toHaveLength(BIG);
    expect(h.broadcastResults[0].spilled).toEqual({ callId: info.callId, originalChars: BIG });

    // 效率统计可观测
    expect(result.efficiency?.spilledOutputs).toBe(1);
    expect(result.efficiency?.spilledChars).toBe(BIG);
  });

  it('落盘进历史的消息也是指针版(result.messages 的 tool output)', async () => {
    const h = buildHarness({ spill: (info) => info.callId });
    const result = await h.run();
    const toolMsg = (result.messages || []).find((m) => m.role === 'tool');
    const out = (toolMsg?.content as any[])[0].output;
    expect(String(out)).toContain('read_tool_output');
    expect(String(out).length).toBeLessThan(6 * 1024); // 落盘/跨轮重发的都是小指针
  });

  it('回调抛错 → 回退现行头尾截断,工具调用不失败,无 spilled 字段', async () => {
    const h = buildHarness({
      spill: () => {
        throw new Error('磁盘满');
      },
    });
    const result = await h.run();
    expect(result.success).toBe(true);
    const out = String(h.seenByModel[0]);
    expect(out).toContain('输出过长已截断');
    expect(out).not.toContain('read_tool_output');
    expect(h.broadcastResults[0].spilled).toBeUndefined();
    expect(result.efficiency?.spilledOutputs).toBeUndefined();
    expect(result.efficiency && 'spilledOutputs' in result.efficiency).toBe(false);
  });

  it('回调返回 null(存储侧拒绝) → 回退现行截断', async () => {
    const h = buildHarness({ spill: () => null });
    await h.run();
    expect(String(h.seenByModel[0])).toContain('输出过长已截断');
  });

  it('无回调(CLI/runner 不注入) → 现状截断,零行为变化', async () => {
    const h = buildHarness();
    const result = await h.run();
    const out = String(h.seenByModel[0]);
    expect(out).toContain('输出过长已截断');
    expect(out).toContain(`原始 ${BIG} 字符`);
    expect(result.efficiency && 'spilledOutputs' in result.efficiency).toBe(false);
  });

  it('保险丝 AGTPILOT_TOOL_SPILL=0 → 有回调也不调用,回退截断', async () => {
    process.env.AGTPILOT_TOOL_SPILL = '0';
    const h = buildHarness({ spill: (info) => info.callId });
    await h.run();
    expect(h.spillCalls).toHaveLength(0); // 内核侧门控,回调根本不被触达
    expect(String(h.seenByModel[0])).toContain('输出过长已截断');
  });

  it('未超限的小输出不 spill:回调不被调用,输出原样直通', async () => {
    const h = buildHarness({ spill: (info) => info.callId, output: smallOutput });
    const result = await h.run();
    expect(h.spillCalls).toHaveLength(0);
    expect(h.seenByModel[0]).toBe('ok'.repeat(100)); // 直通原样,非截断非指针
    expect(String(h.seenByModel[0])).not.toContain('已截断');
    expect(result.efficiency && 'spilledOutputs' in result.efficiency).toBe(false);
  });

  it('sandbox_ 前缀工具走尾优先预览,指针要素齐全', async () => {
    const h = buildHarness({ spill: (info) => info.callId, toolName: 'sandbox_exec' });
    await h.run();
    const pointer = String(h.seenByModel[0]);
    expect(pointer).toContain('read_tool_output');
    expect(pointer.endsWith('_TAIL')).toBe(true);
    // 尾优先(30/70):尾部保留量 > 头部
    const headLen = pointer.indexOf('\n…[原输出共');
    const tailStart = pointer.lastIndexOf(']…\n') + 3;
    expect(pointer.length - tailStart).toBeGreaterThan(headLen);
  });
});
