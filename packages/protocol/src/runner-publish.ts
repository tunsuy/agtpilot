/**
 * Phase 2 发布命令集(docs/design/local-runner-bridge.md §6.2,M3)
 *
 * 固化命令集是防漂移围栏:**审批批的就是执行的**。云端在批准时刻把
 * git push / gh pr create / gh issue comment 逐条固化为 {cmd,args[]} 数组,
 * 随审批结果下行;runner 执行前逐条再过 validatePublishCommand 白名单,
 * 白名单外(或畸形/注入)一律拒绝执行并上报。
 *
 * 纯函数、零依赖(web 与 runner 同源共用;execFile 数组传参无 shell,
 * 白名单校验的是命令**形状**,双保险)。
 */

/** 固化命令:argv 数组形态(永不拼 shell 字符串) */
export interface FrozenCommand {
  cmd: string;
  args: string[];
}

/** 审批结果下行动作(设备轮询领取;publish 携带固化命令集) */
export interface RunnerDeviceAction {
  taskId: string;
  /**
   * 审批关联 id(审计留痕用,非功能键)。审批链路的动作必有;
   * 用户「终止任务」下发的 cancel 无审批单,缺省 —— 旧 runner 的
   * normalizeDeviceAction 会拒收该形状,忽略即可(无本地副作用)。
   */
  approvalId?: string;
  kind: 'publish' | 'cancel';
  /** owner/repo(runner 侧据此在 workspaceRoot 内解析仓库目录,再过路径围栏) */
  repo: string;
  workBranch: string;
  /**
   * 经 fork 派发的任务(viaFork):本地克隆目录对应的是 fork 全名(ghLogin/repo),
   * 不是上游 repo —— Phase 2 发布命令须在 fork 克隆目录内执行(origin 指向 fork)。
   * 缺省(直连派发/旧云端)时按 repo 解析。
   */
  forkRepo?: string;
  /** kind='publish' 必有:审批时刻固化的命令集 */
  commands?: FrozenCommand[];
}

/** 审批单(随任务记录持久化;审批卡展示快照 + 批准时固化命令) */
export interface RunnerApproval {
  approvalId: string;
  status: 'pending' | 'approved' | 'rejected';
  createdAt: number;
  decidedAt?: number;
  /** 决策项 6:批准时勾选「代发认领留言」→ gh issue comment 进固化命令集 */
  includeClaim?: boolean;
  /** 批准时刻固化(仅 status='approved' 存在) */
  commands?: FrozenCommand[];
  /** 审批卡展示快照(PR 终稿优先,缺省回落派发时的草稿) */
  prTitle: string;
  prBody: string;
  commitHash?: string;
  diffstat?: string;
  testTail?: string;
}

// ---------- 白名单校验(runner 执行前的最后一道闸) ----------

const BRANCH_ARG_RE = /^[\w./-]{1,200}$/;
const ISSUE_URL_RE = /^https:\/\/github\.com\/[\w.-]{1,100}\/[\w.-]{1,100}\/issues\/\d{1,10}$/;
/**
 * 控制字符防线:放行 \t \n \r(PR 正文/认领留言天然多行;execFile 数组传参
 * 无 shell,换行无注入面),其余控制字符(NUL/ESC 等,可伪造终端输出)一律拒绝。
 * 分支/URL 位由上方两个正则兜底(形状本身不含任何空白与控制字符)。
 */
const CONTROL_CHARS_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

/** 分支参数防线:形状合法、不以 '-' 开头(防被解析成 flag)、不含 '..' */
function badBranch(s: string): boolean {
  return !BRANCH_ARG_RE.test(s) || s.startsWith('-') || s.includes('..');
}

const GH_OWNER_RE = /^[\w.-]{1,100}$/;

/**
 * --head 参数防线:分支名,或 fork 跨仓形式的 `owner:branch`(gh pr create 官方
 * 支持,经 fork 派发时 head 指向 fork 账号下的分支)。恰好一个冒号,owner 段
 * 形状合法且不以 '-' 开头,branch 段过分支防线;其余(多冒号/空段)一律拒绝。
 */
function badHead(s: string): boolean {
  const i = s.indexOf(':');
  if (i === -1) return badBranch(s);
  if (s.lastIndexOf(':') !== i) return true; // 多于一个冒号
  const owner = s.slice(0, i);
  const branch = s.slice(i + 1);
  return !GH_OWNER_RE.test(owner) || owner.startsWith('-') || owner.includes('..') || badBranch(branch);
}

/**
 * 白名单只认三种**完整形状**(多余参数、缺参数、换序、非字符串一律拒绝):
 * 1. git push -u origin <workBranch>
 * 2. gh pr create --title <t> --body <b> --base <base> --head <head>(定序 10 元)
 * 3. gh issue comment <issueUrl> --body <text>(issueUrl 必须是 GitHub Issue 直达)
 */
export function validatePublishCommand(input: unknown): FrozenCommand | null {
  if (!input || typeof input !== 'object') return null;
  const o = input as Record<string, unknown>;
  if (typeof o.cmd !== 'string' || !Array.isArray(o.args)) return null;
  if (!o.args.every((x) => typeof x === 'string')) return null;
  const a = o.args as string[];
  // NUL/ESC 等控制字符可伪造多行日志/终端注入,一律拒绝(\t\n\r 除外,见上)
  if (CONTROL_CHARS_RE.test(o.cmd) || a.some((s) => CONTROL_CHARS_RE.test(s))) return null;

  if (o.cmd === 'git') {
    if (a.length === 4 && a[0] === 'push' && a[1] === '-u' && a[2] === 'origin' && !badBranch(a[3])) {
      return { cmd: 'git', args: [...a] };
    }
    return null;
  }

  if (o.cmd === 'gh') {
    if (a[0] === 'pr' && a[1] === 'create') {
      if (a.length !== 10) return null;
      if (a[2] !== '--title' || a[4] !== '--body' || a[6] !== '--base' || a[8] !== '--head') return null;
      const title = a[3];
      const body = a[5];
      const base = a[7];
      const head = a[9];
      if (!title || title.length > 300) return null;
      if (body.length > 20000) return null;
      if (badBranch(base) || badHead(head)) return null;
      return { cmd: 'gh', args: [...a] };
    }
    if (a[0] === 'issue' && a[1] === 'comment') {
      if (a.length !== 5 || a[3] !== '--body') return null;
      if (!ISSUE_URL_RE.test(a[2])) return null;
      if (!a[4] || a[4].length > 5000) return null;
      return { cmd: 'gh', args: [...a] };
    }
    return null;
  }

  return null;
}

