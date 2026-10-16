import { spawn, execFile, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { promisify } from 'node:util';
import {
  renderTaskPrompt,
  extractPrFinal,
  extractNoActionFinal,
  type NoActionFinal,
  type RunnerTaskPack,
} from '@agtpilot/protocol';
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
  /**
   * no-action 结论(例外终态):工作分支零 commit 但 agent 输出了带证据的
   * no-action 围栏(上游已修复/无法复现/超出范围)→ ok:true + 本字段,
   * task-run 据此走 no_action 上行而非「无产出」失败。有 commit 时本字段
   * 恒缺省(commit 优先,两围栏并存不成立)。
   */
  noAction?: NoActionFinal;
  /** 任务被云端终止(用户止损):task-run 据此上报 cancelled 而非 failed */
  aborted?: boolean;
  error?: string;
  /**
   * 失败是否为**瞬时 API/网关/网络错误**(isRetryableClaudeFailure 判定)。
   * true = 重跑大概率恢复:runner 侧自动重试一次(task-run)——现场干净从头重跑,
   * 已有产出则带**续跑模式**接着做(git 记录 = 恢复点,已完成的不重做);
   * 云端把这类 failed 标成「可重试」而非干巴巴的终态(protocol RunnerTaskRecord.retryable)。
   * 仅在 claude 进程级失败(退出码带瞬时错误指纹)时为 true;
   * 超时 / max_turns / 验收失败 / 无产出 / git 校验失败一律 false(重跑无意义或必复现)。
   */
  retryable?: boolean;
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
  /**
   * opts.baseBranch = prepareRepo 实探基线(master 默认仓库的回落值),供 git 基线校验与 prompt 展示;
   * opts.continuation = 续跑模式(工作分支已有上次成果,renderTaskPrompt 注入续跑指令:
   * 先看 git log/status/diff 认清现场,接着做,不重做已完成的);
   * opts.abortSignal = 云端终止指令(用户止损),触发即杀 claude 进程树并带 aborted 返回;
   * opts.interjectHandle = 云端插话注入手柄(用户中途纠偏),会话存活期间写入 stdin。
   */
  run(
    pack: RunnerTaskPack,
    repoDir: string,
    onProgress?: (e: ParsedStreamEvent) => void,
    opts?: { baseBranch?: string; continuation?: boolean; abortSignal?: AbortSignal; interjectHandle?: InterjectHandle }
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
  // 续跑模式收尾整理 WIP commit 需要(git reset --soft 到基线后重新提交);
  // 只影响 workspaceRoot 内的本地副本,对外围栏(push/gh/网络)不变
  'Bash(git reset:*)',
  // 身份自愈窄口:prepareRepo 已预写 repo-local user.name/email,这里是
  // 兜底(agent 想改提交身份时不至于撞权限死锁,生产实测 google/ax #470)。
  // 前缀窄匹配:--global/--system 变体不以 `git config user.` 开头,进不来
  'Bash(git config user.name:*)',
  'Bash(git config user.email:*)',
];

/** 固化的禁用清单:对外副作用与网络一律封死(发布走云端审批门) */
export const DISALLOWED_TOOLS = 'Bash(git push:*),Bash(gh:*),WebFetch,WebSearch';

/** 纯函数:任务包 → claude CLI 参数(测试直接断言白名单与红线缺席)
 *  prompt 不再走 argv(流式输入模式:首条 user 消息与后续插话都经 stdin
 *  写入,见 buildUserMessageLine)——argv 里的超长 prompt 会撞 E2BIG,
 *  且中途插话必须有常驻输入通道。 */
export function buildClaudeArgs(pack: RunnerTaskPack, repoDir: string): string[] {
  const allowed = [...ALLOWED_BASE];
  const test = pack.acceptance.testCommand;
  if (test) {
    // 精确匹配 + 前缀匹配(允许 agent 给验收命令加参数,如 pytest -k xxx)
    allowed.push(`Bash(${test})`, `Bash(${test}:*)`);
  }
  return [
    '-p',
    // 流式输入:会话常驻,首条 prompt 与用户中途插话都以 stream-json user 消息写入 stdin
    '--input-format',
    'stream-json',
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

/** 纯函数:文本 → stream-json user 消息行(claude --input-format stream-json 契约) */
export function buildUserMessageLine(text: string): string {
  return (
    JSON.stringify({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text }] },
    }) + '\n'
  );
}

/** 插话送达结果(reason 供 interject_ack 回执与云端 UI 展示) */
export interface InterjectOutcome {
  delivered: boolean;
  /** not_started=会话未起/已收;finishing=agent 已出 result 正在收尾;write_failed=stdin 写入失败 */
  reason?: 'not_started' | 'finishing' | 'write_failed';
}

