import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'node:url';
import type { RunnerTaskPack } from '@agtpilot/protocol';
import {
  buildClaudeArgs,
  buildUserMessageLine,
  parseStreamLine,
  summarizeToolInput,
  tail2k,
  isRetryableClaudeFailure,
  ClaudeCodeAdapter,
  DISALLOWED_TOOLS,
  type InterjectHandle,
  type ParsedStreamEvent,
} from './executor';
import type { ExecAsync } from './repo';

/** 假 claude 二进制(§10:不碰真 CLI;shebang + 可执行位,真 spawn) */
const FIXTURE = fileURLToPath(new URL('../test/fake-claude.mjs', import.meta.url));

const pack = {
  taskId: 'rtask_1',
  kind: 'oss_contribution',
  repo: 'vllm-project/vllm',
  issueUrl: 'https://github.com/vllm-project/vllm/issues/1',
  workBranch: 'contrib/fix-1',
  constraints: [],
  acceptance: { testCommand: 'pytest tests/test_sampling.py' },
  prDraft: { title: 't', bodyTemplate: '' },
  executor: { name: 'claude-code', maxTurns: 42, timeoutMinutes: 20 },
} as RunnerTaskPack;

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'runner-exec-'));
}

/** git 校验/验收命令的假 exec(路由按 args 关键字) */
function fakeGitExec(over?: { ahead?: string; testFail?: boolean; testOut?: string }): ExecAsync {
  return async (cmd, args) => {
    const a = args.join(' ');
    if (cmd === 'git' && a.includes('rev-parse HEAD')) return { stdout: 'abc123def456\n', stderr: '' };
    if (cmd === 'git' && a.includes('rev-list --count')) return { stdout: `${over?.ahead ?? '2'}\n`, stderr: '' };
    if (cmd === 'git' && a.includes('diff --stat')) return { stdout: ' sampling_params.py | 4 +++-\n 1 file changed\n', stderr: '' };
    if (cmd === 'git' && a.includes('--version')) return { stdout: 'git version 2.43.0\n', stderr: '' };
    if (cmd === 'bash') {
      if (over?.testFail) {
        throw Object.assign(new Error('exit 1'), { stdout: '', stderr: over?.testOut ?? 'FAILED tests/test_sampling.py\n', killed: false });
      }
      return { stdout: '1 passed in 0.4s\n', stderr: '' };
    }
    if (a.includes('--version')) return { stdout: '1.2.3 (fake claude)\n', stderr: '' };
    throw new Error(`unexpected exec: ${cmd} ${a}`);
  };
}

const ENV_KEYS = ['FAKE_CLAUDE_ARGS_FILE', 'FAKE_CLAUDE_STDIN_FILE', 'FAKE_CLAUDE_AWAIT_INTERJECT', 'FAKE_CLAUDE_EXIT', 'FAKE_CLAUDE_SLEEP_MS', 'FAKE_CLAUDE_NO_PR', 'FAKE_CLAUDE_NO_ACTION', 'FAKE_CLAUDE_BAD_RESULT', 'FAKE_CLAUDE_NO_RESULT', 'FAKE_CLAUDE_STDERR'];
afterEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
});

