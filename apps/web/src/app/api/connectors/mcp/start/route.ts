import { NextRequest, NextResponse } from 'next/server';
import { randomBytes } from 'crypto';
import { auth } from '@/auth';
import { mcpOAuthFlow } from '@agtpilot/plugin-mcp';
import { getAppBaseUrl } from '@/lib/connector-oauth';
import { getMcpConnectorDef, MCP_OAUTH_STATE_COOKIE } from '@/lib/mcp-connectors';
import { UserMcpOAuthProvider } from '@/lib/mcp-oauth-provider';

/**
 * GET /api/connectors/mcp/start?connector=notion_mcp
 * MCP 标准 OAuth「一键授权」发起端：
 * SDK 自动完成 RFC 9728 受保护资源元数据发现 → RFC 8414/OIDC 授权服务器发现 →
 * RFC 7591 动态客户端注册（DCR）→ PKCE(S256) 授权 URL 构造，本路由只负责
 * 登录校验、CSRF state cookie 与 302 跳转。
 */
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const connectorId = searchParams.get('connector');
  const baseUrl = getAppBaseUrl(req);

  const fail = (msg: string) =>
    NextResponse.redirect(`${baseUrl}/?tab=connectors&error=${encodeURIComponent(msg)}`);

  const def = connectorId ? getMcpConnectorDef(connectorId) : undefined;
  if (!def || def.authType !== 'oauth') {
    return fail(`不支持一键授权的 MCP 连接器: ${connectorId || '(空)'}`);
  }

  const session = await auth();
  if (!session?.user?.id) {
    return fail('请先登录后再进行 MCP 授权');
  }
  const userId = session.user.id;

  try {
    const serverUrl =
      typeof def.servers[0].url === 'function' ? def.servers[0].url('') : def.servers[0].url || '';
    const provider = new UserMcpOAuthProvider(userId, def.id, serverUrl, def.scope);

    // SDK 编排完整授权流程；REDIRECT 时授权 URL 被 provider 捕获
    const result = await mcpOAuthFlow(provider, { serverUrl, scope: def.scope });

    if (result === 'AUTHORIZED') {
      // 已有有效 token（无需重新授权）
      return NextResponse.redirect(
        `${baseUrl}/?tab=connectors&authorized=${encodeURIComponent(def.id)}`
      );
    }

    if (!provider.pendingAuthorizationUrl) {
      return fail('授权服务器未返回跳转地址，请稍后重试');
    }

    // CSRF state：密码学安全随机，绑定用户与连接器写入 httpOnly cookie（与原生 OAuth 同款三重校验）
    const state = randomBytes(24).toString('hex');
    const res = NextResponse.redirect(provider.pendingAuthorizationUrl.toString());
    res.cookies.set(MCP_OAUTH_STATE_COOKIE, `${state}|${def.id}|${userId}`, {
      httpOnly: true,
      sameSite: 'lax',
      secure: baseUrl.startsWith('https://'),
      maxAge: 600, // 10 分钟内完成授权
      path: '/',
    });
    return res;
  } catch (err: any) {
    console.error(`[mcp-oauth] start failed for ${def.id}:`, err);
    return fail(err?.message || '发起 MCP 授权失败');
  }
}
