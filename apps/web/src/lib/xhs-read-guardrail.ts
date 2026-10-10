/**
 * 小红书只读数据工具的读侧护栏(scenario-loop P1)。
 *
 * 订阅任务无人值守地跑,若模型反复调 xhs_read_creator_data 会形成高频爬虫画像
 * (风控红线);读侧此前零限频零审计。护栏两级:
 * - 每任务导航上限(env 可调,默认 8):超限直接拒绝,提示模型「基于已有资料继续」;
 * - 同用户最小读间隔(env 可调,默认 3s):不拒绝,execute 侧等待后继续(节流不浪费模型步数)。
 *
 * 纯内存实现:状态挂在模块级单例上,进程重启即清零;两个 Map 写时裁剪到最近
 * 64 个键(任务/用户量级远小于此,滚动清理足够,无需挂 mission 生命周期钩子)。
 */

export interface ReadGuardrailLimits {
  /** 每任务允许的真实导航次数(超过即拒绝) */
  perMission: number;
  /** 同用户两次读取之间的最小间隔毫秒 */
  minIntervalMs: number;
}

export function readGuardrailLimits(): ReadGuardrailLimits {
  const per = Number(process.env.AGTPILOT_XHS_READ_PER_MISSION);
  const interval = Number(process.env.AGTPILOT_XHS_READ_MIN_INTERVAL_MS);
  return {
    perMission: Number.isFinite(per) && per > 0 ? Math.floor(per) : 8,
    minIntervalMs: Number.isFinite(interval) && interval >= 0 ? Math.floor(interval) : 3000,
  };
}

/** 纯函数:距上次读取的等待时长(0 = 无需等待)。供测试与 execute 复用 */
export function computeReadWaitMs(
  lastReadAt: number | undefined,
  now: number,
  minIntervalMs: number
): number {
  if (lastReadAt === undefined) return 0;
  const elapsed = now - lastReadAt;
  if (elapsed >= minIntervalMs) return 0;
  return minIntervalMs - elapsed;
}

export type ReadGuardrailCheck =
  | { allowed: true; waitMs: number; used: number; cap: number }
  | { allowed: false; used: number; cap: number; reason: string };

const OVER_CAP_REASON = (cap: number) =>
  `本任务浏览器读取已达上限(${cap} 次)。请基于已读取的资料与已有知识完成任务,不要再调用读取工具。`;

const MAP_CAP = 64;

export class ReadGuardrail {
  private limits: ReadGuardrailLimits;
  private taskCounts = new Map<string, number>();
  private userLastRead = new Map<string, number>();

  constructor(limits?: ReadGuardrailLimits) {
    this.limits = limits || readGuardrailLimits();
  }

  /**
   * 导航前检查:返回 allowed(+建议等待时长)或拒绝理由。
   * 只查不记 —— 计数只认真实导航(record),被拒/登录失败不烧上限。
   */
  check(taskId: string | undefined, userId: string, now = Date.now()): ReadGuardrailCheck {
    const key = taskId || 'adhoc';
    const used = this.taskCounts.get(key) || 0;
    if (used >= this.limits.perMission) {
      return { allowed: false, used, cap: this.limits.perMission, reason: OVER_CAP_REASON(this.limits.perMission) };
    }
    const waitMs = computeReadWaitMs(this.userLastRead.get(userId), now, this.limits.minIntervalMs);
    return { allowed: true, waitMs, used, cap: this.limits.perMission };
  }

  /** 真实导航发生后记录(计数 + 间隔时间戳);写时滚动裁剪 */
  record(taskId: string | undefined, userId: string, now = Date.now()): void {
    const key = taskId || 'adhoc';
    this.taskCounts.set(key, (this.taskCounts.get(key) || 0) + 1);
    if (this.taskCounts.size > MAP_CAP) {
      // Map 按插入序迭代,逐出最旧的键
      const oldest = this.taskCounts.keys().next().value;
      if (oldest !== undefined) this.taskCounts.delete(oldest);
    }
    this.userLastRead.set(userId, now);
    if (this.userLastRead.size > MAP_CAP) {
      const oldest = this.userLastRead.keys().next().value;
      if (oldest !== undefined) this.userLastRead.delete(oldest);
    }
  }

  /** 测试隔离用 */
  reset(): void {
    this.taskCounts.clear();
    this.userLastRead.clear();
  }
}

/** 应用级单例(同进程所有 mission 共享;测试用 buildXhsReadGuardrail 独立实例) */
const globalGuardrail = new ReadGuardrail();

export function buildXhsReadGuardrail(): ReadGuardrail {
  return globalGuardrail;
}
