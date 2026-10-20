import { describe, it, expect, vi } from 'vitest';
import {
  deliverChildOutcome,
  buildChildNoticeText,
  buildBgNoticeStep,
  truncateChildDetail,
  BG_SUMMARY_LIMIT,
  BG_ERROR_LIMIT,
  type ChildOutcome,
} from '../background-notify';

/**
 * 后台子任务收尾回注纯逻辑(docs/design/background-child-missions.md §4):
 * 去重、截断、气泡形态、「父在飞 → 入队 / 父已结束 → 唤醒」路由与
 * 气泡先于 push 解锁的顺序(防父已 DONE 时气泡广播触发误推)。
 */

const doneOutcome: ChildOutcome = {
  childMissionId: 'mission_c1',
  childTitle: '竞品调研',
  parentMissionId: 'mission_p1',
  outcome: 'done',
  detail: '结论 A:定价偏高;结论 B:功能缺口在协作',
};

const failedOutcome: ChildOutcome = { ...doneOutcome, childMissionId: 'mission_c2', outcome: 'failed', detail: 'MCP timeout' };

function mockDeps(overrides: Record<string, any> = {}) {
  return {
    isParentRunning: vi.fn((_pid: string) => false),
    enqueueNotice: vi.fn((_pid: string, _text: string) => true),
    wakeParent: vi.fn((_pid: string, _text: string) => {}),
    appendBubble: vi.fn((_o: ChildOutcome, _summary?: string) => {}),
    unlockParentPush: vi.fn((_pid: string) => {}),
    log: vi.fn((_msg: string) => {}),
    ...overrides,
  };
}

describe('deliverChildOutcome · 路由决策', () => {
  it('父在飞 → 入队步边界注入,不派发唤醒轮', () => {
    const deps = mockDeps({ isParentRunning: () => true });
    deliverChildOutcome(doneOutcome, deps, new Set());
    expect(deps.enqueueNotice).toHaveBeenCalledTimes(1);
    expect(deps.enqueueNotice.mock.calls[0][0]).toBe('mission_p1');
    expect(deps.wakeParent).not.toHaveBeenCalled();
  });

  it('父已结束(含 DONE)→ 唤醒续轮,不入队', () => {
    const deps = mockDeps();
    deliverChildOutcome(doneOutcome, deps, new Set());
    expect(deps.wakeParent).toHaveBeenCalledTimes(1);
    expect(deps.enqueueNotice).not.toHaveBeenCalled();
  });

  it('父在飞但运行时把手已删(收尾竞态)→ 回退唤醒派发', () => {
    const deps = mockDeps({ isParentRunning: () => true, enqueueNotice: () => false });
    deliverChildOutcome(doneOutcome, deps, new Set());
    expect(deps.wakeParent).toHaveBeenCalledTimes(1);
  });

  it('唤醒文本不带前缀(由注入通道/派发处加),含标题与整合指令', () => {
    const deps = mockDeps();
    deliverChildOutcome(doneOutcome, deps, new Set());
    const text = deps.wakeParent.mock.calls[0][1];
    expect(text).not.toContain('【后台任务通知】');
    expect(text).toContain('竞品调研');
    expect(text).toContain('整合进当前任务');
  });

  it('同一子任务重复收尾(done/error 双路)→ 只投第一次', () => {
    const notified = new Set<string>();
    const deps = mockDeps();
    deliverChildOutcome(doneOutcome, deps, notified);
    deliverChildOutcome({ ...doneOutcome, outcome: 'failed' }, deps, notified);
    expect(deps.appendBubble).toHaveBeenCalledTimes(1);
    expect(deps.wakeParent).toHaveBeenCalledTimes(1);
  });

  it('气泡先于 push 解锁(父已 DONE 时气泡广播不会触发误推)', () => {
    const deps = mockDeps();
    deliverChildOutcome(doneOutcome, deps, new Set());
    expect(deps.appendBubble).toHaveBeenCalledTimes(1);
    expect(deps.unlockParentPush).toHaveBeenCalledWith('mission_p1');
    expect(deps.appendBubble.mock.invocationCallOrder[0]).toBeLessThan(
      deps.unlockParentPush.mock.invocationCallOrder[0]
    );
  });

  it('去重集超 500 → 收敛到最近 250 条(仿 pushedDoneMissions)', () => {
    const notified = new Set(Array.from({ length: 500 }, (_, i) => `old${i}`));
    deliverChildOutcome(doneOutcome, mockDeps(), notified);
    expect(notified.size).toBe(250);
    expect(notified.has('mission_c1')).toBe(true);
    expect(notified.has('old0')).toBe(false);
  });
});

describe('truncateChildDetail', () => {
  it('done 截 2000 / failed 截 200,截断带标记', () => {
    const long = 'x'.repeat(BG_SUMMARY_LIMIT + 100);
    const done = truncateChildDetail(long, 'done')!;
    expect(done).toBe(`${'x'.repeat(BG_SUMMARY_LIMIT)}…(已截断)`);
    const failed = truncateChildDetail('e'.repeat(BG_ERROR_LIMIT + 50), 'failed')!;
    expect(failed).toBe(`${'e'.repeat(BG_ERROR_LIMIT)}…(已截断)`);
  });

  it('短文本原样;空/纯空白返回 undefined', () => {
    expect(truncateChildDetail('结论 A', 'done')).toBe('结论 A');
    expect(truncateChildDetail('  \n ', 'done')).toBeUndefined();
    expect(truncateChildDetail(undefined, 'failed')).toBeUndefined();
  });
});

describe('buildChildNoticeText', () => {
  it('done:摘要 + 整合指令 + 禁重复派发', () => {
    const t = buildChildNoticeText(doneOutcome, '结论 A');
    expect(t).toContain('子任务「竞品调研」已完成');
    expect(t).toContain('结论 A');
    expect(t).toContain('不要重复派发同一子任务');
  });

  it('done 无摘要:给出兜底提示而非空白', () => {
    expect(buildChildNoticeText(doneOutcome)).toContain('无文本结果');
  });

  it('failed:错误信息 + 改道指令(不原样重试)', () => {
    const t = buildChildNoticeText(failedOutcome, 'MCP timeout');
    expect(t).toContain('执行失败');
    expect(t).toContain('MCP timeout');
    expect(t).toContain('不要原样重复派发');
  });
});

describe('buildBgNoticeStep · 通知气泡形态', () => {
  it('done → DONE 态步骤,bgNotice 载荷完整,id 含 childMissionId 幂等', () => {
    const step = buildBgNoticeStep(doneOutcome, '结论 A');
    expect(step.id).toBe('step_bg_mission_c1');
    expect(step.title).toBe('后台任务已完成: 竞品调研');
    expect(step.status).toBe('DONE');
    expect(step.bgNotice).toEqual({
      childMissionId: 'mission_c1',
      childTitle: '竞品调研',
      outcome: 'done',
      summary: '结论 A',
    });
    // 无 role/tool/answer:不会被 legacy-final 判定误收为最终答复卡
    expect(step.role).toBeUndefined();
    expect(step.answer).toBeUndefined();
  });

  it('failed → FAILED 态步骤', () => {
    const step = buildBgNoticeStep(failedOutcome, 'MCP timeout');
    expect(step.title).toBe('后台任务失败: 竞品调研');
    expect(step.status).toBe('FAILED');
    expect(step.bgNotice?.outcome).toBe('failed');
  });
});
