import { NextRequest, NextResponse } from 'next/server';
import { getConnectorOAuthAdapter } from '@/lib/connector-oauth';

/**
 * GET /api/connectors/oauth/start?provider=github
 * 发起对应平台的 OAuth 跳转
 */
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const provider = searchParams.get('provider');

  if (!provider) {
    return NextResponse.json({ success: false, error: '缺少 provider 参数' }, { status: 400 });
  }

  try {
    const host = req.headers.get('host') || 'localhost:3000';
    const protocol = req.headers.get('x-forwarded-proto') || 'http';
    const callbackUrl = `${protocol}://${host}/api/connectors/oauth/callback?provider=${provider}`;

    const state = Math.random().toString(36).substring(2, 15);
    const adapter = getConnectorOAuthAdapter();

    const authUrl = await adapter.getAuthorizationUrl({
      provider,
      callbackUrl,
      state,
    });

    return NextResponse.redirect(authUrl);
  } catch (err: any) {
    return NextResponse.json(
      {
        success: false,
        error: err.message || '获取授权跳转链接失败',
      },
      { status: 500 }
    );
  }
}
