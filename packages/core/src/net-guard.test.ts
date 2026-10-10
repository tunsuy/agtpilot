import { describe, it, expect } from 'vitest';
import { isPrivateOrReservedIp, guardUrlHost } from './net-guard';

describe('isPrivateOrReservedIp', () => {
  it('拦截 IPv4 私网/保留段', () => {
    const blocked = [
      '0.0.0.0',
      '10.0.0.1',
      '10.255.255.255',
      '127.0.0.1',
      '127.255.0.1',
      '169.254.169.254', // 云元数据端点
      '169.254.0.1',
      '100.64.0.1', // CGNAT
      '100.127.255.255',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.0.1',
      '192.0.2.1', // TEST-NET-1
      '198.51.100.1', // TEST-NET-2
      '203.0.113.1', // TEST-NET-3
      '224.0.0.1', // 组播
      '240.0.0.1', // 保留
      '255.255.255.255',
    ];
    for (const ip of blocked) {
      expect(isPrivateOrReservedIp(ip), ip).toBe(true);
    }
  });

  it('放行公网 IPv4', () => {
    const allowed = ['8.8.8.8', '1.1.1.1', '172.15.0.1', '172.32.0.1', '100.63.0.1', '100.128.0.1', '192.167.0.1', '93.184.216.34'];
    for (const ip of allowed) {
      expect(isPrivateOrReservedIp(ip), ip).toBe(false);
    }
  });

  it('拦截 IPv6 回环/ULA/链路本地/IPv4-mapped 私网', () => {
    const blocked = ['::1', '::', 'fc00::1', 'fd12:3456::1', 'fe80::1', '::ffff:10.0.0.1', '::ffff:169.254.169.254'];
    for (const ip of blocked) {
      expect(isPrivateOrReservedIp(ip), ip).toBe(true);
    }
  });

  it('放行公网 IPv6 与 IPv4-mapped 公网', () => {
    expect(isPrivateOrReservedIp('2001:4860:4860::8888')).toBe(false);
    expect(isPrivateOrReservedIp('::ffff:8.8.8.8')).toBe(false);
  });

  it('非法输入按拒绝处理(fail closed)', () => {
    expect(isPrivateOrReservedIp('not-an-ip')).toBe(true);
    expect(isPrivateOrReservedIp('')).toBe(true);
  });
});

describe('guardUrlHost', () => {
  const lookupPrivate = async (_host: string) => ['10.1.2.3'];
  const lookupPublic = async (_host: string) => ['93.184.216.34'];
  const lookupMixed = async (_host: string) => ['93.184.216.34', '127.0.0.1'];

  it('仅允许 http/https', async () => {
    expect((await guardUrlHost('file:///etc/passwd', lookupPublic)).ok).toBe(false);
    expect((await guardUrlHost('ftp://example.com/x', lookupPublic)).ok).toBe(false);
    expect((await guardUrlHost('http://example.com/x', lookupPublic)).ok).toBe(true);
    expect((await guardUrlHost('https://example.com/x', lookupPublic)).ok).toBe(true);
  });

  it('字面量私网 IP 直接拒绝(不走 DNS)', async () => {
    const r = await guardUrlHost('http://169.254.169.254/latest/meta-data/', lookupPublic);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('private');
  });

  it('localhost 主机名直接拒绝', async () => {
    const r = await guardUrlHost('http://localhost:3000/api', lookupPublic);
    expect(r.ok).toBe(false);
  });

  it('域名解析到私网地址时拒绝', async () => {
    const r = await guardUrlHost('https://internal.corp/api', lookupPrivate);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('private');
  });

  it('多地址解析中混有私网时拒绝(DNS rebinding 缓解)', async () => {
    const r = await guardUrlHost('https://mixed.example.com/', lookupMixed);
    expect(r.ok).toBe(false);
  });

  it('公网域名放行并回传 hostname', async () => {
    const r = await guardUrlHost('https://api.exa.ai/search', lookupPublic);
    expect(r.ok).toBe(true);
    expect(r.hostname).toBe('api.exa.ai');
  });

  it('非法 URL 拒绝', async () => {
    expect((await guardUrlHost('::::', lookupPublic)).ok).toBe(false);
  });
});
