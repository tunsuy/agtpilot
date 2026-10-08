import type { ToolDefinition } from '@agtpilot/core';
import { getMcpAuth, getUserConnectors } from './user-store';
import { MCP_CONNECTOR_DEFS, getMcpConnectorDef, buildUserMcpServers } from './mcp-connectors';

/**
 * 任务中途连接器授权桥（二期核心）
 *
 * 场景：任务执行到一半，Agent 发现需要某个平台的能力（如 Notion），但用户
 * 还没授权该连接器。此时 Agent 调用任务级工具 connector_authorize：
 * 1. 前端驾驶舱实时弹出授权卡片（connector_suggestion 事件）；
 * 2. 工具挂起等待（最长 5 分钟），用户点「一键授权」走完 OAuth 后由
 *    callback 路由 resolve；粘贴凭证类在连接器中心保存 Token 时同样 resolve；
 *    用户也可以点「跳过」，Agent 收到结果后改用 browser_ 工具兜底；
 * 3. 授权成功 → 立即热同步该用户的 MCP 连接 → 返回新挂载的工具清单，
 *    Agent 用 mcp_call 代理工具直接调用（任务启动时工具表已冻结，中途
 *    新授权的连接器工具只能通过 mcp_call 动态调用）。
 *
 * pending 注册表是模块级单例：Next dev/prod 下 lib 模块在同一 server 进程内
 * 共享，OAuth callback / saveToken / skip 三个入口都能命中同一个 promise。
 */

export type ConnectorAuthOutcome = 'authorized' | 'skipped' | 'timeout';

/** 授权等待上限：5 分钟（超时后 Agent 收到提示走浏览器兜底） */
const AUTH_WAIT_TIMEOUT_MS = 5 * 60 * 1000;

interface PendingAuth {
  resolve: (outcome: ConnectorAuthOutcome) => void;
  timer: ReturnType<typeof setTimeout>;
}

const pendingAuths = new Map<string, PendingAuth>();

const pendingKey = (userId: string, connectorId: string) => `${userId}::${connectorId}`;

/** 由 OAuth callback / saveToken / skip 路由调用，解冻等待中的任务工具 */
export function resolveConnectorAuth(
  userId: string,
  connectorId: string,
  outcome: ConnectorAuthOutcome
): boolean {
  const key = pendingKey(userId, connectorId);
  const pending = pendingAuths.get(key);
  if (!pending) return false;
  clearTimeout(pending.timer);
  pendingAuths.delete(key);
  pending.resolve(outcome);
  return true;
}

/** 该用户该连接器是否有任务正在等待授权（UI 状态查询用） */
export function hasPendingConnectorAuth(userId: string, connectorId: string): boolean {
  return pendingAuths.has(pendingKey(userId, connectorId));
}

function waitForConnectorAuth(userId: string, connectorId: string): Promise<ConnectorAuthOutcome> {
  const key = pendingKey(userId, connectorId);
  // 同键重复请求：先解冻旧的（按跳过处理），避免泄漏悬挂 promise
  const old = pendingAuths.get(key);
  if (old) {
    clearTimeout(old.timer);
    old.resolve('skipped');
  }
  return new Promise<ConnectorAuthOutcome>((resolve) => {
    const timer = setTimeout(() => {
      pendingAuths.delete(key);
      resolve('timeout');
    }, AUTH_WAIT_TIMEOUT_MS);
    pendingAuths.set(key, { resolve, timer });
  });
}

export interface ConnectorHubDeps {
  userId: string;
  /** 事件出口：走 ctx.agent.emitEvent → agent-backend.handleEvent → SSE */
  emit: (event: { type: string; payload: Record<string, any>; timestamp: number }) => void;
  /** 取 MCPService（延迟访问，插件未就绪时返回 undefined） */
  getMcpSvc: () => any;
}