// ---------- 云端批准时刻的固化 ----------

export interface PublishCommandInput {
  workBranch: string;
  baseBranch?: string;
  prTitle: string;
  prBody: string;
  issueUrl?: string;
  claimDraft?: string;
  /** 决策项 6:勾选后认领留言进命令集(需 issueUrl + claimDraft 同时存在) */
  includeClaim?: boolean;
  /**
   * 经 fork 派发时的 gh 登录名:PR head 固化为 `forkHead:workBranch`(跨仓形式,
   * 指向 fork 账号下的分支;base 仍是上游 baseBranch)。缺省 = 直连派发,head 为裸分支名。
   * 畸形 forkHead 会使固化命令过不了 validatePublishCommand → 整体 null(拒绝批准)。
   */
  forkHead?: string;
}

/**
 * 构建固化命令集(批准时调用一次,结果随审批单落盘):
 * git push → gh pr create →(可选)gh issue comment。
 * 自洽校验:任何一条过不了 validatePublishCommand → 整体 null(拒绝批准),
 * 保证「固化的必是可执行合法的」。
 */
export function buildPublishCommands(input: PublishCommandInput): FrozenCommand[] | null {
  // 经 fork 派发:push 的 origin 就是 fork 克隆(形状不变);PR head 用跨仓形式指向上游
  const head = input.forkHead ? `${input.forkHead}:${input.workBranch}` : input.workBranch;
  const cmds: FrozenCommand[] = [
    { cmd: 'git', args: ['push', '-u', 'origin', input.workBranch] },
    {
      cmd: 'gh',
      args: [
        'pr', 'create',
        '--title', input.prTitle,
        '--body', input.prBody,
        '--base', input.baseBranch || 'main',
        '--head', head,
      ],
    },
  ];
  if (input.includeClaim && input.issueUrl && input.claimDraft) {
    cmds.push({ cmd: 'gh', args: ['issue', 'comment', input.issueUrl, '--body', input.claimDraft] });
  }
  return cmds.every((c) => validatePublishCommand(c) !== null) ? cmds : null;
}

// ---------- PR 链接回流 ----------

const PR_URL_RE = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/;

/** 从 gh pr create 输出提取 PR 链接(输出可能混有警告行,取第一条命中) */
export function extractPrUrl(text: string): string | null {
  const m = PR_URL_RE.exec(text || '');
  return m ? m[0].slice(0, 500) : null;
}

// ---------- 下行动作清洗(runner 侧防御性校验) ----------

const FORK_REPO_RE = /^[\w.-]{1,100}\/[\w.-]{1,100}$/;

/** 设备动作清洗:形状畸形 → null(忽略该条);命令内容留待执行前逐条白名单校验 */
export function normalizeDeviceAction(input: unknown): RunnerDeviceAction | null {
  if (!input || typeof input !== 'object') return null;
  const o = input as Record<string, unknown>;
  const taskId = typeof o.taskId === 'string' && o.taskId.length <= 128 ? o.taskId : null;
  if (!taskId) return null;
  // approvalId 可选:审批链路动作必有;用户终止任务的 cancel 无审批单
  const approvalId = typeof o.approvalId === 'string' && o.approvalId.length <= 128 ? o.approvalId : undefined;
  if (o.kind !== 'publish' && o.kind !== 'cancel') return null;
  const repo = typeof o.repo === 'string' && o.repo.length <= 201 ? o.repo : null;
  const workBranch = typeof o.workBranch === 'string' && o.workBranch.length <= 200 ? o.workBranch : null;
  if (!repo || !workBranch) return null;
  // forkRepo(可选,经 fork 派发):必须是合法 owner/repo 形状且无 '.'/'..' 段
  // —— runner 侧还要过 repoDirFor 路径围栏,这里是第一道清洗
  let forkRepo: string | undefined;
  if (o.forkRepo !== undefined) {
    if (typeof o.forkRepo !== 'string' || !FORK_REPO_RE.test(o.forkRepo)) return null;
    if (o.forkRepo.split('/').some((seg) => seg === '.' || seg === '..')) return null;
    forkRepo = o.forkRepo;
  }
  if (o.kind === 'cancel') {
    // cancel 允许无审批单(用户终止任务);publish 必带 approvalId(审批链路关联)
    return { taskId, ...(approvalId ? { approvalId } : {}), kind: 'cancel', repo, workBranch };
  }
  if (!approvalId) return null;
  if (!Array.isArray(o.commands) || o.commands.length === 0 || o.commands.length > 3) return null;
  const commands = o.commands.filter(
    (c): c is FrozenCommand => Boolean(c) && typeof c === 'object' && typeof (c as any).cmd === 'string' && Array.isArray((c as any).args)
  );
  if (commands.length !== o.commands.length) return null;
  return { taskId, ...(approvalId ? { approvalId } : {}), kind: 'publish', repo, workBranch, ...(forkRepo ? { forkRepo } : {}), commands };
}
