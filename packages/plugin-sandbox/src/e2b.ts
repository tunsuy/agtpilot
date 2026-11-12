/**
 * 自建 E2B 接入层 —— endpoint 解析 + 会话池。
 *
 * 设计依据 (docs/design/agent-in-sandbox.md / sandbox-control-hardening.md)：
 * - Manus 式用法是「一个任务一个 microVM、跨多次 tool call 复用、心跳续期、
 *   可暂停恢复」，而不是每次工具调用新建再 kill（旧实现每次 create+kill，
 *   自建 E2B 冷启动成本与配额都会被放大）。
 * - 自建 E2B 的关键差异是控制面地址：SDK 默认打 `https://api.<domain>` 与
 *   `<port>-<sandboxId>.<domain>`；自建时通常只设 E2B_DOMAIN / E2B_API_URL，
 *   因此这里统一把 { apiKey, domain, apiUrl, sandboxUrl } 透传给 SDK。
 *
 * 本模块只依赖注入的 factory（Sandbox.create / Sandbox.connect），不直接
 * import SDK 的网络实现，便于单测。
 */

/** 连接 E2B 控制面所需的最小配置（对应 SDK ConnectionOpts 子集） */
export interface E2BConnection {
  apiKey?: string;
  /** 自建控制面域名，决定默认 apiUrl 与 sandbox 端口域名 */
  domain?: string;
  /** 显式 API 地址，常见于自建 —— http://e2b.internal:3000 */
  apiUrl?: string;
  /** sandbox traffic 地址（自建代理域） */
  sandboxUrl?: string;
  debug?: boolean;
  requestTimeoutMs?: number;
}

export interface E2BCreateOptions extends E2BConnection {
  template?: string;
  timeoutMs?: number;
  allowInternetAccess?: boolean;
  metadata?: Record<string, string>;
  /** sandbox 内可见的环境变量（只放 policy.exposeEnv 白名单内的键） */
  envs?: Record<string, string>;
  /** 出站网络规则（net=deny 时 denyOut 全禁） */
  network?: Record<string, any>;
}

export interface E2BCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  error?: string;
}

export interface E2BCodeExecution {
  logs: { stdout: string[]; stderr: string[] };
  results?: Array<any>;
  error?: { value?: string; name?: string } | null;
}

/** SDK Sandbox 实例的结构化子集（测试里用 fake 实现） */
export interface E2BSandboxHandle {
  sandboxId: string;
  getHost(port: number): string;
  commands: {
    run(cmd: string, opts?: Record<string, any>): Promise<E2BCommandResult>;
  };
  files: {
    write(path: string, data: string | Uint8Array): Promise<unknown>;
    read(path: string, opts?: Record<string, any>): Promise<string>;
    list(path: string): Promise<Array<{ name: string; type?: string; path?: string }>>;
    makeDir(path: string): Promise<unknown>;
    remove(path: string): Promise<unknown>;
  };
  runCode?(code: string, opts?: Record<string, any>): Promise<E2BCodeExecution>;
  setTimeout(ms: number): Promise<void>;
  pause(opts?: Record<string, any>): Promise<boolean>;
  kill(): Promise<boolean>;
  isRunning?(opts?: Record<string, any>): Promise<boolean>;
}

export interface SandboxFactory {
  create(opts: E2BCreateOptions): Promise<E2BSandboxHandle>;
  connect(sandboxId: string, opts: E2BConnection): Promise<E2BSandboxHandle>;
}

export interface PoolOptions {
  /** sandbox 生命周期（毫秒），每次 touch 续期 */
  timeoutMs: number;
  /** 心跳续期最小间隔，避免每次工具调用都打控制面 API */
  heartbeatIntervalMs: number;
  /** 空闲多久后回收（pause 保内存，或 kill） */
  idleTtlMs: number;
  /** 回收策略：pause 保留内存快照，kill 直接销毁 */
  idleAction: 'pause' | 'kill';
}

export const DEFAULT_POOL_OPTIONS: PoolOptions = {
  timeoutMs: 300_000,
  heartbeatIntervalMs: 60_000,
  idleTtlMs: 600_000,
  idleAction: 'pause',
};

/**
 * 解析 E2B 连接配置。优先级：session.env（用户个人空间的 Key / 自建地址）
 * → 插件配置 → 进程环境变量。空字符串视为未设置。
 */