/** 判断某连接器对该用户是否「已就绪」（凭证齐备，无论连接是否成功） */
function isConnectorConfigured(userId: string, connectorId: string): boolean {
  const def = getMcpConnectorDef(connectorId);
  if (!def) return false;
  if (def.authType === 'none') return true;
  if (def.authType === 'token') {
    const { configs } = getUserConnectors(userId);
    return Boolean((configs[def.tokenEnvVar!] || '').trim());
  }
  const record = getMcpAuth(userId, def.id);
  return Boolean(record?.tokens?.access_token);
}

/** 列出某用户视角下全部 MCP 连接器与状态（Agent 决策 + 前端展示共用逻辑） */
export function listConnectorStatus(userId: string, mcpSvc: any) {
  const live = new Map<string, { toolsCount: number; error?: string }>();
  try {
    for (const s of mcpSvc?.listUserServers?.(userId) || []) {
      live.set(s.name, { toolsCount: s.toolsCount, error: s.error });
    }
  } catch {
    // ignore
  }
  return MCP_CONNECTOR_DEFS.map((def) => {
    const configured = isConnectorConfigured(userId, def.id);
    const servers = def.servers
      .map((s) => live.get(s.name))
      .filter(Boolean) as Array<{ toolsCount: number; error?: string }>;
    const toolCount = servers.reduce((n, s) => n + s.toolsCount, 0);
    return {
      id: def.id,
      name: def.name,
      description: def.description,
      authType: def.authType,
      status: configured ? 'configured' : 'needs_auth',
      toolCount,
      lastError: servers.find((s) => s.error)?.error,
    };
  });
}

/**
 * 构建两个任务级工具（taskTools 注入，不进全局注册表）：
 * - connector_authorize：向用户发起中途授权请求并等待结果；
 * - mcp_call：按名字代理调用该用户任意已挂载的 MCP 工具（覆盖任务中途新授权的连接器）。
 */
