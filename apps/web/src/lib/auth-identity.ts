/**
 * 登录身份稳定性派生(纯函数,auth.ts 的 jwt 回调使用,单测覆盖)。
 * 背景:@auth/core 对 OAuth 登录每次都会生成随机 UUID 作为 user.id(见其
 * oauth/callback.js,设计上假定接入数据库持久化用户)。我们是 JWT 会话 + 无数据库,
 * 直接采用会导致同一 Google/微信账号每次重新登录都变成"新用户",此前配置的
 * 连接器凭证/记忆/任务全部"消失"(表现为换设备/重新登录后"未配置")。
 *
 * 规则:OAuth 登录用「已验证邮箱」派生与邮箱登录完全一致的 usr_hex id
 * (同一邮箱 = 同一账号,跨设备/跨登录方式);邮箱缺失或未验证时回退
 * providerAccountId(服务商侧稳定 id,如 Google sub / 微信 openid);
 * credentials 登录沿用 authorize 返回的确定性 id。
 */
export function deriveStableUserId(user: any, account: any): string {
  if (account?.type === 'oauth') {
    const email = typeof user.email === 'string' ? user.email.toLowerCase().trim() : '';
    const emailVerified = user.emailVerified ?? account.email_verified;
    if (email && emailVerified) {
      return 'usr_' + Buffer.from(email).toString('hex').slice(0, 16);
    }
    return String(account.providerAccountId || account.sub || user.id);
  }
  return user.id;
}
