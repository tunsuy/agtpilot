/**
 * 运营看板管理员门禁(env AGTPILOT_OPS_ADMINS,逗号分隔)。
 *
 * 条目可以是 userId(usr_…)或邮箱 —— 邮箱按 auth-identity 同款 hex 派生
 * 转成 usr_hex,与 credentials/OAuth 登录得到的稳定 id 完全一致。
 *
 * 默认管理员: env 未设置时回退到内置默认名单 DEFAULT_OPS_ADMINS(负责人
 * 指定的默认运营账号);env 一旦显式设置(任意值,含空串)即以 env 为准,不再
 * 合并默认值——部署方可用 AGTPILOT_OPS_ADMINS="" 清空默认管理员。
 *
 * 消费方:auth.ts jwt 回调(UI 入口显隐)+ /api/ops/* 路由服务端双重校验。
 */

/** 默认运营管理员(邮箱,按登录稳定 id 派生命中)。 */
const DEFAULT_OPS_ADMINS = ['957126743@qq.com'];

/** 邮箱 → 稳定 userId(与 auth-identity.deriveStableUserId / authorize 同款算法) */
function emailToStableId(email: string): string {
  return 'usr_' + Buffer.from(email.toLowerCase().trim()).toString('hex').slice(0, 16);
}

export function getOpsAdminIds(): Set<string> {
  // env 显式设置(含空串)即以 env 为准;未设置才回退内置默认名单。
  const raw =
    process.env.AGTPILOT_OPS_ADMINS !== undefined
      ? process.env.AGTPILOT_OPS_ADMINS
      : DEFAULT_OPS_ADMINS.join(',');
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
