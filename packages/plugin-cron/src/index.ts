import { Context, Service } from '@deepseek-ai/cordis';
import { Cron } from 'croner';
import '@agtpilot/core';

export const name = 'agtpilot-plugin-cron';

/**
 * 无头调度引擎（headless scheduling engine）。
 *
 * 只提供"能力"：cron 表达式解析、定时触发、注销。三件事刻意不做：
 * - 不做持久化（存哪、谁可见是应用层的事 —— Web 存 user-store，CLI 可存本地文件）
 * - 不做执行（触发后干什么、以谁的身份跑，由注册方注入 onFire 回调闭包捕获）
 * - 不注册工具（工具暴露给谁、参数怎么定义由应用层决定 —— Web 用 taskTools
 *   注入用户级同名工具，CLI 自行包装全局工具）
 *
 * 这是 ARCHITECTURE.md「插件是能力提供者，不是策略所有者」的正面样板。
 */
export const inject = ['agent'];

declare module '@deepseek-ai/cordis' {
  interface Context {
    cron: CronService;
  }
}

export class CronService extends Service {
  private jobs: Map<string, { job: Cron; onFire: () => Promise<void> }> = new Map();

  constructor(ctx: Context) {
    super(ctx, 'cron');
  }

  /**
   * 注册（或重新注册）一个调度任务。同 id 重复注册自动替换旧调度。
   * 触发时只调用 onFire —— 执行什么、以谁的身份执行，全由回调决定。
   */
  register(id: string, pattern: string, onFire: () => Promise<void>, timezone = 'Asia/Shanghai'): boolean {
    try {
      this.cancel(id);
      const job = new Cron(pattern, { timezone }, async () => {
        try {
          await onFire();
        } catch (err: any) {
          console.error(`[plugin-cron] 任务 ${id} 触发回调异常:`, err?.message || err);
        }
      });
      this.jobs.set(id, { job, onFire });
      return true;
    } catch (e: any) {
      console.error(`[plugin-cron] 注册任务 ${id} 失败（表达式 "${pattern}"）:`, e?.message || e);
      return false;
    }
  }

  /** 注销调度（不删除调用方自己持久化的任务信息） */
  cancel(id: string): boolean {
    const entry = this.jobs.get(id);
    if (!entry) return false;
    try {
      entry.job.stop();
    } catch {
      // 容错
    }
    this.jobs.delete(id);
    return true;
  }

  /** 下一次触发时间（未注册返回 null） */
  nextRun(id: string): string | null {
    const entry = this.jobs.get(id);
    if (!entry) return null;
    return entry.job.nextRun()?.toISOString() ?? null;
  }

  /** 当前在调度的任务 id 列表 */
  activeIds(): string[] {
    return Array.from(this.jobs.keys());
  }
}

export function apply(ctx: Context) {
  new CronService(ctx);

  // 工具路由自注册照旧保留：路由只声明"定时/提醒类 prompt → 挂载 cron_ 前缀工具"，
  // 工具本体由应用层提供（Web 的用户级 taskTools / CLI 的全局包装，均用 cron_ 前缀）
  ctx.agent.registerToolRoute({
    id: 'cron',
    prefixes: ['cron_'],
    test: /(定时|每天|每小时|每周|每晚|提醒|cron|schedule|remind)/i,
  });
}
