import {
  normalizeTaskPack,
  renderHandoffPack,
  type RunnerEvent,
  type RunnerTaskPack,
  type RunnerTaskRecord,
} from '@agtpilot/protocol';
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
  /** 失败为瞬时 API/网关错误(云端从 runner error 事件回流):UI 标「可重试」,重派大概率恢复 */
  retryable?: boolean;
  updatedAt: number;
  /** runner 领取后绑定的设备 */
  deviceId?: string;
  /** 派发时指定的目标设备(排队中还未被领取时的归属依据) */
  targetDeviceId?: string;
  /** 最近一条可读进展(runner 上行事件摘要;任务列表单行展示用) */
  latest?: { text: string; at: number };
  /** 用户已请求终止(runner 确认前 UI 显示「终止中…」) */
  cancelRequested?: boolean;
  /** 派发时所处的驾驶舱会话 id(互跳关联键;工坊外派发缺省) */
  missionId?: string;
}

/**
 * 任务状态徽章(M2 事件回流):状态机 9 态 → 用户话术。
 * 机会卡徽章与设备页任务列表共用(单一话术来源)。
 */
export const TASK_STATE_META: Record<string, { label: string; cls: string }> = {
  queued: { label: '已派发 · 排队中', cls: 'bg-zinc-50 text-zinc-600 border-zinc-200' },
  dispatched: { label: '已被 runner 领取', cls: 'bg-sky-50 text-sky-700 border-sky-100' },
  running: { label: '本地执行中', cls: 'bg-sky-50 text-sky-700 border-sky-100' },
  awaiting_approval: { label: '待云端审批', cls: 'bg-amber-50 text-amber-700 border-amber-200' },
  finishing: { label: '发布执行中', cls: 'bg-amber-50 text-amber-700 border-amber-200' },
  done: { label: '完成', cls: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
  failed: { label: '失败', cls: 'bg-rose-50 text-rose-700 border-rose-200' },
  cancelled: { label: '已取消', cls: 'bg-zinc-50 text-zinc-500 border-zinc-200' },
  expired: { label: '已过期', cls: 'bg-zinc-50 text-zinc-500 border-zinc-200' },
};

/** 未知态兜底(zinc 中性) */
export function runnerStateMeta(state: string): { label: string; cls: string } {
  return TASK_STATE_META[state] ?? { label: state, cls: 'bg-zinc-50 text-zinc-600 border-zinc-200' };
}

/**
 * 失败任务的「可重试」标记(加固 ②,UI 三处展示共用单一话术):
 * 瞬时 API/网关错误导致的 failed,重新派发大概率恢复。非可重试失败 → null。
 */
export const RUNNER_RETRYABLE_LABEL = '可重试';
export const RUNNER_RETRYABLE_HINT = '瞬时 API/网关错误 · 重新派发大概率恢复';
export function runnerRetryable(task: { state: string; retryable?: boolean }): boolean {
  return task.state === 'failed' && task.retryable === true;
}

/** 非终态 = 仍在跑,任务列表轮询降频/升级的依据 */
export function isRunnerTaskActive(state: string): boolean {
  return !['done', 'failed', 'cancelled', 'expired'].includes(state);
}

/** 单条进展文本(倒序找最近一条有内容的 progress/error 事件;result/state 事件不适合单行展示,跳过) */
function progressText(e: RunnerEvent): string | null {
  const p = e.payload ?? {};
  if (e.type === 'progress') {
    const summary = typeof p.summary === 'string' ? p.summary.trim() : '';
    if (!summary) return null; // result 类 progress 无摘要,继续往前找
    const tool = typeof p.tool === 'string' ? `${p.tool} ` : '';
    return `${tool}${summary}`.slice(0, 120);
  }
  if (e.type === 'error' && typeof p.message === 'string' && p.message.trim()) {
    return p.message.slice(0, 120);
  }
  return null;
}

/** 任务最近一条可读进展(列表单行);无事件/全是无摘要事件 → undefined */
export function latestTaskProgress(
  events?: RunnerEvent[]
): { text: string; at: number } | undefined {
  if (!events || events.length === 0) return undefined;
  for (let i = events.length - 1; i >= 0; i--) {
    const text = progressText(events[i]);
    if (text) return { text, at: events[i].at };
  }
  return undefined;
}

/** 云端任务记录 → 概览行(mine / detail 路由同源出口,摘要字段不含完整事件) */
export function summarizeRunnerTask(t: RunnerTaskRecord): RunnerTaskSummary {
  const latest = latestTaskProgress(t.events);
  return {
    taskId: t.taskId,
    state: t.state,
    repo: t.pack.repo,
    issueUrl: t.pack.issueUrl,
    workBranch: t.pack.workBranch,
    ...(t.prUrl ? { prUrl: t.prUrl } : {}),
    ...(t.error ? { error: t.error } : {}),
    ...(t.retryable ? { retryable: true } : {}),
    updatedAt: t.updatedAt,
    ...(t.deviceId ? { deviceId: t.deviceId } : {}),
    ...(t.targetDeviceId ? { targetDeviceId: t.targetDeviceId } : {}),
    ...(t.cancelRequested ? { cancelRequested: true } : {}),
    ...(t.missionId ? { missionId: t.missionId } : {}),
    ...(latest ? { latest } : {}),
  };
}

/** 设备归属任务:runner 领取绑定(deviceId)或派发时指定(targetDeviceId,排队中未被领取) */
export function tasksForDevice(tasks: RunnerTaskSummary[], deviceId: string): RunnerTaskSummary[] {
  return tasks.filter((t) => t.deviceId === deviceId || t.targetDeviceId === deviceId);
}

/** 任务明细时间线行(事件 → 展示文本;payload 大字段不透出,服务端截断) */
export interface RunnerTaskEventView {
  at: number;
  kind: 'state' | 'progress' | 'error';
  text: string;
}

/**
 * 事件 → 时间线(旧 → 新,取最近 limit 条):progress 逐条展示(agent 干活轨迹),
 * state 展示状态跳变,error 展示失败原因;phase1/phase2_result 的产出细节走审批卡,不进时间线。
 */
export function taskEventTimeline(events?: RunnerEvent[], limit = 60): RunnerTaskEventView[] {
  if (!events || events.length === 0) return [];
  const rows: RunnerTaskEventView[] = [];
  for (let i = Math.max(0, events.length - limit); i < events.length; i++) {
    const e = events[i];
    const p = e.payload ?? {};
    if (e.type === 'state') {
      const to = typeof p.state === 'string' ? p.state : '';
      if (to) rows.push({ at: e.at, kind: 'state', text: `状态 → ${runnerStateMeta(to).label}` });
    } else if (e.type === 'progress') {
      const summary = typeof p.summary === 'string' ? p.summary.slice(0, 200) : '';
      const tool = typeof p.tool === 'string' ? p.tool : '';
      if (summary || tool) {
        // 工具行「Bash · pytest -x」;文本行只留正文
        rows.push({ at: e.at, kind: 'progress', text: [tool, summary].filter(Boolean).join(' · ') });
      }
    } else if (e.type === 'error') {
      const message = typeof p.message === 'string' ? p.message.slice(0, 300) : '';
      if (message) rows.push({ at: e.at, kind: 'error', text: message });
    }
  }
  return rows;
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
    constraints: ['只修这个 Issue,改动最小化', '不动无关文件,不顺手重构', '遵循仓库 CONTRIBUTING 的代码风格与提交规范', '边做边小步 commit 留痕(WIP 提交即可,收尾前整理),中断后续跑以 git 记录为恢复点'],
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
