import { describe, it, expect } from 'vitest';
import { deriveStableUserId } from '@/lib/auth-identity';

/**
 * 登录身份稳定性单测(auth.ts 的 deriveStableUserId)。
 * 背景:@auth/core 对 OAuth 登录每次生成随机 UUID 作为 user.id(假定接数据库持久化),
 * 我们用 JWT 无数据库——直接采用会导致同一账号每次重新登录都变成"新用户",
 * 已配置的连接器凭证/记忆全部"消失"。此纯函数固化稳定身份派生规则。
 */

const GMAIL = 'tstang6868@gmail.com';
const EMAIL_LOGIN_ID = 'usr_' + Buffer.from(GMAIL).toString('hex').slice(0, 16);

describe('deriveStableUserId', () => {
  it('OAuth + 已验证邮箱 → 与邮箱登录完全一致的 usr_hex id(同邮箱跨端同账号)', () => {
    const id = deriveStableUserId(
      { id: '2a9fc67e-86a9-47c9-8f98-f7394409b153', email: GMAIL, emailVerified: true },
      { type: 'oauth', provider: 'google', providerAccountId: '123456789' }
    );
    expect(id).toBe(EMAIL_LOGIN_ID);
  });

  it('回归:同一账号两次 OAuth 登录(每次随机 UUID 不同)→ 派生 id 相同', () => {
    const first = deriveStableUserId(
      { id: 'uuid-random-1', email: GMAIL, emailVerified: true },
      { type: 'oauth', provider: 'google', providerAccountId: '123456789' }
    );
    const second = deriveStableUserId(
      { id: 'uuid-random-2', email: GMAIL, emailVerified: true },
      { type: 'oauth', provider: 'google', providerAccountId: '123456789' }
    );
    expect(first).toBe(second);
    expect(first).not.toMatch(/uuid-random/);
  });

  it('邮箱大小写/首尾空格归一(Google 邮箱等价)', () => {
    const id = deriveStableUserId(
      { id: 'u', email: '  TSTANG6868@GMAIL.com ', emailVerified: true },
      { type: 'oauth', provider: 'google', providerAccountId: 'sub' }
    );
    expect(id).toBe(EMAIL_LOGIN_ID);
  });

  it('OAuth + 邮箱未验证 → 回退 providerAccountId(服务商稳定 id,不用邮箱防冒认)', () => {
    const id = deriveStableUserId(
      { id: 'u', email: GMAIL, emailVerified: false },
      { type: 'oauth', provider: 'github', providerAccountId: 'gh-12345' }
    );
    expect(id).toBe('gh-12345');
  });

  it('OAuth + 无邮箱 → sub 兜底;providerAccountId 也无 → 才用 user.id', () => {
    expect(
      deriveStableUserId({ id: 'u', email: null }, { type: 'oauth', sub: 'google-sub-1' })
    ).toBe('google-sub-1');
    expect(deriveStableUserId({ id: 'fallback-id' }, { type: 'oauth' })).toBe('fallback-id');
  });

  it('credentials 登录(邮箱/一键体验/社交模拟)→ 沿用 authorize 的确定性 id', () => {
    expect(deriveStableUserId({ id: 'usr_747374616e673638' }, { type: 'credentials' })).toBe(
      'usr_747374616e673638'
    );
    expect(deriveStableUserId({ id: 'usr_marshal_01' }, undefined)).toBe('usr_marshal_01');
  });
});
