import { NextRequest, NextResponse } from 'next/server';
import { randomBytes } from 'crypto';
import { auth } from '@/auth';
import {
  getConnectorOAuthAdapter,
  getAppBaseUrl,
  SUPPORTED_OAUTH_PROVIDERS,
  OAUTH_STATE_COOKIE,
} from '@/lib/connector-oauth';

/**
 * GET /api/connectors/oauth/start?provider=github
 * 发起对应平台的 OAuth 跳转（要求已登录；state 通过 httpOnly cookie 绑定用户，回调时校验）
 */
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const provider = searchParams.get('provider');
  const baseUrl = getAppBaseUrl(req);

  const fail = (msg: string) =>
    NextResponse.redirect(`${baseUrl}/?tab=connectors&error=${encodeURIComponent(msg)}`);

  if (!provider || !(SUPPORTED_OAUTH_PROVIDERS as readonly string[]).includes(provider)) {
    return fail(`不支持的 OAuth 提供商: ${provider || '(空)'}`);
  }

  const session = await auth();
  if (!session?.user?.id) {
    return fail('请先登录后再进行 OAuth 授权');
  }

  try {
    const callbackUrl = `${baseUrl}/api/connectors/oauth/callback?provider=${provider}`;

    // CSRF state：密码学安全随机，且与当前用户绑定后写入 httpOnly cookie
    const state = randomBytes(24).toString('hex');
    const adapter = getConnectorOAuthAdapter();

    const authUrl = await adapter.getAuthorizationUrl({
      provider,
      callbackUrl,
      state,
    });

    const res = NextResponse.redirect(authUrl);
    res.cookies.set(OAUTH_STATE_COOKIE, `${state}|${provider}|${session.user.id}`, {
      httpOnly: true,
      sameSite: 'lax',
      secure: baseUrl.startsWith('https://'),
      maxAge: 600, // 10 分钟内完成授权
      path: '/',
    });
    return res;
  } catch (err: any) {
    return fail(err.message || '获取授权跳转链接失败');
  }
}
