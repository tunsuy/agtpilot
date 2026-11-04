import NextAuth from 'next-auth';
import Credentials from 'next-auth/providers/credentials';
import GitHub from 'next-auth/providers/github';
import Google from 'next-auth/providers/google';
import Apple from 'next-auth/providers/apple';
import WeChat from 'next-auth/providers/wechat';
import { consumeVerifiedCode } from './lib/wechat-store';
import { isMockAuthAllowed } from './lib/auth-mock';
import { deriveStableUserId } from './lib/auth-identity';
import { isOpsAdmin } from './lib/ops-admin';
import { recordUserLogin } from './lib/ops-ledger';
import { registerCredentialUser, verifyCredentialUser } from './lib/auth-credentials';

const configuredProviders: any[] = [];

if (process.env.AUTH_GITHUB_ID && process.env.AUTH_GITHUB_SECRET) {
  configuredProviders.push(
    GitHub({
      clientId: process.env.AUTH_GITHUB_ID,
      clientSecret: process.env.AUTH_GITHUB_SECRET,
    })
  );
}

if (process.env.AUTH_GOOGLE_ID && process.env.AUTH_GOOGLE_SECRET) {
  configuredProviders.push(
    Google({
      clientId: process.env.AUTH_GOOGLE_ID,
      clientSecret: process.env.AUTH_GOOGLE_SECRET,
    })
  );
}

if (process.env.AUTH_APPLE_ID && process.env.AUTH_APPLE_SECRET) {
  configuredProviders.push(
    Apple({
      clientId: process.env.AUTH_APPLE_ID,
      clientSecret: process.env.AUTH_APPLE_SECRET,
    })
  );
}

if (process.env.AUTH_WECHAT_ID && process.env.AUTH_WECHAT_SECRET) {
  configuredProviders.push(
    WeChat({
      clientId: process.env.AUTH_WECHAT_ID,
      clientSecret: process.env.AUTH_WECHAT_SECRET,
    })
  );
}

