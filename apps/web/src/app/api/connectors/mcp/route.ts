import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import { getUserConnectors, saveUserConnector, getMcpAuth, deleteMcpAuth } from '@/lib/user-store';
import {
  MCP_CONNECTOR_DEFS,
  MCP_TOKEN_ENV_VARS,
  getMcpConnectorDef,
} from '@/lib/mcp-connectors';
import { getAgentBackend } from '@/lib/agent-backend';
import type { McpConnectorInfo } from '@/types/agent';

/**
 * MCP 连接器管理 API
 * GET  /api/connectors/mcp —— 列出全部 MCP 连接器与当前用户的连接状态
 * POST /api/connectors/mcp —— { action: 'saveToken' | 'disconnect' | 'connect', connectorId, token? }
 */

function maskSecret(val: string): string {
  return val.length > 8 ? `****${val.slice(-4)}` : '****';
}

function buildStatusList(userId: string): McpConnectorInfo[] {
  const { configs } = getUserConnectors(userId);

  // 运行中后端的用户级 MCP 连接状态（工具数/错误），后端未就绪时为空
  let liveServers: Array<{ name: string; toolsCount: number; error?: string }> = [];
  try {
    const backend = getAgentBackend();
    const mcpSvc = (backend.ctx as any).mcp;
    if (mcpSvc?.listUserServers) {
      liveServers = mcpSvc.listUserServers(userId);
    }
  } catch {
    // ignore
  }
  const liveByName = new Map(liveServers.map((s) => [s.name, s]));

  return MCP_CONNECTOR_DEFS.map((def) => {
    let connected = false;
    let keyMasked: string | undefined;

    if (def.authType === 'token') {
      const cred = (configs[def.tokenEnvVar!] || '').trim();
      connected = Boolean(cred);
      if (cred) keyMasked = maskSecret(cred);
    } else if (def.authType === 'oauth') {
      const record = getMcpAuth(userId, def.id);
      connected = Boolean(record?.tokens?.access_token);
      if (connected) keyMasked = '****已授权';
    } else {
      connected = true; // 免凭证直连，永远可用
    }

    // 工具数与最近错误取自运行中的用户级连接
    let toolCount = 0;
    let lastError: string | undefined;
    for (const s of def.servers) {
      const live = liveByName.get(s.name);
      if (live) {
        toolCount += live.toolsCount;
        if (live.error) lastError = live.error;
      }
    }

    return {
      id: def.id,
      name: def.name,
      icon: def.icon,
      category: def.category,
      description: def.description,
      authType: def.authType,
      status: connected ? 'connected' : 'unconfigured',
      keyMasked,
      quickAuthUrl: def.quickAuthUrl,
      authHint: def.authHint,
      docUrl: def.docUrl,
      toolCount: toolCount > 0 ? toolCount : undefined,
      lastError: connected ? lastError : undefined,
    };
  });
}

/** 保存/断开后立即把用户连接同步进运行中的后端（热生效，无需重启） */
async function resyncUserServers(userId: string) {
  try {
    const backend = getAgentBackend();
    await backend.initPlugins();
    const mcpSvc = (backend.ctx as any).mcp;
    if (mcpSvc?.syncUserServers) {
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

    const def = typeof connectorId === 'string' ? getMcpConnectorDef(connectorId) : undefined;
    if (!def) {
      return NextResponse.json({ success: false, error: `未知的 MCP 连接器: ${connectorId}` }, { status: 400 });
    }

    if (action === 'saveToken') {
      if (def.authType !== 'token' || !def.tokenEnvVar || !MCP_TOKEN_ENV_VARS.has(def.tokenEnvVar)) {
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
      return NextResponse.json({ success: true, connectors: buildStatusList(userId) });
    }

    if (action === 'disconnect') {
      // 清凭证 + OAuth 记录，并断开运行中的连接
      if (def.tokenEnvVar) saveUserConnector(userId, def.tokenEnvVar, '');
      deleteMcpAuth(userId, def.id);
      try {
        const mcpSvc = (getAgentBackend().ctx as any).mcp;
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
