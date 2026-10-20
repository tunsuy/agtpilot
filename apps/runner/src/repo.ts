import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { RunnerTaskPack } from '@agtpilot/protocol';
import { queryGhLogin } from './gh';

/**
 * 仓库准备(§6.1 步骤 1,runner 直接执行,不消耗 agent 轮次):
 * clone 到 <workspaceRoot>/<owner>/<repo>,已存在则 fetch + 从 baseBranch 切工作分支;
 * 工作分支上若还有上次尝试的成果(领先 commit / 未提交改动)则**保留现场**
 * (mode='resumed',不重置分支),由 agent 看 git 记录接着做 —— git 记录 =
 * 中断后续作的恢复点(负责人方案,替代「重派 = 从头再来」)。
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
  /**
   * cloned = 新克隆;updated = 增量更新(fetch 后从基线重切工作分支);
   * resumed = **保留现场续跑** —— 工作分支上已有上次尝试的成果(领先 commit 或
   * 未提交改动),不重置分支,由 agent 看 git 记录接着做(任务提示注入续跑模式)。
   */
  mode: 'cloned' | 'updated' | 'resumed';
  /** 经 fork 派发时 = 实际克隆的 fork 全名(ghLogin/repo);直连派发缺省 */
  forkRepo?: string;
  /**
   * 实探生效的基线分支名:pack.baseBranch 缺省 'main',但不少仓库默认分支
   * 是 master(milvus/dapper 等)—— 解析失败时回落远程默认分支。回流云端
   * (phase1_result)固化 PR --base,后续 Phase 2 与本值同一事实源。
   */
  baseBranch: string;
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

/**
 * 远程默认分支名(不含 origin/ 前缀),两档探测:
 * 1. symbolic-ref origin/HEAD —— clone 时设置,增量 fetch 不变,零网络;
 * 2. ls-remote --symref origin HEAD —— 网络实探(旧目录可能没有 origin/HEAD)。
 * 全失败返回 null(调用方决定报错口径)。
 */
