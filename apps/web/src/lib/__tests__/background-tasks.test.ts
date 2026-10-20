import { describe, it, expect, vi } from 'vitest';
import {
  buildBackgroundTaskTools,
  BACKGROUND_TASK_MAX_INFLIGHT,
  BACKGROUND_TASK_TITLE_LIMIT,
  BACKGROUND_TASK_HINT,
} from '../background-tasks';

/**
 * launch_background_task 工具形态(docs/design/background-child-missions.md):
 * 立即返回不阻塞、goal 自包含校验、title 钳制、并发闸、异常收敛 ——
 * runMission 依赖经 hooks 注入,脱离后端单测。
 */
const toolOf = (hooks: Partial<Parameters<typeof buildBackgroundTaskTools>[0]> = {}) =>
  buildBackgroundTaskTools({
    launch: vi.fn().mockResolvedValue({ missionId: 'mission_c1' }),
    countRunningChildren: () => 0,
    ...hooks,
  } as any)[0];

describe('launch_background_task · schema', () => {
  it('工具名/必填参数固定(路由与前端 narrate 按名字识别)', () => {
    const t = toolOf();
    expect(t.name).toBe('launch_background_task');
    expect(t.parameters.required).toEqual(['goal', 'title']);
    // description 必须写清后台语义,模型据此自主决策
    expect(t.description).toContain('立即返回');
    expect(t.description).toContain('【后台任务通知】');
    expect(t.description).toContain('严禁空转等待');
  });
});

describe('launch_background_task · execute', () => {
  it('派发成功:立即返回 childMissionId + hint(不等子任务跑完)', async () => {
    const launch = vi.fn().mockResolvedValue({ missionId: 'mission_c9' });
    const r = await toolOf({ launch }).execute({ goal: '深度调研竞品 X 的定价策略', title: '竞品调研' });
    expect(r).toEqual({
      success: true,
      childMissionId: 'mission_c9',
      title: '竞品调研',
      hint: BACKGROUND_TASK_HINT,
    });
    expect(launch).toHaveBeenCalledWith('深度调研竞品 X 的定价策略', '竞品调研');
  });

  it('goal 空/纯空白 → success:false(子任务指令必须自包含)', async () => {
    const launch = vi.fn();
    const r = await toolOf({ launch }).execute({ goal: '   ', title: 't' });
    expect(r.success).toBe(false);
    expect(r.error).toContain('自包含');
    expect(launch).not.toHaveBeenCalled();
  });

  it('title 缺省回退 goal 截断;超长钳制到 20 字(展示位是窄条)', async () => {
    const launch = vi.fn().mockResolvedValue({ missionId: 'm1' });
    const longGoal = '一二三四五六七八九十一二三四五六七八九十超出部分';
    const r = await toolOf({ launch }).execute({ goal: longGoal, title: '' });
    expect(r.title).toBe(longGoal.slice(0, BACKGROUND_TASK_TITLE_LIMIT));
    expect(r.title).toHaveLength(BACKGROUND_TASK_TITLE_LIMIT);
  });

  it('并发闸:在飞子任务达上限 → 拒派并指路改道,launch 不触发', async () => {
    const launch = vi.fn();
    const r = await toolOf({ launch, countRunningChildren: () => BACKGROUND_TASK_MAX_INFLIGHT }).execute({
      goal: 'g',
      title: 't',
    });
    expect(r.success).toBe(false);
    expect(r.error).toContain('上限');
    expect(launch).not.toHaveBeenCalled();
  });

  it('launch 抛错 → 收敛为 success:false,不炸父任务工具调用', async () => {
    const launch = vi.fn().mockRejectedValue(new Error('runtime down'));
    const r = await toolOf({ launch }).execute({ goal: 'g', title: 't' });
    expect(r).toEqual({ success: false, error: '派发后台任务失败: runtime down' });
  });
});
