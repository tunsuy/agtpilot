import { Context, Service } from '@deepseek-ai/cordis';
import { ToolDefinition } from '@agtpilot/core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';

export const name = 'agtpilot-plugin-mcp';
export const inject = ['agent'];

// 重导出 MCP SDK 授权编排器与类型：供 apps/web 一键授权路由与 OAuthClientProvider
// 实现直接使用（pnpm 严格依赖隔离下 apps/web 不直接依赖 SDK，避免新增安装）
export { auth as mcpOAuthFlow, UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
export type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
export type {
  OAuthTokens,
  OAuthClientMetadata,
  OAuthClientInformationMixed,
} from '@modelcontextprotocol/sdk/shared/auth.js';

/**
 * MCP 连接器插件（自研连接器体系 · 一期）
 *
 * 两层连接管理：
 * 1. 进程级（activeClients）：CLI/单机场景，config.servers 预连接 +
 *    mcp_connect_stdio / mcp_connect_sse 管理工具，工具注册进全局注册表（历史行为，保持不变）。
 * 2. 用户级（userClients，key = `${userId}::${serverName}`）：多用户 Web 场景，
 *    连接与工具定义按用户隔离，【不进全局注册表】，由调用方（agent-backend）
 *    通过 getUserTools() 取出后以 runTask({ taskTools }) 任务级注入，
 *    杜绝 A 用户的连接器工具泄漏给 B 用户的任务。
 *
 * 凭证注入三种方式（按用户友好度排序）：
 * - authProvider：MCP 标准 OAuth（RFC 9728/8414/7591 + PKCE），SDK 自动发现、
 *   动态注册、换 token、401 自动刷新 —— 对应前端「一键授权」；
 * - headers：静态请求头（Bearer / 自定义头）—— 对应「粘贴 Token」；
 * - url 内嵌 query key（如高德 ?key= / 百度 ?ak=）—— 同样走「粘贴 Token」。
 */

export interface MCPServerConfig {
  name: string;
  /** http = Streamable HTTP（首选）；sse = 旧式 SSE；stdio = 本地子进程 */
  transport: 'stdio' | 'sse' | 'http';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  /** 静态凭证请求头（如 { Authorization: 'Bearer xx' }），http/sse 有效 */
  headers?: Record<string, string>;
  /** MCP 标准 OAuth provider；http/sse 有效，SDK 自动处理 token 附加与刷新 */
  authProvider?: OAuthClientProvider;
}

export interface MCPPluginConfig {
  servers?: MCPServerConfig[];
}

/** 工具名净化：模型 API 普遍要求 ^[a-zA-Z0-9_-]{1,64}$ */
export function sanitizeToolName(name: string): string {
  let s = name.replace(/[^a-zA-Z0-9_-]/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '');
  if (s.length > 64) s = s.slice(0, 64);
  return s || 'tool';
}

/** 判断是否为「连接已断」类错误（值得重连重试一次），区别于业务/权限错误 */
function isConnectionError(err: any): boolean {
  const msg = String(err?.message || err || '').toLowerCase();
  return (
    msg.includes('not connected') ||
    msg.includes('connection closed') ||
    msg.includes('econnreset') ||
    msg.includes('econnrefused') ||
    msg.includes('epipe') ||
    msg.includes('socket hang up') ||
    msg.includes('transport') ||
    msg.includes('terminated') ||
    err?.code === 'ECONNRESET' ||
    err?.code === 'EPIPE'
  );
}

/** 单条用户级连接：持有 client，支持断线自动重连一次 */
class UserConnection {
  private client: Client | null = null;
  private connecting: Promise<Client> | null = null;
  tools: ToolDefinition[] = [];
  lastError = '';

  constructor(
    private readonly userId: string,
    readonly config: MCPServerConfig,
    private readonly onEvent: (event: any) => void
  ) {}

  /** 连接指纹：url/headers/command 等不变则复用现有连接（token 由 authProvider 请求时动态读取，不参与指纹） */
  fingerprint(): string {
    const c = this.config;
    return JSON.stringify({
      t: c.transport,
      u: c.url,
      h: c.headers,
      cmd: c.command,
      a: c.args,
      e: c.env,
      oauth: Boolean(c.authProvider),
    });
  }

  private buildTransport(): StdioClientTransport | SSEClientTransport | StreamableHTTPClientTransport {
    const c = this.config;
    if (c.transport === 'stdio') {
      if (!c.command) throw new Error('stdio 类型的 MCP Server 必须提供 command 启动参数。');
      return new StdioClientTransport({
        command: c.command,
        args: c.args || [],
        env: Object.fromEntries(
          Object.entries({ ...process.env, ...(c.env || {}) }).filter(([, v]) => typeof v === 'string')
        ) as Record<string, string>,
      });
    }
    if (!c.url) throw new Error(`${c.transport} 类型的 MCP Server 必须提供 url 参数。`);
    const url = new URL(c.url);
    if (c.transport === 'http') {
      return new StreamableHTTPClientTransport(url, {
        authProvider: c.authProvider,
        requestInit: c.headers ? { headers: { ...c.headers } } : undefined,
      });
    }
    return new SSEClientTransport(url, {
      authProvider: c.authProvider,
      requestInit: c.headers ? { headers: { ...c.headers } } : undefined,
    });
  }

  async connect(): Promise<Client> {
    if (this.client) return this.client;
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      const client = new Client(
        { name: `agtpilot-${this.config.name}-client`, version: '0.1.0' },
        { capabilities: {} }
      );
      await client.connect(this.buildTransport());
      this.client = client;
      this.lastError = '';
      const { tools } = await client.listTools();
      this.tools = this.buildToolDefs(tools);
      return client;
    })().finally(() => {
      this.connecting = null;
    });
    try {
      return await this.connecting;
    } catch (err: any) {
      this.lastError = err?.message || String(err);
      throw err;
    }
  }

  /** 断开后重建（token 已刷新 / 网络恢复场景） */
  private async reconnect(): Promise<Client> {
    await this.close();
    return this.connect();
  }

  async close() {
    const c = this.client;
    this.client = null;
    this.tools = [];
    if (c) {
      try {
        await c.close();
      } catch {
        // ignore
      }
    }
  }

  private buildToolDefs(tools: any[]): ToolDefinition[] {
    const used = new Set<string>();
    const defs: ToolDefinition[] = [];
    for (const tool of tools) {
      let toolName = sanitizeToolName(`mcp_${this.config.name}_${tool.name}`);
      // 同名冲突（净化后撞名）时追加序号，保证任务内工具名唯一
      let n = 2;
      const base = toolName;
      while (used.has(toolName)) toolName = `${base.slice(0, 60)}_${n++}`;
      used.add(toolName);

      const originalName = tool.name;
      const serverName = this.config.name;
      defs.push({
        name: toolName,
        description: `[MCP连接器: ${serverName}] ${tool.description || originalName}`,
        parameters: (tool.inputSchema as any) || { type: 'object', properties: {} },
        dangerLevel: 'medium',
        execute: async (args: any) => {
          this.onEvent({
            type: 'tool_call',
            payload: { tool: toolName, mcpServer: serverName, mcpTool: originalName, args },
            timestamp: Date.now(),
          });
          const call = async (client: Client) =>
            client.callTool({ name: originalName, arguments: args || {} });
          try {
            const client = await this.connect();
            return await call(client);
          } catch (err: any) {
            // 连接类错误：重连重试一次；仍失败（或 401 未授权）则返回带指引的错误
            if (isConnectionError(err)) {
              try {
                const fresh = await this.reconnect();
                return await call(fresh);
              } catch (err2: any) {
                return {
                  error: `MCP 连接器 [${serverName}] 调用失败: ${err2?.message || err2}`,
                  hint: '若为授权过期，请到「连接器中心」重新授权该连接器。',
                };
              }
            }
            const unauthorized =
              err?.name === 'UnauthorizedError' || /401|unauthorized/i.test(String(err?.message));
            return {
              error: `MCP 连接器 [${serverName}] 调用失败: ${err?.message || err}`,
              ...(unauthorized
                ? { hint: '授权已失效，请到「连接器中心」重新授权该连接器。' }
                : {}),
            };
          }
        },
      });
    }
    return defs;
  }
}

