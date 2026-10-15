import { spawn, execFile, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { promisify } from 'node:util';
import { renderTaskPrompt, extractPrFinal, type RunnerTaskPack } from '@agtpilot/protocol';
import type { ExecAsync } from './repo';

/**
 * Phase 1 执行器(docs/design/local-runner-bridge.md §6.1):
 * spawn 用户本机已登录的 claude CLI(headless -p + stream-json),
 * 工具白名单是**真正的安全围栏**(prompt 里的红线只是提示,不依赖它)。
 *
 * 红线(测试断言):
 * - 永不传 --dangerously-skip-permissions;
 * - disallowedTools 固化:git push / gh / WebFetch / WebSearch;
 * - 零 shell:spawn/execFile 数组参数(测试命令经 bash -c 是明确例外,
 *   命令串来自云端审批过的任务包,且在 repoDir 内、带超时)。
 */

export interface Phase1Result {
  ok: boolean;
  /** 工作分支 HEAD(agent 的本地 commit) */
  commitHash?: string;
  diffstat?: string;
  /** 验收命令输出尾部(≤2KB,standard 档) */
  testTail?: string;
  /** agent 按约定输出的 PR 终稿(可能为 null:不阻塞审批,人工可补) */
  prFinal?: { title: string; body: string } | null;
  error?: string;
}

export type ParsedStreamEvent =
  | { kind: 'system'; summary: string }
  | { kind: 'tool'; tool: string; summary: string }
  | { kind: 'text'; summary: string }
  | { kind: 'result'; text: string; isError: boolean };

export interface ExecutorAdapter {
  name: string;
  /** 本机探测:CLI 是否安装可用(派发前云端设备页可展示) */
  detect(): Promise<{ installed: boolean; version?: string }>;
  /** opts.baseBranch = prepareRepo 实探基线(master 默认仓库的回落值),供 git 基线校验 */
  run(
    pack: RunnerTaskPack,
    repoDir: string,
    onProgress?: (e: ParsedStreamEvent) => void,
    opts?: { baseBranch?: string }
  ): Promise<Phase1Result>;
}

/** 固化的工具白名单(§6.1;验收命令另行拼入,见 buildClaudeArgs) */
const ALLOWED_BASE = [
  'Read',
  'Edit',
  'Write',
  'Bash(git status:*)',
  'Bash(git diff:*)',
  'Bash(git log:*)',
  'Bash(git add:*)',
  'Bash(git commit:*)',
  'Bash(git checkout:*)',
  'Bash(git branch:*)',
];

/** 固化的禁用清单:对外副作用与网络一律封死(发布走云端审批门) */
export const DISALLOWED_TOOLS = 'Bash(git push:*),Bash(gh:*),WebFetch,WebSearch';

/** 纯函数:任务包 → claude CLI 参数(测试直接断言白名单与红线缺席) */
export function buildClaudeArgs(pack: RunnerTaskPack, repoDir: string, prompt: string): string[] {
  const allowed = [...ALLOWED_BASE];
  const test = pack.acceptance.testCommand;
  if (test) {
    // 精确匹配 + 前缀匹配(允许 agent 给验收命令加参数,如 pytest -k xxx)
    allowed.push(`Bash(${test})`, `Bash(${test}:*)`);
  }
  return [
    '-p',
    prompt,
    '--output-format',
    'stream-json',
    // print 模式下 stream-json 需要 --verbose(CLI 硬性要求)
    '--verbose',
    '--permission-mode',
    'default',
    '--allowedTools',
    allowed.join(','),
    '--disallowedTools',
    DISALLOWED_TOOLS,
    '--max-turns',
    String(pack.executor.maxTurns),
    '--add-dir',
    repoDir,
  ];
}

/** stream-json 逐行解析(宽容:非 JSON / 未知结构 → null,不中断流) */
export function parseStreamLine(line: string): ParsedStreamEvent | null {
  const t = line.trim();
  if (!t.startsWith('{')) return null;
  let o: Record<string, unknown>;
  try {
    o = JSON.parse(t) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (o.type === 'system') {
    const model = typeof o.model === 'string' ? o.model : '';
    return { kind: 'system', summary: model ? `会话启动 · 模型 ${model}` : '会话启动' };
  }
  if (o.type === 'assistant') {
    const msg = o.message as { content?: unknown[] } | undefined;
    const content = Array.isArray(msg?.content) ? msg!.content : [];
    for (const c of content as Record<string, unknown>[]) {
      if (c?.type === 'tool_use' && typeof c.name === 'string') {
        return { kind: 'tool', tool: c.name, summary: summarizeToolInput(c.input) };
      }
      if (c?.type === 'text' && typeof c.text === 'string' && c.text.trim()) {
        return { kind: 'text', summary: oneLine(c.text, 160) };
      }
    }
    return null;
  }
  if (o.type === 'result') {
    return {
      kind: 'result',
      text: typeof o.result === 'string' ? o.result : '',
      isError: o.is_error === true || o.subtype === 'error_max_turns' || o.subtype === 'error_during_execution',
    };
  }
  return null;
}

function oneLine(s: string, max: number): string {
  const line = s.split('\n').map((x) => x.trim()).filter(Boolean)[0] ?? '';
  return line.length > max ? line.slice(0, max) + '…' : line;
}

/** 工具入参 → 一行摘要(standard 档:工具名 + 一行,不含代码内容) */
export function summarizeToolInput(input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const o = input as Record<string, unknown>;
  for (const key of ['command', 'file_path', 'notebook_path', 'path', 'pattern', 'description', 'url', 'query']) {
    if (typeof o[key] === 'string') return oneLine(o[key] as string, 120);
  }
  try {
    return oneLine(JSON.stringify(o), 120);
  } catch {
    return '';
  }
}

/** 输出尾部截断(standard 档:测试尾部 ≤2KB) */
export function tail2k(s: string): string {
  return s.length > 2048 ? '…' + s.slice(-2048) : s;
}

export type SpawnImpl = (cmd: string, args: string[], opts: SpawnOptions) => ChildProcess;

/**
 * tree-kill(§7 资源围栏,M4):claude 以 detached 起独立进程组,
 * 超时时按组负 pid 杀整棵树(claude 可能再 spawn 子进程,单杀父进程会留孤儿);
 * 组杀失败(平台不支持/已退出)回落单进程 kill。
 */
export function killTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (typeof child.pid === 'number') {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      /* 组不存在或已退出,回落 */
    }
  }
  try {
    child.kill(signal);
  } catch {
    /* 已退出 */
  }
}

