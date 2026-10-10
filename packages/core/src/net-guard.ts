/**
 * 出站网络围栏(Net Guard)—— 私网/保留地址拦截
 *
 * 设计依据 docs/design/sandbox-control-hardening.md §4.1(借鉴 OpenShell
 * 的网络出站管控模式,但不引入常驻代理进程):
 * - 所有由宿主进程代发的 HTTP 出站(sandbox_http_request)必须先过 guardUrlHost;
 * - 校验发生在 DNS 解析之后(逐个地址判私网),不是仅对 hostname 做字符串匹配 ——
 *   `http://169.254.169.254`(云元数据端点)与解析到内网的域名一律拒绝;
 * - fail closed: 非法 IP / 非法 URL / 解析失败都按拒绝处理。
 *
 * 诚实限制(见设计文档 §3):DNS rebinding TOCTOU 未根治(guard 与 fetch 是两次
 * 解析);重定向由调用方逐跳重新调用本模块缓解。
 */
import { lookup as dnsLookup } from 'node:dns/promises';

/** 可注入的 DNS 解析函数(测试注入假解析,生产走 node:dns) */
export type HostLookup = (hostname: string) => Promise<string[]>;

const defaultLookup: HostLookup = async (hostname) => {
  const records = await dnsLookup(hostname, { all: true, verbatim: true });
  return records.map((r) => r.address);
};

function parseIpv4(ip: string): number[] | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const n = Number(p);
    if (n > 255) return null;
    octets.push(n);
  }
  return octets;
}

function isPrivateIpv4(ip: string): boolean {
  const o = parseIpv4(ip);
  if (!o) return true; // 非法 IPv4 → fail closed
  const [a, b] = o;
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 10) return true; // 10/8 私网
  if (a === 127) return true; // 127/8 回环
  if (a === 169 && b === 254) return true; // 169.254/16 链路本地(含云元数据端点 169.254.169.254)
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64/10 CGNAT
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12 私网
  if (a === 192 && b === 0 && (o[2] === 0 || o[2] === 2)) return true; // 192.0.0/24 IETF、192.0.2/24 TEST-NET-1
  if (a === 192 && b === 168) return true; // 192.168/16 私网
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18/15 benchmarking
  if (a === 198 && b === 51 && o[2] === 100) return true; // 198.51.100/24 TEST-NET-2
  if (a === 203 && b === 0 && o[2] === 113) return true; // 203.0.113/24 TEST-NET-3
  if (a >= 224) return true; // 224/4 组播 + 240/4 保留 + 255.255.255.255 广播
  return false;
}

function expandIpv6(ip: string): string | null {
  // 处理 IPv4-mapped 尾段(::ffff:1.2.3.4)
  const v4Mapped = ip.match(/^(.*?):(\d{1,3}(?:\.\d{1,3}){3})$/);
  let working = ip;
  if (v4Mapped) {
    const o = parseIpv4(v4Mapped[2]);
    if (!o) return null;
    const hex1 = ((o[0] << 8) | o[1]).toString(16);
    const hex2 = ((o[2] << 8) | o[3]).toString(16);
    working = `${v4Mapped[1]}:${hex1}:${hex2}`;
  }
  if (!/^[0-9a-fA-F:]+$/.test(working)) return null;
  const halves = working.split('::');
  if (halves.length > 2) return null;
  const expandGroup = (g: string) => g.padStart(4, '0').toLowerCase();
  let groups: string[];
  if (halves.length === 2) {
    const head = halves[0] ? halves[0].split(':') : [];
    const tail = halves[1] ? halves[1].split(':') : [];
    if (head.length + tail.length > 8) return null;
    const mid = new Array(8 - head.length - tail.length).fill('0000');
    groups = [...head.map(expandGroup), ...mid, ...tail.map(expandGroup)];
  } else {
    groups = working.split(':').map(expandGroup);
    if (groups.length !== 8) return null;
  }
  return groups.join(':');
}

function isPrivateIpv6(ip: string): boolean {
  const expanded = expandIpv6(ip);
  if (!expanded) return true; // 非法 IPv6 → fail closed
  const groups = expanded.split(':');
  const first = parseInt(groups[0], 16);
  if (expanded === '0000:0000:0000:0000:0000:0000:0000:0000') return true; // :: 未指定
  if (expanded === '0000:0000:0000:0000:0000:0000:0000:0001') return true; // ::1 回环
  if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 ULA
  if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 链路本地
  // IPv4-mapped ::ffff:x.x.x.x → 按内嵌 IPv4 判
  if (groups.slice(0, 5).every((g) => g === '0000') && groups[5] === 'ffff') {
    const hi = parseInt(groups[6], 16);
    const lo = parseInt(groups[7], 16);
    const v4 = `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
    return isPrivateIpv4(v4);
  }
  return false;
}

/**
 * 判断 IP 是否落在私网/保留/链路本地/组播段(fail closed:非法输入返回 true)。
 * 覆盖 IPv4 与 IPv6(含 IPv4-mapped)。
 */
export function isPrivateOrReservedIp(ip: string): boolean {
  const trimmed = (ip || '').trim().replace(/^\[|\]$/g, '');
  if (!trimmed) return true;
  // 去掉 IPv6 zone id(fe80::1%eth0)
  const noZone = trimmed.split('%')[0];
  if (noZone.includes(':')) return isPrivateIpv6(noZone);
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(noZone)) return isPrivateIpv4(noZone);
  return true; // 不是合法 IP 字面量 → fail closed
}

export interface UrlGuardResult {
  ok: boolean;
  /** 拒绝原因码(私网拦截统一含 'private' 子串,便于断言与提案分类) */
  reason?: 'invalid_url' | 'scheme_not_allowed' | 'private_host' | 'dns_failed';
  message?: string;
  hostname?: string;
}

/**
 * 出站 URL 主机围栏:
 * 1. 仅允许 http/https;
 * 2. hostname 为字面量 IP → 直接判私网;
 * 3. 'localhost' 及 *.localhost → 直接拒;
 * 4. 域名 → 解析出全部地址,任一地址为私网/保留即拒绝。
 */
export async function guardUrlHost(rawUrl: string, lookup: HostLookup = defaultLookup): Promise<UrlGuardResult> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, reason: 'invalid_url', message: `非法 URL: ${rawUrl}` };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, reason: 'scheme_not_allowed', message: `仅允许 http/https,收到 ${url.protocol}` };
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!hostname) {
    return { ok: false, reason: 'invalid_url', message: 'URL 缺少 hostname' };
  }
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) {
    return { ok: false, reason: 'private_host', message: `禁止访问本机回环主机: ${hostname}` };
  }
  // 字面量 IP
  if (hostname.includes(':') || /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname)) {
    if (isPrivateOrReservedIp(hostname)) {
      return { ok: false, reason: 'private_host', message: `禁止访问私网/保留地址: ${hostname}` };
    }
    return { ok: true, hostname };
  }
  // 域名 → DNS 解析后逐地址校验(防「域名解析到内网」)
  let addresses: string[];
  try {
    addresses = await lookup(hostname);
  } catch (e: any) {
    return { ok: false, reason: 'dns_failed', message: `DNS 解析失败: ${hostname}(${e?.message || e})` };
  }
  if (!addresses.length) {
    return { ok: false, reason: 'dns_failed', message: `DNS 解析无结果: ${hostname}` };
  }
  for (const addr of addresses) {
    if (isPrivateOrReservedIp(addr)) {
      return { ok: false, reason: 'private_host', message: `域名 ${hostname} 解析到私网/保留地址 ${addr},禁止访问` };
    }
  }
  return { ok: true, hostname };
}
