import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import { saveUserConnector, deleteMcpAuth } from '@/lib/user-store';
import { MCP_TOKEN_ENV_VARS, getMcpConnectorDef } from '@/lib/mcp-connectors';
import { getAgentBackend } from '@/lib/agent-backend';
import { resolveConnectorAuth } from '@/lib/connector-bridge';
import { buildStatusList } from '@/lib/mcp-status';

async function resyncUserServers(userId: string) {
  try {
    const backend = getAgentBackend();
    await backend.whenReady();
    const mcpSvc = backend.mcp;
    if (mcpSvc?.syncUserServers) {
      // 手动重连前也过一遍续期(临期的设备码 token 先换新再建连)
      const { ensureDeviceTokensFresh } = await import('@/lib/mcp-device-flow');
      await ensureDeviceTokensFresh(userId);
      const { buildUserMcpServers } = await import('@/lib/mcp-connectors');
      const servers = buildUserMcpServers(userId);
      await mcpSvc.syncUserServers(userId, servers);
    }
  } catch (e: any) {
    console.error('[connectors/mcp] resync failed:', e?.message);
  }
}

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json(
      { success: false, error: 'Unauthorized: 请先登录后查看 MCP 连接器' },
      { status: 401 }
    );
  }
  const connectors = buildStatusList(session.user.id);
  return NextResponse.json({
    success: true,
    total: connectors.length,
    connectedCount: connectors.filter((c) => c.status === 'connected').length,
    connectors,
  });
}

export async function POST(req: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json(
        { success: false, error: 'Unauthorized: 请先登录后操作' },
        { status: 401 }
      );
    }
    const userId = session.user.id;
    const body = await req.json();
    const { action, connectorId, token } = body;

    // 跳过任务中途授权请求（解冻等待中的 connector_authorize 工具，Agent 转浏览器兜底）
    if (action === 'skipSuggestion') {
      if (typeof connectorId !== 'string' || !connectorId) {
        return NextResponse.json({ success: false, error: '缺少 connectorId' }, { status: 400 });
      }
      const resolved = resolveConnectorAuth(userId, connectorId, 'skipped');
      return NextResponse.json({ success: true, resolved });
    }

    const def = typeof connectorId === 'string' ? getMcpConnectorDef(connectorId) : undefined;
    if (!def) {
      return NextResponse.json({ success: false, error: `未知的 MCP 连接器: ${connectorId}` }, { status: 400 });
    }

    if (action === 'saveToken') {
      // token 类粘贴凭证;optIn 类借同一通道存开关值 '1'(键同样受白名单约束)
      if ((def.authType !== 'token' && !def.optIn) || !def.tokenEnvVar || !MCP_TOKEN_ENV_VARS.has(def.tokenEnvVar)) {
        return NextResponse.json(
          { success: false, error: `连接器 ${def.id} 不支持粘贴凭证方式` },
          { status: 400 }
        );
      }
      if (typeof token !== 'string' || !token.trim()) {
        return NextResponse.json({ success: false, error: '凭证不能为空' }, { status: 400 });
      }
      saveUserConnector(userId, def.tokenEnvVar, token.trim());
      await resyncUserServers(userId);
      // 若此刻有任务正在等待该连接器授权（中途授权卡片 → 用户来连接器中心粘贴了凭证），解冻它
      resolveConnectorAuth(userId, def.id, 'authorized');
      return NextResponse.json({ success: true, connectors: buildStatusList(userId) });
    }

    if (action === 'disconnect') {
      // 清凭证 + OAuth 记录，并断开运行中的连接
      if (def.tokenEnvVar) saveUserConnector(userId, def.tokenEnvVar, '');
      deleteMcpAuth(userId, def.id);
      try {
        await getAgentBackend().whenReady();
        const mcpSvc = getAgentBackend().mcp;
        for (const s of def.servers) {
          await mcpSvc?.disconnectUser?.(userId, s.name);
        }
      } catch {
        // ignore
      }
      return NextResponse.json({ success: true, connectors: buildStatusList(userId) });
    }

    if (action === 'connect') {
      // 免凭证连接器的手动直连/重试（OAuth 走 start/callback，token 走 saveToken）
      await resyncUserServers(userId);
      return NextResponse.json({ success: true, connectors: buildStatusList(userId) });
    }

    return NextResponse.json({ success: false, error: `未知 action: ${action}` }, { status: 400 });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