const execFileAsync = promisify(execFile) as unknown as ExecAsync;
const defaultExec: ExecAsync = (cmd, args, opts) =>
  execFileAsync(cmd, args, { timeout: 10 * 60 * 1000, maxBuffer: 16 * 1024 * 1024, ...opts });

export interface ClaudeCodeAdapterOptions {
  /** claude 可执行文件(测试注入假二进制) */
  bin?: string;
  spawnImpl?: SpawnImpl;
  exec?: ExecAsync;
  /** 测试用:覆盖任务包的超时(毫秒);生产走 pack.executor.timeoutMinutes */
  timeoutMs?: number;
}

export class ClaudeCodeAdapter implements ExecutorAdapter {
  readonly name = 'claude-code';
  private bin: string;
  private spawnImpl: SpawnImpl;
  private exec: ExecAsync;
  private timeoutMs?: number;

  constructor(opts: ClaudeCodeAdapterOptions = {}) {
    this.bin = opts.bin ?? 'claude';
    this.spawnImpl = opts.spawnImpl ?? (spawn as unknown as SpawnImpl);
    this.exec = opts.exec ?? defaultExec;
    this.timeoutMs = opts.timeoutMs;
  }

  async detect(): Promise<{ installed: boolean; version?: string }> {
    try {
      const { stdout } = await this.exec(this.bin, ['--version'], { timeout: 10_000 });
      return { installed: true, version: oneLine(stdout, 100) };
    } catch {
      return { installed: false };
    }
  }

