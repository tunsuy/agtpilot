import { NextRequest, NextResponse } from 'next/server';
import { getConnectorOAuthAdapter } from '@/lib/connector-oauth';

/**
 * 平台与环境变量的对应映射表
 */
const PROVIDER_ENV_MAP: Record<string, string> = {
  github: 'GITHUB_TOKEN',
  notion: 'NOTION_TOKEN',
  slack: 'SLACK_TOKEN',
};

/**
 * GET /api/connectors/oauth/callback?provider=github&code=...
 * 接收第三方平台授权回调，换取 Access Token 并保存
 */
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const provider = searchParams.get('provider');
  const code = searchParams.get('code');
  const error = searchParams.get('error');
  const errorDescription = searchParams.get('error_description');

  const host = req.headers.get('host') || 'localhost:3000';
  const protocol = req.headers.get('x-forwarded-proto') || 'http';
  const baseUrl = `${protocol}://${host}`;

  if (error) {
    return NextResponse.redirect(
      `${baseUrl}/?tab=connectors&error=${encodeURIComponent(errorDescription || error)}`
    );
  }

  if (!provider || !code) {
    return NextResponse.redirect(
      `${baseUrl}/?tab=connectors&error=${encodeURIComponent('缺少授权 code 或 provider 参数')}`
    );
  }

  try {
    const callbackUrl = `${baseUrl}/api/connectors/oauth/callback?provider=${provider}`;
    const adapter = getConnectorOAuthAdapter();

    const result = await adapter.exchangeCodeForToken({
      provider,
      code,
      callbackUrl,
    });

    // 将获得的 Token 保存到环境变量中
    const targetEnvVar = PROVIDER_ENV_MAP[provider];
    if (targetEnvVar && result.accessToken) {
      process.env[targetEnvVar] = result.accessToken;
    }

    // 重定向回前端连接器中心，并提示授权成功
    return NextResponse.redirect(
      `${baseUrl}/?tab=connectors&authorized=${encodeURIComponent(provider)}`
    );
  } catch (err: any) {
    console.error(`OAuth callback error for ${provider}:`, err);
    return NextResponse.redirect(
      `${baseUrl}/?tab=connectors&error=${encodeURIComponent(err.message || 'OAuth 授权换取 Token 失败')}`
    );
  }
}
