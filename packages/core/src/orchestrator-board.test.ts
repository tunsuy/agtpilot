import { describe, it, expect } from 'vitest';
import { Context } from '@deepseek-ai/cordis';
import { AgentService, OrchestratorService } from './index';
import type { ModelGateway, PlannerNotifier, ToolDefinition } from './index';
import { BOARD_REMINDER_PREFIX } from './notice';

/**
 * 看板滞后催促(2026-10 看板契约切换的核心新增,对照 Claude Code 检测到
 * todo 落后注入 system-reminder 的机制):看板进度由模型显式申报
 * (planner_update_task 与实际工具调用同批),内核不推断步骤完成
 * (旧 noteToolResult「工具成功自动推进」已废)。模型忘了申报时:
 * - 连续 BOARD_LAG_THRESHOLD(=2) 轮「真实工具成功但看板零更新」
 *   → 下一步注入一条【看板同步提醒】(文本来自 PlannerNotifier)并清零
 *   计数,防连环催促;
 * - planner_ 系工具执行本身就是显式申报 → 计数清零;
 * - 元工具(memory_/router_/observability_)不产出任务交付物,不计滞后。
 * harness 复用 smoke.ts 的 cordis stub 模式:脚本化工具序列 + 每轮走
 * prepareStep(滞后检测挂载点)。
 */

function buildBoardHarness(opts: { callSeq: string[]; lagNotice?: string | null }) {
  const ctx = new Context();
  new AgentService(ctx);
  const orch = new OrchestratorService(ctx);

  const lagCalls: Array<{ taskKey: string; idleRounds: number }> = [];
  const stubPlanner: PlannerNotifier = {
    boardLagNotice: (taskKey: string, idleRounds: number) => {
      lagCalls.push({ taskKey, idleRounds });
      // undefined = 默认给文本(测注入);显式 null = 无可催促(测跳过)
      return opts.lagNotice === undefined ? `看板已 ${idleRounds} 轮未随进度更新，请同批申报` : opts.lagNotice;
    },
  };
  ctx.reflect.provide('planner', stubPlanner);

  /** 每次调用 prepareStep 后、真正改写消息时的快照(滞后催促在这里注入) */
  const adjustedMessages: any[][] = [];
  const stubModel: ModelGateway = {
    setPreferredModel: () => {},
    setBudget: () => {},
    runAgentLoop: async (o: any) => {
      const responseMessages: any[] = [];
      let i = 0;
      while (i < opts.callSeq.length) {
        const adjust = await o.prepareStep?.({ stepNumber: i + 1, messages: [...responseMessages] });
        if (adjust?.messages) adjustedMessages.push(adjust.messages);
        const name = opts.callSeq[i];
        const tool = (o.tools as Array<{ name: string; execute: (args: any) => Promise<any> }>).find((t) => t.name === name)!;
        const out = await tool.execute({});
        responseMessages.push({
          role: 'assistant',
          content: [{ type: 'tool-call', toolCallId: `c${i}`, toolName: name, input: {} }],
        });
        responseMessages.push({ role: 'tool', content: [{ type: 'tool-result', toolCallId: `c${i}`, output: out }] });
        i++;
      }
      return { text: '最终答复', finishReason: 'stop', stepsCount: opts.callSeq.length, stepsExhausted: false, responseMessages };
    },
    invokeStep: async () => ({ text: '总结', toolCalls: [], finishReason: 'stop', usage: { promptTokens: 0, completionTokens: 0 } }),
  };
  ctx.reflect.provide('model', stubModel);

  const register = (name: string) =>
    ctx.agent.registerTool({
      name,
      description: name,
      parameters: { type: 'object', properties: {} },
      execute: async () => ({ ok: true }),
    } as ToolDefinition);

  return {
    register,
    lagCalls,
    adjustedMessages,
    run: () => orch.runTask({ prompt: '测试任务', maxSteps: 30 }),
  };
}

/** 真实工作工具各一个(互不相同,避开熔断器的同签名窗口) */
const WORK_TOOLS = ['work_a', 'work_b', 'work_c', 'work_d', 'work_e'];

describe('看板滞后催促(模型显式申报契约的内核侧守门)', () => {
  it('连续 2 轮真实工具成功且零申报 → 注入【看板同步提醒】并清零计数(隔两轮再催)', async () => {
    const seq = [...WORK_TOOLS]; // 5 轮纯工作、零申报
    const h = buildBoardHarness({ callSeq: seq });
    WORK_TOOLS.forEach(h.register);
    await h.run();
    // 第 3、5 步前各触发一次(1+2 轮攒满 → 催;清零后再攒 2 轮 → 再催)
    expect(h.lagCalls).toEqual([{ taskKey: expect.any(String), idleRounds: 2 }, { taskKey: expect.any(String), idleRounds: 2 }]);
    // 注入的消息:前缀 + 规划器给出的文本,追加在消息末尾
    expect(h.adjustedMessages.length).toBe(2);
    const reminder = h.adjustedMessages[0][h.adjustedMessages[0].length - 1];
    expect(reminder.role).toBe('user');
    expect(reminder.content).toContain(BOARD_REMINDER_PREFIX);
    expect(reminder.content).toContain('请同批申报');
  });

  it('模型同批申报(planner_update_task 执行)→ 滞后计数清零,全程零催促', async () => {
    // 每轮工作后跟一次申报:申报即清零,永远攒不满阈值
    const seq = ['work_a', 'planner_update_task', 'work_b', 'planner_update_task', 'work_c', 'planner_update_task', 'work_d', 'planner_update_task'];
    const h = buildBoardHarness({ callSeq: seq });
    ['work_a', 'work_b', 'work_c', 'work_d', 'planner_update_task'].forEach(h.register);
    await h.run();
    expect(h.lagCalls).toEqual([]);
    expect(h.adjustedMessages).toEqual([]);
  });

  it('元工具(memory_/router_/observability_)不算真实推进:不计入滞后', async () => {
    // 1 轮工作 + 5 轮元工具 + 4 轮工作:元工具轮不积累滞后,催促只按真实工作轮计
    const seq = ['work_a', 'memory_store', 'memory_recall', 'router_select_tier', 'observability_trace', 'memory_purge', 'work_b', 'work_c', 'work_d', 'work_e'];
    const h = buildBoardHarness({ callSeq: seq });
    [...WORK_TOOLS, 'memory_store', 'memory_recall', 'router_select_tier', 'observability_trace', 'memory_purge'].forEach(h.register);
    await h.run();
    // 真实工作轮:a(轮1), b/c/d/e(轮7-10) → 第 8、10 步前各催一次;元工具轮若误计会催 ~5 次
    expect(h.lagCalls.length).toBe(2);
    expect(h.lagCalls.every((c) => c.idleRounds === 2)).toBe(true);
  });

  it('规划器无可催促进度(返回 null)→ 不注入任何消息,不影响主流程', async () => {
    const seq = [...WORK_TOOLS];
    const h = buildBoardHarness({ callSeq: seq, lagNotice: null });
    WORK_TOOLS.forEach(h.register);
    await h.run();
    // 查询照常发生(滞后是事实),但 null → 无消息注入
    expect(h.lagCalls.length).toBe(2);
    expect(h.adjustedMessages).toEqual([]);
  });
});
