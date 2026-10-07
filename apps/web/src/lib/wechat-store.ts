export interface WeChatLoginCode {
  code: string;
  status: 'PENDING' | 'VERIFIED' | 'CONSUMED' | 'EXPIRED';
  openid?: string;
  user?: {
    id: string;
    name: string;
    email: string;
  };
  expiresAt: number;
  createdAt: number;
}

// 内存验证码字典 (生产环境可接 Redis，这里提供内存极速持久单例)
const g = globalThis as any;
if (!g.__wechatCodeStore) {
  g.__wechatCodeStore = new Map<string, WeChatLoginCode>();
}

const codeMap: Map<string, WeChatLoginCode> = g.__wechatCodeStore;

export function generateLoginCode(): WeChatLoginCode {
  // 生成 6 位纯数字验证码
  const code = Math.floor(100000 + Math.random() * 900000).toString();
  const now = Date.now();
  const item: WeChatLoginCode = {
    code,
    status: 'PENDING',
    createdAt: now,
    expiresAt: now + 5 * 60 * 1000, // 5 分钟有效
  };
  codeMap.set(code, item);
  return item;
}

export function checkCodeStatus(code: string): WeChatLoginCode | null {
  const item = codeMap.get(code);
  if (!item) return null;
  if (Date.now() > item.expiresAt && item.status === 'PENDING') {
    item.status = 'EXPIRED';
  }
  return item;
}

export function verifyLoginCode(code: string, openid: string, nickname?: string): boolean {
  const item = codeMap.get(code.trim());
  if (!item) return false;
  if (item.status === 'EXPIRED' || Date.now() > item.expiresAt) {
    return false;
  }

  const shortOpenid = openid.slice(-6);
  item.status = 'VERIFIED';
  item.openid = openid;
  item.user = {
    id: `usr_wx_${openid.slice(0, 10)}`,
    name: nickname?.trim() || `微信用户_${shortOpenid}`,
    email: `wx_${shortOpenid}@agtpilot.ai`,
  };
  return true;
}

/**
 * 一次性核销已验证的登录码，返回绑定的微信身份。
 * 供 Credentials authorize 在服务端换取真实用户身份，
 * 核销后立即从字典删除，防止同一验证码被重放登录。
 */
export function consumeVerifiedCode(code: string): WeChatLoginCode['user'] | null {
  const key = code.trim();
  const item = codeMap.get(key);
  if (!item || item.status !== 'VERIFIED' || !item.user) return null;
  if (Date.now() > item.expiresAt) {
    item.status = 'EXPIRED';
    return null;
  }
  const user = item.user;
  codeMap.delete(key);
  return user;
}
