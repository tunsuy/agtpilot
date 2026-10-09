import { getUserCronJobs, saveUserCronJob, deleteUserCronJob } from './user-store';
import { isValidCronPattern, getNextCronRun } from './cron-utils';

/**
 * 用户级定时巡航工具（cron_ 前缀，taskTools 注入）。
 *
 * plugin-cron 已重塑为无头调度引擎（只管 cron 表达式触发，不管存储/执行/工具），
 * 这里补齐应用层三件事：
 * - 持久化：读写 user-store 该用户空间（多用户互不可见）
 * - 执行：经 hooks.register 挂进 AgentBackend 的调度池（闭包捕获 userId → runMission）
 * - 工具：cron_schedule_task / cron_list_tasks / cron_cancel_task（与插件路由规则的前缀约定一致）
 *
 * 模型经这三个工具创建的任务与用户在 UI cron 管理页创建的任务走同一套存储与调度器，
 * 彻底消除「工具路径进全局 .cache、UI 路径进 user-store」的双轨分裂。
 */

export interface UserCronHooks {
  /** 把任务挂进调度池（AgentBackend.registerUserCronJob，闭包已捕获 userId） */
  register: (userId: string, job: any) => void;
  /** 从调度池注销 */
  unregister: (jobId: string) => void;
}

export function buildUserCronTools(userId: string, hooks: UserCronHooks): any[] {
  return [
    {
      name: 'cron_schedule_task',
      description:
        '为当前用户设置自主定时/周期性主动执行任务 (Cron Job)。例如："每天早上9点搜索AI论文"、"每小时检查某系统状态并告警"。Agent 会在后台无人值守自动唤醒执行。创建的任务归当前用户所有，可在其定时任务管理页查看与调整。',
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
      execute: async ({ name, cronPattern, taskPrompt }: any) => {
        try {
          const pattern = String(cronPattern).trim();
          if (!isValidCronPattern(pattern)) {
            return { success: false, error: `无效的 Cron 表达式: ${pattern}（标准 5 位格式，如 "0 9 * * *"）` };
          }
          const job = {
            id: `cron_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
            name: String(name).trim(),
            pattern,
            prompt: String(taskPrompt).trim(),
            status: 'active',
            runCount: 0,
            createdAt: Date.now(),
            nextRun: getNextCronRun(pattern) || undefined,
          };
          saveUserCronJob(userId, job);
          hooks.register(userId, job);
          return {
            success: true,
            jobId: job.id,
            name: job.name,
            pattern: job.pattern,
            nextRun: job.nextRun,
            message: `已成功为当前用户安排定时巡检任务 [${job.name}]，下次预计执行时间: ${job.nextRun || '未知'}。`,
          };
        } catch (err: any) {
          return { success: false, error: `创建定时任务失败: ${err.message}` };
        }
      },
    },
    {
      name: 'cron_list_tasks',
      description: '查看当前用户后台已激活的所有定时巡检任务列表、执行次数与下一次触发时间。',
      parameters: { type: 'object', properties: {} },
      execute: async () => {
        const jobs = getUserCronJobs(userId).filter((j: any) => j.status !== 'cancelled');
        return { success: true, total: jobs.length, tasks: jobs };
      },
    },
    {
      name: 'cron_cancel_task',
      description: '取消当前用户已登记的定时巡检任务，停止后续自动触发。',
      parameters: {
        type: 'object',
        properties: { jobId: { type: 'string', description: '要取消的定时任务 ID' } },
        required: ['jobId'],
      },
      execute: async ({ jobId }: any) => {
        const jobs = getUserCronJobs(userId);
        const job = jobs.find((j: any) => j.id === jobId);
        if (!job) {
          return { success: false, error: `当前用户名下未找到 ID 为 [${jobId}] 的定时任务。` };
        }
        job.status = 'cancelled';
        job.cancelledAt = Date.now();
        saveUserCronJob(userId, job);
        hooks.unregister(String(jobId));
        return { success: true, message: `任务 [${job.name}] 已成功取消并停止。` };
      },
    },
  ];
}