export interface SyncUserServersResult {
  connected: string[];
  reused: string[];
  failed: Array<{ name: string; error: string }>;
  removed: string[];
}

export class MCPService extends Service {
  /** 进程级连接（CLI 场景，工具注册进全局注册表） */
  private activeClients = new Map<string, { client: Client; tools: string[] }>();
  /** 用户级连接隔离池：`${userId}::${serverName}` → UserConnection */
  private userClients = new Map<string, UserConnection>();

  constructor(ctx: Context) {
    super(ctx, 'mcp');
  }

  // ---- 用户级 API（多用户 Web 场景，供 agent-backend 调用）----

  /**
   * 全量对齐某用户的 MCP 服务器清单：新增的连接、指纹未变的复用、
   * 清单里已移除的断开。单个失败不阻断其余（failed 里返回）。
   */
  async syncUserServers(userId: string, servers: MCPServerConfig[]): Promise<SyncUserServersResult> {
    const result: SyncUserServersResult = { connected: [], reused: [], failed: [], removed: [] };
    const prefix = `${userId}::`;
    const wanted = new Map<string, MCPServerConfig>();
    for (const s of servers) wanted.set(`${prefix}${s.name}`, s);

    // 1. 断开用户清单里已不存在的连接
    for (const [key, conn] of Array.from(this.userClients.entries())) {
      if (!key.startsWith(prefix)) continue;
      if (!wanted.has(key)) {
        await conn.close();
        this.userClients.delete(key);
        result.removed.push(conn.config.name);
      }
    }

    // 2. 新增或复用（指纹一致且已有工具 → 直接复用；一致但上次失败 → 原地重试；不一致 → 重建）
    const emit = (event: any) => this.ctx.agent.emitEvent(event);
    for (const [key, cfg] of wanted) {
      const existing = this.userClients.get(key);
      const candidate = new UserConnection(userId, cfg, emit);
      if (existing && existing.fingerprint() === candidate.fingerprint()) {
        if (existing.tools.length > 0) {
          result.reused.push(cfg.name);
          continue;
        }
        try {
          await existing.connect();
          result.connected.push(cfg.name);
        } catch (err: any) {
          result.failed.push({ name: cfg.name, error: err?.message || String(err) });
        }
        continue;
      }
      if (existing) await existing.close();
      this.userClients.set(key, candidate);
      try {
        await candidate.connect();
        result.connected.push(cfg.name);
      } catch (err: any) {
        result.failed.push({ name: cfg.name, error: err?.message || String(err) });
      }
    }
    return result;
  }

