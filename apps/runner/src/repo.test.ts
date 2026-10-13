import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { RunnerTaskPack } from '@agtpilot/protocol';
import { repoDirFor, prepareRepo, WorkspaceFenceError, type ExecAsync } from './repo';

const pack = {
  taskId: 'rtask_1',
  kind: 'oss_contribution',
  repo: 'vllm-project/vllm',
  issueUrl: 'https://github.com/vllm-project/vllm/issues/1',
  workBranch: 'contrib/fix-1',
  constraints: [],
  acceptance: {},
  prDraft: { title: 't', bodyTemplate: '' },
  executor: { name: 'claude-code', maxTurns: 10, timeoutMinutes: 5 },
} as RunnerTaskPack;

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'runner-repo-'));
}

function recExec(handler?: (cmd: string, args: string[]) => Promise<{ stdout: string; stderr: string }>) {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  const exec: ExecAsync = async (cmd, args) => {
    calls.push({ cmd, args: [...args] });
    if (handler) return handler(cmd, args);
    return { stdout: '', stderr: '' };
  };
  return { calls, exec };
}

describe('repoDirFor(workspaceRoot 围栏第二道闸)', () => {
  it('owner/repo → root 内绝对路径', () => {
    expect(repoDirFor('/ws', 'vllm-project/vllm')).toBe(path.join('/ws', 'vllm-project', 'vllm'));
  });

  it('路径穿越一律抛 WorkspaceFenceError(即便 resolve 后仍在 root 内)', () => {
    for (const bad of ['../evil', 'a/../../evil', 'owner/..', 'owner/.', '/abs/repo']) {
      expect(() => repoDirFor('/ws', bad), bad).toThrow(WorkspaceFenceError);
    }
  });
});

describe('prepareRepo(clone/fetch + 切工作分支,零 shell)', () => {
  it('目录不存在 → git clone https github 地址 + checkout -B 工作分支 origin/基线', async () => {
    const root = tmpRoot();
    const { calls, exec } = recExec();
    const r = await prepareRepo(pack, root, exec);
    expect(r.mode).toBe('cloned');
    expect(r.repoDir).toBe(path.join(root, 'vllm-project', 'vllm'));
    expect(calls[0]).toEqual({
      cmd: 'git',
      args: ['clone', '--', 'https://github.com/vllm-project/vllm.git', r.repoDir],
    });
    expect(calls[1].args).toEqual(['-C', r.repoDir, 'checkout', '-B', 'contrib/fix-1', 'origin/main']);
  });

  it('已有 .git → fetch --prune 增量更新(不重复 clone)', async () => {
    const root = tmpRoot();
    const repoDir = path.join(root, 'vllm-project', 'vllm');
    fs.mkdirSync(path.join(repoDir, '.git'), { recursive: true });
    const { calls, exec } = recExec();
    const r = await prepareRepo(pack, root, exec);
    expect(r.mode).toBe('updated');
    expect(calls[0].args.slice(2)).toEqual(['fetch', '--prune', 'origin']);
    expect(calls.some((c) => c.args[0] === 'clone')).toBe(false);
  });

  it('无远程基线(origin/main 不存在)→ 退本地基线分支', async () => {
    const root = tmpRoot();
    const { calls, exec } = recExec(async (_cmd, args) => {
      if (args.includes(`origin/main`)) throw new Error('invalid reference: origin/main');
      return { stdout: '', stderr: '' };
    });
    await prepareRepo({ ...pack, baseBranch: 'main' }, root, exec);
    expect(calls.at(-1)!.args).toEqual(['-C', expect.stringContaining('vllm'), 'checkout', '-B', 'contrib/fix-1', 'main']);
  });

  it('自定义 baseBranch 透传;围栏拒绝发生在任何 git 调用之前', async () => {
    const root = tmpRoot();
    const { calls, exec } = recExec();
    await prepareRepo({ ...pack, baseBranch: 'release-1.x' }, root, exec);
    expect(calls.at(-1)!.args.at(-1)).toBe('origin/release-1.x');

    const { calls: c2, exec: e2 } = recExec();
    await expect(prepareRepo({ ...pack, repo: '../evil' } as RunnerTaskPack, root, e2)).rejects.toThrow(WorkspaceFenceError);
    expect(c2).toHaveLength(0);
  });
});

