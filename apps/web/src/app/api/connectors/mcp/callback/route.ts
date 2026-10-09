import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import { mcpOAuthFlow } from '@agtpilot/plugin-mcp';
import { getAppBaseUrl } from '@/lib/connector-oauth';
import { getMcpConnectorDef, MCP_OAUTH_STATE_COOKIE } from '@/lib/mcp-connectors';
import { UserMcpOAuthProvider } from '@/lib/mcp-oauth-provider';
import { getAgentBackend } from '@/lib/agent-backend';
import { resolveConnectorAuth } from '@/lib/connector-bridge';

/**
 * GET /api/connectors/mcp/callback?code=...&state=...
 * MCP 一键授权回调：state 三重校验（值/连接器/用户）→ SDK 用保存的 PKCE
 * verifier 换 token → 加密落盘到用户空间 → 预热连接（立即挂工具）→ 跳回连接器中心。
 */
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const code = searchParams.get('code');
  const state = searchParams.get('state');
  const error = searchParams.get('error');
  const errorDescription = searchParams.get('error_description');
  const baseUrl = getAppBaseUrl(req);

  const fail = (msg: string) => {
    const res = NextResponse.redirect(
      `${baseUrl}/?tab=connectors&error=${encodeURIComponent(msg)}`
    );
    res.cookies.delete(MCP_OAUTH_STATE_COOKIE);
    return res;
  };

  if (error) {
    return fail(errorDescription || error);
  }
  if (!code || !state) {
    return fail('缺少授权 code 或 state 参数');
  }

  // 必须已登录：token 只有绑定到具体用户才有意义
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) {
    return fail('登录状态已失效，请重新登录后再授权');
  }

  // CSRF 校验：state 必须与 start 阶段写入 httpOnly cookie 的值一致，且同一用户、同一连接器
  const stored = req.cookies.get(MCP_OAUTH_STATE_COOKIE)?.value || '';
  const [savedState, savedConnectorId, savedUserId] = stored.split('|');
  if (!savedState || savedState !== state || savedUserId !== userId) {
    return fail('state 校验失败（可能存在 CSRF 风险或授权已过期），请重新发起授权');
  }

  const def = getMcpConnectorDef(savedConnectorId);
  if (!def || def.authType !== 'oauth') {
    return fail(`未知的 MCP 连接器: ${savedConnectorId}`);
  }

  try {
    const serverUrl =
      typeof def.servers[0].url === 'function' ? def.servers[0].url('') : def.servers[0].url || '';
    const provider = new UserMcpOAuthProvider(userId, def.id, serverUrl, def.scope);

    // SDK 用已保存的 codeVerifier 完成 token 交换，tokens 经 provider 加密落盘
    const result = await mcpOAuthFlow(provider, { serverUrl, authorizationCode: code });
    if (result !== 'AUTHORIZED') {
      return fail('授权未完成，请重新发起一键授权');
    }

    // 预热连接：立即连上该用户的 MCP 服务器并挂载工具（失败不阻断，任务执行时会重试）
    try {
      const backend = getAgentBackend();
      await backend.initPlugins();
      const mcpSvc = (backend.ctx as any).mcp;
      if (mcpSvc?.syncUserServers) {
        const { buildUserMcpServers } = await import('@/lib/mcp-connectors');
        await mcpSvc.syncUserServers(userId, buildUserMcpServers(userId));
      }
    } catch (e: any) {
      console.error(`[mcp-oauth] warm connect failed for ${def.id}:`, e?.message);
    }

    // 若有任务正在中途等待该连接器授权（connector_authorize 挂起中），解冻并让其继续
    resolveConnectorAuth(userId, def.id, 'authorized');

    const okRes = NextResponse.redirect(
      `${baseUrl}/?tab=connectors&authorized=${encodeURIComponent(def.id)}`
    );
    okRes.cookies.delete(MCP_OAUTH_STATE_COOKIE);
    return okRes;
  } catch (err: any) {
    console.error(`[mcp-oauth] callback failed for ${def.id}:`, err);
    return fail(err?.message || 'MCP 授权换取 Token 失败');
  }
}
