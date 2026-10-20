import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { RunnerTaskPack } from '@agtpilot/protocol';
import { repoDirFor, prepareRepo, ensureGitIdentity, isWorktreePristine, WorkspaceFenceError, type ExecAsync } from './repo';

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
    // 克隆后先固化 repo 级 git 身份(两发 config),再切工作分支
    expect(calls[1].args).toEqual(['-C', r.repoDir, 'config', 'user.name', 'agtpilot-runner']);
    expect(calls[2].args).toEqual(['-C', r.repoDir, 'config', 'user.email', 'agtpilot-runner@localhost']);
    expect(calls[3].args).toEqual(['-C', r.repoDir, 'checkout', '-B', 'contrib/fix-1', 'origin/main']);
    // 基线命中 → 零额外探测调用,回流原值
    expect(r.baseBranch).toBe('main');
    expect(calls).toHaveLength(4);
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

describe('prepareRepo · 基线分支解析(master 默认仓库,生产实测 milvus-io/milvus#52049)', () => {
  const milvusPack = { ...pack, repo: 'milvus-io/milvus', workBranch: 'contrib/oss-radar-52049' };

  /**
   * 假 exec:'main' 基线(远程/本地)checkout 一律 fatal(复现生产报错);
   * symbolic-ref / ls-remote 按注入场景返回或抛错。
   */
  function execNoMain(symbols: { symref?: string; lsRemote?: string }) {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const exec: ExecAsync = async (cmd, args) => {
      calls.push({ cmd, args: [...args] });
      const a = args.join(' ');
      if (a.includes('checkout') && (a.endsWith('origin/main') || a.endsWith(' main'))) {
        throw Object.assign(new Error('Command failed'), {
          stderr: "fatal: 'main' is not a commit and a branch 'x' cannot be created from it",
        });
      }
      if (a.includes('symbolic-ref')) {
        if (symbols.symref === undefined) throw new Error('refname refs/remotes/origin/HEAD is not a symbolic ref');
        return { stdout: `origin/${symbols.symref}\n`, stderr: '' };
      }
      if (a.includes('ls-remote')) {
        if (symbols.lsRemote === undefined) throw new Error('network unreachable');
        return { stdout: `ref: refs/heads/${symbols.lsRemote}\tHEAD\nrefs/heads/${symbols.lsRemote}\tabc123\n`, stderr: '' };
      }
      return { stdout: '', stderr: '' };
    };
    return { calls, exec };
  }

  it('main 不存在 → symbolic-ref 探测默认分支,checkout origin/master,回流 baseBranch=master', async () => {
    const root = tmpRoot();
    const { calls, exec } = execNoMain({ symref: 'master' });
    const r = await prepareRepo(milvusPack, root, exec);
    expect(r.baseBranch).toBe('master');
    expect(calls.at(-1)!.args).toEqual([
      '-C', r.repoDir, 'checkout', '-B', 'contrib/oss-radar-52049', 'origin/master',
    ]);
  });

  it('symbolic-ref 失败 → ls-remote --symref 网络实探兜底(旧目录无 origin/HEAD)', async () => {
    const root = tmpRoot();
    const { calls, exec } = execNoMain({ lsRemote: 'master' });
    const r = await prepareRepo(milvusPack, root, exec);
    expect(r.baseBranch).toBe('master');
    expect(calls.some((c) => c.args.includes('ls-remote'))).toBe(true);
    expect(calls.at(-1)!.args.at(-1)).toBe('origin/master');
  });

  it('两档探测全失败 → 抛错明示基线不存在(不静默切错误分支)', async () => {
    const root = tmpRoot();
    const { exec } = execNoMain({});
    await expect(prepareRepo(milvusPack, root, exec)).rejects.toThrow('基线分支 main 不存在');
  });

  it('探测的默认分支也无远程引用 → 退本地分支名', async () => {
    const root = tmpRoot();
    // origin/master checkout 也失败(极端:克隆残缺),本地 master 兜底
    const { exec } = execNoMain({ symref: 'master' });
    // 覆盖:让 origin/master 失败但本地 master 成功 —— 在 execNoMain 外再包一层
    const wrapped: ExecAsync = async (cmd, args) => {
      if (args.join(' ').endsWith('origin/master')) throw new Error('invalid ref');
      return exec(cmd, args);
    };
    const r = await prepareRepo(milvusPack, root, wrapped);
    expect(r.baseBranch).toBe('master');
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
    // fork 派发身份 = gh 登录名 + noreply 邮箱(复用已实探的 ghLogin,零额外 gh 调用)
    expect(calls[3].args).toEqual(['-C', r.repoDir, 'config', 'user.name', 'tunsuy']);
    expect(calls[4].args).toEqual(['-C', r.repoDir, 'config', 'user.email', 'tunsuy@users.noreply.github.com']);
    expect(calls[5].args).toEqual(['-C', r.repoDir, 'checkout', '-B', 'contrib/fix-1', 'origin/main']);
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

describe('ensureGitIdentity(repo 级身份固化,google/ax #470「改得动、提不了」根修)', () => {
  it('有 gh 登录名 → name=login,email=<login>@users.noreply.github.com(PR 提交可归属)', async () => {
    const { calls, exec } = recExec();
    await ensureGitIdentity('/ws/o/r', exec, 'tunsuy');
    expect(calls).toEqual([
      { cmd: 'git', args: ['-C', '/ws/o/r', 'config', 'user.name', 'tunsuy'] },
      { cmd: 'git', args: ['-C', '/ws/o/r', 'config', 'user.email', 'tunsuy@users.noreply.github.com'] },
    ]);
  });

  it('无 gh 登录名(直连派发)→ agtpilot-runner 兜底身份,零 gh 调用', async () => {
    const { calls, exec } = recExec();
    await ensureGitIdentity('/ws/o/r', exec, null);
    expect(calls[0].args.at(-1)).toBe('agtpilot-runner');
    expect(calls[1].args.at(-1)).toBe('agtpilot-runner@localhost');
    expect(calls.every((c) => c.cmd !== 'gh')).toBe(true);
  });

  it('env 覆写优先于 gh 登录名(设备想换提交身份的场景)', async () => {
    process.env.AGTPILOT_GIT_NAME = 'bot';
    process.env.AGTPILOT_GIT_EMAIL = 'bot@example.com';
    try {
      const { calls, exec } = recExec();
      await ensureGitIdentity('/ws/o/r', exec, 'tunsuy');
      expect(calls[0].args.at(-1)).toBe('bot');
      expect(calls[1].args.at(-1)).toBe('bot@example.com');
    } finally {
      delete process.env.AGTPILOT_GIT_NAME;
      delete process.env.AGTPILOT_GIT_EMAIL;
    }
  });

  it('续跑现场(resumed)也先补身份再 checkout(现场保留不跳过固化)', async () => {
    const root = tmpRoot();
    const repoDir = path.join(root, 'vllm-project', 'vllm');
    fs.mkdirSync(path.join(repoDir, '.git'), { recursive: true });
    const { calls, exec } = recExec(async (_cmd, args) => {
      const a = args.join(' ');
      if (a.includes('rev-list --count')) return { stdout: '2\n', stderr: '' };
      return { stdout: '', stderr: '' };
    });
    const r = await prepareRepo(pack, root, exec);
    expect(r.mode).toBe('resumed');
    const cfgIdx = calls.findIndex((c) => c.args.includes('user.name'));
    const coIdx = calls.findIndex((c) => c.args[2] === 'checkout');
    expect(cfgIdx).toBeGreaterThan(-1);
    expect(coIdx).toBeGreaterThan(-1);
    expect(cfgIdx).toBeLessThan(coIdx);
  });
});

describe('prepareRepo · 现场保留(续跑模式:分支已有上次成果 → 不重置)', () => {
  /** 假 exec:按场景路由 show-ref/rev-list/symbolic-ref/status/checkout(fetch 恒成功) */
  function priorExec(o: {
    branchExists?: boolean; // show-ref 工作分支(缺省存在)
    ahead?: Record<string, string>; // rev-list range → 领先数(未列出的 range 一律抛)
    head?: string; // symbolic-ref --short HEAD(当前检出分支)
    status?: string; // status --porcelain(缺省干净)
    symref?: string; // origin/HEAD 远程默认分支(缺省探测失败)
  }) {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const exec: ExecAsync = async (cmd, args) => {
      calls.push({ cmd, args: [...args] });
      const a = args.join(' ');
      if (a.includes('fetch')) return { stdout: '', stderr: '' };
      if (a.includes('clone')) return { stdout: '', stderr: '' };
      if (a.includes('config user.')) return { stdout: '', stderr: '' }; // repo 级身份固化
      if (a.includes('show-ref')) {
        if (o.branchExists === false) throw new Error('missing ref');
        return { stdout: '', stderr: '' };
      }
      if (a.includes('rev-list --count')) {
        const range = a.slice(a.indexOf('rev-list --count') + 'rev-list --count'.length + 1);
        const v = o.ahead?.[range];
        if (v === undefined) throw new Error(`bad revision: ${range}`);
        return { stdout: `${v}\n`, stderr: '' };
      }
      if (a.includes('symbolic-ref --short HEAD')) return { stdout: `${o.head ?? ''}\n`, stderr: '' };
      if (a.includes('symbolic-ref --short refs/remotes/origin/HEAD')) {
        if (!o.symref) throw new Error('not a symbolic ref');
        return { stdout: `origin/${o.symref}\n`, stderr: '' };
      }
      if (a.includes('status --porcelain')) return { stdout: o.status ?? '', stderr: '' };
      if (a.includes('checkout')) return { stdout: '', stderr: '' };
      throw new Error(`unexpected: ${a}`);
    };
    return { calls, exec };
  }

  function existingRepo(root: string): string {
    const repoDir = path.join(root, 'vllm-project', 'vllm');
    fs.mkdirSync(path.join(repoDir, '.git'), { recursive: true });
    return repoDir;
  }

  it('工作分支有领先 commit(ahead>0)→ mode=resumed,普通 checkout 保现场,绝无 checkout -B 重置', async () => {
    const root = tmpRoot();
    const repoDir = existingRepo(root);
    const { calls, exec } = priorExec({ ahead: { 'origin/main..contrib/fix-1': '3' } });
    const r = await prepareRepo(pack, root, exec);
    expect(r.mode).toBe('resumed');
    expect(r.baseBranch).toBe('main');
    expect(calls.at(-1)!.args).toEqual(['-C', repoDir, 'checkout', 'contrib/fix-1']);
    expect(calls.some((c) => c.args.includes('-B'))).toBe(false);
  });

  it('分支存在但零领先 + 干净 → 无现场,走原 checkout -B 重置路径(与旧版一致)', async () => {
    const root = tmpRoot();
    existingRepo(root);
    const { calls, exec } = priorExec({ ahead: { 'origin/main..contrib/fix-1': '0' }, head: 'main', status: '' });
    const r = await prepareRepo(pack, root, exec);
    expect(r.mode).toBe('updated');
    expect(calls.at(-1)!.args).toEqual([
      '-C', expect.stringContaining('vllm'), 'checkout', '-B', 'contrib/fix-1', 'origin/main',
    ]);
  });

  it('未提交改动 + HEAD 停在工作分支 → 保留现场(刚改完没来得及 commit 就断了的场景)', async () => {
    const root = tmpRoot();
    existingRepo(root);
    const { exec } = priorExec({
      ahead: { 'origin/main..contrib/fix-1': '0' },
      head: 'contrib/fix-1',
      status: ' M sampling_params.py\n',
    });
    const r = await prepareRepo(pack, root, exec);
    expect(r.mode).toBe('resumed');
    expect(r.baseBranch).toBe('main');
  });

  it('脏文件在别的分支(HEAD ≠ 工作分支)→ 不算本任务现场,走重置路径', async () => {
    const root = tmpRoot();
    existingRepo(root);
    const { exec } = priorExec({
      ahead: { 'origin/main..contrib/fix-1': '0' },
      head: 'some-other-branch',
      status: ' M x.py\n',
    });
    expect((await prepareRepo(pack, root, exec)).mode).toBe('updated');
  });

  it('工作分支不存在 → 直接走原重置路径(探测零干扰)', async () => {
    const root = tmpRoot();
    existingRepo(root);
    const { exec } = priorExec({ branchExists: false });
    expect((await prepareRepo(pack, root, exec)).mode).toBe('updated');
  });

  it('master 默认仓库:main 两档 range 读不出 → 探远程默认分支再算领先,baseBranch 回流 master', async () => {
    const root = tmpRoot();
    existingRepo(root);
    const { exec } = priorExec({
      ahead: { 'origin/master..contrib/fix-1': '2' }, // main 的两档 range 都抛
      symref: 'master',
    });
    const r = await prepareRepo(pack, root, exec);
    expect(r.mode).toBe('resumed');
    expect(r.baseBranch).toBe('master');
  });

  it('全新克隆不可能有现场 → 零额外探测(不触发 show-ref/rev-list)', async () => {
    const root = tmpRoot();
    const { calls, exec } = priorExec({ ahead: { 'origin/main..contrib/fix-1': '9' } });
    const r = await prepareRepo(pack, root, exec);
    expect(r.mode).toBe('cloned');
    expect(calls.some((c) => c.args.includes('show-ref'))).toBe(false);
    expect(calls.some((c) => c.args.includes('rev-list'))).toBe(false);
  });
});

describe('isWorktreePristine(自动重试模式选择器:干净从头跑 / 有产出续跑)', () => {
  function pristineExec(over?: {
    status?: string;
    ahead?: string;
    statusThrow?: boolean;
    revListThrow?: boolean;
    originRangeFail?: boolean;
  }): ExecAsync {
    return async (_cmd, args) => {
      const a = args.join(' ');
      if (a.includes('status --porcelain')) {
        if (over?.statusThrow) throw new Error('git status boom');
        return { stdout: over?.status ?? '', stderr: '' };
      }
      if (a.includes('rev-list --count')) {
        if (over?.revListThrow) throw new Error('rev-list boom');
        if (over?.originRangeFail && a.includes('origin/')) throw new Error('no origin ref');
        return { stdout: `${over?.ahead ?? '0'}\n`, stderr: '' };
      }
      throw new Error(`unexpected: ${a}`);
    };
  }

  it('干净 + 零领先 → true(什么都没干就挂了,重试从头重跑)', async () => {
    expect(await isWorktreePristine('/ws/o/r', 'main', pristineExec())).toBe(true);
  });

  it('有未提交改动 → false', async () => {
    expect(await isWorktreePristine('/ws/o/r', 'main', pristineExec({ status: ' M file.py\n' }))).toBe(false);
  });

  it('有领先 commit(ahead>0)→ false(agent 已产出,重试走续跑模式接着做)', async () => {
    expect(await isWorktreePristine('/ws/o/r', 'main', pristineExec({ ahead: '3' }))).toBe(false);
  });

  it('git status 失败 → false(保守不重试)', async () => {
    expect(await isWorktreePristine('/ws/o/r', 'main', pristineExec({ statusThrow: true }))).toBe(false);
  });

  it('两个 range 都读不出领先数 → false', async () => {
    expect(await isWorktreePristine('/ws/o/r', 'main', pristineExec({ revListThrow: true }))).toBe(false);
  });

  it('origin/<base> 不存在 → 回落本地 <base>..HEAD range(master 回落场景)', async () => {
    expect(await isWorktreePristine('/ws/o/r', 'master', pristineExec({ originRangeFail: true, ahead: '0' }))).toBe(true);
  });
});

describe('prepareRepo · 远端现场收编(仅 PR 跟进任务:origin/<workBranch> 已推送产出)', () => {
  const fuPack = {
    ...pack,
    prFollowUp: { prUrl: 'https://github.com/vllm-project/vllm/pull/999', baseTaskId: 'rtask_0' },
  } as RunnerTaskPack;

  it('updated + 本地无现场 + origin/<workBranch> 存在 → 收编为 resumed(不重置到基线)', async () => {
    const root = tmpRoot();
    const repoDir = path.join(root, 'vllm-project', 'vllm');
    fs.mkdirSync(path.join(repoDir, '.git'), { recursive: true });
    const { calls, exec } = recExec(async (_cmd, args) => {
      // 本地分支不存在(findPriorWork 落空),远端分支存在(上轮已审批推送)
      if (args.includes(`refs/heads/${pack.workBranch}`)) throw new Error('fatal: invalid reference');
      if (args.includes('rev-list') && args.some((a) => a === `origin/main..${pack.workBranch}`)) {
        return { stdout: '3\n', stderr: '' };
      }
      return { stdout: '', stderr: '' };
    });
    const r = await prepareRepo(fuPack, root, exec);
    expect(r.mode).toBe('resumed');
    expect(r.baseBranch).toBe('main');
    // 收编动作:以 origin/<workBranch> 落本地跟踪分支,而非 checkout -B origin/main 重置
    expect(calls.some((c) => c.args.slice(2).includes(`origin/${pack.workBranch}`) && c.args.includes('-B'))).toBe(true);
    expect(calls.some((c) => c.args.slice(2).join(' ') === `checkout -B ${pack.workBranch} origin/main`)).toBe(false);
  });

  it('全新克隆(跨设备跟进)也能收编:clone 后 origin/<workBranch> 存在 → resumed', async () => {
    const root = tmpRoot();
    const { exec } = recExec(); // 全成功 mock:show-ref 远端分支命中
    const r = await prepareRepo(fuPack, root, exec);
    expect(r.mode).toBe('resumed');
  });

  it('跟进任务但远端也没有该分支(上轮没推送/首次跟进失败重派)→ 走原重置路径', async () => {
    const root = tmpRoot();
    const { calls, exec } = recExec(async (_cmd, args) => {
      if (args.includes(`refs/remotes/origin/${pack.workBranch}`)) throw new Error('fatal: invalid reference');
      if (args.includes(`refs/heads/${pack.workBranch}`)) throw new Error('fatal: invalid reference');
      return { stdout: '', stderr: '' };
    });
    const r = await prepareRepo(fuPack, root, exec);
    expect(r.mode).toBe('cloned');
    // 收编探测落空后仍走原重置路径:checkout -B <workBranch> origin/main
    expect(
      calls.some((c) => c.args.slice(2).join(' ') === `checkout -B ${pack.workBranch} origin/main`)
    ).toBe(true);
  });

  it('普通任务(无 prFollowUp)不触发收编:远端同名分支存在也保持旧行为(零额外 git 调用)', async () => {
    const root = tmpRoot();
    const repoDir = path.join(root, 'vllm-project', 'vllm');
    fs.mkdirSync(path.join(repoDir, '.git'), { recursive: true });
    const { calls, exec } = recExec(); // 全成功 mock(收编若触发会命中)
    const r = await prepareRepo(pack, root, exec);
    expect(r.mode).toBe('updated');
    expect(calls.some((c) => c.args.includes(`refs/remotes/origin/${pack.workBranch}`))).toBe(false);
  });
});
