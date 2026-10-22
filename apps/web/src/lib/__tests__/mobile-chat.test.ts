import { describe, it, expect } from 'vitest';
import { chatAvailability, summarizeProcessBlocks } from '../mobile-chat';
import type { CockpitBlock } from '../cockpit-blocks';
import type { Mission, MissionStep } from '../../types/agent';

/**
 * 移动端对话态两枚纯函数:历史内容三态判定(stripped 终态摘要 ≠ 空会话)
 * 与「任务过程 · N 项」折叠摘要统计(桌面 CockpitView inline 逻辑抽纯,口径一致)。
 */

const stepOf = (over: Partial<MissionStep>): MissionStep =>
  ({ id: 'step_1', title: 'x', status: 'DONE', ...over }) as MissionStep;

const missionOf = (over: Partial<Mission>): Mission =>
  ({
    id: 'mission_m1',
    title: 't',
    status: 'DONE',
    progress: 100,
    startedAt: 0,
    steps: [],
    ...over,
  }) as unknown as Mission;

describe('chatAvailability', () => {
  it('null → empty', () => {
    expect(chatAvailability(null)).toBe('empty');
  });

  it('有 steps → ready(含续聊发送后的乐观气泡)', () => {
    expect(chatAvailability(missionOf({ steps: [stepOf({})] }))).toBe('ready');
  });

  it('stripped 且无 steps → loading(终态摘要等懒回水,不误判空会话)', () => {
    expect(chatAvailability(missionOf({ stripped: true, stepCount: 12 }))).toBe('loading');
  });

  it('无 steps 且非 stripped → empty(新会话待命)', () => {
    expect(chatAvailability(missionOf({}))).toBe('empty');
  });
});

describe('summarizeProcessBlocks', () => {
  it('工具块数真实动作行(带 tool 或失败),元步骤不计;失败单列', () => {
    const blocks: CockpitBlock[] = [
      {
        type: 'tools',
        key: 'g1',
        steps: [
          stepOf({ id: 's1', tool: 'search_web' }),
          stepOf({ id: 's2', status: 'FAILED' }), // 无 tool 但失败 → 计数且计失败
          stepOf({ id: 's3', title: '已完成一轮推理' }), // 元步骤 → 不计
        ],
      },
    ];
    const r = summarizeProcessBlocks(blocks);
    expect(r.count).toBe(2);
    expect(r.failed).toBe(1);
  });

  it('非工具块(assistant/notice)各计 1,无失败', () => {
    const blocks: CockpitBlock[] = [
      { type: 'assistant', step: stepOf({ id: 'a1', reasoning: '思考' }) },
      {
        type: 'notice',
        step: stepOf({
          id: 'n1',
          bgNotice: { childMissionId: 'mission_c1', childTitle: '子任务', outcome: 'done' },
        }),
      },
    ];
    const r = summarizeProcessBlocks(blocks);
    expect(r.count).toBe(2);
    expect(r.failed).toBe(0);
  });

  it('耗时 = 首步开始 → 末步结束的墙钟时间(间隙计入)', () => {
    const blocks: CockpitBlock[] = [
      {
        type: 'tools',
        key: 'g1',
        steps: [
          stepOf({ id: 's1', tool: 'a', startedAt: 1000, duration: '500ms' }),
          stepOf({ id: 's2', tool: 'b', startedAt: 4000, duration: '1000ms' }),
        ],
      },
    ];
    // 1000 → 4000+1000 = 4000ms
    expect(summarizeProcessBlocks(blocks).elapsedMs).toBe(4000);
  });

  it('全无计时数据 → 耗时 undefined(摘要行不显示耗时段)', () => {
    const blocks: CockpitBlock[] = [{ type: 'assistant', step: stepOf({ id: 'a1' }) }];
    expect(summarizeProcessBlocks(blocks).elapsedMs).toBeUndefined();
  });

  it('空块数组 → 全零', () => {
    const r = summarizeProcessBlocks([]);
    expect(r).toEqual({ count: 0, failed: 0, elapsedMs: undefined });
  });
});
