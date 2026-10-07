import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import {
  getConnectorOAuthAdapter,
  getAppBaseUrl,
  SUPPORTED_OAUTH_PROVIDERS,
  OAUTH_STATE_COOKIE,
} from '@/lib/connector-oauth';
import { saveUserConnector } from '@/lib/user-store';

/**
 * 平台 → 用户级凭证键 的对应映射表。
 * Token 一律写入用户独立存储（user-store），绝不写 process.env，
 * 避免进程级全局共享导致多用户 token 串号。
 */
const PROVIDER_ENV_MAP: Record<string, string> = {
  github: 'GITHUB_TOKEN',
  notion: 'NOTION_TOKEN',
  slack: 'SLACK_TOKEN',
};

/**
 * GET /api/connectors/oauth/callback?provider=github&code=...&state=...
 * 接收第三方平台授权回调，校验 state 后换取 Access Token 并保存到当前用户空间
 */
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const provider = searchParams.get('provider');
  const code = searchParams.get('code');
  const state = searchParams.get('state');
  const error = searchParams.get('error');
  const errorDescription = searchParams.get('error_description');

  const baseUrl = getAppBaseUrl(req);

  const fail = (msg: string) => {
    const res = NextResponse.redirect(
      `${baseUrl}/?tab=connectors&error=${encodeURIComponent(msg)}`
    );
    res.cookies.delete(OAUTH_STATE_COOKIE);
    return res;
  };

  if (error) {
    return fail(errorDescription || error);
  }

  if (
    !provider ||
    !(SUPPORTED_OAUTH_PROVIDERS as readonly string[]).includes(provider) ||
    !code
  ) {
    return fail('缺少授权 code 或 provider 参数');
  }

  // 必须已登录：token 只有绑定到具体用户才有意义
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) {
    return fail('登录状态已失效，请重新登录后再授权');
  }

  // CSRF 校验：state 必须与 start 阶段写入 httpOnly cookie 的值一致，且属于同一用户、同一 provider
  const stored = req.cookies.get(OAUTH_STATE_COOKIE)?.value || '';
  const [savedState, savedProvider, savedUserId] = stored.split('|');
  if (
    !savedState ||
    savedState !== state ||
    savedProvider !== provider ||
    savedUserId !== userId
  ) {
    return fail('state 校验失败（可能存在 CSRF 风险或授权已过期），请重新发起授权');
  }

  try {
    const callbackUrl = `${baseUrl}/api/connectors/oauth/callback?provider=${provider}`;
    const adapter = getConnectorOAuthAdapter();

    const result = await adapter.exchangeCodeForToken({
      provider,
      code,
      callbackUrl,
    });

    const targetEnvVar = PROVIDER_ENV_MAP[provider];
    if (!targetEnvVar || !result.accessToken) {
      return fail(`未能获取 ${provider} 的有效 Access Token`);
    }

    // 保存到用户独立空间（与手动填 Key 走同一存储，重启不丢、用户间隔离）
    saveUserConnector(userId, targetEnvVar, result.accessToken);
    if (result.refreshToken) {
      saveUserConnector(userId, `${targetEnvVar}__REFRESH`, result.refreshToken);
    }

    // 重定向回前端连接器中心，并提示授权成功
    const okRes = NextResponse.redirect(
      `${baseUrl}/?tab=connectors&authorized=${encodeURIComponent(provider)}`
    );
    okRes.cookies.delete(OAUTH_STATE_COOKIE);
    return okRes;
  } catch (err: any) {
    console.error(`OAuth callback error for ${provider}:`, err);
    return fail(err.message || 'OAuth 授权换取 Token 失败');
  }
}