describe('prepareRepo · 经 fork 派发(pack.viaFork,派发弹窗显式勾选)', () => {
  const forkPack = { ...pack, viaFork: true } as RunnerTaskPack;

  /** 假 gh:api user → 登录名;repo fork → 按场景成功/报错 */
  function ghRecExec(opts: { login?: string; forkError?: string } = {}) {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const exec: ExecAsync = async (cmd, args) => {
      calls.push({ cmd, args: [...args] });
      if (cmd === 'gh' && args[0] === 'api') {
        if (opts.login === undefined) throw Object.assign(new Error('gh api failed'), { stderr: 'HTTP 401: Bad credentials' });
        return { stdout: `${opts.login}\n`, stderr: '' };
      }
      if (cmd === 'gh' && args[0] === 'repo') {
        if (opts.forkError) throw Object.assign(new Error('gh repo fork failed'), { stderr: opts.forkError });
        return { stdout: '', stderr: '' };
      }
      return { stdout: '', stderr: '' };
    };
    return { calls, exec };
  }

  it('实探登录名 → gh repo fork --clone=false(幂等确保)→ 克隆 fork 副本,返回 forkRepo', async () => {
    const root = tmpRoot();
    const { calls, exec } = ghRecExec({ login: 'tunsuy' });
    const r = await prepareRepo(forkPack, root, exec);
    expect(r.forkRepo).toBe('tunsuy/vllm');
    expect(r.repoDir).toBe(path.join(root, 'tunsuy', 'vllm'));
    expect(r.mode).toBe('cloned');
    expect(calls[0]).toEqual({ cmd: 'gh', args: ['api', 'user', '--jq', '.login'] });
    expect(calls[1]).toEqual({ cmd: 'gh', args: ['repo', 'fork', 'vllm-project/vllm', '--clone=false'] });
    expect(calls[2]).toEqual({ cmd: 'git', args: ['clone', '--', 'https://github.com/tunsuy/vllm.git', r.repoDir] });
    expect(calls[3].args).toEqual(['-C', r.repoDir, 'checkout', '-B', 'contrib/fix-1', 'origin/main']);
  });

  it('fork 已存在(gh 报 already exists)→ 等同成功,继续克隆', async () => {
    const root = tmpRoot();
    const { exec } = ghRecExec({ login: 'tunsuy', forkError: 'tunsuy/vllm already exists' });
    const r = await prepareRepo(forkPack, root, exec);
    expect(r.forkRepo).toBe('tunsuy/vllm');
    expect(r.mode).toBe('cloned');
  });

  it('fork 真失败(非 already exists)→ 抛错,不克隆', async () => {
    const root = tmpRoot();
    const { calls, exec } = ghRecExec({ login: 'tunsuy', forkError: 'HTTP 403: Must have admin rights' });
    await expect(prepareRepo(forkPack, root, exec)).rejects.toThrow('gh repo fork 失败');
    expect(calls.some((c) => c.args[0] === 'clone')).toBe(false);
  });

  it('gh 未登录 → 抛错提示 gh auth login,零 gh 副作用、零 git 调用', async () => {
    const root = tmpRoot();
    const { calls, exec } = ghRecExec({ login: undefined });
    await expect(prepareRepo(forkPack, root, exec)).rejects.toThrow('gh 未登录');
    expect(calls).toHaveLength(1); // 只有探测本身
  });

  it('直连派发(无 viaFork)完全不触碰 gh;经 fork 时已有 .git → fetch 复用', async () => {
    const root = tmpRoot();
    const { calls, exec } = ghRecExec({ login: 'tunsuy' });
    const r = await prepareRepo(pack, root, exec);
    expect(r.forkRepo).toBeUndefined();
    expect(calls.every((c) => c.cmd !== 'gh')).toBe(true);

    // 经 fork + fork 目录已克隆过 → fetch 增量,不重复 clone
    const forkDir = path.join(root, 'tunsuy', 'vllm');
    fs.mkdirSync(path.join(forkDir, '.git'), { recursive: true });
    const r2 = await prepareRepo(forkPack, root, exec);
    expect(r2.mode).toBe('updated');
    expect(r2.repoDir).toBe(forkDir);
    expect(calls.filter((c) => c.args[0] === 'clone')).toHaveLength(1); // 仅直连那次;fork 复用走 fetch 不再克隆
  });
});
