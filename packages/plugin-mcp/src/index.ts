import { Context, Service } from '@deepseek-ai/cordis';
import { ToolDefinition } from '@agtpilot/core';
import { createHash } from 'node:crypto';
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
 * MCP 连接器插件（自研连接器体系 · 无头能力引擎形态）
 *
 * 插件只提供「连接管理」能力（进程级 connectServer/listServers + 用户级
 * syncUserServers/getUserTools/disconnectUser）；工具暴露归应用层：
 * - CLI 单用户：apps/cli/src/bin.ts 包装 mcp_connect_* 全局工具；
 * - Web 多用户：连接器中心（UI）+ getUserTools 任务级 taskTools 注入。
 * （旧版在插件里自注册 mcp_connect_* 全局工具，是反模式清单 #10 的复发：
 * 多用户部署下模型经全局工具建立的连接会泄漏到所有用户。）
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
    msg.includes('transport closed') ||
    msg.includes('terminated') ||
    err?.code === 'ECONNRESET' ||
    err?.code === 'EPIPE'
  );
}

/**
 * 远程端点安全校验：只允许 http(s)，并封禁云厂商元数据端点
 * （169.254.169.254 / fd00:ec2::254 —— 命中即可窃取宿主机云凭证）。
 * 本地地址（localhost/内网 IP）不封禁：本地 MCP Server 是合法常见用法。
 */