// Credentials provider (支持邮箱密码、一键 Demo 以及全真 Social 模拟)
configuredProviders.push(
  Credentials({
    name: 'Credentials',
    credentials: {
      email: { label: 'Email', type: 'email' },
      password: { label: 'Password', type: 'password' },
      name: { label: 'Name', type: 'text' },
      mode: { label: 'Mode', type: 'text' },
      isDemo: { label: 'Demo', type: 'text' },
      socialProvider: { label: 'SocialProvider', type: 'text' },
      socialName: { label: 'SocialName', type: 'text' },
      wechatCode: { label: 'WechatCode', type: 'text' },
    },
    async authorize(credentials) {
      // 微信验证码登录：服务端核销一次性验证码，换取公众号回调绑定的真实 openid 身份
      if (credentials?.wechatCode) {
        const wxUser = consumeVerifiedCode(String(credentials.wechatCode));
        if (!wxUser) return null;
        return {
          id: wxUser.id,
          name: wxUser.name,
          email: wxUser.email,
          role: 'user',
          tier: 'Pro',
          tokensUsed: 0,
          tokensLimit: 100000,
        };
      }

      // 以下 isDemo / socialProvider 均为沙盒模拟身份，生产环境默认关闭（AUTH_ALLOW_MOCK 控制）
      if (!isMockAuthAllowed()) {
        if (credentials?.isDemo === 'true' || credentials?.socialProvider) {
          return null;
        }
      }

      if (credentials?.isDemo === 'true') {
        return {
          id: 'usr_marshal_01',
          name: 'Marshal',
          email: 'marshal@agtpilot.ai',
          image: 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=128&auto=format&fit=crop&q=80',
          role: 'admin',
          tier: 'Pro',
          tokensUsed: 42800,
          tokensLimit: 200000,
        };
      }

      if (credentials?.socialProvider) {
        const p = String(credentials.socialProvider);
        const socialName = typeof credentials.socialName === 'string' ? credentials.socialName : undefined;
        if (p === 'wechat') {
          return {
            id: 'usr_wechat_default',
            name: socialName || '微信用户_AgtPilot',
            email: 'wechat_user@agtpilot.ai',
            image: 'https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?w=128&auto=format&fit=crop&q=80',
            role: 'user',
            tier: 'Pro',
            tokensUsed: 6200,
            tokensLimit: 100000,
          };
        }
        if (p === 'google') {
          return {
            id: 'usr_google_default',
            name: socialName || 'Google Account',
            email: 'google_user@gmail.com',
            image: 'https://images.unsplash.com/photo-1570295999919-56ceb5ecca61?w=128&auto=format&fit=crop&q=80',
            role: 'user',
            tier: 'Pro',
            tokensUsed: 8900,
            tokensLimit: 150000,
          };
        }
        if (p === 'github') {
          return {
            id: 'usr_github_default',
            name: socialName || 'GitHub Developer',
            email: 'developer@github.com',
            image: 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=128&auto=format&fit=crop&q=80',
            role: 'admin',
            tier: 'Pro',
            tokensUsed: 14500,
            tokensLimit: 200000,
          };
        }
        if (p === 'apple') {
          return {
            id: 'usr_apple_default',
            name: socialName || 'Apple ID User',
            email: 'apple_user@icloud.com',
            image: 'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=128&auto=format&fit=crop&q=80',
            role: 'user',
            tier: 'Pro',
            tokensUsed: 5000,
            tokensLimit: 100000,
          };
        }
      }

      const email = String(credentials?.email ?? '').trim().toLowerCase();
      const password = String(credentials?.password ?? '');
      if (!email || !password) return null;

      if (credentials?.mode === 'register') {
        const registered = registerCredentialUser(
          email,
          password,
          String(credentials?.name ?? email.split('@')[0]),
        );
        if (!registered) return null;
        return {
          id: 'usr_' + Buffer.from(registered.email).toString('hex').slice(0, 16),
          name: registered.name,
          email: registered.email,
          role: 'user',
          tier: 'Pro',
          tokensUsed: 0,
          tokensLimit: 100000,
        };
      }

      const verified = verifyCredentialUser(email, password);
      if (!verified) return null;
      return {
        id: 'usr_' + Buffer.from(verified.email).toString('hex').slice(0, 16),
        name: verified.name,
        email: verified.email,
        role: 'user',
        tier: 'Pro',
        tokensUsed: 0,
        tokensLimit: 100000,
      };
    },
  })
);

export const { handlers, signIn, signOut, auth } = NextAuth({
  trustHost: true,
  providers: configuredProviders,
  session: { strategy: 'jwt' },
  secret: process.env.AUTH_SECRET || process.env.NEXTAUTH_SECRET || 'agtpilot-super-secret-jwt-key-2026',
  callbacks: {
    jwt({ token, user, account }) {
      if (user) {
        token.id = deriveStableUserId(user, account);
        // 运营管理员:env AGTPILOT_OPS_ADMINS 命中即 admin(压过 mock 缺省
        // role);OpsView 入口显隐读它,API 路由另有服务端双重校验
        token.role = isOpsAdmin(token.id as string) ? 'admin' : (user as any).role || 'user';
        token.tier = (user as any).tier || 'Pro';
        token.tokensUsed = (user as any).tokensUsed ?? 3500;
        token.tokensLimit = (user as any).tokensLimit ?? 100000;
      }
      return token;
    },
    session({ session, token }) {
      if (session.user) {
        session.user.id = (token.id as string) || (token.sub as string);
        (session.user as any).role = token.role;
        (session.user as any).tier = token.tier;
        (session.user as any).tokensUsed = token.tokensUsed;
        (session.user as any).tokensLimit = token.tokensLimit;
      }
      return session;
    },
  },
  events: {
    // 运营流水:登录事件(总用户/昵称邮箱的唯一来源 —— UserScopedData 不存
    // 这些)。best-effort:记录失败静默,绝不让登录本身失败。
    signIn({ user, account }) {
      try {
        recordUserLogin({
          userId: deriveStableUserId(user, account),
          name: (user as any)?.name ?? null,
          email: (user as any)?.email ?? null,
          provider: account?.provider,
        });
      } catch {
        // ignore
      }
    },
  },
});
