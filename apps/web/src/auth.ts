import NextAuth from 'next-auth';
import Credentials from 'next-auth/providers/credentials';

export const { handlers, signIn, signOut, auth } = NextAuth({
  providers: [
    Credentials({
      name: 'Credentials',
      credentials: {
        email: { label: 'Email', type: 'email' },
        password: { label: 'Password', type: 'password' },
        isDemo: { label: 'Demo', type: 'text' },
      },
      async authorize(credentials) {
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

        const email = credentials?.email as string;
        const password = credentials?.password as string;

        if (!email || !password) {
          return null;
        }

        return {
          id: `usr_${Date.now()}`,
          name: email.split('@')[0],
          email,
          role: 'user',
          tier: 'Pro',
          tokensUsed: 3500,
          tokensLimit: 100000,
        };
      },
    }),
  ],
  session: { strategy: 'jwt' },
  secret: process.env.AUTH_SECRET || process.env.NEXTAUTH_SECRET || 'agtpilot-super-secret-jwt-key-2026',
  callbacks: {
    jwt({ token, user }) {
      if (user) {
        token.role = (user as any).role || 'user';
        token.tier = (user as any).tier || 'Pro';
        token.tokensUsed = (user as any).tokensUsed ?? 3500;
        token.tokensLimit = (user as any).tokensLimit ?? 100000;
      }
      return token;
    },
    session({ session, token }) {
      if (session.user) {
        (session.user as any).role = token.role;
        (session.user as any).tier = token.tier;
        (session.user as any).tokensUsed = token.tokensUsed;
        (session.user as any).tokensLimit = token.tokensLimit;
      }
      return session;
    },
  },
});
