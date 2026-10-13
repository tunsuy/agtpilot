import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { RunnerTaskPack } from '@agtpilot/protocol';

/**
 * 仓库准备(§6.1 步骤 1,runner 直接执行,不消耗 agent 轮次):
 * clone 到 <workspaceRoot>/<owner>/<repo>,已存在则 fetch + 从 baseBranch 切工作分支。
 *
 * 围栏:目标目录 resolve 后必须仍在 workspaceRoot 内(协议层已拒 '.'/'..' 段,
 * 这里做第二道解析后前缀校验,与 plugin-sandbox resolveSafePath 同语义)。
 * git 一律 execFile 数组参数(零 shell),远程 URL 只从 pack.repo 拼 https github 地址。
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
}

export async function prepareRepo(
  pack: RunnerTaskPack,
  root: string,
  exec: ExecAsync = defaultExecAsync
): Promise<PreparedRepo> {
  const repoDir = repoDirFor(root, pack.repo);
  const base = pack.baseBranch ?? 'main';
  const remoteUrl = `https://github.com/${pack.repo}.git`;

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
  return { repoDir, mode };
}
