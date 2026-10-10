/**
 * 工坊使用历史(本地 localStorage,按浏览器隔离)
 *
 * 支撑两件事:
 * 1. 「一键重跑」:卡片上直接用上次参数重新发起任务(周报/复盘是周期性高频场景);
 * 2. 表单回填:再次打开工坊时预填上次的选择,不用从头点一遍。
 * 只是便利性缓存,读不到(隐私窗口/被清理)时静默降级为全新表单,不影响功能。
 */

export interface WorkshopRunRecord {
  id: string;
  at: number;
  /** 任务标题(用于历史条目展示) */
  title: string;
  params: Record<string, unknown>;
}

const KEY = 'agtpilot.workshop.history.v1';
const MAX_RECORDS = 20;

function readAll(): WorkshopRunRecord[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as WorkshopRunRecord[]) : [];
  } catch {
    return [];
  }
}

function writeAll(records: WorkshopRunRecord[]) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(KEY, JSON.stringify(records.slice(0, MAX_RECORDS)));
  } catch {
    // 存储满/被禁用时静默
  }
}

export function recordRun(id: string, title: string, params: Record<string, unknown>) {
  writeAll([{ id, at: Date.now(), title, params }, ...readAll().filter((r) => r.id !== id)]);
}

export function lastRunOf(id: string): WorkshopRunRecord | null {
  return readAll().find((r) => r.id === id) || null;
}

export function recentRuns(limit = 3): WorkshopRunRecord[] {
  return readAll().slice(0, limit);
}

export function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天前`;
  return new Date(ts).toLocaleDateString('zh-CN');
}
