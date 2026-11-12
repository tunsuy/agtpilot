import { Context } from '@deepseek-ai/cordis';
import '@agtpilot/core';
import {
  buildChildEnv,
  decideFence,
  buildBwrapArgs,
  guardCommandSensitivePaths,
  resolveCredentialRequest,
  guardUrlHost,
  DEFAULT_CREDENTIAL_BINDINGS,
} from '@agtpilot/core';
import type { SandboxSessionPolicy } from '@agtpilot/core';
import { exec, execFile, execFileSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import { promisify } from 'node:util';
import { Sandbox as E2BSandbox } from '@e2b/code-interpreter';
import {
  E2BSessionPool,
  DEFAULT_POOL_OPTIONS,
  resolveE2BConnection,
  resolveControlPlaneUrl,
  sandboxSessionKey,
  truncateCommandOutput,
  sandboxFileUrl,
  controlPlaneProtocol,
  probeControlPlane,
} from './e2b';
import type {
  E2BConnection,
  E2BCreateOptions,
  E2BSandboxHandle,
  SandboxFactory,
} from './e2b';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

export const name = 'agtpilot-plugin-sandbox';
export const inject = ['agent'];

export interface SandboxConfig {
  workspaceRoot?: string;
  defaultTimeoutMs?: number;
  e2bApiKey?: string;
  /** 自建 E2B 控制面域名，例如 e2b.internal.example.com */
  e2bDomain?: string;
  /** 自建 E2B API 地址；设置后优先于 e2bDomain */
  e2bApiUrl?: string;
  /** 自建 E2B sandbox traffic 地址模板 */
  e2bSandboxUrl?: string;
  /** 预构建的 E2B template 名称或 ID */
  e2bTemplate?: string;
  /** E2B sandbox 生命周期超时 */
  e2bTimeoutMs?: number;
  /** 是否允许自建 sandbox 访问外网 */
  e2bAllowInternetAccess?: boolean;
  /** sandbox idle 回收策略 */
  e2bIdleAction?: 'pause' | 'kill';
  /** sandbox 空闲回收时间 */
  e2bIdleTtlMs?: number;
}

function numberFromEnv(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** 探测宿主机 bwrap(bubblewrap)可用性:apply() 时一次,结果缓存 */
function detectBwrap(): boolean {
  if (process.platform !== 'linux') return false;
  try {
    execFileSync('bwrap', ['--version'], { stdio: 'ignore', timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * E2B SDK 工厂（注入给会话池，便于单测替换为 fake）。
 * 自建部署的关键：把 domain / apiUrl / sandboxUrl 原样透传给 SDK ——
 * 默认 SDK 会打 https://api.e2b.app，自建时必须让这几个字段生效。
 */
function buildE2BFactory(): SandboxFactory {
  return {
    async create(opts) {
      const { template, ...rest } = opts;
      const sdkOpts = rest as Record<string, any>;
      const sandbox = template
        ? await E2BSandbox.create(template, sdkOpts)
        : await E2BSandbox.create(sdkOpts);
      return sandbox as unknown as E2BSandboxHandle;
    },
    async connect(sandboxId, connection) {
      const sandbox = await E2BSandbox.connect(sandboxId, connection as Record<string, any>);
      return sandbox as unknown as E2BSandboxHandle;
    },
  };
}

export function apply(ctx: Context, config: SandboxConfig = {}) {
  // 工具路由自注册：prompt 命中代码/命令执行类关键词时挂载本插件工具组
  ctx.agent.registerToolRoute({
    id: 'sandbox',
    prefixes: ['sandbox_'],
    test: /(代码|脚本|运行|执行|命令|终端|文件|目录|沙箱|微虚拟机|编译|部署|python|javascript|node|shell|sql|code|script|run|execute|sandbox|terminal)/i,
  });

  const workspaceRoot = config.workspaceRoot || process.cwd();
  const defaultTimeoutMs = config.defaultTimeoutMs || 30000;
  const tempSandboxDir = path.resolve(workspaceRoot, '.cache/sandbox');
  const bwrapAvailable = detectBwrap();

  if (!fsSync.existsSync(tempSandboxDir)) {
    fsSync.mkdirSync(tempSandboxDir, { recursive: true });
  }

  // ---- 自建 E2B 接入 ----
  // 连接配置每次调用按 session.env → 插件配置 → 进程环境解析（见 e2b.ts），
  // 支持多用户各自指向自己的自建 E2B 实例。会话池按 taskId 复用 sandbox：
  // 一次任务内多次工具调用共享同一 VM，心跳续期，空闲按 pause/kill 回收。
  const e2bPool = new E2BSessionPool(
    buildE2BFactory(),
    {
      ...DEFAULT_POOL_OPTIONS,
      timeoutMs: config.e2bTimeoutMs || numberFromEnv(process.env.E2B_TIMEOUT_MS, DEFAULT_POOL_OPTIONS.timeoutMs),
      idleTtlMs: config.e2bIdleTtlMs || numberFromEnv(process.env.E2B_IDLE_TTL_MS, DEFAULT_POOL_OPTIONS.idleTtlMs),
      idleAction: config.e2bIdleAction || (process.env.E2B_IDLE_ACTION === 'kill' ? 'kill' : DEFAULT_POOL_OPTIONS.idleAction),
    },
  );

  function e2bConnection(session?: any): E2BConnection {
    return resolveE2BConnection({
      sessionEnv: session?.env,
      plugin: {
        apiKey: config.e2bApiKey,
        domain: config.e2bDomain,
        apiUrl: config.e2bApiUrl,
        sandboxUrl: config.e2bSandboxUrl,
      },
      processEnv: process.env as Record<string, string | undefined>,
    });
  }

  function e2bCreateOptions(session?: any): E2BCreateOptions {
    const template =
      session?.env?.E2B_TEMPLATE || config.e2bTemplate || process.env.E2B_TEMPLATE || undefined;
    return {
      ...e2bConnection(session),
      ...(template ? { template } : {}),
      timeoutMs: config.e2bTimeoutMs || numberFromEnv(process.env.E2B_TIMEOUT_MS, DEFAULT_POOL_OPTIONS.timeoutMs),
      allowInternetAccess: config.e2bAllowInternetAccess,
      metadata: {
        ...(session?.userId ? { userId: String(session.userId) } : {}),
        ...(session?.taskId ? { taskId: String(session.taskId) } : {}),
      },
      envs: buildChildEnv(session?.env, session?.sandbox as SandboxSessionPolicy | undefined),
      ...(session?.sandbox?.net === 'deny' ? { network: { denyOut: ['0.0.0.0/0'] } } : {}),
    };
  }

  /** 取当前任务会话（自建 E2B 不可用时抛错，由调用方决定是否降级） */
  async function acquireE2BSandbox(session?: any): Promise<{ key: string; sandbox: E2BSandboxHandle }> {
    const key = sandboxSessionKey(session);
    void e2bPool.evictIdle().catch(() => {});
    const sandbox = await e2bPool.acquire(
      key,
      e2bCreateOptions(session),
      e2bConnection(session),
      session?.sandbox?.e2bSandboxId,
    );
    // 把 sandboxId 写回活引用策略对象：web 层可持久化，跨进程重启可 resume
    if (session?.sandbox && typeof session.sandbox === 'object') {
      try {
        session.sandbox.e2bSandboxId = sandbox.sandboxId;
      } catch {
        // 策略对象被冻结时跳过写回；会话本身仍可用，只是不能跨进程 resume
      }
    }
    await e2bPool.touch(key, sandbox);
    return { key, sandbox };
  }

  async function runPythonInSandbox(
    sandbox: E2BSandboxHandle,
    code: string,
    timeoutMs: number,
  ): Promise<{
    stdout: string;
    stderr: string;
    error?: string;
    artifacts: Array<{ text?: string; formats?: string[]; hasImage?: boolean; pngBase64?: string }>;
    mode: 'runCode' | 'command';
  }> {
    if (typeof sandbox.runCode === 'function') {
      const execution = await sandbox.runCode(code, { timeoutMs });
      return {
        stdout: execution.logs.stdout.join('\n').trim(),
        stderr: execution.logs.stderr.join('\n').trim(),
        error: execution.error ? execution.error.value || execution.error.name : undefined,
        artifacts: (execution.results || []).map((r: any) => ({
          text: r.text,
          formats: r.formats ? Object.keys(r.formats) : [],
          hasImage: !!(r.png || r.jpeg || r.svg),
          pngBase64: r.png,
        })),
        mode: 'runCode',
      };
    }
    // 自建模板没有 code-interpreter kernel 时退回文件 + python3
    const file = `/home/user/.agtpilot/snippet_${Date.now()}.py`;
    await sandbox.files.makeDir('/home/user/.agtpilot').catch(() => {});
    await sandbox.files.write(file, code);
    const result = await sandbox.commands.run(`python3 ${file}`, { timeoutMs });
    return {
      stdout: (result.stdout || '').trim(),
      stderr: (result.stderr || '').trim(),
      error: result.exitCode !== 0 ? result.error || result.stderr || `exit ${result.exitCode}` : undefined,
      artifacts: [],
      mode: 'command',
    };
  }

  // 辅助函数：路径围栏（Path Traversal 防护）。
  // 解析后必须落在 workspaceRoot 内 —— 绝对路径逃逸与 ../ 穿越一律拒绝（返回 null）。
  function resolveSafePath(userPath: string): string | null {
    const resolved = path.isAbsolute(userPath)
      ? path.normalize(userPath)
      : path.resolve(workspaceRoot, userPath);
    if (resolved === workspaceRoot || !resolved.startsWith(workspaceRoot + path.sep)) {
      return null;
    }
    return resolved;
  }

  /**
   * 子进程环境:基础白名单 + 仅 session.sandbox.exposeEnv 显式白名单内的任务级 Key。
   * 凭据托管(docs/design/sandbox-control-hardening.md §4.3):session.env 默认
   * **零 Key 进子进程** —— 修复旧实现整包展开造成的凭据泄漏;合法消费方
   * (plugin-search / plugin-notify 等)都在插件 JS 进程内读 session.env,不受影响。
   */
  function childEnv(session?: any): NodeJS.ProcessEnv {
    return buildChildEnv(session?.env, session?.sandbox as SandboxSessionPolicy | undefined) as NodeJS.ProcessEnv;
  }

  /** 围栏决策 + 降级/拒绝的诚实标注(延续 E2B 降级显式标注模式) */
  function fenceDecision(session?: any) {
    const policy = session?.sandbox as SandboxSessionPolicy | undefined;
    return decideFence(policy?.fence, bwrapAvailable);
  }

  /** sandbox_deny 结构化事件(拒绝日志 → 权限提案的数据源,见设计文档 §4.4) */
  function emitDeny(session: any, payload: Record<string, any>) {
    ctx.agent.emitEvent({
      type: 'sandbox_deny',
      payload: {
        ...payload,
        taskId: session?.taskId,
        userId: session?.userId,
      },
      timestamp: Date.now(),
    });
  }

  // 1. 统一执行入口 (sandbox_exec) + 文件/目录操作 (sandbox_file)
  type SandboxRuntime = 'shell' | 'python' | 'node' | 'ts';
  type SandboxTarget = 'auto' | 'local' | 'e2b';

  /** 取当前任务 E2B 会话：只复用/恢复，不冷启动空 VM（读文件/列目录场景） */
  async function getE2BSandbox(session?: any): Promise<E2BSandboxHandle | undefined> {
    const key = sandboxSessionKey(session);
    const existing = e2bPool.get(key);
    if (existing) {
      await e2bPool.touch(key, existing);
      return existing;
    }
    const savedId = session?.sandbox?.e2bSandboxId as string | undefined;
    if (!savedId) return undefined;
    const resumed = await e2bPool.resume(key, savedId, e2bConnection(session));
    if (resumed) await e2bPool.touch(key, resumed);
    return resumed;
  }

  function emitTerminal(payload: Record<string, any>, session?: any) {
    ctx.agent.emitEvent({
      type: 'terminal_output',
      payload: { ...payload, taskId: session?.taskId, userId: session?.userId },
      timestamp: Date.now(),
    });
  }

  /** 本地执行：shell 走 bwrap/裸 shell；代码写临时文件后由 python3/node/tsx 执行 */
  async function execLocal(
    runtime: SandboxRuntime,
    payload: { command?: string; code?: string; cwd?: string; timeoutMs: number },
    session?: any,
  ) {
    let execCwd = workspaceRoot;
    if (payload.cwd) {
      const resolved = resolveSafePath(String(payload.cwd));
      if (!resolved) {
        return { success: false, target: 'local' as const, error: `工作目录越界: ${payload.cwd}（只允许 workspace 内路径）` };
      }
      execCwd = resolved;
    }

    const fence = fenceDecision(session);
    if (fence.blocked) {
      return { success: false, target: 'local' as const, isolation: 'blocked', error: fence.reason };
    }
    if (fence.degraded) {
      ctx.agent.emitEvent({ type: 'thought', payload: { text: `沙箱围栏降级: ${fence.reason}` }, timestamp: Date.now() });
    }
    const fenceLabel = fence.wrap ? 'bwrap' : fence.degraded ? 'degraded' : 'off';

    const source = runtime === 'shell' ? String(payload.command ?? '') : String(payload.code ?? '');
    const sourceGuard = guardCommandSensitivePaths(source);
    if (!sourceGuard.ok) {
      emitDeny(session, {
        tool: 'sandbox_exec',
        reason: sourceGuard.code,
        match: sourceGuard.match,
        detail: sourceGuard.message,
      });
      return { success: false, target: 'local' as const, isolation: fenceLabel, code: sourceGuard.code, error: sourceGuard.message };
    }

    const startTime = Date.now();
    const env = childEnv(session);
    try {
      if (runtime === 'shell') {
        const { stdout, stderr } = fence.wrap
          ? await execFileAsync(
              'bwrap',
              [...buildBwrapArgs({ workspaceRoot, net: session?.sandbox?.net }), '--', '/bin/sh', '-c', String(payload.command)],
              { cwd: execCwd, timeout: payload.timeoutMs, maxBuffer: 10 * 1024 * 1024, env },
            )
          : await execAsync(String(payload.command), {
              cwd: execCwd,
              timeout: payload.timeoutMs,
              maxBuffer: 10 * 1024 * 1024,
              env,
            });
        const durationMs = Date.now() - startTime;
        emitTerminal(
          { command: payload.command, cwd: execCwd, stdout: stdout.trim(), stderr: stderr.trim(), exitCode: 0, durationMs, fence: fenceLabel },
          session,
        );
        return {
          success: true,
          target: 'local' as const,
          isolation: fenceLabel,
          exitCode: 0,
          stdout: stdout.trim(),
          stderr: stderr.trim(),
          durationMs,
        };
      }

      const fileExt = runtime === 'python' ? '.py' : runtime === 'ts' ? '.ts' : '.mjs';
      const tempFilePath = path.join(
        tempSandboxDir,
        `snippet_${Date.now()}_${Math.random().toString(36).slice(2, 6)}${fileExt}`,
      );
      await fs.writeFile(tempFilePath, String(payload.code ?? ''), 'utf-8');
      try {
        const runner = runtime === 'python' ? 'python3' : runtime === 'ts' ? 'npx' : 'node';
        const runnerArgs = runtime === 'ts' ? ['tsx', tempFilePath] : [tempFilePath];
        const { stdout, stderr } = fence.wrap
          ? await execFileAsync(
              'bwrap',
              [...buildBwrapArgs({ workspaceRoot, net: session?.sandbox?.net }), '--', runner, ...runnerArgs],
              { cwd: execCwd, timeout: payload.timeoutMs, env },
            )
          : await execFileAsync(runner, runnerArgs, { cwd: execCwd, timeout: payload.timeoutMs, env });
        return {
          success: true,
          target: 'local' as const,
          isolation: fenceLabel,
          exitCode: 0,
          stdout: stdout.trim(),
          stderr: stderr.trim(),
          durationMs: Date.now() - startTime,
        };
      } finally {
        await fs.unlink(tempFilePath).catch(() => {});
      }
    } catch (err: any) {
      const durationMs = Date.now() - startTime;
      const stdout = String(err.stdout || '').trim();
      const stderr = String(err.stderr || err.message || '').trim();
      if (runtime === 'shell') {
        emitTerminal(
          { command: payload.command, cwd: execCwd, stdout, stderr, exitCode: err.code ?? -1, durationMs, fence: fenceLabel },
          session,
        );
      }
      return {
        success: false,
        target: 'local' as const,
        isolation: fenceLabel,
        exitCode: typeof err.code === 'number' ? err.code : -1,
        stdout,
        stderr,
        durationMs,
        ...(err.killed ? { timedOut: true } : {}),
        error: stderr || err.message,
      };
    }
  }

  /** E2B microVM 执行：会话复用 + 心跳；python 走 runCode（无 kernel 模板自动退回 python3） */
  async function execE2B(
    runtime: SandboxRuntime,
    payload: { command?: string; code?: string; cwd?: string; timeoutMs: number; background?: boolean },
    session?: any,
  ) {
    const connection = e2bConnection(session);
    if (!connection.apiKey) {
      return { success: false, target: 'e2b' as const, error: `未配置 E2B_API_KEY（控制面 ${resolveControlPlaneUrl(connection)}）` };
    }
    const { key, sandbox } = await acquireE2BSandbox(session);
    const startTime = Date.now();

    if (runtime === 'python') {
      const execution = await runPythonInSandbox(sandbox, String(payload.code ?? ''), payload.timeoutMs);
      return {
        success: !execution.error,
        target: 'e2b' as const,
        isolation: 'e2b-microvm',
        sandboxId: sandbox.sandboxId,
        sessionKey: key,
        exitCode: execution.error ? 1 : 0,
        stdout: truncateCommandOutput(execution.stdout),
        stderr: truncateCommandOutput(execution.stderr),
        durationMs: Date.now() - startTime,
        ...(execution.error ? { error: execution.error } : {}),
        ...(execution.artifacts.length
          ? {
              artifacts: execution.artifacts.map(({ pngBase64, ...rest }) => ({
                text: rest.text,
                formats: rest.formats,
                isChartOrImage: rest.hasImage,
              })),
            }
          : {}),
        ...(execution.artifacts.some((artifact) => artifact.pngBase64)
          ? { imageArtifacts: execution.artifacts.filter((artifact) => artifact.pngBase64).map((artifact) => artifact.pngBase64) }
          : {}),
      };
    }

    if (runtime === 'shell') {
      const cwd = String(payload.cwd || '/home/user');
      const result = await sandbox.commands.run(String(payload.command ?? ''), {
        cwd,
        timeoutMs: payload.timeoutMs,
        ...(payload.background ? { background: true } : {}),
      });
      const durationMs = Date.now() - startTime;
      const stdout = truncateCommandOutput(result.stdout || '');
      const stderr = truncateCommandOutput(result.stderr || '');
      emitTerminal(
        { command: payload.command, cwd, stdout, stderr, exitCode: result.exitCode ?? 0, durationMs, fence: 'e2b-microvm', sandboxId: sandbox.sandboxId },
        session,
      );
      return {
        success: (result.exitCode ?? 0) === 0,
        target: 'e2b' as const,
        isolation: 'e2b-microvm',
        sandboxId: sandbox.sandboxId,
        sessionKey: key,
        exitCode: result.exitCode ?? 0,
        stdout,
        stderr,
        durationMs,
        ...(payload.background ? { pid: (result as any).pid } : {}),
      };
    }

    const fileExt = runtime === 'ts' ? '.ts' : '.mjs';
    const file = `/home/user/.agtpilot/snippet_${Date.now()}${fileExt}`;
    await sandbox.files.makeDir('/home/user/.agtpilot').catch(() => {});
    await sandbox.files.write(file, String(payload.code ?? ''));
    const result = await sandbox.commands.run(
      runtime === 'ts' ? `npx tsx ${file}` : `node ${file}`,
      { cwd: '/home/user', timeoutMs: payload.timeoutMs },
    );
    const exitCode = result.exitCode ?? 0;
    return {
      success: exitCode === 0,
      target: 'e2b' as const,
      isolation: 'e2b-microvm',
      sandboxId: sandbox.sandboxId,
      sessionKey: key,
      exitCode,
      stdout: truncateCommandOutput(result.stdout || ''),
      stderr: truncateCommandOutput(result.stderr || ''),
      durationMs: Date.now() - startTime,
      ...(exitCode !== 0 ? { error: result.error || result.stderr || `exit ${exitCode}` } : {}),
    };
  }

  ctx.agent.registerTool({
    name: 'sandbox_exec',
    description:
      '统一执行入口：runtime=shell 执行命令，python/node/ts 执行代码片段。target 语义：auto（默认，runtime=python 且已配 E2B 时走微虚拟机，其余本地工作区）、e2b（强制 Firecracker 微虚拟机，持久文件系统/后台任务/图表产物，跨调用复用同一台 VM）、local（强制本机工作区，工坊构建产物等必须落 workspace 的场景）。本地默认 best_effort 围栏（bwrap 窄挂载，缺失时逻辑预检并显式降级）；显式 target=e2b 失败会如实报错，只有 auto 会降级本地并标注 degraded。高危工具，触发安全审批拦截。',
    dangerLevel: 'high',
    parameters: {
      type: 'object',
      properties: {
        runtime: { type: 'string', enum: ['shell', 'python', 'node', 'ts'], description: '执行类型' },
        command: { type: 'string', description: 'runtime=shell 时的命令' },
        code: { type: 'string', description: 'runtime=python/node/ts 时代码' },
        target: { type: 'string', enum: ['auto', 'local', 'e2b'], description: '执行环境，默认 auto' },
        cwd: { type: 'string', description: '工作目录；本地必须在 workspace 内，E2B 默认 /home/user' },
        timeoutMs: { type: 'number', description: '超时毫秒；本地默认 30000，E2B 默认 120000' },
        background: { type: 'boolean', description: '仅 E2B shell：后台运行并返回 pid' },
      },
      required: ['runtime'],
    },
    execute: async (args: any, session?: any) => {
      const runtime = String(args?.runtime || '') as SandboxRuntime;
      if (!['shell', 'python', 'node', 'ts'].includes(runtime)) {
        return { success: false, error: 'runtime 必须为 shell/python/node/ts' };
      }
      if (runtime === 'shell' && !String(args?.command || '').trim()) {
        return { success: false, error: 'runtime=shell 需要 command' };
      }
      if (runtime !== 'shell' && !String(args?.code || '').trim()) {
        return { success: false, error: `runtime=${runtime} 需要 code` };
      }
      if (args?.background && runtime !== 'shell') {
        return { success: false, error: 'background 仅支持 runtime=shell 且 target=e2b' };
      }

      const requested = (args?.target as SandboxTarget) || 'auto';
      const hasKey = Boolean(e2bConnection(session).apiKey);
      const target: 'local' | 'e2b' =
        requested === 'e2b' || requested === 'local'
          ? requested
          : runtime === 'python' && hasKey
          ? 'e2b'
          : 'local';
      const timeoutMs = Number(args?.timeoutMs) || (target === 'e2b' ? 120_000 : defaultTimeoutMs);
      if (args?.background && !(target === 'e2b' && runtime === 'shell')) {
        return { success: false, error: 'background 仅支持 runtime=shell 且 target=e2b' };
      }
      const payload = {
        command: args?.command,
        code: args?.code,
        cwd: args?.cwd,
        timeoutMs,
        background: Boolean(args?.background),
      };

      if (target === 'e2b') {
        if (!hasKey) {
          return {
            success: false,
            target,
            error: `target=e2b 但未配置 E2B_API_KEY（控制面 ${resolveControlPlaneUrl(e2bConnection(session))}）`,
          };
        }
        try {
          return await execE2B(runtime, payload, session);
        } catch (err: any) {
          // 显式 e2b：失败就失败，不偷偷换本机执行
          if (requested === 'e2b') {
            return { success: false, target, error: err.message };
          }
          ctx.agent.emitEvent({
            type: 'thought',
            payload: { text: `E2B 沙箱不可用（${err.message}），auto 模式降级为本地执行。` },
            timestamp: Date.now(),
          });
          const fallback = await execLocal(runtime, payload, session);
          return { ...fallback, degraded: true, warning: `E2B 不可用，已降级本地执行：${err.message}` };
        }
      }
      return execLocal(runtime, payload, session);
    },
  });

  ctx.agent.registerTool({
    name: 'sandbox_file',
    description:
      '文件与目录操作：action=read|write|list|downloadUrl，target=local（默认，仅 workspace 路径围栏）| e2b（当前任务 microVM，与 sandbox_exec 共享 /home/user）。e2b 的 read/list/downloadUrl 只复用已有会话、不冷启动空 VM；write 按需创建。downloadUrl 返回 traffic 域名直连地址。',
    dangerLevel: 'medium',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['read', 'write', 'list', 'downloadUrl'], description: '操作类型' },
        path: { type: 'string', description: '文件或目录路径（本地相对 workspace；E2B 默认 /home/user 下）' },
        content: { type: 'string', description: 'action=write 时的文本内容' },
        target: { type: 'string', enum: ['local', 'e2b'], description: '操作环境，默认 local' },
        overwrite: { type: 'boolean', description: 'write 是否覆盖已有文件，默认 true' },
        startLine: { type: 'number', description: 'read 起始行（从 1 开始）' },
        maxLines: { type: 'number', description: 'read 最大行数，默认 500（本地）' },
        maxChars: { type: 'number', description: 'read 最大返回字符数，默认 20000' },
        port: { type: 'number', description: 'downloadUrl 端口，默认 49983' },
      },
      required: ['action', 'path'],
    },
    execute: async (args: any, session?: any) => {
      const action = String(args?.action || '');
      const target = (args?.target as 'local' | 'e2b') || 'local';
      const filePath = String(args?.path || '');
      const maxChars = Number(args?.maxChars) || 20_000;

      if (!filePath) return { success: false, error: 'path 不能为空' };

      if (action === 'downloadUrl') {
        if (target !== 'e2b') return { success: false, error: 'downloadUrl 仅适用于 target=e2b' };
        const sandbox = await getE2BSandbox(session);
        if (!sandbox) {
          return { success: false, path: filePath, error: '当前任务暂无 E2B 会话（先用 sandbox_exec target=e2b 或 sandbox_file write）' };
        }
        return {
          success: true,
          path: filePath,
          sandboxId: sandbox.sandboxId,
          url: sandboxFileUrl(sandbox, filePath, Number(args?.port) || 49983, controlPlaneProtocol(e2bConnection(session))),
        };
      }

      if (target === 'local') {
        if (action === 'write') {
          const fullPath = resolveSafePath(filePath);
          if (!fullPath) return { success: false, path: filePath, error: `路径越界: ${filePath}（只允许 workspace 内路径）` };
          try {
            if (args?.overwrite === false && fsSync.existsSync(fullPath)) {
              return { success: false, path: filePath, error: `文件已存在且 overwrite=false: ${filePath}` };
            }
            await fs.mkdir(path.dirname(fullPath), { recursive: true });
            await fs.writeFile(fullPath, String(args?.content ?? ''), 'utf-8');
            return {
              success: true,
              path: filePath,
              bytesWritten: Buffer.byteLength(String(args?.content ?? ''), 'utf-8'),
            };
          } catch (err: any) {
            return { success: false, path: filePath, error: err.message };
          }
        }

        if (action === 'list') {
          const fullPath = filePath === '.' ? workspaceRoot : resolveSafePath(filePath);
          if (!fullPath) return { success: false, path: filePath, error: `路径越界: ${filePath}（只允许 workspace 内路径）` };
          try {
            const entries = await fs.readdir(fullPath, { withFileTypes: true });
            return {
              success: true,
              path: filePath,
              count: entries.length,
              entries: entries.map((entry) => ({
                name: entry.name,
                isDirectory: entry.isDirectory(),
                isFile: entry.isFile(),
              })),
            };
          } catch (err: any) {
            return { success: false, path: filePath, error: err.message };
          }
        }

        const fullPath = resolveSafePath(filePath);
        if (!fullPath) return { success: false, path: filePath, error: `路径越界: ${filePath}（只允许 workspace 内路径）` };
        try {
          const stats = await fs.stat(fullPath);
          if (stats.isDirectory()) return { success: false, path: filePath, error: '目标是目录，请用 action=list' };
          const raw = await fs.readFile(fullPath, 'utf-8');
          const lines = raw.split('\n');
          const startIdx = Math.max(0, (Number(args?.startLine) || 1) - 1);
          const maxLines = Number(args?.maxLines) || 500;
          const selected = lines.slice(startIdx, startIdx + maxLines).join('\n');
          return {
            success: true,
            path: filePath,
            totalLines: lines.length,
            linesRead: Math.min(maxLines, Math.max(0, lines.length - startIdx)),
            content: truncateCommandOutput(selected, maxChars),
          };
        } catch (err: any) {
          return { success: false, path: filePath, error: err.message };
        }
      }

      // ---- E2B 文件面 ----
      if (!e2bConnection(session).apiKey) {
        return { success: false, path: filePath, error: '未配置 E2B_API_KEY（自建 E2B 控制面未就绪）' };
      }

      if (action === 'write') {
        try {
          const { sandbox, key } = await acquireE2BSandbox(session);
          const dir = path.posix.dirname(filePath);
          if (dir && dir !== '.' && dir !== '/') await sandbox.files.makeDir(dir).catch(() => {});
          await sandbox.files.write(filePath, String(args?.content ?? ''));
          return {
            success: true,
            path: filePath,
            bytesWritten: Buffer.byteLength(String(args?.content ?? ''), 'utf-8'),
            sandboxId: sandbox.sandboxId,
            sessionKey: key,
            downloadUrl: sandboxFileUrl(sandbox, filePath, 49983, controlPlaneProtocol(e2bConnection(session))),
          };
        } catch (err: any) {
          return { success: false, path: filePath, error: err.message };
        }
      }

      const sandbox = await getE2BSandbox(session);
      if (!sandbox) {
        return { success: false, path: filePath, error: '当前任务暂无 E2B 会话（write 或 sandbox_exec target=e2b 会创建）' };
      }
      try {
        if (action === 'list') {
          const entries = await sandbox.files.list(filePath || '/home/user');
          return {
            success: true,
            path: filePath,
            count: entries.length,
            entries: entries.map((entry) => ({
              name: entry.name,
              type: entry.type,
              ...(entry.path ? { path: entry.path } : {}),
            })),
          };
        }
        const content = await sandbox.files.read(filePath);
        return {
          success: true,
          path: filePath,
          sandboxId: sandbox.sandboxId,
          truncated: content.length > maxChars,
          content: truncateCommandOutput(content, maxChars),
        };
      } catch (err: any) {
        return { success: false, path: filePath, error: err.message };
      }
    },
  });

  // 2. 会话生命周期 (sandbox_session)
  ctx.agent.registerTool({
    name: 'sandbox_session',
    description:
      '管理当前任务的隔离沙箱会话：status 查看状态、probe 探测自建 E2B 控制面连通性、pause 暂停并保留内存快照（登录态/进程不丢）、resume 恢复、kill 销毁。暂停后下次 sandbox_exec(target=e2b) / sandbox_file(target=e2b) 会自动恢复；未配置 E2B 时仅回报无会话。',
    dangerLevel: 'medium',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['status', 'probe', 'pause', 'resume', 'kill'],
          description: '会话操作',
        },
      },
      required: ['action'],
    },
    execute: async ({ action }, session?: any) => {
      const key = sandboxSessionKey(session);
      const connection = e2bConnection(session);
      if (action === 'probe') {
        const probe = await probeControlPlane(connection);
        return {
          success: probe.ok,
          action,
          controlPlane: probe.url,
          status: probe.status,
          latencyMs: probe.latencyMs,
          ...(probe.error ? { error: probe.error } : {}),
          hasApiKey: Boolean(connection.apiKey),
        };
      }
      const savedId = session?.sandbox?.e2bSandboxId as string | undefined;
      if (action === 'status') {
        const sandbox = e2bPool.get(key);
        return {
          success: true,
          action,
          sessionKey: key,
          controlPlane: resolveControlPlaneUrl(connection),
          active: Boolean(sandbox),
          resumable: Boolean(savedId),
          ...(savedId ? { savedSandboxId: savedId } : {}),
          ...(sandbox ? { sandboxId: sandbox.sandboxId, running: await sandbox.isRunning?.().catch(() => undefined) } : {}),
        };
      }
      if (action === 'pause') {
        return { success: await e2bPool.pause(key), action, sessionKey: key };
      }
      if (action === 'kill') {
        const killed = await e2bPool.kill(key);
        if (session?.sandbox && typeof session.sandbox === 'object') {
          try {
            delete session.sandbox.e2bSandboxId;
          } catch {
            // 冻结对象忽略
          }
        }
        return { success: killed, action, sessionKey: key };
      }
      // resume：无非重新 acquire 一次（connect 会自动恢复已暂停的 sandbox）
      if (!connection.apiKey) {
        return { success: false, action, error: '未配置 E2B_API_KEY（自建 E2B 控制面未就绪）。' };
      }
      try {
        const { sandbox } = await acquireE2BSandbox(session);
        return { success: true, action, sessionKey: key, sandboxId: sandbox.sandboxId };
      } catch (err: any) {
        return { success: false, action, error: err.message };
      }
    },
  });

  // 3. 受控 HTTP 出站 (sandbox_http_request) —— 凭据托管注入 + 端点绑定 + 私网围栏
  //    (docs/design/sandbox-control-hardening.md §4.3:密钥永远不进子进程环境;
  //    需要携带用户 Key 的出站请求走本工具,由宿主进程按 credentialRef 解析、
  //    校验端点绑定后代发。任何拒绝都发 sandbox_deny 事件 → 审计 + 权限提案。)
  ctx.agent.registerTool({
    name: 'sandbox_http_request',
    description:
      '发起一次受控 HTTP(S) 请求（隔离层级：宿主进程代发 + 出站围栏）。私网/保留地址/云元数据端点一律拒绝；携带凭据时经 credentialRef 引用用户空间保存的 Key（真实值不出宿主进程、不进任何子进程），且只允许发往该 Key 绑定的官方端点（端点不匹配返回 credential_endpoint_mismatch）。高危工具，触发安全审批拦截。',
    dangerLevel: 'high',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '目标 URL（仅 http/https）' },
        method: { type: 'string', description: 'HTTP 方法，默认 GET' },
        headers: { type: 'object', description: '附加请求头（键值对）' },
        body: { type: 'string', description: '请求体文本（POST/PUT 等）' },
        credentialRef: {
          type: 'string',
          description: '凭据引用名（用户空间保存的环境变量名，如 EXA_API_KEY）；缺省则不携带凭据',
        },
        authStyle: {
          type: 'string',
          enum: ['bearer', 'header', 'query'],
          description: '凭据注入方式：bearer=Authorization Bearer 头；header=自定义头（authHeaderName，默认 x-api-key）；query=URL 参数（authQueryParam，默认 api_key）',
        },
        authHeaderName: { type: 'string', description: 'authStyle=header 时的头名，默认 x-api-key' },
        authQueryParam: { type: 'string', description: 'authStyle=query 时的参数名，默认 api_key' },
        timeoutMs: { type: 'number', description: '请求超时毫秒数，默认 30000ms' },
      },
      required: ['url'],
    },
    execute: async (
      { url, method = 'GET', headers, body, credentialRef, authStyle = 'bearer', authHeaderName = 'x-api-key', authQueryParam = 'api_key', timeoutMs },
      session?: any,
    ) => {
      const bindings = {
        ...DEFAULT_CREDENTIAL_BINDINGS,
        ...((session?.sandbox?.credentialBindings as Record<string, string[]>) || {}),
      };
      const timeout = timeoutMs || defaultTimeoutMs;
      const MAX_REDIRECTS = 3;
      let currentUrl = String(url);
      let credentialValue: string | undefined;
      const originalHost = (() => {
        try {
          return new URL(currentUrl).hostname.toLowerCase();
        } catch {
          return '';
        }
      })();

      for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
        // 出站围栏：scheme + 私网/保留地址（DNS 解析后逐地址校验）
        const guard = await guardUrlHost(currentUrl);
        if (!guard.ok) {
          const reason = guard.reason === 'private_host' ? 'private_host_blocked' : (guard.reason || 'blocked');
          emitDeny(session, { tool: 'sandbox_http_request', reason, url: currentUrl, detail: guard.message });
          return { success: false, url: currentUrl, code: reason, error: guard.message };
        }

        // 凭据解析 + 端点绑定校验（只在首跳注入；重定向改 host 时凭据不放行）
        if (credentialRef && hop === 0) {
          const decision = resolveCredentialRequest(
            { credentialRef: String(credentialRef), hostname: guard.hostname || originalHost },
            session?.env,
            bindings,
          );
          if (!decision.ok) {
            emitDeny(session, {
              tool: 'sandbox_http_request',
              reason: decision.code,
              url: currentUrl,
              credentialRef: String(credentialRef),
              detail: decision.message,
            });
            return { success: false, url: currentUrl, code: decision.code, error: decision.message };
          }
          credentialValue = decision.value;
        } else if (credentialRef && guard.hostname && guard.hostname.toLowerCase() !== originalHost) {
          const message = `重定向改变目标主机（${originalHost} → ${guard.hostname}），凭据 ${credentialRef} 不放行`;
          emitDeny(session, {
            tool: 'sandbox_http_request',
            reason: 'credential_endpoint_mismatch',
            url: currentUrl,
            credentialRef: String(credentialRef),
            detail: message,
          });
          return { success: false, url: currentUrl, code: 'credential_endpoint_mismatch', error: message };
        }

        // 组装请求（凭据只在宿主进程内注入这一跳的请求，绝不落入任何子进程/日志）
        const reqHeaders: Record<string, string> = { ...(headers || {}) };
        let finalUrl = currentUrl;
        if (credentialValue) {
          if (authStyle === 'bearer') {
            reqHeaders['Authorization'] = `Bearer ${credentialValue}`;
          } else if (authStyle === 'header') {
            reqHeaders[String(authHeaderName)] = credentialValue;
          } else {
            const u = new URL(currentUrl);
            u.searchParams.set(String(authQueryParam), credentialValue);
            finalUrl = u.toString();
          }
        }

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeout);
        let res: Response;
        try {
          res = await fetch(finalUrl, {
            method: String(method).toUpperCase(),
            headers: reqHeaders,
            body: body !== undefined ? String(body) : undefined,
            redirect: 'manual', // 手动跟随：每一跳重新过围栏（缓解重定向到内网的 TOCTOU）
            signal: controller.signal,
          });
        } catch (err: any) {
          return { success: false, url: currentUrl, error: err?.message || String(err) };
        } finally {
          clearTimeout(timer);
        }

        // 重定向：逐跳重校验
        if (res.status >= 300 && res.status < 400) {
          const location = res.headers.get('location');
          if (!location || hop === MAX_REDIRECTS) {
            return { success: false, url: currentUrl, status: res.status, error: '重定向缺少 Location 或超过 3 跳上限' };
          }
          currentUrl = new URL(location, currentUrl).toString();
          continue;
        }

        const text = await res.text().catch(() => '');
        return {
          success: res.ok,
          url: currentUrl,
          status: res.status,
          contentType: res.headers.get('content-type') || undefined,
          body: text.length > 200_000 ? `${text.slice(0, 200_000)}\n...[截断,共 ${text.length} 字符]` : text,
          ...(credentialRef ? { credentialRef: String(credentialRef), credentialInjected: true } : {}),
        };
      }
      return { success: false, url: String(url), error: '重定向跳数超限' };
    },
  });
}
