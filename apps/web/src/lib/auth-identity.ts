/**
 * 登录身份稳定性派生(纯函数,auth.ts 的 jwt 回调使用,单测覆盖)。
 * 背景:@auth/core 对 OAuth/OIDC 登录每次都会生成随机 UUID 作为 user.id(见其
 * oauth/callback.js,设计上假定接入数据库持久化用户)。我们是 JWT 会话 + 无数据库,
 * 直接采用会导致同一 Google/微信账号每次重新登录都变成"新用户",此前配置的
 * 连接器凭证/记忆/任务全部"消失"(表现为换设备/重新登录后"未配置")。
 *
 * 规则:OAuth/OIDC 登录用「已验证邮箱」派生与邮箱登录完全一致的 usr_hex id
 * (同一邮箱 = 同一账号,跨设备/跨登录方式);邮箱缺失或未验证时回退
 * providerAccountId(服务商侧稳定 id,如 Google sub / 微信 openid);
 * credentials 登录沿用 authorize 返回的确定性 id。
 *
 * 坑位备忘(踩过):
 * - Google provider 的 type 是 "oidc" 而非 "oauth",两个都要匹配;
 * - @auth/core 的 defaultAccount 会剥掉 email_verified/sub 等 claims,只有
 *   id_token 原始 JWT 字符串可用——需自行解码 payload 取 email_verified / sub。
 */

/** 解码 OIDC id_token 的 payload claims(不验签:仅读取声明,签验已由 @auth/core 完成) */
function decodeIdTokenClaims(idToken: unknown): Record<string, any> | null {
  if (typeof idToken !== 'string' || !idToken.includes('.')) return null;
  try {
    const payload = idToken.split('.')[1];
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf-8'));
  } catch {
    return null;
  }
}

export function deriveStableUserId(user: any, account: any): string {
  const type = account?.type;
  if (type === 'oauth' || type === 'oidc') {
    const claims = decodeIdTokenClaims(account?.id_token) || {};
    const email =
      typeof user.email === 'string'
        ? user.email.toLowerCase().trim()
        : typeof claims.email === 'string'
          ? claims.email.toLowerCase().trim()
          : '';
    const emailVerified =
      user.emailVerified ?? account?.email_verified ?? claims.email_verified;
    if (email && emailVerified) {
      return 'usr_' + Buffer.from(email).toString('hex').slice(0, 16);
    }
    return String(account?.providerAccountId || claims.sub || account?.sub || user.id);
  }
  return user.id;
}
