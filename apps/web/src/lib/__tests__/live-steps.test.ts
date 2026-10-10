import { describe, it, expect } from 'vitest';
import type { Mission } from '@/types/agent';
import {
  LIVE_STEP_ID_PREFIX,
  applyDelta,
  closeLiveStep,
  ensureLiveStep,
  finalizeWithAnswer,
  findLiveStep,
  resolveMission,
} from '@/lib/live-steps';

/**
 * 流式 live assistant step 状态机（P1 真流式 + P0 思考指示）：
 * 会话进行中驾驶舱可见性的核心 —— step_started 创建占位、assistant_delta
 * 累积、tool_call/error 收尾、done 权威全文合并去重、事件按 taskId 归属。
 */

function makeMission(id = 'mission_test', steps: Mission['steps'] = []): Mission {
  return {
    id,
    title: 'test',
    status: 'ACTIVE',
    progress: 5,
    startedAt: Date.now(),
    steps,
  };
}

describe('ensureLiveStep / findLiveStep', () => {
  it('无 live step 时创建 RUNNING 占位（正在思考…）', () => {
    const m = makeMission();
    const step = ensureLiveStep(m, 1);
    expect(step.status).toBe('RUNNING');
    expect(step.role).toBe('assistant');
    expect(step.title).toBe('正在思考…');
    expect(step.id.startsWith(LIVE_STEP_ID_PREFIX)).toBe(true);
    expect(m.steps).toHaveLength(1);
  });

  it('wrap-up 指示用独立标题', () => {
    const m = makeMission();
    ensureLiveStep(m, undefined, 'wrap-up');
    expect(m.steps[0].title).toBe('正在做最终总结…');
  });

  it('已存在 RUNNING live step 时复用，不重复创建（单 live step 不变量）', () => {
    const m = makeMission();
    const first = ensureLiveStep(m, 1);
    const second = ensureLiveStep(m, 2);
    expect(second).toBe(first);
    expect(m.steps).toHaveLength(1);
  });

  it('已关闭的 live step 不再被 findLiveStep 命中', () => {
    const m = makeMission();
    const step = ensureLiveStep(m, 1);
    closeLiveStep(m, { status: 'DONE' });
    expect(findLiveStep(m)).toBeUndefined();
    expect(step.status).toBe('DONE');
  });
});

describe('applyDelta', () => {
  it('text 增量累积进 answer，首个文本改标题', () => {
    const m = makeMission();
    ensureLiveStep(m, 1);
    applyDelta(m, '你', 'text');
    applyDelta(m, '好', 'text');
    const live = findLiveStep(m)!;
    expect(live.answer).toBe('你好');
    expect(live.title).toBe('智能体回复');
  });

  it('reasoning 增量累积进独立字段，不动 answer', () => {
    const m = makeMission();
    ensureLiveStep(m, 1);
    applyDelta(m, '先分析问题…', 'reasoning');
    const live = findLiveStep(m)!;
    expect(live.reasoning).toBe('先分析问题…');
    expect(live.answer).toBe('');
    expect(live.title).toBe('深度思考中…');
  });

  it('无 live step 时自动补建（容错）', () => {
    const m = makeMission();
    applyDelta(m, 'hi', 'text');
    expect(m.steps).toHaveLength(1);
    expect(m.steps[0].answer).toBe('hi');
  });
});

describe('closeLiveStep', () => {
  it('有正文时关闭保留 answer 与默认标题', () => {
    const m = makeMission();
    ensureLiveStep(m, 1);
    applyDelta(m, '段落', 'text');
    const closed = closeLiveStep(m, { status: 'DONE' });
    expect(closed).toBe(true);
    expect(m.steps[0].status).toBe('DONE');
    expect(m.steps[0].title).toBe('智能体回复');
    expect(m.steps[0].answer).toBe('段落');
    expect(m.steps[0].duration).toMatch(/ms$/);
  });

  it('无正文 DONE → 已完成一轮推理；FAILED → 回复中断', () => {
    const a = makeMission('a');
    ensureLiveStep(a, 1);
    closeLiveStep(a, { status: 'DONE' });
    expect(a.steps[0].title).toBe('已完成一轮推理');

    const b = makeMission('b');
    ensureLiveStep(b, 1);
    closeLiveStep(b, { status: 'FAILED' });
    expect(b.steps[0].title).toBe('回复中断');
  });

  it('无 live step 时返回 false（幂等）', () => {
    const m = makeMission();
    expect(closeLiveStep(m, { status: 'DONE' })).toBe(false);
  });
});

describe('finalizeWithAnswer（done 合并去重）', () => {
  it('live step 原地升级：权威全文覆盖累积部分，绝不拼接', () => {
    const m = makeMission();
    ensureLiveStep(m, 1);
    applyDelta(m, '已流出的部', 'text');
    const live = findLiveStep(m)!;
    const merged = finalizeWithAnswer(m, '最终权威回答全文');
    expect(merged).toBe(true);
    expect(live.answer).toBe('最终权威回答全文');
    expect(live.status).toBe('DONE');
    expect(live.title).toBe('智能体回复');
    expect(m.steps.filter((s) => s.role === 'assistant')).toHaveLength(1);
  });

  it('无 live step（纯工具任务）返回 false，调用方才会追加独立回复步骤', () => {
    const m = makeMission();
    expect(finalizeWithAnswer(m, '答案')).toBe(false);
  });
});

describe('resolveMission（事件归属，串台修复）', () => {
  const a = makeMission('mission_a');
  const b = makeMission('mission_b');

  it('优先事件自带 taskId：A 的步骤不再挂到 B（activeMission 指向 B 的场景）', () => {
    const resolved = resolveMission([a, b], 'mission_b', { taskId: 'mission_a' });
    expect(resolved).toBe(a);
  });

  it('taskId 找不到时兜底 activeMissionId', () => {
    const resolved = resolveMission([a, b], 'mission_b', { taskId: 'mission_unknown' });
    expect(resolved).toBe(b);
  });

  it('无 taskId（viewport/terminal 等全局事件）走 activeMissionId', () => {
    expect(resolveMission([a, b], 'mission_a', {})).toBe(a);
    expect(resolveMission([a, b], 'mission_a', null)).toBe(a);
  });

  it('两者都缺时返回 undefined', () => {
    expect(resolveMission([a, b], null, {})).toBeUndefined();
  });
});