export function buildConnectorBridgeTools(deps: ConnectorHubDeps): ToolDefinition[] {
  const { userId, emit, getMcpSvc } = deps;

  const collectNewTools = async (connectorId: string) => {
    const def = getMcpConnectorDef(connectorId);
    const mcpSvc = getMcpSvc();
    if (!def || !mcpSvc?.syncUserServers) return [];
    try {
      await mcpSvc.syncUserServers(userId, buildUserMcpServers(userId));
      const all = await mcpSvc.getUserTools(userId);
      const prefixes = def.servers.map((s) => `mcp_${s.name}_`);
      return all
        .filter((t: any) => prefixes.some((p) => t.name.startsWith(p)))
        .map((t: any) => ({ name: t.name, description: t.description, parameters: t.parameters }));
    } catch (e: any) {
      return [{ error: e?.message || String(e) }];
    }
  };

  const connectorAuthorize: ToolDefinition = {
    name: 'connector_authorize',
    description:
      '当任务需要某平台能力（如 Notion 文档、滴答清单日程、高德地图）但对应 MCP 连接器尚未授权时调用：' +
      '向用户弹出授权卡片并等待其完成一键授权/粘贴凭证（最长 5 分钟）。' +
      '授权成功后返回新挂载的工具清单，之后用 mcp_call 工具按名字调用它们。' +
      '可先用 action=list 查看当前所有连接器的授权状态。用户跳过或超时时，改用 browser_ 系列工具兜底完成任务。',
    dangerLevel: 'medium',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'request'],
          description: 'list = 查看全部连接器及授权状态；request = 对指定连接器发起中途授权请求',
        },
        connectorId: { type: 'string', description: 'action=request 时必填，连接器 id（从 list 结果中取）' },
        reason: { type: 'string', description: 'action=request 时必填，一句话向用户解释为什么需要这个连接器' },
      },
      required: ['action'],
    },
    execute: async ({ action, connectorId, reason }) => {
      if (action === 'list') {
        return { connectors: listConnectorStatus(userId, getMcpSvc()) };
      }
      if (action !== 'request' || !connectorId) {
        return { error: 'action 必须是 list 或 request（request 需带 connectorId 与 reason）' };
      }
      const def = getMcpConnectorDef(connectorId);
      if (!def) {
        return {
          error: `未知连接器: ${connectorId}`,
          available: MCP_CONNECTOR_DEFS.map((d) => ({ id: d.id, name: d.name })),
        };
      }
      if (def.authType === 'none') {
        return { already: true, message: `${def.name} 免凭证直连，无需授权，其工具已挂载（mcp_${def.servers[0].name}_ 前缀）。` };
      }
      // 已配置凭证：直接热同步并返回工具，不打扰用户
      if (isConnectorConfigured(userId, connectorId)) {
        const tools = await collectNewTools(connectorId);
        return {
          already: true,
          message: `${def.name} 已授权。`,
          tools,
          howToCall: '用 mcp_call 工具调用上述 name，args 按其 parameters 传参。',
        };
      }

      // 发起中途授权：先挂 pending 再发事件，避免用户秒点授权时 resolve 落空
      const suggestionId = pendingKey(userId, connectorId);
      const waitPromise = waitForConnectorAuth(userId, connectorId);
      emit({
        type: 'connector_suggestion',
        payload: {
          id: suggestionId,
          connectorId: def.id,
          connectorName: def.name,
          authType: def.authType,
          reason: reason || `任务需要访问 ${def.name}`,
          authorizeUrl:
            def.authType === 'oauth'
              ? `/api/connectors/mcp/start?connector=${encodeURIComponent(def.id)}`
              : undefined,
        },
        timestamp: Date.now(),
      });

      const outcome = await waitPromise;
      emit({
        type: 'connector_suggestion_resolved',
        payload: { id: suggestionId, connectorId: def.id, outcome },
        timestamp: Date.now(),
      });

      if (outcome === 'authorized') {
        const tools = await collectNewTools(connectorId);
        return {
          authorized: true,
          message: `用户已完成 ${def.name} 授权，工具已挂载。`,
          tools,
          howToCall: '用 mcp_call 工具调用上述 name（server 传连接器 id），args 按其 parameters 传参。',
        };
      }
      if (outcome === 'timeout') {
        return {
          authorized: false,
          message: `等待 ${def.name} 授权超时（5 分钟）。请改用 browser_ 系列工具在网页上直接完成任务，不要再等待授权。`,
        };
      }
      return {
        authorized: false,
        message: `用户跳过了 ${def.name} 授权。请尊重用户选择，改用 browser_ 系列工具在网页上直接完成任务。`,
      };
    },
  };

  const mcpCall: ToolDefinition = {
    name: 'mcp_call',
    description:
      '代理调用当前用户已挂载的任意 MCP 连接器工具（工具名形如 mcp_notion_search）。' +
      '主要用于任务中途新授权的连接器（其工具不在本任务的初始工具表里）。' +
      '初始就挂载的 mcp_ 工具请优先直接调用，不必经过本工具。',
    dangerLevel: 'medium',
    parameters: {
      type: 'object',
      properties: {
        tool: { type: 'string', description: '要调用的 MCP 工具完整名称（如 mcp_notion_search）' },
        args: { type: 'object', description: '按该工具 parameters schema 传入的参数对象' },
      },
      required: ['tool'],
    },
    execute: async ({ tool, args }, session?: any) => {
      const mcpSvc = getMcpSvc();
      if (!mcpSvc?.getUserTools) return { error: 'MCP 服务未就绪' };
      const tools: ToolDefinition[] = await mcpSvc.getUserTools(userId);
      const target = tools.find((t) => t.name === tool);
      if (!target) {
        return {
          error: `未找到用户 MCP 工具: ${tool}`,
          available: tools.map((t) => t.name),
          hint: '若连接器尚未授权，先用 connector_authorize 发起授权。',
        };
      }
      return target.execute(args || {}, session);
    },
  };

  return [connectorAuthorize, mcpCall];
}