describe('buildClaudeArgs(§6.1 固化命令行,纯函数直测)', () => {
  const args = buildClaudeArgs(pack, '/ws/repo');

  it('headless + 流式输入/输出 stream-json + default 权限模式 + 轮次上限 + add-dir', () => {
    expect(args[0]).toBe('-p');
    expect(args[args.indexOf('--input-format') + 1]).toBe('stream-json');
    expect(args).toContain('--output-format');
    expect(args[args.indexOf('--output-format') + 1]).toBe('stream-json');
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('default');
    expect(args[args.indexOf('--max-turns') + 1]).toBe('42');
    expect(args[args.indexOf('--add-dir') + 1]).toBe('/ws/repo');
  });

  it('prompt 不再进 argv(流式输入:首条消息与插话都走 stdin,超长 prompt 不撞 E2BIG)', () => {
    expect(args.join(' ')).not.toContain('PROMPT');
    // -p 后紧跟的是 flag 而不是 prompt 文本
    expect(args[args.indexOf('-p') + 1]).toBe('--input-format');
  });

  it('白名单固化:读写 + 只读/本地 git 子命令 + 验收命令(精确+前缀)', () => {
    const allowed = args[args.indexOf('--allowedTools') + 1];
    for (const t of ['Read', 'Edit', 'Write', 'Bash(git status:*)', 'Bash(git add:*)', 'Bash(git commit:*)']) {
      expect(allowed).toContain(t);
    }
    expect(allowed).toContain('Bash(pytest tests/test_sampling.py)');
    expect(allowed).toContain('Bash(pytest tests/test_sampling.py:*)');
    expect(allowed).not.toContain('git push');
    expect(allowed).not.toContain('WebFetch');
  });

  it('禁用清单固化:git push / gh / 网络;红线断言 --dangerously-skip-permissions 永不出现', () => {
    expect(args[args.indexOf('--disallowedTools') + 1]).toBe(DISALLOWED_TOOLS);
    expect(DISALLOWED_TOOLS).toContain('Bash(git push:*)');
    expect(DISALLOWED_TOOLS).toContain('Bash(gh:*)');
    expect(DISALLOWED_TOOLS).toContain('WebFetch');
    expect(DISALLOWED_TOOLS).toContain('WebSearch');
    expect(args).not.toContain('--dangerously-skip-permissions');
    expect(args.join(' ')).not.toContain('dangerously');
  });

  it('无验收命令 → 白名单不注入 Bash(pytest…)', () => {
    const a2 = buildClaudeArgs({ ...pack, acceptance: {} }, '/ws/repo');
    expect(a2[a2.indexOf('--allowedTools') + 1]).not.toContain('pytest');
  });
});

describe('parseStreamLine(stream-json 宽容解析)', () => {
  it('system/init → 会话启动 + 模型名;非 init 的 system 行 → null', () => {
    expect(parseStreamLine('{"type":"system","subtype":"init","model":"sonnet"}')).toEqual({
      kind: 'system',
      summary: '会话启动 · 模型 sonnet',
    });
    // CLI 实测:思考过程会持续输出 subtype=thinking_tokens 的 system 行(无 model 字段),
    // 旧实现把它们全标成「会话启动」,任务时间线被灌成一屏重复 —— 必须忽略
    expect(parseStreamLine('{"type":"system","subtype":"thinking_tokens","estimated_tokens":8}')).toBeNull();
    expect(parseStreamLine('{"type":"system","subtype":"status","status":"busy"}')).toBeNull();
  });

  it('assistant tool_use → 工具名 + 一行摘要;text → 仅首行', () => {
    const tool = parseStreamLine('{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"pytest -x\\nsecond"}}]}}');
    expect(tool).toEqual({ kind: 'tool', tool: 'Bash', summary: 'pytest -x' });
    const text = parseStreamLine('{"type":"assistant","message":{"content":[{"type":"text","text":"第一行\\n第二行"}]}}');
    expect(text).toEqual({ kind: 'text', summary: '第一行' });
  });

  it('result → 文本与 is_error;error_max_turns 视为失败', () => {
    expect(parseStreamLine('{"type":"result","subtype":"success","result":"done","is_error":false}')).toEqual({
      kind: 'result', text: 'done', isError: false,
    });
    expect(parseStreamLine('{"type":"result","subtype":"error_max_turns","result":"x"}')?.kind).toBe('result');
    expect(parseStreamLine('{"type":"result","subtype":"error_max_turns","result":"x"}')).toMatchObject({ isError: true });
  });

  it('非 JSON / 未知类型 / user 消息 → null(不中断流)', () => {
    expect(parseStreamLine('not json')).toBeNull();
    expect(parseStreamLine('')).toBeNull();
    expect(parseStreamLine('{"type":"user","message":{}}')).toBeNull();
    expect(parseStreamLine('{"type":"assistant","message":{"content":[]}}')).toBeNull();
    expect(parseStreamLine('{broken')).toBeNull();
  });

  it('summarizeToolInput:command/file_path 优先,兜底 JSON 截断;tail2k 截尾', () => {
    expect(summarizeToolInput({ command: 'git status\nmore' })).toBe('git status');
    expect(summarizeToolInput({ file_path: '/a/b.py' })).toBe('/a/b.py');
    expect(summarizeToolInput({ foo: 'x'.repeat(200) })).toHaveLength(121); // 120 + …
    expect(summarizeToolInput(null)).toBe('');
    expect(tail2k('a'.repeat(3000))).toHaveLength(2049);
    expect(tail2k('a'.repeat(3000)).startsWith('…')).toBe(true);
    expect(tail2k('short')).toBe('short');
  });
});

