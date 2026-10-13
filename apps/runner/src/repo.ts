import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { RunnerTaskPack } from '@agtpilot/protocol';
import { queryGhLogin } from './gh';

/**
 * 仓库准备(§6.1 步骤 1,runner 直接执行,不消耗 agent 轮次):
 * clone 到 <workspaceRoot>/<owner>/<repo>,已存在则 fetch + 从 baseBranch 切工作分支。
 *
 * 经 fork 派发(pack.viaFork,派发弹窗显式勾选):先 `gh repo fork`(幂等,已存在
 * 等同成功)确保本机 gh 账号名下有上游 fork,再克隆 **fork 副本**到
 * <workspaceRoot>/<ghLogin>/<repo> —— origin 指向 fork,Phase 2 固化命令
 * `git push -u origin <branch>` 推的就是 fork,PR 以 owner:branch 跨仓形式指向上游。
 * fork 是对外可见动作,只发生在用户派发时显式勾选之后(审批红线不变:推代码仍走 Phase 2)。
 *
 * 围栏:目标目录 resolve 后必须仍在 workspaceRoot 内(协议层已拒 '.'/'..' 段,
 * 这里做第二道解析后前缀校验,与 plugin-sandbox resolveSafePath 同语义)。
 * git 一律 execFile 数组参数(零 shell),远程 URL 只从 pack.repo(或 gh 登录名
 * + 仓库名)拼 https github 地址。
 */

export type ExecAsync = (
  cmd: string,
  args: string[],
  opts?: { cwd?: string; timeout?: number; maxBuffer?: number; env?: NodeJS.ProcessEnv }
) => Promise<{ stdout: string; stderr: string }>;

const execFileAsync = promisify(execFile) as unknown as ExecAsync;

export const defaultExecAsync: ExecAsync = (cmd, args, opts) =>
  execFileAsync(cmd, args, { timeout: 10 * 60 * 1000, maxBuffer: 16 * 1024 * 1024, ...opts });

export class WorkspaceFenceError extends Error {}

/** owner/repo → workspaceRoot 内的绝对路径;越界一律抛 WorkspaceFenceError */
export function repoDirFor(root: string, repo: string): string {
  const resolvedRoot = path.resolve(root);
  const target = path.resolve(resolvedRoot, ...repo.split('/'));
  if (target !== resolvedRoot && !target.startsWith(resolvedRoot + path.sep)) {
    throw new WorkspaceFenceError(`仓库路径逃逸 workspaceRoot:${repo}`);
  }
  if (repo.split('/').some((seg) => seg === '.' || seg === '..' || seg === '')) {
    throw new WorkspaceFenceError(`仓库名含非法路径段:${repo}`);
  }
  return target;
}

export interface PreparedRepo {
  repoDir: string;
  mode: 'cloned' | 'updated';
  /** 经 fork 派发时 = 实际克隆的 fork 全名(ghLogin/repo);直连派发缺省 */
  forkRepo?: string;
}

/**
 * 幂等确保 gh 账号名下存在上游仓的 fork:
 * `gh repo fork <upstream> --clone=false`;已存在(gh 报 already exists)等同成功。
 * 只在 pack.viaFork(用户派发时显式勾选)下被调用 —— fork 是对外可见动作,
 * 但内容 = 上游公开仓的副本,零本地数据;代码 push 仍必须过 Phase 2 审批门。
 */
export async function ensureFork(upstreamRepo: string, exec: ExecAsync): Promise<void> {
  try {
    await exec('gh', ['repo', 'fork', upstreamRepo, '--clone=false'], { timeout: 60 * 1000 });
  } catch (e: any) {
    const msg = String(e?.stderr || e?.message || e);
    if (!/already exists/i.test(msg)) {
      throw new Error(`gh repo fork 失败(gh 需已登录且有 fork 权限):${msg.slice(-300)}`);
    }
  }
}

export async function prepareRepo(
  pack: RunnerTaskPack,
  root: string,
  exec: ExecAsync = defaultExecAsync
): Promise<PreparedRepo> {
  // 经 fork 派发:实际克隆目标 = ghLogin/repo(每次实探账号,不用进程缓存)
  let cloneRepo = pack.repo;
  let forkRepo: string | undefined;
  if (pack.viaFork) {
    const ghLogin = await queryGhLogin(exec);
    if (!ghLogin) {
      throw new Error('任务要求经 fork 派发,但本机 gh 未登录(或输出异常):先执行 gh auth login,或重新以直连方式派发');
    }
    forkRepo = `${ghLogin}/${pack.repo.split('/')[1]}`;
    await ensureFork(pack.repo, exec);
    cloneRepo = forkRepo;
  }

  const repoDir = repoDirFor(root, cloneRepo);
  const base = pack.baseBranch ?? 'main';
  const remoteUrl = `https://github.com/${cloneRepo}.git`;

  let mode: PreparedRepo['mode'];
  if (fs.existsSync(path.join(repoDir, '.git'))) {
    await exec('git', ['-C', repoDir, 'fetch', '--prune', 'origin']);
    mode = 'updated';
  } else {
    fs.mkdirSync(path.dirname(repoDir), { recursive: true });
    await exec('git', ['clone', '--', remoteUrl, repoDir]);
    mode = 'cloned';
  }

  // 从基线切工作分支:优先 origin/<base>(fetch 后最新),无远程基线时退本地 <base>
  try {
    await exec('git', ['-C', repoDir, 'checkout', '-B', pack.workBranch, `origin/${base}`]);
  } catch {
    await exec('git', ['-C', repoDir, 'checkout', '-B', pack.workBranch, base]);
  }
  return { repoDir, mode, ...(forkRepo ? { forkRepo } : {}) };
}
