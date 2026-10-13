import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'node:url';
import type { RunnerTaskPack } from '@agtpilot/protocol';
import {
  buildClaudeArgs,
  parseStreamLine,
  summarizeToolInput,
  tail2k,
  ClaudeCodeAdapter,
  DISALLOWED_TOOLS,
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

const ENV_KEYS = ['FAKE_CLAUDE_ARGS_FILE', 'FAKE_CLAUDE_EXIT', 'FAKE_CLAUDE_SLEEP_MS', 'FAKE_CLAUDE_NO_PR', 'FAKE_CLAUDE_BAD_RESULT', 'FAKE_CLAUDE_NO_RESULT'];
afterEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
});

describe('buildClaudeArgs(§6.1 固化命令行,纯函数直测)', () => {
  const args = buildClaudeArgs(pack, '/ws/repo', 'PROMPT');

  it('headless + stream-json + default 权限模式 + 轮次上限 + add-dir', () => {
    expect(args.slice(0, 2)).toEqual(['-p', 'PROMPT']);
    expect(args).toContain('--output-format');
    expect(args[args.indexOf('--output-format') + 1]).toBe('stream-json');
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('default');
    expect(args[args.indexOf('--max-turns') + 1]).toBe('42');
    expect(args[args.indexOf('--add-dir') + 1]).toBe('/ws/repo');
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
    const a2 = buildClaudeArgs({ ...pack, acceptance: {} }, '/ws/repo', 'P');
    expect(a2[a2.indexOf('--allowedTools') + 1]).not.toContain('pytest');
  });
});

describe('parseStreamLine(stream-json 宽容解析)', () => {
  it('system/init → 会话启动 + 模型名', () => {
    expect(parseStreamLine('{"type":"system","subtype":"init","model":"sonnet"}')).toEqual({
      kind: 'system',
      summary: '会话启动 · 模型 sonnet',
    });
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

describe('ClaudeCodeAdapter.run(真 spawn 假 claude + 假 git/验收 exec)', () => {
  it('成功路径:进度事件流 + commit/diffstat/验收尾部 + pr-final 提取;实收参数无红线', async () => {
    const dir = tmpDir();
    process.env.FAKE_CLAUDE_ARGS_FILE = path.join(dir, 'argv.json');
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

    // 真实 argv 复核红线:无 dangerously,禁用清单在场,prompt 是渲染后的任务指令
    const argv: string[] = JSON.parse(fs.readFileSync(process.env.FAKE_CLAUDE_ARGS_FILE!, 'utf-8'));
    expect(argv).not.toContain('--dangerously-skip-permissions');
    expect(argv).toContain('--disallowedTools');
    expect(argv[argv.indexOf('-p') + 1]).toContain('严禁 git push');
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

  it('工作分支无本地 commit(ahead=0)→ 失败「没有产出」', async () => {
    const r = await new ClaudeCodeAdapter({ bin: FIXTURE, exec: fakeGitExec({ ahead: '0' }) }).run(pack, tmpDir());
    expect(r.ok).toBe(false);
    expect(r.error).toContain('无本地 commit');
  }, 20_000);

  it('验收命令未通过 → 失败并带 testTail(runner 独立复跑,不信任 agent 自述)', async () => {
    const r = await new ClaudeCodeAdapter({ bin: FIXTURE, exec: fakeGitExec({ testFail: true }) }).run(pack, tmpDir());
    expect(r.ok).toBe(false);
    expect(r.error).toContain('验收命令未通过');
    expect(r.testTail).toContain('FAILED tests/test_sampling.py');
    expect(r.commitHash).toBe('abc123def456'); // 产出信息仍回流,便于人工介入
  }, 20_000);
});
