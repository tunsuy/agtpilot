import { Context, Service } from '@deepseek-ai/cordis';
import { Cron } from 'croner';
import '@agtpilot/core';

export const name = 'agtpilot-plugin-cron';
export const inject = ['agent', 'orchestrator'];

export interface ScheduledJobInfo {
  id: string;
  name: string;
  pattern: string;
  prompt: string;
  nextRun?: string;
  runCount: number;
  lastRunAt?: number;
  status: 'active' | 'paused' | 'cancelled';
}

export class CronService extends Service {
  private jobs: Map<string, { job: Cron; info: ScheduledJobInfo }> = new Map();

  constructor(ctx: Context) {
    super(ctx, 'cron');
  }

  schedule(name: string, pattern: string, prompt: string): ScheduledJobInfo {
    const id = `cron_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

    const info: ScheduledJobInfo = {
      id,
      name,
      pattern,
      prompt,
      runCount: 0,
      status: 'active',
    };

    const cronJob = new Cron(pattern, { timezone: 'Asia/Shanghai' }, async () => {
      info.runCount++;
      info.lastRunAt = Date.now();
      info.nextRun = cronJob.nextRun()?.toISOString();

      // 自主唤醒智能体执行任务
      try {
        await this.ctx.orchestrator.runTask({
          prompt: `【定时巡检主动触发 - ${info.name}】: ${info.prompt}`,
        });
      } catch (err) {
        // 容错记录
      }
    });

    info.nextRun = cronJob.nextRun()?.toISOString();
    this.jobs.set(id, { job: cronJob, info });

    return info;
  }

  cancel(id: string): boolean {
    const entry = this.jobs.get(id);
    if (!entry) return false;

    entry.job.stop();
    entry.info.status = 'cancelled';
    this.jobs.delete(id);
    return true;
  }

  list(): ScheduledJobInfo[] {
    return Array.from(this.jobs.values()).map(({ job, info }) => ({
      ...info,
      nextRun: job.nextRun()?.toISOString(),
    }));
  }
}

export function apply(ctx: Context) {
  const cronService = new CronService(ctx);

  // 1. 创建定时主动巡检任务 (cron_schedule_task)
  ctx.agent.registerTool({
    name: 'cron_schedule_task',
    description: '设置自主定时/周期性主动执行任务 (Cron Job)。例如："每天早上9点搜索AI论文"、"每小时检查某系统状态并告警"。Agent 会在后台无人值守自动唤醒执行。',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '定时任务名称 (如: "每日GitHub趋势早报", "系统健康巡检")' },
        cronPattern: {
          type: 'string',
          description: '标准 5 位 Cron 表达式 (如: "0 9 * * *" 表示每天9点, "*/30 * * * *" 表示每30分钟)',
        },
        taskPrompt: { type: 'string', description: '触发时自动派发给 Agent 执行的完整自然语言任务指令' },
      },
      required: ['name', 'cronPattern', 'taskPrompt'],
    },
    execute: async ({ name, cronPattern, taskPrompt }) => {
      try {
        const info = cronService.schedule(name, cronPattern, taskPrompt);
        return {
          success: true,
          jobId: info.id,
          name: info.name,
          pattern: info.pattern,
          nextRun: info.nextRun,
          message: `已成功安排定时巡检任务 [${info.name}]，下次预计执行时间: ${info.nextRun || '未知'}。`,
        };
      } catch (err: any) {
        return {
          success: false,
          error: `创建定时任务失败: ${err.message}`,
        };
      }
    },
  });

  // 2. 列出正在运行的所有定时任务 (cron_list_tasks)
  ctx.agent.registerTool({
    name: 'cron_list_tasks',
    description: '查看当前后台已激活的所有定时巡检任务列表、执行次数与下一次触发时间。',
    parameters: {
      type: 'object',
      properties: {},
    },
    execute: async () => {
      const tasks = cronService.list();
      return {
        success: true,
        total: tasks.length,
        tasks,
      };
    },
  });

  // 3. 取消定时任务 (cron_cancel_task)
  ctx.agent.registerTool({
    name: 'cron_cancel_task',
    description: '取消已登记的定时巡检任务，停止后续自动触发。',
    parameters: {
      type: 'object',
      properties: {
        jobId: { type: 'string', description: '要取消的定时任务 ID' },
      },
      required: ['jobId'],
    },
    execute: async ({ jobId }) => {
      const ok = cronService.cancel(jobId);
      return {
        success: ok,
        message: ok ? `任务 [${jobId}] 已成功取消并停止。` : `未找到 ID 为 [${jobId}] 的定时任务。`,
      };
    },
  });
}
