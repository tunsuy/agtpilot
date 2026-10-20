import { describe, it, expect } from 'vitest';
import { extractChildMissionId, childStatusMeta } from '../BackgroundChildPanel';
import type { Mission, MissionStep } from '../../types/agent';

/**
 * 后台子任务折叠面板的两枚纯函数(docs/design/background-child-missions.md §5):
 * childMissionId 提取(output 三形态容忍)与子任务状态 chip 判定
 * (失败信号 = step_err_ 尾步,mission.status 失败也收敛为 DONE)。
 */

const stepOf = (over: Partial<MissionStep>): MissionStep =>
  ({ id: 'step_1', title: 'x', status: 'DONE', ...over }) as MissionStep;

const missionOf = (over: Partial<Mission>): Mission =>
  ({
    id: 'mission_c1',
    title: '竞品调研',
    status: 'DONE',
    steps: [],
    ...over,
  }) as unknown as Mission;

describe('extractChildMissionId', () => {
  it('output 为对象形态(编排器直存工具结果)', () => {
    const id = extractChildMissionId(
      stepOf({ tool: 'launch_background_task', output: { success: true, childMissionId: 'mission_1791968561786' } })
    );
    expect(id).toBe('mission_1791968561786');
  });

  it('output 为 JSON 串形态(落盘 round-trip 后)', () => {
    const id = extractChildMissionId(
      stepOf({ tool: 'launch_background_task', output: JSON.stringify({ success: true, childMissionId: 'mission_42' }) })
    );
    expect(id).toBe('mission_42');
  });

  it('裸文本兜底:非 JSON 串里按 mission id 模式提取', () => {
    const id = extractChildMissionId(stepOf({ tool: 'launch_background_task', output: 'child=mission_99x_1 launched' }));
    expect(id).toBe('mission_99x_1');
  });

  it('派发中(output 未落)/失败结果(无 childMissionId)→ undefined(行不出 chevron)', () => {
    expect(extractChildMissionId(stepOf({ tool: 'launch_background_task', status: 'RUNNING' }))).toBeUndefined();
    expect(
      extractChildMissionId(stepOf({ tool: 'launch_background_task', output: { success: false, error: '在飞后台子任务已达上限(4 个)' } }))
    ).toBeUndefined();
    expect(extractChildMissionId(stepOf({ tool: 'web_search', output: 'mission_1' }))).toBeDefined(); // 提取不挑工具名(调用方已按 tool 门控)
  });
});

describe('childStatusMeta', () => {
  it('ACTIVE → 执行中(spinner)', () => {
    expect(childStatusMeta(missionOf({ status: 'ACTIVE' })).label).toBe('执行中');
  });

  it('DONE 无失败尾步 → 已完成', () => {
    expect(childStatusMeta(missionOf({ status: 'DONE' })).label).toBe('已完成');
  });

  it('DONE 但带 step_err_ 尾步 → 失败(mission 级失败收敛在 DONE,数据判定)', () => {
    const m = missionOf({
      status: 'DONE',
      steps: [stepOf({ id: 'step_err_1791968561786', title: '执行异常: MCP timeout', status: 'FAILED' })],
    });
    expect(childStatusMeta(m).label).toBe('失败');
  });

  it('INTERRUPTED → 已中断;QUEUED → 等待中', () => {
    expect(childStatusMeta(missionOf({ status: 'INTERRUPTED' })).label).toBe('已中断');
    expect(childStatusMeta(missionOf({ status: 'QUEUED' })).label).toBe('等待中');
  });
});