async function remoteDefaultBranch(repoDir: string, exec: ExecAsync): Promise<string | null> {
  try {
    const r = await exec('git', ['-C', repoDir, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
    const name = r.stdout.trim().replace(/^origin\//, '');
    if (name) return name;
  } catch {
    // 下一档
  }
  try {
    const r = await exec('git', ['-C', repoDir, 'ls-remote', '--symref', 'origin', 'HEAD']);
    const m = r.stdout.match(/ref:\s*refs\/heads\/([^\s\t]+)/);
    if (m?.[1]) return m[1];
  } catch {
    // 放弃,由调用方报错
  }
  return null;
}

/**
 * 现场检查(加固 ①「runner 自动重试」的模式选择器,§6.1):
 * 无未提交改动(git status --porcelain 空)**且** 相对基线零领先 commit。
 *
 * 引入续跑模式(git 记录 = 恢复点)后,这不再是「重试闸」—— 瞬时 API 错误
 * 一律自动重试一次,本值只决定重试姿势:true(什么都没干就挂了)→ 从头重跑;
 * false(已有 WIP commit / 未提交改动)→ 带【续跑模式】指令重跑,agent 先
 * git log/status/diff 看清现场,接着上次断点继续,已完成的不重做。
 *
 * 保守口径:任一 git 命令失败 / 两个 range 都读不出领先数 → 返回 false
 * (宁可让 agent 自己审视现场,也不盲当干净从头跑)。
 * base 用 prepareRepo 实探回流的基线(master 默认仓库的回落值),与 executor 同口径。
 */
export async function isWorktreePristine(
  repoDir: string,
  base: string,
  exec: ExecAsync = defaultExecAsync
): Promise<boolean> {
  try {
    const st = await exec('git', ['-C', repoDir, 'status', '--porcelain']);
    if (st.stdout.trim() !== '') return false; // 有未提交改动
  } catch {
    return false; // 读不出状态 → 保守视为不干净
  }
  for (const range of [`origin/${base}..HEAD`, `${base}..HEAD`]) {
    try {
      const n = Number((await exec('git', ['-C', repoDir, 'rev-list', '--count', range])).stdout.trim());
      if (Number.isFinite(n)) return n === 0; // 能读出领先数即以它为准
    } catch {
      /* 换下一个 range */
    }
  }
  return false; // 两个 range 都读不出 → 保守不重试
}

/**
 * 现场探测(续跑模式的前置,负责人方案:agent 边做边小步 commit,git 记录 =
 * 中断后续作的恢复点):工作分支是否已有上次尝试的成果。
 *
 * 只认**正面证据**,两路:
 * ① 相对基线有领先 commit(WIP 或整理后的都算)——range 口径与 executor 校验、
 *    isWorktreePristine 一致:先 origin/<base>..<branch>,再 <base>..<branch>,
 *    双双读不出时探远程默认分支再试一轮(master 默认仓库口径);
 * ② HEAD 仍停在工作分支且有未提交改动(刚改完还没来得及 commit 就断了)。
 *
 * 分支不存在 / 无正面证据 / 任一关键 git 命令失败 → null(回落 checkout -B
 * 重置原路径,与旧版行为一致 —— 宁可重头也不误保来路不明的现场)。
 * 返回值 = 生效基线分支名(供 PreparedRepo.baseBranch 回流)。
 */
async function findPriorWork(
  repoDir: string,
  workBranch: string,
  base: string,
  exec: ExecAsync
): Promise<string | null> {
  try {
    await exec('git', ['-C', repoDir, 'show-ref', '--verify', '--quiet', `refs/heads/${workBranch}`]);
  } catch {
    return null; // 工作分支不存在 → 无现场
  }

  // ① 领先 commit(先按任务包基线,读不出再按远程默认分支)
  const aheadOf = async (b: string): Promise<'positive' | 'zero' | 'unknown'> => {
    for (const range of [`origin/${b}..${workBranch}`, `${b}..${workBranch}`]) {
      try {
        const n = Number((await exec('git', ['-C', repoDir, 'rev-list', '--count', range])).stdout.trim());
        if (Number.isFinite(n)) return n > 0 ? 'positive' : 'zero';
      } catch {
        /* 换下一个 range */
      }
    }
    return 'unknown';
  };
  let effectiveBase = base;
  let ahead = await aheadOf(base);
  if (ahead === 'unknown') {
    const remoteDefault = await remoteDefaultBranch(repoDir, exec);
    if (remoteDefault && remoteDefault !== base) {
      effectiveBase = remoteDefault;
      ahead = await aheadOf(remoteDefault);
    }
  }
  if (ahead === 'positive') return effectiveBase;

  // ② 未提交改动(仅当 HEAD 就停在工作分支,别的分支上的脏文件不算本任务现场)
  try {
    const head = (await exec('git', ['-C', repoDir, 'symbolic-ref', '--short', 'HEAD'])).stdout.trim();
    if (head !== workBranch) return null;
    const st = await exec('git', ['-C', repoDir, 'status', '--porcelain']);
    if (st.stdout.trim() === '') return null; // 干净且零领先 → 无现场,走原重置路径
    return effectiveBase;
  } catch {
    return null; // 状态读不出 → 保守回落原路径
  }
}

/**
 * 远端现场收编(PR 跟进任务专用,2026-10-20):本地工作分支没有现场,但
 * origin/<workBranch> 存在(上轮产出已审批推送;跟进任务可能派到另一台设备,
 * 或原设备工作区被清/分支被删)→ 以 origin/<workBranch> 落本地跟踪分支,按
 * resumed 续跑 —— 不走 checkout -B origin/<base> 重置(那会把已关联 PR 的
 * commit 全丢掉,跟进任务等于从基线重做,还会让后续 push 与远端分叉必败)。
 * 只对 pack.prFollowUp 任务启用:普通派发路径零行为变化(零额外 git 调用)。
 * 返回生效基线分支名(与 findPriorWork 同口径:任务包基线读不出时探远程默认分支)。
 */
async function adoptRemoteWork(
  repoDir: string,
  workBranch: string,
  base: string,
  exec: ExecAsync
): Promise<string | null> {
  try {
    await exec('git', ['-C', repoDir, 'show-ref', '--verify', '--quiet', `refs/remotes/origin/${workBranch}`]);
  } catch {
    return null; // 远端没有该分支 → 无现场可收编(全新派发的常态)
  }
  try {
    await exec('git', ['-C', repoDir, 'checkout', '-B', workBranch, `origin/${workBranch}`]);
  } catch {
    return null; // checkout 失败 → 保守回落原重置路径
  }
  // 基线判定与 findPriorWork 同口径(ahead range / 审批 PR --base 回流用)
  const aheadOf = async (b: string): Promise<boolean | null> => {
    for (const range of [`origin/${b}..${workBranch}`, `${b}..${workBranch}`]) {
      try {
        const n = Number((await exec('git', ['-C', repoDir, 'rev-list', '--count', range])).stdout.trim());
        if (Number.isFinite(n)) return n > 0;
      } catch {
        /* 换下一个 range */
      }
    }
    return null;
  };
  let effectiveBase = base;
  const ahead = await aheadOf(base);
  if (ahead === null || ahead === false) {
    // 读不出或零领先(如 PR 已被 squash 合并):再探远程默认分支,尽力给出真实基线
    const remoteDefault = await remoteDefaultBranch(repoDir, exec);
    if (remoteDefault && remoteDefault !== base) effectiveBase = remoteDefault;
  }
  return effectiveBase;
}

/**
 * repo-local git 身份(user.name/user.email),prepareRepo 在克隆/更新后调用。
 * 只写工作副本的 .git/config,绝不碰设备 global 配置;ghLogin 传 null 时
 * (直连派发保持「零 gh 调用」契约,不额外实探)回落固定兜底身份。
 * AGTPILOT_GIT_NAME / AGTPILOT_GIT_EMAIL 可显式覆写(设备上想用别的
 * 提交身份时设置,如公司账号)。
 */
export async function ensureGitIdentity(
  repoDir: string,
  exec: ExecAsync = defaultExecAsync,
  ghLogin: string | null = null
): Promise<void> {
  const name = process.env.AGTPILOT_GIT_NAME?.trim() || ghLogin || 'agtpilot-runner';
  const email =
    process.env.AGTPILOT_GIT_EMAIL?.trim() ||
    (ghLogin ? `${ghLogin}@users.noreply.github.com` : 'agtpilot-runner@localhost');
  await exec('git', ['-C', repoDir, 'config', 'user.name', name]);
  await exec('git', ['-C', repoDir, 'config', 'user.email', email]);
}

export async function prepareRepo(
  pack: RunnerTaskPack,
  root: string,
  exec: ExecAsync = defaultExecAsync
): Promise<PreparedRepo> {
  // 经 fork 派发:实际克隆目标 = ghLogin/repo(每次实探账号,不用进程缓存)
  let cloneRepo = pack.repo;
  let forkRepo: string | undefined;
  let ghLogin: string | null = null;
  if (pack.viaFork) {
    ghLogin = await queryGhLogin(exec);
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

  // repo 级 git 身份固化(生产实测 google/ax #470「改得动、提不了」的根因):
  // 克隆出来的工作副本没有 user.name/user.email,headless agent 的裸
  // `git commit` 必失败;而补身份的各种变体(git config / git -c / GIT_*
  // env 前缀)又都不匹配固化白名单的形状,default 权限模式下被自动拒绝
  // (`--author=` 能过权限但只设 author,committer 身份仍缺)。那次任务
  // agent 改完 4 个文件、试了 8 种 commit 姿势全灭,最终被判「无本地
  // commit(没有产出)」。这里在准备阶段统一写 repo-local config(不碰
  // global),agent 裸 commit 即可成功;身份优先级 env 覆写 > gh 登录名
  // (fork 派发已实探,零额外调用)> agtpilot-runner 兜底。
  await ensureGitIdentity(repoDir, exec, ghLogin);

  // 现场保留(续跑模式):增量更新时工作分支已有上次成果(领先 commit 或未提交
  // 改动)→ 不再 checkout -B 重置(那会把上次产出扔掉),保留现场直接续作,
  // 由任务提示注入的【续跑模式】指令让 agent 先看 git 记录再接着做。
  // 全新克隆不可能有现场,跳过探测(零额外 git 调用)。
  if (mode === 'updated') {
    const priorBase = await findPriorWork(repoDir, pack.workBranch, base, exec);
    if (priorBase) {
      await exec('git', ['-C', repoDir, 'checkout', pack.workBranch]);
      return { repoDir, mode: 'resumed', baseBranch: priorBase, ...(forkRepo ? { forkRepo } : {}) };
    }
  }

  // 远端现场收编(仅 PR 跟进任务):本地无现场(updated 探测落空)或全新克隆,
  // 但 origin/<workBranch> 存在(跨设备派发/工作区被清)→ 收编已推送产出按
  // resumed 续跑。普通派发不进此分支(行为与旧版逐调用一致);跟进任务远端
  // 无该分支时 show-ref 落空即返回 null,走原重置路径。
  if (pack.prFollowUp) {
    const adoptedBase = await adoptRemoteWork(repoDir, pack.workBranch, base, exec);
    if (adoptedBase) {
      return { repoDir, mode: 'resumed', baseBranch: adoptedBase, ...(forkRepo ? { forkRepo } : {}) };
    }
  }

  // 从基线切工作分支:origin/<base> → 本地 <base> → 远程默认分支。
  // 第三档是生产实测修复:不少仓库默认分支是 master(milvus-io/milvus
  // #52049 派发即在前两档翻车 —— fatal: 'main' is not a commit and a
  // branch cannot be created from it)。回落的分支名经 baseBranch 回流
  // 云端,PR --base 与 rev-list 基线都以它为准。
  const checkout = (ref: string) => exec('git', ['-C', repoDir, 'checkout', '-B', pack.workBranch, ref]);
  let baseBranch = base;
  try {
    await checkout(`origin/${base}`);
  } catch {
    try {
      await checkout(base);
    } catch {
      const remoteDefault = await remoteDefaultBranch(repoDir, exec);
      if (!remoteDefault) {
        throw new Error(
          `基线分支 ${base} 不存在(origin/${base} 与本地 ${base} 均失败),远程默认分支也探测失败(git symbolic-ref / ls-remote)。若仓库确用其他基线,派发时请在任务包指定 baseBranch`
        );
      }
      baseBranch = remoteDefault;
      try {
        await checkout(`origin/${remoteDefault}`);
      } catch {
        await checkout(remoteDefault);
      }
    }
  }
  return { repoDir, mode, baseBranch, ...(forkRepo ? { forkRepo } : {}) };
}
