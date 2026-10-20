import { describe, it, expect } from 'vitest';
import { Context } from '@deepseek-ai/cordis';
import { AgentService, OrchestratorService } from './index';
import type { ModelGateway, PlannerNotifier } from './index';
import { BACKGROUND_NOTICE_PREFIX, STEP_NOTICE_PREFIX, USER_MESSAGE_PREFIX } from './notice';

/**
 * 后台任务通知(getBackgroundNotice)通道消费接线
 * (docs/design/background-child-missions.md):prepareStep 每步拉取,非空则
 * 以【后台任务通知】user 消息追加到本步末尾 —— 注入点在治理提示之后、
 * 用户追加消息之前;返回空/抛错静默跳过;不传回调零感知(CLI/runner 行为
 * 与之前一致)。harness 复用 orchestrator-session.test.ts 的 cordis stub 模式。
 */

function buildHarness() {
  const ctx = new Context();
  new AgentService(ctx);
  const orch = new OrchestratorService(ctx);
  /** stub 模型手动调一次 prepareStep,记录返回的 adjust */
  const captured: any[] = [];

  const stubModel: ModelGateway = {
    setPreferredModel: () => {},
    setBudget: () => {},
    runAgentLoop: async (o: any) => {
      const messages = [{ role: 'user', content: '测试任务' }];
      captured.push(await o.prepareStep({ stepNumber: 1, messages }));
      return {
        text: '完成',
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
    captured,
    run: (opts: Record<string, any> = {}) =>
      orch.runTask({ taskId: 'task_bg_1', prompt: '测试任务', maxSteps: 5, ...opts }),
  };
}

describe('getBackgroundNotice 通道消费', () => {
  it('返回非空 → 末尾追加【后台任务通知】user 消息,原数组不改', async () => {
    const h = buildHarness();
    const notice = '子任务「调研 X」已完成。结果摘要:结论 A/结论 B';
    const r = await h.run({ getBackgroundNotice: () => notice });
    expect(r.success).toBe(true);
    const messages = h.captured[0].messages;
    expect(messages).toHaveLength(2);
    expect(messages[1]).toEqual({
      role: 'user',
      content: `${BACKGROUND_NOTICE_PREFIX}${notice}`,
    });
  });

  it('返回 null/空串 → 不注入(prepareStep 无消息改写)', async () => {
    const h = buildHarness();
    const r = await h.run({ getBackgroundNotice: () => null });
    expect(r.success).toBe(true);
    expect(h.captured[0]?.messages).toBeUndefined();
  });

  it('回调抛错 → 静默跳过,任务照常完成', async () => {
    const h = buildHarness();
    const r = await h.run({
      getBackgroundNotice: () => {
        throw new Error('queue exploded');
      },
    });
    expect(r.success).toBe(true);
    expect(h.captured[0]?.messages).toBeUndefined();
  });

  it('不传回调 → 零感知(与通道上线前行为一致)', async () => {
    const h = buildHarness();
    const r = await h.run();
    expect(r.success).toBe(true);
    expect(h.captured[0]).toBeUndefined();
  });

  it('三通道同帧注入顺序:治理提示 → 后台通知 → 用户追加消息', async () => {
    const h = buildHarness();
    const r = await h.run({
      getStepNotice: () => '记忆 m1 已被删除',
      getBackgroundNotice: () => '子任务已完成',
      getUserMessages: () => '顺便查下 Y',
    });
    expect(r.success).toBe(true);
    const contents = h.captured[0].messages.slice(1).map((m: any) => m.content);
    expect(contents).toEqual([
      `${STEP_NOTICE_PREFIX}记忆 m1 已被删除`,
      `${BACKGROUND_NOTICE_PREFIX}子任务已完成`,
      `${USER_MESSAGE_PREFIX}顺便查下 Y`,
    ]);
  });
});