/**
 * 插话注入手柄:bin 主循环创建并随 runTask 下传,executor spawn claude 后填入
 * send(会话存活期间可注),close/收尾后置回 null。云端的 interject 指令到达时
 * bin 调 send —— 写入 stdin 即成为会话里的下一条 user 消息(实测:agent 会
 * 立刻处理插话再继续原任务)。
 */
export interface InterjectHandle {
  send: ((text: string) => InterjectOutcome) | null;
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
    // 只有 init 是真会话启动;CLI 还会输出 thinking_tokens 等其它 subtype 的
    // system 行(思考过程 token 估算,每步多条)——不区分会把时间线灌满重复的「会话启动」
    if (o.subtype !== 'init') return null;
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

/**
 * 瞬时失败分类器(纯函数,vitest 直测;加固 ①「runner 自动重试」与
 * 加固 ②「云端标可重试」共用同一判据,docs/design/local-runner-bridge.md §6.1)。
 *
 * 只认「claude 因瞬时 API/网关/网络错误退出」——这类重跑一次大概率恢复
 * (2026-10-15 生产实测:ai.ctaigw.cn 网关别名瞬断 → claude 退出码 1 ·
 * [claude-code:unrecognized_model],同环境两次忠实复跑均成功)。
 *
 * 明确**不**重试(重跑要么必复现、要么再耗一个超时窗口、要么是真失败):
 * 执行超时 / max_turns / 验收命令未过 / 无本地产出 / git 校验失败 / claude 启动失败。
 * 采用「先否决后放行」:命中任一 NON_RETRYABLE 立即 false,再匹配 RETRYABLE 指纹。
 */
const NON_RETRYABLE_PATTERNS: readonly RegExp[] = [
  /执行超时/,
  /max[_\s]?turns/i,
  /达到最大轮次/,
  /agent 报告执行失败/, // max_turns 或内部错误的包装文案,含 max_turns 字样 → 保守不重试
  /验收命令/,
  /无本地 commit/,
  /没有产出/,
  /无法读取工作分支/,
  /无法确认相对基线/,
  /启动失败/, // spawn 失败(detect 已过,非瞬时)
];

const RETRYABLE_PATTERNS: readonly RegExp[] = [
  /unrecognized[_\s]?model/i,
  /model[_\s]?(?:not[_\s]?(?:found|available)|unavailable)/i,
  /overloaded/i,
  /\bapi[_\s]error\b/i,
  /internal[_\s]server[_\s]error/i,
  /rate[_\s]?limit/i,
  /too[_\s]many[_\s]requests/i,
  /service[_\s]unavailable/i,
  /\bbad[_\s]gateway\b/i,
  /gateway[_\s]time-?out/i,
  /connection[_\s](?:reset|closed|refused|error|timed[_\s]?out)/i,
  /\b(?:econnreset|econnrefused|etimedout|eai_again|enotfound|ehostunreach|enetunreach|epipe)\b/i,
  /socket[_\s]hang[_\s]up/i,
  /\bfetch[_\s]failed\b/i,
  /network[_\s](?:error|unreachable)/i,
  /stream[_\s](?:disconnected|error|timeout)/i,
  /temporarily[_\s]unavailable/i,
  /\btry[_\s]again\b/i,
  /\bupstream[_\s](?:error|unavailable|timeout|reset)\b/i,
  /\bcapacity\b/i,
  /\b(?:status|code|http)[_\s:]*(?:code)?[\s:]*(?:429|500|502|503|504|529)\b/i,
];

/** claude 失败文案 → 是否瞬时(可重试);非字符串/空 → false */
export function isRetryableClaudeFailure(errorText: string | undefined | null): boolean {
  if (typeof errorText !== 'string' || !errorText) return false;
  if (NON_RETRYABLE_PATTERNS.some((re) => re.test(errorText))) return false;
  return RETRYABLE_PATTERNS.some((re) => re.test(errorText));
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
    opts?: { baseBranch?: string; continuation?: boolean; abortSignal?: AbortSignal; interjectHandle?: InterjectHandle }
  ): Promise<Phase1Result> {
    const prompt = renderTaskPrompt(pack, {
      continuation: opts?.continuation === true,
      ...(opts?.baseBranch ? { baseBranch: opts.baseBranch } : {}),
    });
    const args = buildClaudeArgs(pack, repoDir);

    // ---- 1. headless 跑 agent(流式解析 stream-json → 进度事件;prompt 经 stdin 注入) ----
    const timeoutMs = this.timeoutMs ?? Math.max(1, pack.executor.timeoutMinutes) * 60_000;
    const agent = await this.runClaude(args, prompt, repoDir, timeoutMs, onProgress, opts?.abortSignal, opts?.interjectHandle);
    // claude 进程级失败:标注是否瞬时 API/网关错误(供 task-run 自动重试 + 云端标可重试)。
    // 其余 ok:false 分支(git 校验 / 验收)是确定性失败,不带 retryable(缺省即 false)。
    // 用户中止(aborted)优先:终止就是终止,不进自动重试、不标可重试。
    if (!agent.ok) {
      if (agent.aborted) return { ok: false, error: agent.error, aborted: true };
      return { ok: false, error: agent.error, retryable: isRetryableClaudeFailure(agent.error) };
    }

    const prFinal = agent.resultText ? extractPrFinal(agent.resultText) : null;
    const noActionFinal = agent.resultText ? extractNoActionFinal(agent.resultText) : null;

    // ---- 2. git 校验:工作分支上必须有 agent 的本地 commit(§6.1 终态判据) ----
    // 例外:零 commit 但 agent 输出了带证据的 no-action 围栏 → 合法终态(无需改动),
    // 不再判「无产出」失败(生产背景:milvus #52049 已被上游修复,反复重派死循环)
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
      if (noActionFinal) {
        return { ok: true, noAction: noActionFinal };
      }
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

  /** spawn claude 并流式消费 stdout;超时 tree-kill(SIGTERM→5s→SIGKILL,整进程组);
   *  abortSignal(云端终止指令)同用 tree-kill,带 aborted=true 返回。
   *  流式输入会话:prompt 作为首条 user 消息写 stdin;首个 result 到达(agent 认为
   *  做完)即关 stdin → claude 自然退出 → 进 git 校验/验收;result 前到达的插话
   *  经 interjectHandle 注入(写入即成会话下一条 user 消息,agent 立刻处理)。 */
  private runClaude(
    args: string[],
    prompt: string,
    repoDir: string,
    timeoutMs: number,
    onProgress?: (e: ParsedStreamEvent) => void,
    abortSignal?: AbortSignal,
    interjectHandle?: InterjectHandle
  ): Promise<{ ok: boolean; resultText?: string; error?: string; aborted?: boolean }> {
    return new Promise((resolve) => {
      if (abortSignal?.aborted) {
        resolve({ ok: false, error: '任务已被终止(派发后云端即取消)', aborted: true });
        return;
      }
      const child = this.spawnImpl(this.bin, args, {
        cwd: repoDir,
        env: process.env,
        stdio: ['pipe', 'pipe', 'pipe'],
        // 独立进程组:超时可整树 kill(见 killTree)
        detached: true,
      });
      let buf = '';
      let stderrTail = '';
      let resultText = '';
      let resultIsError = false;
      let sawResult = false;
      let timedOut = false;
      let aborted = false;
      let settled = false;

      // stdin 写入通道:首条 prompt + 后续插话。EPIPE(claude 已退出/正在退出)
      // 不能让进程崩——吞掉,写入方按 write 返回值/异常如实回执 write_failed。
      child.stdin?.on('error', () => {});
      try {
        child.stdin?.write(buildUserMessageLine(prompt));
      } catch {
        /* 启动即失败会走 child.on('error')/close 分支,这里不重复处理 */
      }

      const killTimer = setTimeout(() => {
        timedOut = true;
        killTree(child, 'SIGTERM');
        setTimeout(() => {
          killTree(child, 'SIGKILL');
        }, 5000).unref?.();
      }, timeoutMs);

      // 用户止损:同超时路径整树杀(claude 可能已 spawn 子进程,单杀父进程会留孤儿)
      const onAbort = () => {
        aborted = true;
        killTree(child, 'SIGTERM');
        setTimeout(() => {
          killTree(child, 'SIGKILL');
        }, 5000).unref?.();
      };
      abortSignal?.addEventListener('abort', onAbort, { once: true });

      // 插话注入口:会话存活(未出 result、未 close)才可注;其余如实回执未送达
      if (interjectHandle) {
        interjectHandle.send = (text: string): InterjectOutcome => {
          if (settled || sawResult) return { delivered: false, reason: 'finishing' };
          try {
            child.stdin?.write(buildUserMessageLine(text));
            return { delivered: true };
          } catch {
            return { delivered: false, reason: 'write_failed' };
          }
        };
      }

      const finish = (r: { ok: boolean; resultText?: string; error?: string; aborted?: boolean }) => {
        if (settled) return;
        settled = true;
        clearTimeout(killTimer);
        abortSignal?.removeEventListener('abort', onAbort);
        if (interjectHandle) interjectHandle.send = null;
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
            // 首个 result = agent 认为任务完成:关闭输入,claude 走完当前输出即退。
            // result 前已写入 stdin 的插话仍会被处理(排队消息在 EOF 前有效),
            // 若因此多出一轮,新 result 覆盖 resultText —— 最终以最后一轮为准。
            try {
              child.stdin?.end();
            } catch {
              /* 已关/已退,EPIPE 由 error 监听吞掉 */
            }
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
        if (aborted) {
          finish({ ok: false, error: '任务已被云端终止(用户止损),本地进程已杀', aborted: true });
          return;
        }
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
