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
  approvalId: string;
  kind: 'publish' | 'cancel';
  /** owner/repo(runner 侧据此在 workspaceRoot 内解析仓库目录,再过路径围栏) */
  repo: string;
  workBranch: string;
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
      if (badBranch(base) || badBranch(head)) return null;
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
}

/**
 * 构建固化命令集(批准时调用一次,结果随审批单落盘):
 * git push → gh pr create →(可选)gh issue comment。
 * 自洽校验:任何一条过不了 validatePublishCommand → 整体 null(拒绝批准),
 * 保证「固化的必是可执行合法的」。
 */
export function buildPublishCommands(input: PublishCommandInput): FrozenCommand[] | null {
  const cmds: FrozenCommand[] = [
    { cmd: 'git', args: ['push', '-u', 'origin', input.workBranch] },
    {
      cmd: 'gh',
      args: [
        'pr', 'create',
        '--title', input.prTitle,
        '--body', input.prBody,
        '--base', input.baseBranch || 'main',
        '--head', input.workBranch,
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

/** 设备动作清洗:形状畸形 → null(忽略该条);命令内容留待执行前逐条白名单校验 */
export function normalizeDeviceAction(input: unknown): RunnerDeviceAction | null {
  if (!input || typeof input !== 'object') return null;
  const o = input as Record<string, unknown>;
  const taskId = typeof o.taskId === 'string' && o.taskId.length <= 128 ? o.taskId : null;
  const approvalId = typeof o.approvalId === 'string' && o.approvalId.length <= 128 ? o.approvalId : null;
  if (!taskId || !approvalId) return null;
  if (o.kind !== 'publish' && o.kind !== 'cancel') return null;
  const repo = typeof o.repo === 'string' && o.repo.length <= 201 ? o.repo : null;
  const workBranch = typeof o.workBranch === 'string' && o.workBranch.length <= 200 ? o.workBranch : null;
  if (!repo || !workBranch) return null;
  if (o.kind === 'cancel') {
    return { taskId, approvalId, kind: 'cancel', repo, workBranch };
  }
  if (!Array.isArray(o.commands) || o.commands.length === 0 || o.commands.length > 3) return null;
  const commands = o.commands.filter(
    (c): c is FrozenCommand => Boolean(c) && typeof c === 'object' && typeof (c as any).cmd === 'string' && Array.isArray((c as any).args)
  );
  if (commands.length !== o.commands.length) return null;
  return { taskId, approvalId, kind: 'publish', repo, workBranch, commands };
}