export function resolveE2BConnection(
  sources: {
    sessionEnv?: Record<string, string | undefined>;
    plugin?: Partial<E2BConnection>;
    processEnv?: Record<string, string | undefined>;
  },
): E2BConnection {
  const pick = (key: string, pluginValue?: string): string | undefined => {
    const fromSession = sources.sessionEnv?.[key];
    if (typeof fromSession === 'string' && fromSession !== '') return fromSession;
    if (typeof pluginValue === 'string' && pluginValue !== '') return pluginValue;
    const fromProcess = sources.processEnv?.[key];
    if (typeof fromProcess === 'string' && fromProcess !== '') return fromProcess;
    return undefined;
  };

  const apiKey = pick('E2B_API_KEY', sources.plugin?.apiKey);
  const domain = pick('E2B_DOMAIN', sources.plugin?.domain);
  const apiUrl = pick('E2B_API_URL', sources.plugin?.apiUrl);
  const sandboxUrl = pick('E2B_SANDBOX_URL', sources.plugin?.sandboxUrl);
  const debug = pick('E2B_DEBUG', sources.plugin?.debug ? 'true' : undefined) === 'true';

  return {
    ...(apiKey ? { apiKey } : {}),
    ...(domain ? { domain } : {}),
    ...(apiUrl ? { apiUrl } : {}),
    ...(sandboxUrl ? { sandboxUrl } : {}),
    ...(debug ? { debug: true } : {}),
  };
}

/** 控制面主机名，仅用于健康探测/错误提示（不泄露 Key） */
export function resolveControlPlaneUrl(conn: E2BConnection): string {
  if (conn.apiUrl) return conn.apiUrl.replace(/\/+$/, '');
  if (conn.debug) return 'http://localhost:3000';
  return `https://api.${conn.domain || 'e2b.app'}`;
}

/** 会话池键：多用户部署按 userId 分域，缺省 default */
export function sandboxSessionKey(session: { taskId?: string; userId?: string } | undefined): string {
  const user = session?.userId || 'default';
  const task = session?.taskId || 'adhoc';
  return `${user}::${task}`;
}

interface SessionEntry {
  sandbox: E2BSandboxHandle;
  lastTouch: number;
  lastHeartbeat: number;
}

/**
 * 按任务复用的 sandbox 会话池。
 *
 * 不变量：
 * - 同一 key 并发 acquire 只创建一次（pending 去重）；
 * - 每次使用前 touch() 续期（默认 60s 节流），长任务不会被超时打断；
 * - 暂停恢复失败 → 丢弃会话重新创建，不把错误抛给调用方当作任务失败。
 */
export class E2BSessionPool {
  private sessions = new Map<string, SessionEntry>();
  private pending = new Map<string, Promise<E2BSandboxHandle>>();

  constructor(
    private factory: SandboxFactory,
    private options: PoolOptions = DEFAULT_POOL_OPTIONS,
    private now: () => number = () => Date.now(),
  ) {}

  /** 取会话（不存在则连接 resumeId 或新建） */
  async acquire(
    key: string,
    createOptions: E2BCreateOptions,
    connection: E2BConnection,
    resumeId?: string,
  ): Promise<E2BSandboxHandle> {
    const existing = this.sessions.get(key);
    if (existing) {
      const alive = await this.isAlive(existing.sandbox);
      if (alive) return existing.sandbox;
      this.sessions.delete(key);
    }

    const inflight = this.pending.get(key);
    if (inflight) return inflight;

    const task = (async () => {
      let sandbox: E2BSandboxHandle | undefined;
      if (resumeId) {
        try {
          sandbox = await this.factory.connect(resumeId, connection);
        } catch {
          sandbox = undefined;
        }
      }
      if (!sandbox) sandbox = await this.factory.create(createOptions);
      this.sessions.set(key, { sandbox, lastTouch: this.now(), lastHeartbeat: this.now() });
      return sandbox;
    })();

    this.pending.set(key, task);
    try {
      return await task;
    } finally {
      this.pending.delete(key);
    }
  }

  /** 心跳续期（节流）：把 sandbox TTL 推后，避免长任务被控制面回收 */
  async touch(key: string, sandbox: E2BSandboxHandle): Promise<void> {
    const entry = this.sessions.get(key);
    const timestamp = this.now();
    const last = entry?.lastHeartbeat ?? 0;
    if (entry) entry.lastTouch = timestamp;
    if (timestamp - last < this.options.heartbeatIntervalMs) return;
    try {
      await sandbox.setTimeout(this.options.timeoutMs);
      if (entry) entry.lastHeartbeat = timestamp;
    } catch {
      // 续期失败不阻断本次调用：控制面短暂不可用时仍尝试执行，下次 acquire 会重建
    }
  }

  /** 当前会话 id（供持久化 / 前端产物直连下载） */
  sandboxIdOf(key: string): string | undefined {
    return this.sessions.get(key)?.sandbox.sandboxId;
  }

  get(key: string): E2BSandboxHandle | undefined {
    return this.sessions.get(key)?.sandbox;
  }