  /** 取某用户当前全部可用的 MCP 工具定义（任务级注入用，不进全局注册表） */
  async getUserTools(userId: string): Promise<ToolDefinition[]> {
    const prefix = `${userId}::`;
    const tools: ToolDefinition[] = [];
    for (const [key, conn] of this.userClients) {
      if (key.startsWith(prefix)) tools.push(...conn.tools);
    }
    return tools;
  }

  /** 断开某用户某个（或全部）MCP 连接 */
  async disconnectUser(userId: string, serverName?: string): Promise<string[]> {
    const prefix = `${userId}::`;
    const removed: string[] = [];
    for (const [key, conn] of Array.from(this.userClients.entries())) {
      if (!key.startsWith(prefix)) continue;
      if (serverName && conn.config.name !== serverName) continue;
      await conn.close();
      this.userClients.delete(key);
      removed.push(conn.config.name);
    }
    return removed;
  }

  /** 某用户当前连接状态（管理界面展示用） */
  listUserServers(userId: string): Array<{ name: string; toolsCount: number; error?: string }> {
    const prefix = `${userId}::`;
    const out: Array<{ name: string; toolsCount: number; error?: string }> = [];
    for (const [key, conn] of this.userClients) {
      if (key.startsWith(prefix)) {
        out.push({ name: conn.config.name, toolsCount: conn.tools.length, error: conn.lastError || undefined });
      }
    }
    return out;
  }

