import { Context } from '@deepseek-ai/cordis';
import '@agtpilot/core';
import {
  buildChildEnv,
  decideFence,
  buildBwrapArgs,
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

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

export const name = 'agtpilot-plugin-sandbox';
export const inject = ['agent'];

export interface SandboxConfig {
  workspaceRoot?: string;
  defaultTimeoutMs?: number;
  e2bApiKey?: string;
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

export function apply(ctx: Context, config: SandboxConfig = {}) {
  // 工具路由自注册：prompt 命中代码/命令执行类关键词时挂载本插件工具组
  ctx.agent.registerToolRoute({
    id: 'sandbox',
    prefixes: ['sandbox_'],
    test: /(代码|脚本|运行|执行|命令|编译|部署|python|javascript|node|shell|sql|code|script|run|execute)/i,
  });

  const workspaceRoot = config.workspaceRoot || process.cwd();
  const defaultTimeoutMs = config.defaultTimeoutMs || 30000;
  const tempSandboxDir = path.resolve(workspaceRoot, '.cache/sandbox');
  const bwrapAvailable = detectBwrap();

  if (!fsSync.existsSync(tempSandboxDir)) {
    fsSync.mkdirSync(tempSandboxDir, { recursive: true });
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

  // 1. 命令执行原子能力 (sandbox_run_command)
  ctx.agent.registerTool({
    name: 'sandbox_run_command',
    description: '在宿主机的工作目录中执行 Shell 命令，返回标准输出、标准错误和退出码。隔离层级：默认 local（路径围栏+环境白名单，无系统级隔离）；fence 配置开启且宿主机有 bwrap 时为 bwrap 内核围栏（只读根+可写工作区）；Python 代码可改用 sandbox_run_code 走 E2B 云端 MicroVM 隔离。高危工具，触发安全审批拦截。',
    dangerLevel: 'high',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: '待执行的终端命令 (如: "ls -la", "pnpm test")' },
        cwd: { type: 'string', description: '命令执行的工作目录，默认为当前项目根目录' },
        timeoutMs: { type: 'number', description: '命令执行超时毫秒数，默认 30000ms' },
      },
      required: ['command'],
    },
    execute: async ({ command, cwd, timeoutMs }, session?: any) => {
      let execCwd = workspaceRoot;
      if (cwd) {
        const resolved = resolveSafePath(String(cwd));
        if (!resolved) {
          return { success: false, command, error: `工作目录越界: ${cwd}（只允许 workspace 内路径）` };
        }
        execCwd = resolved;
      }
      const timeout = timeoutMs || defaultTimeoutMs;
      const startTime = Date.now();

      // 内核围栏决策(hard_requirement 下 bwrap 缺失 → 拒绝执行)
      const fence = fenceDecision(session);
      if (fence.blocked) {
        ctx.agent.emitEvent({
          type: 'thought',
          payload: { text: `沙箱围栏拒绝执行: ${fence.reason}` },
          timestamp: Date.now(),
        });
        return { success: false, command, error: fence.reason, fence: 'blocked' };
      }
      if (fence.degraded) {
        ctx.agent.emitEvent({
          type: 'thought',
          payload: { text: `沙箱围栏降级: ${fence.reason}` },
          timestamp: Date.now(),
        });
      }
      const fenceLabel = fence.wrap ? 'bwrap' : fence.degraded ? 'degraded (bwrap 不可用)' : 'off';

      try {
        const env = childEnv(session);
        const { stdout, stderr } = fence.wrap
          ? await execFileAsync(
              'bwrap',
              [...buildBwrapArgs({ workspaceRoot, net: session?.sandbox?.net }), '--', '/bin/sh', '-c', String(command)],
              { cwd: execCwd, timeout, maxBuffer: 10 * 1024 * 1024, env },
            )
          : await execAsync(command, {
              cwd: execCwd,
              timeout,
              maxBuffer: 10 * 1024 * 1024, // 10MB 缓冲区保护
              env,
            });

        const durationMs = Date.now() - startTime;
        ctx.agent.emitEvent({
          type: 'terminal_output',
          payload: {
            command,
            cwd: execCwd,
            stdout: stdout.trim(),
            stderr: stderr.trim(),
            exitCode: 0,
            durationMs,
            fence: fenceLabel,
          },
          timestamp: Date.now(),
        });
        return {
          success: true,
          command,
          exitCode: 0,
          stdout: stdout.trim(),
          stderr: stderr.trim(),
          durationMs,
          fence: fenceLabel,
        };
      } catch (err: any) {
        const durationMs = Date.now() - startTime;
        const errOut = (err.stderr || err.message || '').trim();
        const stdOut = (err.stdout || '').trim();
        ctx.agent.emitEvent({
          type: 'terminal_output',
          payload: {
            command,
            cwd: execCwd,
            stdout: stdOut,
            stderr: errOut,
            exitCode: err.code ?? -1,
            durationMs,
            fence: fenceLabel,
          },
          timestamp: Date.now(),
        });
        return {
          success: false,
          command,
          exitCode: err.code ?? -1,
          stdout: stdOut,
          stderr: errOut,
          durationMs,
          timedOut: err.killed || false,
          fence: fenceLabel,
        };
      }
    },
  });

  // 2. 本地/云端多语言代码解释执行 (sandbox_run_code)
  ctx.agent.registerTool({
    name: 'sandbox_run_code',
    description: '执行一段 Node.js (JavaScript/TypeScript) 或 Python 代码片段：配置了 E2B_API_KEY 且为 Python 时自动走云端 Firecracker 微虚拟机隔离执行（结果 mode=e2b-isolated）；否则在本地临时目录执行（默认无系统级隔离，结果 mode=local；fence 开启且宿主机有 bwrap 时以只读根内核围栏包裹，结果 fence=bwrap；降级时会显式标注）。',
    dangerLevel: 'high',
    parameters: {
      type: 'object',
      properties: {
        language: {
          type: 'string',
          enum: ['javascript', 'typescript', 'python'],
          description: '代码所用语言类型',
        },
        code: { type: 'string', description: '待执行的代码文本内容' },
        timeoutMs: { type: 'number', description: '执行超时时间 (毫秒)，默认 15000ms' },
      },
      required: ['language', 'code'],
    },
    execute: async ({ language, code, timeoutMs = 15000 }, session?: any) => {
      // 若检测到 Python 代码且配置了 E2B_API_KEY，自动走云端 Firecracker 微虚拟机
      // 用户级 Key 优先（session.env 来自任务发起者的个人空间，多用户隔离）
      const e2bKey = session?.env?.E2B_API_KEY || config.e2bApiKey || process.env.E2B_API_KEY;
      if (language === 'python' && e2bKey) {
        let sandbox: any = null;
        try {
          sandbox = await E2BSandbox.create({ apiKey: e2bKey });
          const execution = await sandbox.runCode(code, { timeoutMs });
          return {
            success: !execution.error,
            language: 'python (E2B Cloud MicroVM)',
            mode: 'e2b-isolated',
            stdout: execution.logs.stdout.join('\n').trim(),
            stderr: execution.logs.stderr.join('\n').trim(),
            error: execution.error ? execution.error.value : undefined,
            artifacts: (execution.results || []).map((r: any) => ({
              text: r.text,
              hasImage: !!(r.png || r.jpeg),
            })),
          };
        } catch (err: any) {
          // 云端沙箱失败 → 降级本地执行，但必须让模型与用户看见降级事实
          ctx.agent.emitEvent({
            type: 'thought',
            payload: {
              text: `E2B 云端沙箱不可用（${err.message}），已降级为本地临时目录执行（无系统级隔离）。`,
            },
            timestamp: Date.now(),
          });
        } finally {
          if (sandbox) await sandbox.kill().catch(() => {});
        }
      }

      // 本地临时目录执行（注意：非系统级隔离，与宿主共享文件系统；fence 配置开启且
      // 宿主机有 bwrap 时以只读根内核围栏包裹，可写区仅 workspace）
      const fileExt = language === 'python' ? '.py' : language === 'typescript' ? '.ts' : '.mjs';
      const tempFileName = `snippet_${Date.now()}_${Math.random().toString(36).slice(2, 6)}${fileExt}`;
      const tempFilePath = path.join(tempSandboxDir, tempFileName);
      const degraded = Boolean(language === 'python' && e2bKey);

      const fence = fenceDecision(session);
      if (fence.blocked) {
        return { success: false, language, error: fence.reason, fence: 'blocked' };
      }
      if (fence.degraded) {
        ctx.agent.emitEvent({
          type: 'thought',
          payload: { text: `沙箱围栏降级: ${fence.reason}` },
          timestamp: Date.now(),
        });
      }
      const fenceLabel = fence.wrap ? 'bwrap' : fence.degraded ? 'degraded (bwrap 不可用)' : 'off';

      try {
        await fs.writeFile(tempFilePath, code, 'utf-8');

        // execFile 数组参数：临时文件路径不经 shell 解释（路径由本插件生成，但保持零 shell 原则）
        const runner =
          language === 'python' ? 'python3' : language === 'typescript' ? 'npx' : 'node';
        const runnerArgs =
          language === 'typescript' ? ['tsx', tempFilePath] : [tempFilePath];

        const startTime = Date.now();
        const { stdout, stderr } = fence.wrap
          ? await execFileAsync(
              'bwrap',
              [
                ...buildBwrapArgs({ workspaceRoot, net: session?.sandbox?.net }),
                '--',
                runner,
                ...runnerArgs,
              ],
              { cwd: workspaceRoot, timeout: timeoutMs, env: childEnv(session) },
            )
          : await execFileAsync(runner, runnerArgs, {
              cwd: workspaceRoot,
              timeout: timeoutMs,
              env: childEnv(session),
            });

        return {
          success: true,
          language,
          mode: degraded ? 'local-fallback (E2B 不可用)' : 'local',
          fence: fenceLabel,
          stdout: stdout.trim(),
          stderr: stderr.trim(),
          durationMs: Date.now() - startTime,
          ...(degraded ? { warning: '云端隔离沙箱不可用，本次在本地宿主环境执行。' } : {}),
        };
      } catch (err: any) {
        return {
          success: false,
          language,
          mode: degraded ? 'local-fallback (E2B 不可用)' : 'local',
          fence: fenceLabel,
          stdout: (err.stdout || '').trim(),
          stderr: (err.stderr || err.message || '').trim(),
          error: err.message,
        };
      } finally {
        await fs.unlink(tempFilePath).catch(() => {});
      }
    },
  });

  // 3. E2B 官方云端安全微虚拟机 (Firecracker MicroVM) 沙箱执行 (sandbox_e2b_run_python)
  ctx.agent.registerTool({
    name: 'sandbox_e2b_run_python',
    description: '在 E2B 官方云端安全微虚拟机 (Firecracker MicroVM) 沙箱中执行 Python 代码，支持全套科学计算库 (pandas, numpy, matplotlib) 并能自动捕获生成的图表与可视化图片',
    dangerLevel: 'high',
    parameters: {
      type: 'object',
      properties: {
        code: { type: 'string', description: '待在 E2B 沙箱微虚拟机中执行的 Python 代码' },
      },
      required: ['code'],
    },
    execute: async ({ code }, session?: any) => {
      // 用户级 Key 优先（session.env 来自任务发起者的个人空间，多用户隔离）
      const apiKey = session?.env?.E2B_API_KEY || config.e2bApiKey || process.env.E2B_API_KEY;
      if (!apiKey) {
        return {
          success: false,
          error: '未配置 E2B_API_KEY。请在环境变量或插件配置中设置 E2B_API_KEY 即可使用云端安全 MicroVM 沙箱。',
        };
      }

      ctx.agent.emitEvent({
        type: 'tool_call',
        payload: { tool: 'sandbox_e2b_run_python', codeSnippet: code.slice(0, 100) },
        timestamp: Date.now(),
      });

      let sandbox: any = null;
      try {
        sandbox = await E2BSandbox.create({ apiKey });
        const execution = await sandbox.runCode(code, { timeoutMs: defaultTimeoutMs * 4 });

        const logs = {
          stdout: execution.logs.stdout.join('\n'),
          stderr: execution.logs.stderr.join('\n'),
        };

        const artifacts = (execution.results || []).map((r: any) => ({
          text: r.text,
          formats: r.formats ? Object.keys(r.formats) : [],
          isChartOrImage: !!(r.png || r.jpeg || r.svg),
          pngBase64: r.png,
        }));

        // 沙箱内代码报错是真实失败（success:false），不能拿着 error 还报 success
        return {
          success: !execution.error,
          logs,
          artifacts,
          ...(execution.error ? { error: execution.error.value } : {}),
        };
      } catch (err: any) {
        return {
          success: false,
          error: err.message,
        };
      } finally {
        if (sandbox) {
          await sandbox.kill().catch(() => {});
        }
      }
    },
  });

  // 4. 安全读取文件 (sandbox_read_file)
  ctx.agent.registerTool({
    name: 'sandbox_read_file',
    description: '读取工作区中指定文件的文本内容 (支持按行读取与防超大文件截断保护)',
    dangerLevel: 'low',
    parameters: {
      type: 'object',
      properties: {
        filePath: { type: 'string', description: '待读取的目标文件路径' },
        startLine: { type: 'number', description: '起始行号 (可选，从 1 开始)' },
        maxLines: { type: 'number', description: '最大读取行数 (默认 500 行)' },
      },
      required: ['filePath'],
    },
    execute: async ({ filePath, startLine = 1, maxLines = 500 }) => {
      const fullPath = resolveSafePath(String(filePath));
      if (!fullPath) {
        return { success: false, filePath, error: `路径越界: ${filePath}（只允许 workspace 内路径）` };
      }

      try {
        const stats = await fs.stat(fullPath);
        if (stats.isDirectory()) {
          return { success: false, error: `路径 [${filePath}] 是一个目录，请使用 sandbox_list_dir。` };
        }

        const rawContent = await fs.readFile(fullPath, 'utf-8');
        const lines = rawContent.split('\n');
        const totalLines = lines.length;

        const startIdx = Math.max(0, startLine - 1);
        const selectedLines = lines.slice(startIdx, startIdx + maxLines);

        return {
          success: true,
          filePath,
          totalLines,
          startLine,
          linesRead: selectedLines.length,
          content: selectedLines.join('\n'),
        };
      } catch (err: any) {
        return {
          success: false,
          filePath,
          error: err.message,
        };
      }
    },
  });

  // 5. 安全写入/更新文件 (sandbox_write_file)
  ctx.agent.registerTool({
    name: 'sandbox_write_file',
    description: '向工作区指定文件写入内容 (自动创建不存在的父级目录)',
    dangerLevel: 'medium',
    parameters: {
      type: 'object',
      properties: {
        filePath: { type: 'string', description: '目标文件路径' },
        content: { type: 'string', description: '需要写入的文件内容' },
        overwrite: { type: 'boolean', description: '是否允许覆盖已有文件，默认 true' },
      },
      required: ['filePath', 'content'],
    },
    execute: async ({ filePath, content, overwrite = true }) => {
      const fullPath = resolveSafePath(String(filePath));
      if (!fullPath) {
        return {
          success: false,
          filePath,
          error: `路径越界: ${filePath}（只允许 workspace 内路径）`,
        };
      }

      try {
        if (!overwrite && fsSync.existsSync(fullPath)) {
          return {
            success: false,
            filePath,
            error: `文件 [${filePath}] 已存在且 overwrite 为 false。`,
          };
        }

        await fs.mkdir(path.dirname(fullPath), { recursive: true });
        await fs.writeFile(fullPath, content, 'utf-8');

        return {
          success: true,
          filePath,
          bytesWritten: Buffer.byteLength(content, 'utf-8'),
          message: `已成功保存文件: ${filePath}`,
        };
      } catch (err: any) {
        return {
          success: false,
          filePath,
          error: err.message,
        };
      }
    },
  });

  // 6. 目录浏览 (sandbox_list_dir)
  ctx.agent.registerTool({
    name: 'sandbox_list_dir',
    description: '列出指定目录下的所有文件与子文件夹详情',
    dangerLevel: 'low',
    parameters: {
      type: 'object',
      properties: {
        dirPath: { type: 'string', description: '目标目录路径，默认为当前工作区根目录' },
      },
    },
    execute: async ({ dirPath = '.' }) => {
      const fullPath = resolveSafePath(String(dirPath)) || workspaceRoot;

      try {
        const entries = await fs.readdir(fullPath, { withFileTypes: true });
        const list = entries.map((entry) => ({
          name: entry.name,
          isDirectory: entry.isDirectory(),
          isFile: entry.isFile(),
        }));

        return {
          success: true,
          dirPath,
          count: list.length,
          entries: list,
        };
      } catch (err: any) {
        return {
          success: false,
          dirPath,
          error: err.message,
        };
      }
    },
  });

  // 7. 受控 HTTP 出站 (sandbox_http_request) —— 凭据托管注入 + 端点绑定 + 私网围栏
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