  /**
   * 只按已保存 id 恢复会话（不新建）：
   * 读文件/列目录这类"不该为了看一眼而冷启动一台空 VM"的场景用。
   * connect 失败（已销毁/控制面不可用）返回 undefined。
   */
  async resume(key: string, sandboxId: string, connection: E2BConnection): Promise<E2BSandboxHandle | undefined> {
    const existing = this.sessions.get(key);
    if (existing) return existing.sandbox;
    try {
      const sandbox = await this.factory.connect(sandboxId, connection);
      this.sessions.set(key, { sandbox, lastTouch: this.now(), lastHeartbeat: this.now() });
      return sandbox;
    } catch {
      return undefined;
    }
  }

  /** 暂停（保留内存快照，登录态/进程不丢） */
  async pause(key: string): Promise<boolean> {
    const entry = this.sessions.get(key);
    if (!entry) return false;
    try {
      return await entry.sandbox.pause({ keepMemory: true });
    } catch {
      return false;
    }
  }

  /** 销毁会话 */
  async kill(key: string): Promise<boolean> {
    const entry = this.sessions.get(key);
    if (!entry) return false;
    this.sessions.delete(key);
    try {
      return await entry.sandbox.kill();
    } catch {
      return false;
    }
  }

  /** 空闲回收：pause 或 kill 过期会话；返回回收的 key 列表 */
  async evictIdle(): Promise<string[]> {
    const timestamp = this.now();
    const evicted: string[] = [];
    for (const [key, entry] of this.sessions) {
      if (timestamp - entry.lastTouch < this.options.idleTtlMs) continue;
      this.sessions.delete(key);
      evicted.push(key);
      try {
        if (this.options.idleAction === 'pause') await entry.sandbox.pause({ keepMemory: true });
        else await entry.sandbox.kill();
      } catch {
        // 控制面失败时留给控制面自身超时回收
      }
    }
    return evicted;
  }

  /** 只操作本地表，不触网（供工具查询用） */
  keys(): string[] {
    return [...this.sessions.keys()];
  }

  private async isAlive(sandbox: E2BSandboxHandle): Promise<boolean> {
    if (!sandbox.isRunning) return true;
    try {
      return await sandbox.isRunning();
    } catch {
      return false;
    }
  }
}

/**
 * 把命令结果裁剪到可回灌上下文的长度。
 * 长输出保留头尾（错误往往在尾部），中段标注省略 —— 与 Manus「只回摘要」一致。
 */
export function truncateCommandOutput(text: string, limit = 8_000): string {
  if (text.length <= limit) return text;
  const head = Math.floor(limit * 0.3);
  const tail = limit - head;
  return `${text.slice(0, head)}\n...[省略 ${text.length - limit} 字符]...\n${text.slice(-tail)}`;
}

/** 控制面协议（自建常见 http；文件直连地址需与之一致） */
export function controlPlaneProtocol(conn: E2BConnection): 'http' | 'https' {
  try {
    return new URL(resolveControlPlaneUrl(conn)).protocol === 'http:' ? 'http' : 'https';
  } catch {
    return 'https';
  }
}

/** 产物下载直连地址（不经过业务后端带宽） */
export function sandboxFileUrl(
  sandbox: E2BSandboxHandle,
  filePath: string,
  port = 49983,
  protocol: 'http' | 'https' = 'https',
): string {
  const host = sandbox.getHost(port);
  const base = /^https?:\/\//.test(host) ? host : `${protocol}://${host}`;
  return `${base.replace(/\/+$/, '')}/files?path=${encodeURIComponent(filePath)}&username=user`;
}

/**
 * 自建 E2B 控制面连通性探测（排查部署用）：
 * 打 `GET <controlPlane>/health`，只回报状态码与耗时，不回显 Key。
 */
export async function probeControlPlane(
  connection: E2BConnection,
  options: { timeoutMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<{ url: string; ok: boolean; status?: number; latencyMs: number; error?: string }> {
  const url = `${resolveControlPlaneUrl(connection)}/health`;
  const fetchImpl = options.fetchImpl || fetch;
  const controller = new AbortController();
  const timeoutMs = options.timeoutMs || 5_000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();
  try {
    const res = await fetchImpl(url, {
      method: 'GET',
      signal: controller.signal,
      headers: connection.apiKey ? { 'X-API-Key': connection.apiKey } : undefined,
    });
    return {
      url,
      ok: res.status >= 200 && res.status < 400,
      status: res.status,
      latencyMs: Date.now() - startedAt,
    };
  } catch (err: any) {
    return {
      url,
      ok: false,
      latencyMs: Date.now() - startedAt,
      error: err?.message || String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}