  async run(
    pack: RunnerTaskPack,
    repoDir: string,
    onProgress?: (e: ParsedStreamEvent) => void,
    opts?: { baseBranch?: string }
  ): Promise<Phase1Result> {
    const prompt = renderTaskPrompt(pack);
    const args = buildClaudeArgs(pack, repoDir, prompt);

    // ---- 1. headless 跑 agent(流式解析 stream-json → 进度事件) ----
    const timeoutMs = this.timeoutMs ?? Math.max(1, pack.executor.timeoutMinutes) * 60_000;
    const agent = await this.runClaude(args, repoDir, timeoutMs, onProgress);
    if (!agent.ok) return { ok: false, error: agent.error };

    const prFinal = agent.resultText ? extractPrFinal(agent.resultText) : null;

    // ---- 2. git 校验:工作分支上必须有 agent 的本地 commit(§6.1 终态判据) ----
    // 基线优先用 prepareRepo 实探结果(master 默认仓库的回落值);缺省退 pack
    const base = opts?.baseBranch || pack.baseBranch || 'main';
    let commitHash = '';
    try {
      commitHash = (await this.exec('git', ['-C', repoDir, 'rev-parse', 'HEAD'])).stdout.trim();
    } catch {
      return { ok: false, error: '无法读取工作分支 HEAD(git rev-parse 失败)', prFinal };
    }
    let ahead = -1;
    for (const range of [`origin/${base}..HEAD`, `${base}..HEAD`]) {
      try {
        ahead = Number((await this.exec('git', ['-C', repoDir, 'rev-list', '--count', range])).stdout.trim());
        break;
      } catch {
        /* 换下一个 range */
      }
    }
    if (ahead === 0) {
      return { ok: false, error: 'agent 结束但工作分支无本地 commit(没有产出)', prFinal };
    }
    if (ahead < 0) {
      return { ok: false, error: `无法确认相对基线 ${base} 的 commit 数(git rev-list 失败)`, prFinal };
    }

    let diffstat = '';
    for (const range of [`origin/${base}...HEAD`, `${base}...HEAD`]) {
      try {
        diffstat = (await this.exec('git', ['-C', repoDir, 'diff', '--stat', range])).stdout.trim();
        break;
      } catch {
        /* 换下一个 range */
      }
    }

    // ---- 3. 验收命令:runner 侧独立复跑(不信任 agent 自述) ----
    let testTail: string | undefined;
    const testCommand = pack.acceptance.testCommand;
    if (testCommand) {
      try {
        const r = await this.exec('bash', ['-c', testCommand], { cwd: repoDir, timeout: 10 * 60 * 1000 });
        testTail = tail2k(`${r.stdout}${r.stderr ? '\n' + r.stderr : ''}`);
      } catch (e) {
        const err = e as { stdout?: string; stderr?: string; killed?: boolean; message?: string };
        const out = `${err.stdout ?? ''}${err.stderr ? '\n' + err.stderr : ''}`.trim();
        return {
          ok: false,
          error: err.killed ? '验收命令超时(10 分钟)' : '验收命令未通过',
          commitHash,
          diffstat: diffstat || undefined,
          testTail: tail2k(out || err.message || ''),
          prFinal,
        };
      }
    }

    return { ok: true, commitHash, diffstat: diffstat || undefined, testTail, prFinal };
  }

  /** spawn claude 并流式消费 stdout;超时 tree-kill(SIGTERM→5s→SIGKILL,整进程组) */
  private runClaude(
    args: string[],
    repoDir: string,
    timeoutMs: number,
    onProgress?: (e: ParsedStreamEvent) => void
  ): Promise<{ ok: boolean; resultText?: string; error?: string }> {
    return new Promise((resolve) => {
      const child = this.spawnImpl(this.bin, args, {
        cwd: repoDir,
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        // 独立进程组:超时可整树 kill(见 killTree)
        detached: true,
      });
      let buf = '';
      let stderrTail = '';
      let resultText = '';
      let resultIsError = false;
      let sawResult = false;
      let timedOut = false;
      let settled = false;

      const killTimer = setTimeout(() => {
        timedOut = true;
        killTree(child, 'SIGTERM');
        setTimeout(() => {
          killTree(child, 'SIGKILL');
        }, 5000).unref?.();
      }, timeoutMs);

      const finish = (r: { ok: boolean; resultText?: string; error?: string }) => {
        if (settled) return;
        settled = true;
        clearTimeout(killTimer);
        resolve(r);
      };

      child.stdout?.on('data', (chunk: Buffer) => {
        buf += chunk.toString('utf-8');
        let nl: number;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          const ev = parseStreamLine(line);
          if (!ev) continue;
          if (ev.kind === 'result') {
            sawResult = true;
            resultText = ev.text;
            resultIsError = ev.isError;
          } else {
            onProgress?.(ev);
          }
        }
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        stderrTail = tail2k(stderrTail + chunk.toString('utf-8'));
      });
      child.on('error', (e) => finish({ ok: false, error: `claude 启动失败:${e.message}` }));
      child.on('close', (code) => {
        if (timedOut) {
          finish({ ok: false, error: `执行超时(${Math.round(timeoutMs / 60000)} 分钟),已终止` });
          return;
        }
        if (code !== 0) {
          finish({ ok: false, error: `claude 退出码 ${code}${stderrTail ? ' · ' + stderrTail : ''}` });
          return;
        }
        if (resultIsError) {
          finish({ ok: false, error: `agent 报告执行失败(max_turns 或内部错误)${resultText ? ' · ' + oneLine(resultText, 200) : ''}` });
          return;
        }
        if (!sawResult) {
          finish({ ok: false, error: 'stream-json 未见 result 事件(输出不完整)' + (stderrTail ? ' · ' + stderrTail : '') });
          return;
        }
        finish({ ok: true, resultText });
      });
    });
  }
}
