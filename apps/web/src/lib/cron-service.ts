import { getUserCronJobs, saveUserCronJob, deleteUserCronJob } from './user-store';
import { isValidCronPattern, getNextCronRun } from './cron-utils';

/**
 * 用户级定时巡航工具(cron_ 前缀,taskTools 注入)。
 *
 * plugin-cron 已重塑为无头调度引擎(只管 cron 表达式触发,不管存储/执行/工具),
 * 这里补齐应用层三件事:
 * - 持久化:读写 user-store 该用户空间(多用户互不可见)
 * - 执行:经 hooks.register 挂进 AgentBackend 的调度池(闭包捕获 userId → runMission)
 * - 工具:cron_task(action=schedule|list|cancel)(与插件路由规则的前缀约定一致)
 *
 * 模型经该工具创建的任务与用户在 UI cron 管理页创建的任务走同一套存储与调度器,
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
      name: 'cron_task',
      description:
        '当前用户的自主定时/周期性任务(Cron Job)管理。action=schedule:设置定时主动执行任务,例如"每天早上9点搜索AI论文""每小时检查某系统状态并告警",Agent 会在后台无人值守自动唤醒执行;action=list:查看已激活的全部定时任务、执行次数与下次触发时间;action=cancel:按 jobId 取消任务,停止后续自动触发。任务归当前用户所有,可在其定时任务管理页查看与调整。',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['schedule', 'list', 'cancel'],
            description: 'schedule = 创建定时任务;list = 列出任务;cancel = 取消任务',
          },
          name: { type: 'string', description: 'action=schedule:定时任务名称 (如: "每日GitHub趋势早报")' },
          cronPattern: {
            type: 'string',
            description: 'action=schedule:标准 5 位 Cron 表达式 (如: "0 9 * * *" 每天9点, "*/30 * * * *" 每30分钟)',
          },
          taskPrompt: { type: 'string', description: 'action=schedule:触发时自动派发给 Agent 执行的完整自然语言任务指令' },
          jobId: { type: 'string', description: 'action=cancel:要取消的定时任务 ID' },
        },
        required: ['action'],
      },
      execute: async (args: any) => {
        const action = String(args?.action || '');
        if (action === 'schedule') {
          try {
            const pattern = String(args.cronPattern || '').trim();
            const name = String(args.name || '').trim();
            const taskPrompt = String(args.taskPrompt || '').trim();
            if (!name || !pattern || !taskPrompt) {
              return { success: false, error: 'action=schedule 需要 name、cronPattern 与 taskPrompt' };
            }
            if (!isValidCronPattern(pattern)) {
              return { success: false, error: `无效的 Cron 表达式: ${pattern}（标准 5 位格式，如 "0 9 * * *"）` };
            }
            const job = {
              id: `cron_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
              name,
              pattern,
              prompt: taskPrompt,
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
        }
        if (action === 'list') {
          const jobs = getUserCronJobs(userId).filter((j: any) => j.status !== 'cancelled');
          return { success: true, total: jobs.length, tasks: jobs };
        }
        if (action === 'cancel') {
          const jobId = String(args?.jobId || '');
          if (!jobId) return { success: false, error: 'action=cancel 需要 jobId' };
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
        }
        return { success: false, error: `action 无效: ${action}（可选 schedule / list / cancel）` };
      },
    },
  ];
}
