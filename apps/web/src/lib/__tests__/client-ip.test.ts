import { describe, it, expect } from 'vitest';
import { extractClientIp } from '../client-ip';

/** 从普通对象造一个 Headers 视角(get 大小写不敏感语义由调用方保证,这里精确小写) */
function headers(obj: Record<string, string>): { get(name: string): string | null } {
  return { get: (name: string) => obj[name] ?? null };
}

describe('extractClientIp(来源 IP 提取,仅展示用)', () => {
  it('x-forwarded-for 取首跳(最左 = 原始客户端)', () => {
    expect(extractClientIp(headers({ 'x-forwarded-for': '203.0.113.7, 10.0.0.1' }))).toBe('203.0.113.7');
    expect(extractClientIp(headers({ 'x-forwarded-for': '  198.51.100.4  ' }))).toBe('198.51.100.4');
  });

  it('无 x-forwarded-for 时回退 x-real-ip', () => {
    expect(extractClientIp(headers({ 'x-real-ip': '192.0.2.9' }))).toBe('192.0.2.9');
  });

  it('IPv6 合法值通过(xff 首跳与 x-real-ip 均可)', () => {
    expect(extractClientIp(headers({ 'x-forwarded-for': '2001:db8::1' }))).toBe('2001:db8::1');
    expect(extractClientIp(headers({ 'x-real-ip': '::1' }))).toBe('::1');
  });

  it('畸形/伪造值拒绝:非法字符串、带端口括号、超长、空串 → 尝试下一候选或 null', () => {
    expect(extractClientIp(headers({ 'x-forwarded-for': 'not-an-ip' }))).toBeNull();
    expect(extractClientIp(headers({ 'x-forwarded-for': '[::1]:8080' }))).toBeNull();
    expect(extractClientIp(headers({ 'x-forwarded-for': 'x'.repeat(100) }))).toBeNull();
    expect(extractClientIp(headers({ 'x-forwarded-for': '' }))).toBeNull();
    // 首跳畸形但 x-real-ip 合法 → 回退
    expect(extractClientIp(headers({ 'x-forwarded-for': 'bogus', 'x-real-ip': '203.0.113.7' }))).toBe('203.0.113.7');
  });

  it('两个头都缺失(无反代直连)→ null', () => {
    expect(extractClientIp(headers({}))).toBeNull();
  });
});
