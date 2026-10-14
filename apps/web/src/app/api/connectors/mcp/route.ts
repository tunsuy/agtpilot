import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import { getUserConnectors, saveUserConnector, getMcpAuth, deleteMcpAuth } from '@/lib/user-store';
import {
  MCP_CONNECTOR_DEFS,
  MCP_TOKEN_ENV_VARS,
  getMcpConnectorDef,
  deviceFlowAvailable,
  subagentAvailability,
  type SubagentAvailability,
} from '@/lib/mcp-connectors';
import { getAgentBackend } from '@/lib/agent-backend';
import { resolveConnectorAuth } from '@/lib/connector-bridge';
import type { McpConnectorInfo } from '@/types/agent';

/**
 * MCP 连接器管理 API
 * GET  /api/connectors/mcp —— 列出全部 MCP 连接器与当前用户的连接状态
 * POST /api/connectors/mcp —— { action: 'saveToken' | 'disconnect' | 'connect' | 'skipSuggestion', connectorId, token? }
 */

function maskSecret(val: string): string {
  return val.length > 8 ? `****${val.slice(-4)}` : '****';
}

function buildStatusList(userId: string): McpConnectorInfo[] {
  const { configs } = getUserConnectors(userId);

  // 运行中后端的用户级 MCP 连接状态（工具数/只读数/错误），后端未就绪时为空
  let liveServers: Array<{
    name: string;
    toolsCount: number;
    readOnlyCount?: number;
    heuristicReadOnlyCount?: number;
    error?: string;
  }> = [];
  try {
    const mcpSvc = getAgentBackend().mcp;
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
      if (cred) {
        connected = true;
        // gho_ 前缀 = 设备码授权换来的 OAuth token(短期 token 会自动续期);其余按普通粘贴凭证掩码
        if (cred.startsWith('gho_')) {
          const autoRenew = Boolean(getMcpAuth(userId, def.id)?.tokenRefresh?.refreshToken);
          keyMasked = `设备码已授权 ${maskSecret(cred)}${autoRenew ? ' · 自动续期' : ''}`;
        } else {
          keyMasked = maskSecret(cred);
        }
      } else if (def.defaultCred) {
        // 用户未配自有 key,但连接器内置缺省公共凭证(如飞猪公共试用 key)→ 开箱即用
        connected = true;
        keyMasked = '公共试用通道';
      }
    } else if (def.authType === 'oauth') {
      const record = getMcpAuth(userId, def.id);
      connected = Boolean(record?.tokens?.access_token);
      if (connected) keyMasked = '****已授权';
    } else if (def.optIn && def.tokenEnvVar) {
      // opt-in 免凭证连接器:用户显式启用(存 '1')才算已连接
      connected = (configs[def.tokenEnvVar] || '').trim() === '1';
      if (connected) keyMasked = '已启用';
    } else {
      connected = true; // 免凭证直连，永远可用
    }

    // 工具数/只读数与最近错误取自运行中的用户级连接;子 agent 可用性逐服务器判定后合并
    let toolCount = 0;
    let readOnlyCount = 0;
    let heuristicReadOnlyCount = 0;
    let lastError: string | undefined;
    const RANK: Record<SubagentAvailability, number> = {
      escape: 3,
      ready: 2,
      'needs-measurement': 1,
      closed: 0,
    };
    let availability: SubagentAvailability = 'closed';
    for (const s of def.servers) {
      const live = liveByName.get(s.name);
      const tc = live?.toolsCount ?? 0;
      const rc = live?.readOnlyCount ?? 0;
      toolCount += tc;
      readOnlyCount += rc;
      heuristicReadOnlyCount += live?.heuristicReadOnlyCount ?? 0;
      if (live?.error) lastError = live.error;
      const a = subagentAvailability(s.name, { flagged: s.subagentOpen, toolCount: tc, readOnlyCount: rc });
      if (RANK[a] > RANK[availability]) availability = a;
    }

    return {
      id: def.id,
      name: def.name,
      icon: def.icon,
      category: def.category,
      description: def.description,
      authType: def.authType,
      optIn: def.optIn,
      status: connected ? 'connected' : 'unconfigured',
      keyMasked,
      deviceFlow: def.deviceFlow ? { available: deviceFlowAvailable(def) } : undefined,
      quickAuthUrl: def.quickAuthUrl,
      authHint: def.authHint,
      docUrl: def.docUrl,
      toolCount: toolCount > 0 ? toolCount : undefined,
      lastError: connected ? lastError : undefined,
      subagent: {
        open: def.servers.some((s) => s.subagentOpen),
        availability,
        readOnlyCount: toolCount > 0 ? readOnlyCount : undefined,
        heuristicReadOnlyCount: toolCount > 0 ? heuristicReadOnlyCount : undefined,
      },
    };
  });
}

/** 保存/断开后立即把用户连接同步进运行中的后端（热生效，无需重启） */
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
