import { Cron } from 'croner';

/**
 * 根据 Cron 表达式计算下一次执行时间（默认按东八区中国时区计算）
 */
export function getNextCronRun(pattern: string, timezone = 'Asia/Shanghai'): string | null {
  if (!pattern || typeof pattern !== 'string') return null;
  const trimmed = pattern.trim();
  try {
    const cron = new Cron(trimmed, { timezone });
    const next = cron.nextRun();
    return next ? next.toISOString() : null;
  } catch {
    // 降级尝试不传时区（使用宿主默认时区）
    try {
      const cron = new Cron(trimmed);
      const next = cron.nextRun();
      return next ? next.toISOString() : null;
    } catch {
      return null;
    }
  }
}

/**
 * 校验 Cron 表达式是否有效
 */
export function isValidCronPattern(pattern: string): boolean {
  if (!pattern || typeof pattern !== 'string') return false;
  try {
    const cron = new Cron(pattern.trim());
    return !!cron;
  } catch {
    return false;
  }
}

/**
 * 格式化任务下次触发时间展示
 */
export function formatCronNextRun(pattern: string, status: string = 'active', storedNextRun?: string): string {
  if (status !== 'active') {
    return '已暂停';
  }

  // 优先动态计算当前时间之后的下一次触发时间
  const nextIso = getNextCronRun(pattern);
  const targetDate = nextIso ? new Date(nextIso) : storedNextRun ? new Date(storedNextRun) : null;

  if (!targetDate || isNaN(targetDate.getTime())) {
    return '表达式待校验';
  }

  // 格式化为本地易读时间
  return targetDate.toLocaleString('zh-CN', {
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}
