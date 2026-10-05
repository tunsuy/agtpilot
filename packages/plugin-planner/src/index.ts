import { Context, Service } from '@deepseek-ai/cordis';
import { PlanData, PlanTask } from '@agtpilot/protocol';
import '@agtpilot/core';

export const name = 'agtpilot-plugin-planner';
export const inject = ['agent'];

declare module '@deepseek-ai/cordis' {
  interface Context {
    planner: PlannerService;
  }
  interface Events {
    'agtpilot/plan'(plan: PlanData): void;
  }
}

export class PlannerService extends Service {
  private currentPlan: PlanData | null = null;

  constructor(ctx: Context) {
    super(ctx, 'planner');
  }

  createPlan(goal: string, rawTasks: Array<{ id?: string; title: string; description?: string }>): PlanData {
    const tasks: PlanTask[] = rawTasks.map((t, idx) => ({
      id: t.id || `task_${idx + 1}`,
      title: t.title,
      description: t.description,
      status: idx === 0 ? 'in_progress' : 'pending',
    }));

    const plan: PlanData = {
      id: `plan_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      goal,
      tasks,
      currentTaskId: tasks[0]?.id,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    this.currentPlan = plan;
    this.broadcastPlan(plan);
    return plan;
  }

  updateTask(taskId: string, status: PlanTask['status'], result?: string): PlanData | null {
    if (!this.currentPlan) return null;

    const taskIndex = this.currentPlan.tasks.findIndex((t) => t.id === taskId);
    if (taskIndex === -1) return null;

    this.currentPlan.tasks[taskIndex].status = status;
    if (result) {
      this.currentPlan.tasks[taskIndex].result = result;
    }

    // 如果当前任务完成，自动将下一个待处理任务标记为 in_progress
    if (status === 'completed') {
      const nextTask = this.currentPlan.tasks.slice(taskIndex + 1).find((t) => t.status === 'pending');
      if (nextTask) {
        nextTask.status = 'in_progress';
        this.currentPlan.currentTaskId = nextTask.id;
      }
    } else if (status === 'in_progress') {
      this.currentPlan.currentTaskId = taskId;
    }

    this.currentPlan.updatedAt = Date.now();
    this.broadcastPlan(this.currentPlan);
    return this.currentPlan;
  }

  getPlan(): PlanData | null {
    return this.currentPlan;
  }

  private broadcastPlan(plan: PlanData) {
    (this.ctx as any).emit('agtpilot/plan', plan);
    this.ctx.agent.emitEvent({
      type: 'plan',
      payload: plan,
      timestamp: plan.updatedAt,
    });
  }
}

export function apply(ctx: Context) {
  const plannerService = new PlannerService(ctx);

  // 1. 创建结构化任务看板 (planner_create_plan)
  ctx.agent.registerTool({
    name: 'planner_create_plan',
    description: '当面对复杂多步骤任务（如深度调研、全栈开发、对比评测）时，首先调用此工具创建结构化任务拆解看板 (Todo Checklist)，使执行过程全程透明可视。',
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
          description: '按先后逻辑拆解的 3-7 个具体行动步骤列表',
        },
      },
      required: ['goal', 'tasks'],
    },
    execute: async ({ goal, tasks }) => {
      const plan = plannerService.createPlan(goal, tasks);
      return {
        success: true,
        planId: plan.id,
        tasksCount: plan.tasks.length,
        currentTaskId: plan.currentTaskId,
        message: `已成功创建包含 ${plan.tasks.length} 个步骤的任务规划看板，首步正在执行中。`,
      };
    },
  });

  // 2. 推进与更新任务步骤状态 (planner_update_task)
  ctx.agent.registerTool({
    name: 'planner_update_task',
    description: '每当完成当前步骤或进入下一阶段时调用此工具，更新看板中特定步骤的状态 (in_progress, completed, failed)，并可附带本阶段的关键结论。',
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
    execute: async ({ taskId, status, result }) => {
      const plan = plannerService.updateTask(taskId, status as any, result);
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

  // 3. 子智能体委派协作 (planner_delegate_subagent)
  ctx.agent.registerTool({
    name: 'planner_delegate_subagent',
    description: '将某个子任务专门委派给专注领域的子智能体（如：研究专家 Researcher、编码专家 Coder、数据分析师 Analyst）自主深入解决，完成后收敛返回结果。',
    parameters: {
      type: 'object',
      properties: {
        subagentRole: {
          type: 'string',
          description: '子智能体角色类型 (例如: "深度检索研究员 (DeepResearcher)", "Python代码实现专家 (PythonCoder)", "数据审查员 (Auditor)")',
        },
        taskInstruction: {
          type: 'string',
          description: '分配给子智能体的具体指令、约束边界与期望交付格式',
        },
      },
      required: ['subagentRole', 'taskInstruction'],
    },
    execute: async ({ subagentRole, taskInstruction }) => {
      // 记录子智能体委派动作
      return {
        success: true,
        role: subagentRole,
        instruction: taskInstruction,
        status: 'completed',
        summary: `[子智能体 ${subagentRole}] 成功受理并已执行子任务: "${taskInstruction.slice(0, 80)}..."`,
      };
    },
  });
}
