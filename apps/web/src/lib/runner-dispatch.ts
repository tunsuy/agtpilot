import { normalizeTaskPack, renderHandoffPack, type RunnerTaskPack } from '@agtpilot/protocol';
import type { OssOpportunity } from '../workshops/oss_radar/opportunities';

/**
 * 机会卡 →「派发到本地」任务包构建(纯函数,vitest 直测)。
 *
 * 雷达产出(OssOpportunity)是弱结构:项目名可能不是 owner/repo、链接可能没有 Issue。
 * 构建失败一律返回 null(卡片只保留只读展示),成功也再过一遍协议层 normalizeTaskPack
 * —— 云端入库前的最后一道清洗,与 runner 侧同源。
 *
 * Phase 1 本地 agent 禁网:雷达摘要/类型/难度/适合理由/第一步全部装进 issueContext
 * 随包下发,agent 不打开 Issue 页面也有干活依据。
 */

const REPO_RE = /^[\w.-]{1,100}\/[\w.-]{1,100}$/;

/** 机会链接里挑派发目标:优先 GitHub Issue 直达,其次任意 GitHub 链接;没有 → null */
export function pickIssueUrl(links: string[]): string | null {
  const gh = links.filter((u) => /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+/.test(u));
  return gh.find((u) => /\/issues\/\d+/.test(u)) ?? gh[0] ?? null;
}

export function issueNoFromUrl(url: string): string | null {
  const m = url.match(/\/issues\/(\d+)/);
  return m ? m[1] : null;
}

/** 任务 id:协议 ID_RE([\w-]{1,128})内的时间序 id */
export function newRunnerTaskId(now: number = Date.now()): string {
  return `rtask_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/** /api/runner/tasks/mine 的任务概览行(机会卡状态徽章 + 派发弹窗用) */
export interface RunnerTaskSummary {
  taskId: string;
  state: string;
  repo: string;
  issueUrl: string;
  workBranch: string;
  prUrl?: string;
  error?: string;
  updatedAt: number;
  deviceId?: string;
}

export interface DispatchDraftOptions {
  taskId?: string;
  workBranch?: string;
  dispatchNote?: string;
  /** 经 fork 派发(弹窗检测到无推送权限时默认勾选;runner 自动 fork 后克隆副本干活) */
  viaFork?: boolean;
  now?: number;
}

/** OssOpportunity → 可入库任务包;项目名非 owner/repo 或无 GitHub 链接 → null */
export function buildTaskPackFromOpportunity(
  opp: OssOpportunity,
  opts: DispatchDraftOptions = {}
): RunnerTaskPack | null {
  const repo = (opp.project || '').trim();
  if (!REPO_RE.test(repo) || repo.split('/').some((s) => s === '.' || s === '..')) return null;
  const issueUrl = pickIssueUrl(opp.links);
  if (!issueUrl) return null;

  const issueNo = issueNoFromUrl(issueUrl);
  const taskId = opts.taskId ?? newRunnerTaskId(opts.now);
  const workBranch = (opts.workBranch || '').trim() || `contrib/oss-radar-${issueNo ?? taskId.slice(-6)}`;

  const issueContext =
    [
      opp.summary && `【雷达摘要】${opp.summary}`,
      opp.kind && `【机会类型】${opp.kind}`,
      opp.difficulty && `【难度】${opp.difficulty}`,
      opp.fit && `【为什么适合】${opp.fit}`,
      opp.firstStep && `【建议第一步】${opp.firstStep}`,
    ]
      .filter(Boolean)
      .join('\n') || undefined;

  const short = (opp.summary || '').split('\n')[0].trim().slice(0, 80);
  const prTitle = short || (issueNo ? `Issue #${issueNo} 修复` : '贡献机会修复');

  return normalizeTaskPack({
    taskId,
    kind: 'oss_contribution',
    repo,
    issueUrl,
    workBranch,
    constraints: ['只修这个 Issue,改动最小化', '不动无关文件,不顺手重构', '遵循仓库 CONTRIBUTING 的代码风格与提交规范'],
    acceptance: { note: '按 CONTRIBUTING 指引运行仓库相关测试,保证通过' },
    issueContext,
    claimDraft: `我想认领这个 Issue${issueNo ? `(#${issueNo})` : ''},预计近日内提交 PR 修复。`,
    prDraft: {
      title: `fix: ${prTitle}`,
      bodyTemplate: `关联 Issue:${issueUrl}\n\n## 改动说明\n(由本地 agent 按实际改动补全)\n\n## 测试\n(验收命令与结果)`,
    },
    executor: { name: 'claude-code', maxTurns: 60, timeoutMinutes: 30 },
    dispatchNote: (opts.dispatchNote || '').trim() || undefined,
    viaFork: opts.viaFork === true ? true : undefined,
  });
}

/** 交接包预览/复制与派发同源:同一个 pack 渲染(设计文档 §6.3 T0 降级路径) */
export function handoffPackFor(opp: OssOpportunity): string | null {
  const pack = buildTaskPackFromOpportunity(opp);
  return pack ? renderHandoffPack(pack) : null;
}
