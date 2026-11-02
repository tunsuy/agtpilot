/**
 * 运营看板管理员门禁(env AGTPILOT_OPS_ADMINS,逗号分隔)。
 *
 * 条目可以是 userId(usr_…)或邮箱 —— 邮箱按 auth-identity 同款 hex 派生
 * 转成 usr_hex,与 credentials/OAuth 登录得到的稳定 id 完全一致。
 * 未配置 = env 通道无管理员(mock Demo usr_marshal_01 自带 role='admin',
 * 仅开发环境可用:生产 AUTH_ALLOW_MOCK 已关)。
 *
 * 消费方:auth.ts jwt 回调(UI 入口显隐)+ /api/ops/* 路由服务端双重校验。
 */

/** 邮箱 → 稳定 userId(与 auth-identity.deriveStableUserId / authorize 同款算法) */
function emailToStableId(email: string): string {
  return 'usr_' + Buffer.from(email.toLowerCase().trim()).toString('hex').slice(0, 16);
}

export function getOpsAdminIds(): Set<string> {
  const raw = process.env.AGTPILOT_OPS_ADMINS || '';
  const ids = new Set<string>();
  for (const part of raw.split(',')) {
    const v = part.trim();
    if (!v) continue;
    ids.add(v.includes('@') ? emailToStableId(v) : v);
  }
  return ids;
}

export function isOpsAdmin(userId?: string | null): boolean {
  if (!userId) return false;
  return getOpsAdminIds().has(userId);
}