  // ---- 进程级 API（CLI 场景，历史行为）----

  /** 连接单个 MCP Server 并将其工具注册至全局注册表 */
  async connectServer(serverConfig: MCPServerConfig) {
    if (this.activeClients.has(serverConfig.name)) {
      return { success: false, error: `MCP Server [${serverConfig.name}] 已处于连接状态。` };
    }

    const client = new Client(
      { name: `agtpilot-${serverConfig.name}-client`, version: '0.1.0' },
      { capabilities: {} }
    );

    const conn = new UserConnection('__global__', serverConfig, (event) => this.ctx.agent.emitEvent(event));
    // 复用 UserConnection 的 transport 构建逻辑
    const transport = (conn as any).buildTransport();
    await client.connect(transport);

    const { tools } = await client.listTools();
    const registeredToolNames: string[] = [];
    const used = new Set<string>();

    for (const tool of tools) {
      let toolName = sanitizeToolName(`mcp_${serverConfig.name}_${tool.name}`);
      let n = 2;
      const base = toolName;
      while (used.has(toolName)) toolName = `${base.slice(0, 60)}_${n++}`;
      used.add(toolName);

      const originalName = tool.name;
      const serverName = serverConfig.name;
      this.ctx.agent.registerTool({
        name: toolName,
        description: `[MCP: ${serverName}] ${tool.description || ''}`,
        parameters: (tool.inputSchema as any) || { type: 'object', properties: {} },
        dangerLevel: 'medium',
        execute: async (args: any) => {
          this.ctx.agent.emitEvent({
            type: 'tool_call',
            payload: { tool: toolName, mcpServer: serverName, args },
            timestamp: Date.now(),
          });
          return client.callTool({ name: originalName, arguments: args });
        },
      });
      registeredToolNames.push(toolName);
    }

    this.activeClients.set(serverConfig.name, { client, tools: registeredToolNames });

    return {
      success: true,
      serverName: serverConfig.name,
      toolsCount: registeredToolNames.length,
      tools: registeredToolNames,
    };
  }

  /** 断开进程级连接 */
  async disconnectServer(serverName: string) {
    const info = this.activeClients.get(serverName);
    if (!info) return { success: false, error: `MCP Server [${serverName}] 未连接。` };
    try {
      await info.client.close();
    } catch {
      // ignore
    }
    this.activeClients.delete(serverName);
    return { success: true, serverName };
  }

  listServers() {
    return Array.from(this.activeClients.entries()).map(([srvName, info]) => ({
      name: srvName,
      toolsCount: info.tools.length,
      tools: info.tools,
    }));
  }

  async closeAll() {
    for (const [, info] of this.activeClients) {
      try {
        await info.client.close();
      } catch {
        // ignore
      }
    }
    this.activeClients.clear();
    for (const [, conn] of this.userClients) {
      await conn.close();
    }
    this.userClients.clear();
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    mcp: MCPService;
  }
}