function assertSafeUrl(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`无效的 URL: ${rawUrl}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`只允许 http/https 协议的 MCP 端点，收到: ${url.protocol}`);
  }
  const host = url.hostname.toLowerCase();
  if (host === '169.254.169.254' || host === 'fd00:ec2::254' || host === '[fd00:ec2::254]') {
    throw new Error('禁止访问云元数据端点（169.254.169.254）—— 该地址可泄露宿主机凭证。');
  }
  return url;
}

/**
 * stdio 子进程环境白名单：只传运行必需的基础变量 + 配置显式给出的 env。
 * 绝不整包继承 process.env —— MCP Server 是第三方代码，拿到宿主全部密钥
 * （含其他用户配置的 Key）等于把整个进程的凭证面交出去。
 */
function buildStdioEnv(extra?: Record<string, string>): Record<string, string> {
  const base: Record<string, string> = {};
  for (const [k, v] of Object.entries({
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    LANG: process.env.LANG,
    LC_ALL: process.env.LC_ALL,
    TZ: process.env.TZ,
    TMPDIR: process.env.TMPDIR,
  })) {
    if (typeof v === 'string') base[k] = v;
  }
  return { ...base, ...(extra || {}) };
}

/** 按 config 构建 transport（stdio/sse/http 三种，UserConnection 与进程级连接共用） */
function buildMCPTransport(
  c: MCPServerConfig
): StdioClientTransport | SSEClientTransport | StreamableHTTPClientTransport {
  if (c.transport === 'stdio') {
    if (!c.command) throw new Error('stdio 类型的 MCP Server 必须提供 command 启动参数。');
    return new StdioClientTransport({
      command: c.command,
      args: c.args || [],
      env: buildStdioEnv(c.env),
    });
  }
  if (!c.url) throw new Error(`${c.transport} 类型的 MCP Server 必须提供 url 参数。`);
  const url = assertSafeUrl(c.url);
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

  /**
   * 连接指纹：url/headers/command 等不变则复用现有连接。
   * 敏感字段（headers/env）只进 SHA-256 哈希 —— 指纹用于日志/比较，
   * 不能把用户凭证明文带出去。
   */
  fingerprint(): string {
    const c = this.config;
    const sensitive = JSON.stringify({ h: c.headers, e: c.env }) || '';
    return JSON.stringify({
      t: c.transport,
      u: c.url,
      cmd: c.command,
      a: c.args,
      oauth: Boolean(c.authProvider),
      sensitiveHash: createHash('sha256').update(sensitive).digest('hex').slice(0, 16),
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
      // 半死连接修复：listTools 成功之前不落地 this.client ——
      // 否则连接成功但工具拉取失败时，连接呈「已连接零工具」的假成功态
      // 且后续 connect() 直接返回，永远不自愈。
      await client.connect(buildMCPTransport(this.config));
      let tools: any[];
      try {
        ({ tools } = await client.listTools());
      } catch (err) {
        await client.close().catch(() => {});
        throw err;
      }
      this.tools = this.buildToolDefs(tools);
      this.client = client;
      this.lastError = '';
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
  /** 进程级连接（CLI/操作员预配置场景，工具注册进全局注册表） */
  private activeClients = new Map<string, { conn: UserConnection; tools: string[] }>();
  /** 进程级连接的并发锁：同名 server 并发 connect 只跑一次 */
  private connectLocks = new Map<string, Promise<any>>();
  /** 用户级连接隔离池：`${userId}::${serverName}` → UserConnection */
  private userClients = new Map<string, UserConnection>();
  /** 每用户 sync 锁：并发 sync 同一用户时不交叉重建连接 */
  private syncLocks = new Map<string, Promise<SyncUserServersResult>>();

  constructor(ctx: Context) {
    super(ctx, 'mcp');
  }

  // ---- 用户级 API（多用户 Web 场景，供 agent-backend 调用）----

  /**
   * 全量对齐某用户的 MCP 服务器清单：新增的连接、指纹未变的复用、
   * 清单里已移除的断开。单个失败不阻断其余（failed 里返回）。
   * 同一用户并发调用串行执行，避免交叉重建连接池。
   */
  async syncUserServers(userId: string, servers: MCPServerConfig[]): Promise<SyncUserServersResult> {
    const prev = this.syncLocks.get(userId);
    const run = prev ? prev.catch(() => undefined).then(() => this.doSyncUserServers(userId, servers)) : this.doSyncUserServers(userId, servers);
    this.syncLocks.set(userId, run);
    try {
      return await run;
    } finally {
      if (this.syncLocks.get(userId) === run) this.syncLocks.delete(userId);
    }
  }

  private async doSyncUserServers(userId: string, servers: MCPServerConfig[]): Promise<SyncUserServersResult> {
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

  // ---- 进程级 API（CLI/操作员预配置场景）----

  /** 连接单个 MCP Server 并将其工具注册至全局注册表（同名并发只连一次） */
  async connectServer(serverConfig: MCPServerConfig) {
    const existing = this.activeClients.get(serverConfig.name);
    if (existing) {
      return { success: false, error: `MCP Server [${serverConfig.name}] 已处于连接状态。` };
    }
    const prevLock = this.connectLocks.get(serverConfig.name);
    const run = prevLock
      ? prevLock.catch(() => undefined).then(() => this.doConnectServer(serverConfig))
      : this.doConnectServer(serverConfig);
    this.connectLocks.set(serverConfig.name, run);
    try {
      return await run;
    } finally {
      if (this.connectLocks.get(serverConfig.name) === run) this.connectLocks.delete(serverConfig.name);
    }
  }

  private async doConnectServer(serverConfig: MCPServerConfig) {
    const recheck = this.activeClients.get(serverConfig.name);
    if (recheck) {
      return { success: false, error: `MCP Server [${serverConfig.name}] 已处于连接状态。` };
    }

    const conn = new UserConnection('__global__', serverConfig, (event) => this.ctx.agent.emitEvent(event));
    await conn.connect();

    // 注册进全局注册表（CLI 单用户/操作员预配置场景 —— Web 多用户走 getUserTools 任务级注入）
    const registeredToolNames: string[] = [];
    for (const def of conn.tools) {
      this.ctx.agent.registerTool(def);
      registeredToolNames.push(def.name);
    }

    this.activeClients.set(serverConfig.name, { conn, tools: registeredToolNames });

    return {
      success: true,
      serverName: serverConfig.name,
      toolsCount: registeredToolNames.length,
      tools: registeredToolNames,
    };
  }

  /** 断开进程级连接并从全局注册表反注册其工具（不留可调用但必失败的僵尸工具） */
  async disconnectServer(serverName: string) {
    const info = this.activeClients.get(serverName);
    if (!info) return { success: false, error: `MCP Server [${serverName}] 未连接。` };
    this.activeClients.delete(serverName);
    for (const toolName of info.tools) {
      this.ctx.agent.unregisterTool(toolName);
    }
    await info.conn.close();
    return { success: true, serverName, unregisteredTools: info.tools.length };
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
      await info.conn.close().catch(() => {});
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
  // 工具路由自注册：prompt 命中外部工具服务类关键词时挂载本插件工具组。
  // 工具本体按前缀约定由应用层提供（CLI: bin.ts 的 mcp_connect_* 包装）。
  ctx.agent.registerToolRoute({
    id: 'mcp',
    prefixes: ['mcp_'],
    test: /(mcp|外部工具服务|连接器)/i,
  });

  const svc = new MCPService(ctx);

  // 启动时自动连接配置中指定的预设 MCP Servers（操作员预配置，进程级）
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
