import { describe, it, expect } from 'vitest';
import { deriveStableUserId } from '@/lib/auth-identity';

/**
 * 登录身份稳定性单测(auth-identity 的 deriveStableUserId)。
 * 背景:@auth/core 对 OAuth/OIDC 登录每次生成随机 UUID 作为 user.id(假定接数据库),
 * 我们用 JWT 无数据库——直接采用会导致同一账号每次重新登录都变成"新用户",
 * 已配置的连接器凭证/记忆全部"消失"。
 */

const GMAIL = 'tstang6868@gmail.com';
const EMAIL_LOGIN_ID = 'usr_' + Buffer.from(GMAIL).toString('hex').slice(0, 16);

/** 伪造 Google 形态的 id_token(sub/email/email_verified claims) */
function fakeGoogleIdToken(claims: Record<string, unknown> = {}): string {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256' })).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({
      sub: '117999678611234567890',
      email: GMAIL,
      email_verified: true,
      ...claims,
    })
  ).toString('base64url');
  const sig = Buffer.from('fake-signature').toString('base64url');
  return `${header}.${payload}.${sig}`;
}

describe('deriveStableUserId', () => {
  it('Google(type oidc + id_token 声明)→ 与邮箱登录完全一致的 usr_hex id', () => {
    const id = deriveStableUserId(
      { id: '2a9fc67e-86a9-47c9-8f98-f7394409b153', email: GMAIL },
      {
        type: 'oidc',
        provider: 'google',
        id_token: fakeGoogleIdToken(),
        providerAccountId: '117999678611234567890',
      }
    );
    expect(id).toBe(EMAIL_LOGIN_ID);
  });

  it('回归:同一账号两次 OAuth 登录(每次随机 UUID 不同)→ 派生 id 相同', () => {
    const mk = (uuid: string) =>
      deriveStableUserId(
        { id: uuid, email: GMAIL },
        {
          type: 'oidc',
          provider: 'google',
          id_token: fakeGoogleIdToken(),
          providerAccountId: '117999678611234567890',
        }
      );
    expect(mk('uuid-random-1')).toBe(mk('uuid-random-2'));
    expect(mk('uuid-random-1')).not.toMatch(/uuid-random/);
  });

  it('user.email 缺失时用 id_token claims 里的邮箱(大小写/空格归一)', () => {
    const id = deriveStableUserId(
      { id: 'u' },
      {
        type: 'oidc',
        id_token: fakeGoogleIdToken({ email: '  TSTANG6868@GMAIL.com ' }),
        providerAccountId: 'sub',
      }
    );
    expect(id).toBe(EMAIL_LOGIN_ID);
  });

  it('type 为 oauth(非 oidc)也走稳定派生;email_verified 显式为 false → 回退 providerAccountId', () => {
    expect(
      deriveStableUserId(
        { id: 'u', email: GMAIL, emailVerified: true },
        { type: 'oauth', provider: 'custom-oauth', providerAccountId: 'oauth-1' }
      )
    ).toBe(EMAIL_LOGIN_ID);

    expect(
      deriveStableUserId(
        { id: 'u', email: GMAIL, emailVerified: false },
        { type: 'oidc', provider: 'github', providerAccountId: 'gh-12345' }
      )
    ).toBe('gh-12345');
  });

  it('无邮箱/无验证声明 → providerAccountId;再无 → id_token sub 兜底;最后才 user.id', () => {
    expect(
      deriveStableUserId({ id: 'u', email: null }, { type: 'oauth', sub: 'wechat-openid' })
    ).toBe('wechat-openid');

    expect(
      deriveStableUserId(
        { id: 'u' },
        { type: 'oidc', id_token: fakeGoogleIdToken({ email_verified: false }) }
      )
    ).toBe('117999678611234567890');

    expect(deriveStableUserId({ id: 'fallback-id' }, { type: 'oidc' })).toBe('fallback-id');
  });

  it('id_token 损坏不致命(解不开当无 claims 处理)', () => {
    expect(
      deriveStableUserId(
        { id: 'u', email: GMAIL, emailVerified: true },
        { type: 'oidc', id_token: 'not.a.valid.jwt!!!', providerAccountId: 'pa' }
      )
    ).toBe(EMAIL_LOGIN_ID);
  });

  it('credentials 登录(邮箱/一键体验/社交模拟)→ 沿用 authorize 的确定性 id', () => {
    expect(deriveStableUserId({ id: 'usr_747374616e673638' }, { type: 'credentials' })).toBe(
      'usr_747374616e673638'
    );
    expect(deriveStableUserId({ id: 'usr_marshal_01' }, undefined)).toBe('usr_marshal_01');
  });
});
