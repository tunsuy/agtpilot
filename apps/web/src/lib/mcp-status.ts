/**
 * MCP 连接器状态装配（从 /api/connectors/mcp 路由抽出，
 * 供该路由与首屏聚合接口 /api/bootstrap 共用）。
 */
import { getUserConnectors, getMcpAuth } from '@/lib/user-store';
import {
  MCP_CONNECTOR_DEFS,
  deviceFlowAvailable,
  subagentAvailability,
  type SubagentAvailability,
} from '@/lib/mcp-connectors';
import { getAgentBackend } from '@/lib/agent-backend';
import type { McpConnectorInfo } from '@/types/agent';

function maskSecret(val: string): string {
  return val.length > 8 ? `****${val.slice(-4)}` : '****';
}

export function buildStatusList(userId: string): McpConnectorInfo[] {
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
      connected = Boolean(cred);
      if (cred === '1' && def.publicTrial) {
        // 哨兵 '1' = 用户在卡片手动启用了公共试用通道(非用户私有 key,不掩码)
        keyMasked = '公共试用通道';
      } else if (cred.startsWith('gho_')) {
        // gho_ 前缀 = 设备码授权换来的 OAuth token(短期 token 会自动续期);其余按普通粘贴凭证掩码
        const autoRenew = Boolean(getMcpAuth(userId, def.id)?.tokenRefresh?.refreshToken);
        keyMasked = `设备码已授权 ${maskSecret(cred)}${autoRenew ? ' · 自动续期' : ''}`;
      } else if (cred) {
        keyMasked = maskSecret(cred);
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
      publicTrial: def.publicTrial,
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
