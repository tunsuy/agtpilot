/**
 * 登录徽标数据(纯函数,客户端安全)。
 *
 * 从 browser-login(扫码登录状态机,服务端专属、内联大量浏览器自动化逻辑)
 * 抽出:连接器页与工坊页只需要这个纯计算,不该把整个登录状态机打进客户端 chunk。
 */
import type { XhsManagedRecord } from './user-store';

/** 供 UI 读取用户登录徽标数据(登录时间 + 是否可能过期) */
export function loginBadgeInfo(record: XhsManagedRecord | undefined): {
  loggedIn: boolean;
  lastLoginAt?: number;
  maybeStale: boolean;
} {
  const lastLoginAt = record?.lastLoginAt;
  if (!lastLoginAt) return { loggedIn: false, maybeStale: false };
  // ⚠️ 30 天为经验值:网页版会话有效期待实测
  const maybeStale = Date.now() - lastLoginAt > 30 * 24 * 3600 * 1000;
  return { loggedIn: true, lastLoginAt, maybeStale };
}