export function apply(ctx: Context, config: MCPPluginConfig = {}) {
  // 工具路由自注册：prompt 命中外部工具服务类关键词时挂载本插件工具组
  ctx.agent.registerToolRoute({
    id: 'mcp',
    prefixes: ['mcp_'],
    test: /(mcp|外部工具服务)/i,
  });

  const svc = new MCPService(ctx);

  // 1. 暴露 mcp_connect_stdio 工具供 Agent 自主挂载本地 MCP Server
  ctx.agent.registerTool({
    name: 'mcp_connect_stdio',
    description: '连接一个基于标准输入输出 (Stdio) 的 Anthropic 官方 MCP Server，并自动将其暴露的所有工具动态挂载到微内核中',
    dangerLevel: 'high',
    parameters: {
      type: 'object',
      properties: {
        serverName: { type: 'string', description: '为该 MCP Server 指定的唯一别名 (如: "sqlite", "github", "filesystem")' },
        command: { type: 'string', description: '启动命令可执行文件 (如: "npx", "node", "uvx", "docker")' },
        args: {
          type: 'array',
          items: { type: 'string' },
          description: '启动命令参数列表 (如: ["-y", "@modelcontextprotocol/server-sqlite", "--db-path", "app.db"])',
        },
      },
      required: ['serverName', 'command'],
    },
    execute: async ({ serverName, command, args = [] }) => {
      try {
        return await svc.connectServer({ name: serverName, transport: 'stdio', command, args });
      } catch (err: any) {
        return { success: false, serverName, error: err.message };
      }
    },
  });

  // 2. 暴露 mcp_connect_sse 工具供 Agent 挂载远程 HTTP/SSE MCP Server
  ctx.agent.registerTool({
    name: 'mcp_connect_sse',
    description: '通过 Server-Sent Events (SSE) 连接远程托管的 MCP 服务端并动态挂载其工具',
    dangerLevel: 'medium',
    parameters: {
      type: 'object',
      properties: {
        serverName: { type: 'string', description: 'MCP 服务端别名标识' },
        url: { type: 'string', description: '远程 MCP SSE 端点 URL (如: "http://localhost:8000/sse")' },
      },
      required: ['serverName', 'url'],
    },
    execute: async ({ serverName, url }) => {
      try {
        return await svc.connectServer({ name: serverName, transport: 'sse', url });
      } catch (err: any) {
        return { success: false, serverName, error: err.message };
      }
    },
  });

  // 3. 暴露 mcp_connect_http 工具供 Agent 挂载 Streamable HTTP MCP Server（支持静态凭证头）
  ctx.agent.registerTool({
    name: 'mcp_connect_http',
    description: '通过 Streamable HTTP 连接远程 MCP 服务端（MCP 标准首选传输，支持 Authorization 等静态凭证头）并动态挂载其工具',
    dangerLevel: 'medium',
    parameters: {
      type: 'object',
      properties: {
        serverName: { type: 'string', description: 'MCP 服务端别名标识' },
        url: { type: 'string', description: '远程 MCP Streamable HTTP 端点 URL' },
        headers: {
          type: 'object',
          description: '可选：附加请求头（如 {"Authorization": "Bearer xx"}）',
          additionalProperties: { type: 'string' },
        },
      },
      required: ['serverName', 'url'],
    },
    execute: async ({ serverName, url, headers }) => {
      try {
        return await svc.connectServer({ name: serverName, transport: 'http', url, headers });
      } catch (err: any) {
        return { success: false, serverName, error: err.message };
      }
    },
  });

  // 4. 暴露 mcp_list_servers 工具查看当前已连接的 MCP 实例与挂载工具
  ctx.agent.registerTool({
    name: 'mcp_list_servers',
    description: '列出当前所有已成功连接的 MCP Server 及其已动态挂载至微内核的工具清单',
    dangerLevel: 'low',
    parameters: {
      type: 'object',
      properties: {},
    },
    execute: async () => {
      const servers = svc.listServers();
      return { success: true, serversCount: servers.length, servers };
    },
  });

  // 启动时自动连接配置文件中指定的预设 MCP Servers
  if (config.servers && config.servers.length > 0) {
    for (const s of config.servers) {
      svc.connectServer(s).catch((err) => {
        console.error(`[MCP Plugin] 自动连接 MCP Server [${s.name}] 失败:`, err.message);
      });
    }
  }

  // 退出时妥善关闭所有已连接的 MCP 客户端（进程级 + 用户级）
  ctx.on('dispose', async () => {
    await svc.closeAll();
  });
}
