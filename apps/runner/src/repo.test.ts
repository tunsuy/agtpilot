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