describe('isRetryableClaudeFailure(瞬时 API/网关错误分类器,加固 ①② 共用判据)', () => {
  it('生产实测事故文案 → 可重试(2026-10-15 ai.ctaigw.cn 网关别名瞬断)', () => {
    expect(
      isRetryableClaudeFailure(
        'claude 退出码 1 · [claude-code:unrecognized_model] {"model":"3bbfba16dd6e4fed90af61eee76db87f","query_source":"sdk"}'
      )
    ).toBe(true);
  });

  it('常见瞬时 API/网关/网络错误 → 可重试', () => {
    for (const e of [
      'claude 退出码 1 · API Error: overloaded',
      'claude 退出码 1 · rate_limit_error: Too many requests',
      'claude 退出码 1 · 503 Service Unavailable',
      'claude 退出码 1 · status 529 {"type":"error"}',
      'claude 退出码 1 · Error: fetch failed (ECONNRESET)',
      'claude 退出码 1 · socket hang up',
      'claude 退出码 1 · Internal server error',
      'claude 退出码 1 · connection reset by peer',
      'claude 退出码 1 · Bad Gateway',
      'claude 退出码 1 · upstream timeout, please try again',
      'claude 退出码 1 · stream disconnected before completion',
      'claude 退出码 1 · getaddrinfo EAI_AGAIN api.example.com',
    ]) {
      expect(isRetryableClaudeFailure(e), e).toBe(true);
    }
  });

  it('确定性失败 → 不重试(重跑必复现/再耗超时窗口/是真失败)', () => {
    for (const e of [
      '执行超时(30 分钟),已终止',
      'agent 报告执行失败(max_turns 或内部错误)',
      'agent 报告执行失败(max_turns 或内部错误) · 达到最大轮次',
      '验收命令未通过',
      '验收命令超时(10 分钟)',
      'agent 结束但工作分支无本地 commit(没有产出)',
      '无法读取工作分支 HEAD(git rev-parse 失败)',
      '无法确认相对基线 main 的 commit 数(git rev-list 失败)',
      'claude 启动失败:spawn claude ENOENT',
      // 退出码非零但 stderr 无瞬时指纹(如 agent 自身报错)→ 保守不重试
      'claude 退出码 1 · some deterministic agent crash',
      'claude 退出码 2',
    ]) {
      expect(isRetryableClaudeFailure(e), e).toBe(false);
    }
  });

  it('否决优先:文案同时含瞬时指纹与不可重试标记 → 不重试(如超时里提到 overloaded)', () => {
    expect(isRetryableClaudeFailure('执行超时(30 分钟),已终止 · 期间 overloaded')).toBe(false);
    expect(isRetryableClaudeFailure('验收命令未通过 · pytest 报 connection error')).toBe(false);
  });

  it('空/非字符串 → false', () => {
    expect(isRetryableClaudeFailure(undefined)).toBe(false);
    expect(isRetryableClaudeFailure(null)).toBe(false);
    expect(isRetryableClaudeFailure('')).toBe(false);
  });
});

