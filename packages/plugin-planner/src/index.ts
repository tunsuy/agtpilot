import { Context, Service } from '@deepseek-ai/cordis';
import { PlanData, PlanTask } from '@agtpilot/protocol';
import type { PlannerNotifier } from '@agtpilot/core';
import '@agtpilot/core';

export const name = 'agtpilot-plugin-planner';
export const inject = ['agent'];

// Context.planner 的类型声明在 core（PlannerNotifier，依赖倒置）：
// 内核只需要 boardLagNotice（滞后催促文本）；本服务的完整 API（createPlan 等）留在插件内部。

declare module '@deepseek-ai/cordis' {
  interface Events {
    'agtpilot/plan'(plan: PlanData): void;
  }
}

export class PlannerService extends Service implements PlannerNotifier {
  /** 计划按任务键（orchestrator taskId）隔离：多用户并发任务各自持有独立看板，互不串台 */
  private plans: Array<PlanData & { taskKey?: string }> = [];

  constructor(ctx: Context) {
    super(ctx, 'planner');
  }

  createPlan(goal: string, rawTasks: Array<{ id?: string; title: string; description?: string }>, taskKey?: string): PlanData {
    const tasks: PlanTask[] = rawTasks.map((t, idx) => ({
      id: t.id || `task_${idx + 1}`,
      title: t.title,
      description: t.description,
      status: idx === 0 ? 'in_progress' : 'pending',
    }));

    const plan: PlanData & { taskKey?: string } = {
      id: `plan_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      goal,
      tasks,
      currentTaskId: tasks[0]?.id,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    if (taskKey) {
      plan.taskKey = taskKey;
      // 同一任务的旧计划作废（模型可能重建看板）
      this.plans = this.plans.filter((p) => p.taskKey !== taskKey);
    }

    this.plans.push(plan);
    this.evictStale();
    this.broadcastPlan(plan);
    return plan;
  }

  /**
   * 容量控制（>20 时淘汰）：优先淘汰「已全部完结且最久未更新」的计划 ——
   * 旧实现直接 shift 掉最旧的，活跃看板也会被逐出，任务中途看板凭空消失。
   */
  private evictStale() {
    while (this.plans.length > 20) {
      const candidates = this.plans
        .map((p, i) => ({ p, i }))
        .filter(({ p }) => !p.tasks.some((t) => t.status === 'in_progress' || t.status === 'pending'));
      if (candidates.length === 0) break; // 全部活跃：宁可超限也不逐出活跃看板
      const victim = candidates.reduce((a, b) => (a.p.updatedAt <= b.p.updatedAt ? a : b));
      this.plans.splice(victim.i, 1);
    }
  }

  updateTask(taskId: string, status: PlanTask['status'], result?: string, taskKey?: string): PlanData | null {
    const plan = this.planFor(taskKey);
    if (!plan) return null;

    const taskIndex = plan.tasks.findIndex((t) => t.id === taskId);
    if (taskIndex === -1) return null;

    plan.tasks[taskIndex].status = status;
    if (result) {
      plan.tasks[taskIndex].result = result;
    }

    // 当前任务完成或确认失败，都推进到下一个待处理任务 ——
    // 只处理 completed 会让 failed 后 currentTaskId 悬停，看板冻结
    if (status === 'completed' || status === 'failed') {
      const nextTask = plan.tasks.slice(taskIndex + 1).find((t) => t.status === 'pending');
      if (nextTask) {
        nextTask.status = 'in_progress';
        plan.currentTaskId = nextTask.id;
      }
    } else if (status === 'in_progress') {
      plan.currentTaskId = taskId;
    }

    plan.updatedAt = Date.now();
    this.broadcastPlan(plan);
    return plan;
  }

  getPlan(taskKey?: string): PlanData | null {
    return this.planFor(taskKey);
  }

  /**
   * 看板滞后提醒（由 core Orchestrator 在滞后达阈值时调用）：看板进度由
   * 模型显式申报维护（planner_update_task 与实际工具调用同批发出 ——
   * Claude Code TodoWrite / Codex update_plan 同款契约，2026-10 切换，
   * 取代旧的「工具成功自动推进」推断：推断猜不准语义事件，纯写作步骤
   * 永远推不动、并行轮跳步、审批冻结期整条冻结）。模型忘了申报时，这里
   * 给出带当前步骤上下文的催促文本，注入下一轮让模型当轮补报 ——
   * 「忘了」是一次性事件而不是静默漂移。
   */
  boardLagNotice(taskKey: string, idleRounds: number): string | null {
    const plan = this.planFor(taskKey);
    if (!plan) return null;
    const current = plan.tasks.find((t) => t.id === plan.currentTaskId && t.status === 'in_progress');
    if (!current) return null; // 无进行中步骤(全完结/全失败):没有可同步的进度
    return (
      `看板已 ${idleRounds} 轮未随进度更新：当前步骤「${current.title}」仍为进行中，但真实工具已连续执行成功。` +
      '请在本轮工具调用【同一批】里附带 planner_update_task 同步看板：已完成的步骤标 completed 并附一句话成果，新开始的步骤标 in_progress。' +
      '不要为汇报单独花一轮。'
    );
  }

  private planFor(taskKey?: string): (PlanData & { taskKey?: string }) | null {
    if (taskKey) {
      return this.plans.find((p) => p.taskKey === taskKey) ?? null;
    }
    // 未指定任务键时作用于最近创建的计划（兼容历史调用方式）
    return this.plans[this.plans.length - 1] ?? null;
  }

  private broadcastPlan(plan: PlanData) {
    this.ctx.emit('agtpilot/plan', plan);
    this.ctx.agent.emitEvent({
      type: 'plan',
      payload: plan,
      timestamp: plan.updatedAt,
    });
  }
}

export function apply(ctx: Context) {
  const plannerService = new PlannerService(ctx);

  // 1. 创建结构化任务看板 (planner_create_plan) —— 基线工具：路由启用时也始终挂载
  ctx.agent.registerTool({
    name: 'planner_create_plan',
    baseline: true,
    description:
      '任务涉及多个异构动作（如"检索 + 浏览网页 + 生成图表"）或用户一条消息提出多个事项时调用，在开始执行第一个动作【之前】为执行过程建立可视化的任务看板 —— 看板要在动手前立起来，不要执行到一半才补建。' +
      '简单任务（单次搜索、单次问答、两步以内的操作）【不要】建看板，直接执行即可。' +
      '步骤数量按真实必要动作数拆解，严禁为凑数拆步骤。' +
      '执行中发现原计划不成立（检索为空/路径失败）或用户目标变化时，可再次调用以重建看板 —— 同一任务重建会自动替换旧看板。',
    parameters: {
      type: 'object',
      properties: {
        goal: { type: 'string', description: '本次复杂任务的最终总目标' },
        tasks: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: '任务简短序号标识 (如: step_1, step_2)' },
              title: { type: 'string', description: '该步骤的清晰标题 (如: "全网检索最新AI开源项目")' },
              description: { type: 'string', description: '该步骤要执行的详细工作与预期产出' },
            },
            required: ['title'],
          },
          description: '按真实必要动作数拆解的步骤列表（宁少勿多）',
        },
      },
      required: ['goal', 'tasks'],
    },
    execute: async ({ goal, tasks }, session?: any) => {
      const plan = plannerService.createPlan(goal, tasks, session?.taskId);
      return {
        success: true,
        planId: plan.id,
        tasksCount: plan.tasks.length,
        currentTaskId: plan.currentTaskId,
        message: `已创建包含 ${plan.tasks.length} 个步骤的任务看板。看板状态由你维护：步骤完成的当轮在与实际工具调用同一批里调用 planner_update_task 标记 completed（附一句话成果），开始新步骤时同批标记 in_progress —— 不要为汇报单独花一轮。`,
      };
    },
  });

  // 2. 看板状态更新 (planner_update_task) —— 常规进度通道；基线工具
  ctx.agent.registerTool({
    name: 'planner_update_task',
    baseline: true,
    description:
      '看板进度的常规更新通道：一个步骤完成时【立即】标记 completed（附一句话成果），开始新步骤时标记 in_progress，一次保持恰好一个 in_progress、做完即勾不攒批。' +
      '更新永远与当轮的实际工具调用【同一批】并行发出，严禁为汇报单独花一轮（这是步数膨胀的老路）。' +
      '计划需要整体改向或重排步骤时，直接用 planner_create_plan 重建看板（同任务自动替换），不要用本工具逐条搬移状态。',
    parameters: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: '要更新的任务 ID (如: step_1)' },
        status: {
          type: 'string',
          enum: ['pending', 'in_progress', 'completed', 'failed'],
          description: '新的任务状态',
        },
        result: { type: 'string', description: '可选，该步骤取得的阶段性产出或关键发现摘要' },
      },
      required: ['taskId', 'status'],
    },
    execute: async ({ taskId, status, result }, session?: any) => {
      const plan = plannerService.updateTask(taskId, status as any, result, session?.taskId);
      if (!plan) {
        return { success: false, error: `未找到指定任务 ID [${taskId}] 或尚未初始化规划看板。` };
      }
      return {
        success: true,
        taskId,
        status,
        currentActiveTaskId: plan.currentTaskId,
        message: `步骤 [${taskId}] 状态已更新为 [${status}]。`,
      };
    },
  });
}
