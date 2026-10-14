import * as net from 'net';

/**
 * 从请求头提取客户端来源 IP(仅展示/排障用,绝非鉴权依据)。
 *
 * 优先级:x-forwarded-for 首跳 → x-real-ip;均要求通过 net.isIP 格式校验
 * (IPv4/IPv6,≤45 字符)。App Router 拿不到 socket 远端地址,
 * 无反代直连部署时两个头都不存在 → null(设备页 IP 栏留空)。
 *
 * 安全注记:未经可信反代剥离时,这两个头都可被客户端伪造 ——
 * 云端记录它只为「设备页显示最近来源 IP」,不参与任何访问控制。
 */
export function extractClientIp(headers: { get(name: string): string | null }): string | null {
  const candidates = [
    headers.get('x-forwarded-for')?.split(',')[0]?.trim(),
    headers.get('x-real-ip')?.trim(),
  ];
  for (const c of candidates) {
    if (c && c.length <= 45 && net.isIP(c) !== 0) return c;
  }
  return null;
}