describe('ClaudeCodeAdapter.run(真 spawn 假 claude + 假 git/验收 exec)', () => {
  it('成功路径:进度事件流 + commit/diffstat/验收尾部 + pr-final 提取;实收参数无红线', async () => {
    const dir = tmpDir();
    process.env.FAKE_CLAUDE_ARGS_FILE = path.join(dir, 'argv.json');
    process.env.FAKE_CLAUDE_STDIN_FILE = path.join(dir, 'stdin.json');
    const adapter = new ClaudeCodeAdapter({ bin: FIXTURE, exec: fakeGitExec() });
    const progress: ParsedStreamEvent[] = [];
    const r = await adapter.run(pack, dir, (e) => progress.push(e));

    expect(r.ok).toBe(true);
    expect(r.commitHash).toBe('abc123def456');
    expect(r.diffstat).toContain('sampling_params.py');
    expect(r.testTail).toContain('1 passed');
    expect(r.prFinal).toEqual({ title: 'fix: 采样参数越界校验', body: '关联 #12345\n\n增加温度参数范围校验,补充单测。' });

    // 进度:Read 工具 / 文本一行 / Bash 工具(result 不进 progress)
    expect(progress).toContainEqual({ kind: 'tool', tool: 'Read', summary: 'sampling_params.py' });
    expect(progress.some((p) => p.kind === 'text' && p.summary === '定位到校验分支,开始修复。')).toBe(true);
    expect(progress.some((p) => p.kind === 'tool' && p.tool === 'Bash')).toBe(true);
    expect(progress.some((p) => p.kind === 'result')).toBe(false);

    // 真实 argv 复核红线:无 dangerously,禁用清单在场;prompt 经 stdin 首条 user 消息送入
    const argv: string[] = JSON.parse(fs.readFileSync(process.env.FAKE_CLAUDE_ARGS_FILE!, 'utf-8'));
    expect(argv).not.toContain('--dangerously-skip-permissions');
    expect(argv).toContain('--disallowedTools');
    expect(argv[argv.indexOf('-p') + 1]).toBe('--input-format');
    const stdinTexts: string[] = JSON.parse(fs.readFileSync(process.env.FAKE_CLAUDE_STDIN_FILE!, 'utf-8'));
    expect(stdinTexts[0]).toContain('严禁 git push'); // 渲染后的任务指令
  }, 20_000);

  it('续跑模式:opts.continuation → prompt 注入续跑指令(先看 git 记录再做);缺省不注入,红线不变', async () => {
    const dir = tmpDir();
    process.env.FAKE_CLAUDE_ARGS_FILE = path.join(dir, 'argv.json');
    process.env.FAKE_CLAUDE_STDIN_FILE = path.join(dir, 'stdin.json');
    const adapter = new ClaudeCodeAdapter({ bin: FIXTURE, exec: fakeGitExec() });

    await adapter.run(pack, dir, undefined, { continuation: true, baseBranch: 'main' });
    const argv: string[] = JSON.parse(fs.readFileSync(process.env.FAKE_CLAUDE_ARGS_FILE!, 'utf-8'));
    const prompt = (JSON.parse(fs.readFileSync(process.env.FAKE_CLAUDE_STDIN_FILE!, 'utf-8')) as string[])[0];
    expect(prompt).toContain('【续跑模式】');
    expect(prompt).toContain('git log origin/main..HEAD');
    expect(prompt).toContain('已完成的工作不要重做');
    // 续跑不放松任何围栏
    expect(argv).not.toContain('--dangerously-skip-permissions');
    expect(argv[argv.indexOf('--disallowedTools') + 1]).toBe(DISALLOWED_TOOLS);

    await adapter.run(pack, dir);
    const prompt2 = (JSON.parse(fs.readFileSync(process.env.FAKE_CLAUDE_STDIN_FILE!, 'utf-8')) as string[])[0];
    expect(prompt2).not.toContain('续跑模式');
  }, 20_000);

  it('detect:--version 可执行 → installed + 版本;抛错 → installed=false', async () => {
    expect(await new ClaudeCodeAdapter({ bin: FIXTURE, exec: fakeGitExec() }).detect()).toEqual({
      installed: true, version: '1.2.3 (fake claude)',
    });
    const bad: ExecAsync = async () => { throw new Error('ENOENT'); };
    expect(await new ClaudeCodeAdapter({ bin: 'no-such-claude', exec: bad }).detect()).toEqual({ installed: false });
  });

  it('无 pr-final 围栏 → ok=true 且 prFinal=null(不阻塞,人工可补)', async () => {
    process.env.FAKE_CLAUDE_NO_PR = '1';
    const r = await new ClaudeCodeAdapter({ bin: FIXTURE, exec: fakeGitExec() }).run(pack, tmpDir());
    expect(r.ok).toBe(true);
    expect(r.prFinal).toBeNull();
  }, 20_000);

  it('非零退出码 → 失败并带 stderr 尾部', async () => {
    process.env.FAKE_CLAUDE_EXIT = '1';
    const r = await new ClaudeCodeAdapter({ bin: FIXTURE, exec: fakeGitExec() }).run(pack, tmpDir());
    expect(r.ok).toBe(false);
    expect(r.error).toContain('退出码 1');
    expect(r.error).toContain('fake-claude stderr 备注');
    // stderr 无瞬时指纹 → retryable 缺省(false),不触发自动重试
    expect(r.retryable).toBe(false);
  }, 20_000);

  it('瞬时 API 错误退出(unrecognized_model)→ 失败标 retryable:true(加固 ①/② 的判据来源)', async () => {
    process.env.FAKE_CLAUDE_EXIT = '1';
    process.env.FAKE_CLAUDE_STDERR = '[claude-code:unrecognized_model] {"model":"x","query_source":"sdk"}';
    const r = await new ClaudeCodeAdapter({ bin: FIXTURE, exec: fakeGitExec() }).run(pack, tmpDir());
    expect(r.ok).toBe(false);
    expect(r.error).toContain('退出码 1');
    expect(r.retryable).toBe(true);
  }, 20_000);

  it('max_turns(result is_error)→ retryable:false(确定性失败,不重试)', async () => {
    process.env.FAKE_CLAUDE_BAD_RESULT = '1';
    const r = await new ClaudeCodeAdapter({ bin: FIXTURE, exec: fakeGitExec() }).run(pack, tmpDir());
    expect(r.ok).toBe(false);
    expect(r.error).toContain('agent 报告执行失败');
    expect(r.retryable).toBe(false);
  }, 20_000);

  it('result is_error(max_turns)→ 失败;流缺 result → 失败', async () => {
    process.env.FAKE_CLAUDE_BAD_RESULT = '1';
    const r1 = await new ClaudeCodeAdapter({ bin: FIXTURE, exec: fakeGitExec() }).run(pack, tmpDir());
    expect(r1.ok).toBe(false);
    expect(r1.error).toContain('agent 报告执行失败');

    delete process.env.FAKE_CLAUDE_BAD_RESULT;
    process.env.FAKE_CLAUDE_NO_RESULT = '1';
    const r2 = await new ClaudeCodeAdapter({ bin: FIXTURE, exec: fakeGitExec() }).run(pack, tmpDir());
    expect(r2.ok).toBe(false);
    expect(r2.error).toContain('未见 result');
  }, 20_000);

  it('超时 → SIGTERM 终止并失败(不挂死)', async () => {
    process.env.FAKE_CLAUDE_SLEEP_MS = '5000';
    const r = await new ClaudeCodeAdapter({ bin: FIXTURE, exec: fakeGitExec(), timeoutMs: 300 }).run(pack, tmpDir());
    expect(r.ok).toBe(false);
    expect(r.error).toContain('执行超时');
  }, 20_000);

  it('云端终止(abortSignal)→ tree-kill 进程并带 aborted 返回,区别于超时/失败', async () => {
    process.env.FAKE_CLAUDE_SLEEP_MS = '5000';
    const abort = new AbortController();
    const p = new ClaudeCodeAdapter({ bin: FIXTURE, exec: fakeGitExec(), timeoutMs: 30_000 }).run(
      pack,
      tmpDir(),
      undefined,
      { abortSignal: abort.signal }
    );
    setTimeout(() => abort.abort(), 300); // 模拟保活轮询收到终止指令
    const r = await p;
    expect(r.ok).toBe(false);
    expect(r.aborted).toBe(true);
    expect(r.error).toContain('终止');
  }, 20_000);

  it('abortSignal 已触发(spawn 前取消)→ 不起进程直接 aborted 返回', async () => {
    const abort = new AbortController();
    abort.abort();
    const r = await new ClaudeCodeAdapter({ bin: FIXTURE, exec: fakeGitExec() }).run(
      pack,
      tmpDir(),
      undefined,
      { abortSignal: abort.signal }
    );
    expect(r.ok).toBe(false);
    expect(r.aborted).toBe(true);
  }, 20_000);

  it('工作分支无本地 commit(ahead=0)→ 失败「没有产出」', async () => {
    const r = await new ClaudeCodeAdapter({ bin: FIXTURE, exec: fakeGitExec({ ahead: '0' }) }).run(pack, tmpDir());
    expect(r.ok).toBe(false);
    expect(r.error).toContain('无本地 commit');
  }, 20_000);

  it('no-action 例外终态:ahead=0 + 带证据围栏 → ok:true + noAction(不再判「无产出」);prompt 含第 6 步例外出口', async () => {
    const dir = tmpDir();
    process.env.FAKE_CLAUDE_NO_ACTION = '1';
    process.env.FAKE_CLAUDE_ARGS_FILE = path.join(dir, 'argv.json');
    process.env.FAKE_CLAUDE_STDIN_FILE = path.join(dir, 'stdin.json');
    const r = await new ClaudeCodeAdapter({ bin: FIXTURE, exec: fakeGitExec({ ahead: '0' }) }).run(pack, dir);
    expect(r.ok).toBe(true);
    expect(r.noAction?.reason).toBe('already_fixed');
    expect(r.noAction?.evidence).toContain('d9bef57b8f');
    expect(r.commitHash).toBeUndefined(); // 零 commit 路径,无产出字段
    expect(r.retryable).toBeUndefined(); // 非失败,不进重试语义

    // agent 确实收到了例外出口指令(围栏约定随 prompt 下发,prompt 经 stdin 首条消息)
    const argv: string[] = JSON.parse(fs.readFileSync(process.env.FAKE_CLAUDE_ARGS_FILE!, 'utf-8'));
    expect(argv[argv.indexOf('-p') + 1]).toBe('--input-format');
    const prompt = (JSON.parse(fs.readFileSync(process.env.FAKE_CLAUDE_STDIN_FILE!, 'utf-8')) as string[])[0];
    expect(prompt).toContain('例外出口(与第 5 步二选一)');
    expect(prompt).toContain('```no-action');
    expect(prompt).toContain('不许拿这个当逃避干活的出口');
  }, 20_000);

  it('commit 优先:ahead>0 时即便回复带 no-action 围栏也走正常产出路径(noAction 恒缺省)', async () => {
    process.env.FAKE_CLAUDE_NO_ACTION = '1';
    const r = await new ClaudeCodeAdapter({ bin: FIXTURE, exec: fakeGitExec() }).run(pack, tmpDir());
    expect(r.ok).toBe(true);
    expect(r.commitHash).toBe('abc123def456');
    expect(r.noAction).toBeUndefined(); // 既 commit 又宣称无需改动自相矛盾 → 只认 commit
  }, 20_000);

  it('opts.baseBranch(实探基线)→ git 基线校验走该分支(milvus master 场景,pack 缺省 main 不再误用)', async () => {
    const seen: string[] = [];
    const wrapped: ExecAsync = async (cmd, args) => {
      const a = args.join(' ');
      if (cmd === 'git' && (a.includes('rev-list') || a.includes('diff --stat'))) seen.push(a);
      return fakeGitExec()(cmd, args);
    };
    const r = await new ClaudeCodeAdapter({ bin: FIXTURE, exec: wrapped }).run(
      pack,
      tmpDir(),
      undefined,
      { baseBranch: 'master' }
    );
    expect(r.ok).toBe(true);
    const rev = seen.find((s) => s.includes('rev-list'));
    expect(rev).toContain('origin/master..HEAD');
    expect(rev).not.toContain('main');
  }, 20_000);

  it('验收命令未通过 → 失败并带 testTail(runner 独立复跑,不信任 agent 自述)', async () => {
    const r = await new ClaudeCodeAdapter({ bin: FIXTURE, exec: fakeGitExec({ testFail: true }) }).run(pack, tmpDir());
    expect(r.ok).toBe(false);
    expect(r.error).toContain('验收命令未通过');
    expect(r.testTail).toContain('FAILED tests/test_sampling.py');
    expect(r.commitHash).toBe('abc123def456'); // 产出信息仍回流,便于人工介入
  }, 20_000);
});

