/**
 * 列表行时间展示的统一口径(会话列表 / 巡航执行历史 / 记忆 / 技能 / 交付库 等共用)。
 *
 * 分级规则:今天只显示时分;当年跨天带月日;跨年再补年份。
 * 有效时间戳为 0 / NaN 时返回空串,交由调用方决定是否兜底展示。
 */

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

export function formatListTime(ts: number, now: number = Date.now()): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime()) || ts === 0) return '';
  const n = new Date(now);
  const hm = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  const sameDay =
    d.getFullYear() === n.getFullYear() &&
    d.getMonth() === n.getMonth() &&
    d.getDate() === n.getDate();
  if (sameDay) return hm;
  const md = `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  if (d.getFullYear() === n.getFullYear()) return `${md} ${hm}`;
  return `${d.getFullYear()}-${md} ${hm}`;
}

/** 完整日期时间(用于 title / tooltip,精确到秒)。 */
export function formatFullDateTime(ts: number): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime()) || ts === 0) return '';
  return d.toLocaleString('zh-CN', { hour12: false });
}
