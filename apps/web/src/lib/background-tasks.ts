/**
 * 后台子任务派发工具(launch_background_task,taskTools 注入)。
 * docs/design/background-child-missions.md
 *
 * Claude Code「run_in_background」同款语义:模型自主判断长耗时任务并派发为
 * 带 parentMissionId 的独立子 mission(unattended,独立上下文,步骤落库全程
 * 可回看);工具立即返回不阻塞当前对话,子任务完成/失败经【后台任务通知】
 * 通道回注父任务(在飞 → prepareStep 步边界注入;已结束 → 自动唤醒续轮)。
 *
 * 纯 builder(照 lib/cron-service.ts buildUserCronTools 形态):runMission/
 * 在飞计数由 AgentBackend 以 hooks 闭包注入,本模块可脱离后端单测。
 * 挂载 gate(子任务/unattended 轮不挂,防递归与链式派发风暴)在 agent-backend
 * 挂载点,不在这里重复。
 */

/** 每个父任务同时在飞的后台子任务上限(并发闸;超限让模型改道同步执行) */
export const BACKGROUND_TASK_MAX_INFLIGHT = 4;

/** title 钳制上限(会话工具行/通知气泡/推送 body 的展示位都是窄条) */
export const BACKGROUND_TASK_TITLE_LIMIT = 20;

/** 派发成功返回给模型的提示:后台语义 + 严禁空转等待(与系统提示词规则 15 呼应) */
export const BACKGROUND_TASK_HINT =
  '后台任务已派发,正在独立执行。完成或失败时,结果会自动以【后台任务通知】送达 —— 现在不要等待结果,先继续处理其他工作;收到通知后再整合其结果。';

export interface BackgroundTaskHooks {
  /** 派发子 mission(agent-backend 闭包:runMission + unattended:true + parentMissionId) */
  launch: (goal: string, title: string) => Promise<{ missionId: string }>;
  /** 该父任务当前在飞子任务数(runInflight 为事实源) */
  countRunningChildren: () => number;
}

export function buildBackgroundTaskTools(hooks: BackgroundTaskHooks): any[] {
  return [
    {
      name: 'launch_background_task',
      description:
        '把一个长耗时任务派发为后台子任务异步执行:工具立即返回,不阻塞当前对话;子任务在独立上下文中无人值守运行(看不到当前对话内容,也不能向用户提问)。子任务完成或失败时,结果摘要会自动以【后台任务通知】送达 —— 当前轮还在跑则在下一步边界注入,已结束则自动开启新一轮。何时用:预计需要多轮工具调用、耗时较长、且与当前主线相对独立的调研/产出任务(深度调研、长文撰写、批量处理)。何时不用:三五步就能完成的短任务,或必须拿到结果才能继续下一步的强耦合任务(直接同步执行)。派发后先继续其他工作,严禁空转等待。',
      parameters: {
        type: 'object',
        properties: {
          goal: {
            type: 'string',
            description:
              '子任务的完整指令。必须自包含:子任务看不到当前对话上下文,把必要的背景、目标、约束、期望的产出形式全部写清楚。',
          },
          title: {
            type: 'string',
            description: '子任务短标题(20 字以内,如「竞品 X 深度调研」),用于会话展示与完成通知',
          },
        },
        required: ['goal', 'title'],
      },
      execute: async ({ goal, title }: any) => {
        try {
          const goalText = String(goal || '').trim();
          if (!goalText) {
            return { success: false, error: 'goal 不能为空:子任务指令必须自包含(背景/目标/产出要求)' };
          }
          const titleText = (String(title || '').trim() || goalText).slice(0, BACKGROUND_TASK_TITLE_LIMIT);
          const inflight = hooks.countRunningChildren();
          if (inflight >= BACKGROUND_TASK_MAX_INFLIGHT) {
            return {
              success: false,
              error: `在飞后台子任务已达上限(${BACKGROUND_TASK_MAX_INFLIGHT} 个):等某个子任务完成后再派发,或本步直接同步执行。`,
            };
          }
          const { missionId } = await hooks.launch(goalText, titleText);
          return { success: true, childMissionId: missionId, title: titleText, hint: BACKGROUND_TASK_HINT };
        } catch (err: any) {
          return { success: false, error: `派发后台任务失败: ${err?.message || err}` };
        }
      },
    },
  ];
}
