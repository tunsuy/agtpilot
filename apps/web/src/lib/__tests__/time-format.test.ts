import { describe, it, expect } from 'vitest';
import { formatListTime, formatFullDateTime } from '../time-format';

describe('formatListTime', () => {
  // 用本地时间构造,避免测试受时区影响
  const now = new Date(2026, 10, 11, 15, 30).getTime(); // 2026-11-11 15:30

  it('当天只显示时分', () => {
    const ts = new Date(2026, 10, 11, 9, 5).getTime();
    expect(formatListTime(ts, now)).toBe('09:05');
  });

  it('当年跨天带月日与时分', () => {
    const ts = new Date(2026, 2, 3, 8, 0).getTime(); // 2026-03-03
    expect(formatListTime(ts, now)).toBe('03-03 08:00');
  });

  it('跨年带年份', () => {
    const ts = new Date(2025, 11, 31, 23, 59).getTime(); // 2025-12-31
    expect(formatListTime(ts, now)).toBe('2025-12-31 23:59');
  });

  it('非法时间戳返回空串', () => {
    expect(formatListTime(0, now)).toBe('');
    expect(formatListTime(NaN, now)).toBe('');
  });
});

describe('formatFullDateTime', () => {
  it('非法时间戳返回空串', () => {
    expect(formatFullDateTime(0)).toBe('');
    expect(formatFullDateTime(NaN)).toBe('');
  });

  it('合法时间戳返回非空', () => {
    expect(formatFullDateTime(new Date(2026, 10, 11, 9, 5, 3).getTime())).not.toBe('');
  });
});
