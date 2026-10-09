import { Context, Service } from '@deepseek-ai/cordis';
import { PlanData, PlanTask } from '@agtpilot/protocol';
import type { PlannerNotifier } from '@agtpilot/core';
import '@agtpilot/core';

export const name = 'agtpilot-plugin-planner';
export const inject = ['agent'];

// Context.planner 的类型声明在 core（PlannerNotifier，依赖倒置）：
// 内核只需要 noteToolResult；本服务的完整 API（createPlan 等）留在插件内部。

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
    if (this.plans.length > 20) this.plans.shift(); // 控制内存
    this.broadcastPlan(plan);
    return plan;
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

    // 如果当前任务完成，自动将下一个待处理任务标记为 in_progress
    if (status === 'completed') {
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
   * 看板自动推进（由 core Orchestrator 在工具执行成功后调用）：
   * 真实工具成功即视为当前 in_progress 步骤完成。模型不再需要为"汇报进度"
   * 单独花一轮调用 planner_update_task —— 每个阶段一次汇报调用曾是步数
   * 膨胀的最大来源。元工具（看板/记忆）不触发推进。
   */
  noteToolResult(taskKey: string, toolName: string) {
    if (/^(planner_|memory_)/.test(toolName)) return;
    const plan = this.planFor(taskKey);
    if (!plan) return;
    const current = plan.tasks.find((t) => t.id === plan.currentTaskId && t.status === 'in_progress');
    if (current) {
      this.updateTask(current.id, 'completed', `${current.title}（由工具 ${toolName} 完成推进）`, taskKey);
    }
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
      '仅当任务确实需要多个异构动作（如"检索 + 浏览网页 + 生成图表"）时才调用，为执行过程建立可视化的任务看板。' +
      '简单任务（单次搜索、单次问答、两步以内的操作）【不要】建看板，直接执行即可。' +
      '步骤数量按真实必要动作数拆解，严禁为凑数拆步骤。',
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
        message: `已创建包含 ${plan.tasks.length} 个步骤的任务看板。看板状态由系统随工具执行自动推进，无需另行汇报进度，请直接开始执行首步。`,
      };
    },
  });

  // 2. 修正看板状态 (planner_update_task) —— 正常推进无需调用；基线工具
  ctx.agent.registerTool({
    name: 'planner_update_task',
    baseline: true,
    description:
      '仅在需要显式修正看板状态时调用（如某步骤确认无法完成需标记 failed、或需回退状态）。' +
      '看板会随工具执行成功【自动推进】，正常完成步骤、进入下一阶段都【不需要】调用本工具 —— 请直接执行下一步动作。',
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