describe('buildUserMessageLine(stream-json user 消息行,纯函数直测)', () => {
  it('形状:单行 JSON(换行被转义),type=user + content text 原样;换行结尾', () => {
    const line = buildUserMessageLine('第一行\n第二行');
    expect(line.endsWith('\n')).toBe(true);
    expect(line.slice(0, -1)).not.toContain('\n'); // 多行文本仍是单条消息行(不撕裂流协议)
    expect(JSON.parse(line)).toEqual({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: '第一行\n第二行' }] },
    });
  });
});

describe('中途插话(流式输入会话 · interjectHandle 注入)', () => {
  it('prompt 走 stdin 首条;执行中插话被注入会话;会话结束注入口关闭', async () => {
    const dir = tmpDir();
    process.env.FAKE_CLAUDE_STDIN_FILE = path.join(dir, 'stdin.json');
    process.env.FAKE_CLAUDE_AWAIT_INTERJECT = '1';
    const adapter = new ClaudeCodeAdapter({ bin: FIXTURE, exec: fakeGitExec() });
    const handle: InterjectHandle = { send: null };

    const runP = adapter.run(pack, dir, undefined, { interjectHandle: handle });
    // 会话起来后注入口就位(spawn 完成、假 claude 正在等插话)
    for (let i = 0; i < 100 && handle.send === null; i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(handle.send).not.toBeNull();
    const outcome = handle.send!('git 邮箱写错了,改用 bot@x.dev 重新提交');
    expect(outcome).toEqual({ delivered: true });

    const r = await runP;
    expect(r.ok).toBe(true);
    // 插话文本缀在 result 后(假 claude INTERJECTED 标记),pr-final 围栏提取不受影响
    expect(r.prFinal).toEqual({ title: 'fix: 采样参数越界校验', body: '关联 #12345\n\n增加温度参数范围校验,补充单测。' });
    // stdin 实收:首条 = 渲染后 prompt,第二条 = 插话原文
    const stdinTexts: string[] = JSON.parse(fs.readFileSync(process.env.FAKE_CLAUDE_STDIN_FILE!, 'utf-8'));
    expect(stdinTexts[0]).toContain('严禁 git push');
    expect(stdinTexts[1]).toBe('git 邮箱写错了,改用 bot@x.dev 重新提交');
    // 会话结束:注入口关闭(此后云端插话由 bin 回执 not_started,绝不注死会话)
    expect(handle.send).toBeNull();
  }, 20_000);

  it('无插话时正常收尾:首个 result 即关 stdin,会话自然退出(不等插话、不悬挂)', async () => {
    const dir = tmpDir();
    process.env.FAKE_CLAUDE_STDIN_FILE = path.join(dir, 'stdin.json');
    const adapter = new ClaudeCodeAdapter({ bin: FIXTURE, exec: fakeGitExec() });
    const handle: InterjectHandle = { send: null };
    const r = await adapter.run(pack, dir, undefined, { interjectHandle: handle });
    expect(r.ok).toBe(true);
    expect(r.prFinal).not.toBeNull();
    const stdinTexts: string[] = JSON.parse(fs.readFileSync(process.env.FAKE_CLAUDE_STDIN_FILE!, 'utf-8'));
    expect(stdinTexts).toHaveLength(1); // 只有首条 prompt,没有多余写入
  }, 20_000);

  it('未提供 handle 也照常执行(旧调用形状兼容)', async () => {
    const r = await new ClaudeCodeAdapter({ bin: FIXTURE, exec: fakeGitExec() }).run(pack, tmpDir());
    expect(r.ok).toBe(true);
  }, 20_000);
});
