import {
  NO_ACTION_REASON_LABELS,
  isTerminalRunnerState,
  normalizeTaskPack,
  renderHandoffPack,
  type NoActionReason,
  type RunnerEvent,
  type RunnerTaskPack,
  type RunnerTaskRecord,
} from '@agtpilot/protocol';
import type { OssOpportunity } from '../workshops/oss_radar/opportunities';
import type { RadarDispatchHistoryEntry } from '../workshops/oss_radar/context';

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
  /**
   * no-action 例外终态结论(agent 核实无需改动 + 证据):reason 枚举、同源中文标签、
   * 证据摘要(≤500 字,全文在任务记录里)。state='no_action' 时必有。
   */
  noAction?: { reason: NoActionReason; label: string; evidence: string };
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
 * 任务状态徽章(M2 事件回流):状态机 10 态 → 用户话术。
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
  // no-action 例外终态:agent 带证据核实无需改动(上游已修复/无法复现/不属于本仓库)。
  // 不是失败(rose 会误导),也不是完成(emerald 留给有 PR 的 done)——teal 中性收敛
  no_action: { label: '无需改动', cls: 'bg-teal-50 text-teal-700 border-teal-200' },
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

/** 非终态 = 仍在跑,任务列表轮询降频/升级的依据(no_action 是例外终态,不算在途) */
export function isRunnerTaskActive(state: string): boolean {
  return !['done', 'failed', 'no_action', 'cancelled', 'expired'].includes(state);
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

/** no-action 原因 → 中文标签(protocol 同源词表;未知枚举兜底「无需改动」) */
export function noActionLabel(reason: string): string {
  return NO_ACTION_REASON_LABELS[reason as NoActionReason] ?? '无需改动';
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
    ...(t.noAction
      ? {
          noAction: {
            reason: t.noAction.reason,
            label: noActionLabel(t.noAction.reason),
            // 列表轮询(5-15s)反复拉全量任务,证据只带摘要;全文在任务记录/时间线里
            evidence: t.noAction.evidence.slice(0, 500),
          },
        }
      : {}),
    updatedAt: t.updatedAt,
    ...(t.deviceId ? { deviceId: t.deviceId } : {}),
    ...(t.targetDeviceId ? { targetDeviceId: t.targetDeviceId } : {}),
    ...(t.cancelRequested ? { cancelRequested: true } : {}),
    ...(t.missionId ? { missionId: t.missionId } : {}),
    ...(latest ? { latest } : {}),
  };
}

/**
 * 派发防重冲突 → 用户话术(路由 409 与弹窗共用;参数结构化,不依赖 bridge 类型)。
 * no_action:摆出历史结论与证据摘要,让用户自己判断是否仍要重派;
 * active:提醒在途任务,重复派发会并行跑两份。
 */
export function describeDispatchConflict(c: {
  kind: 'no_action' | 'active';
  state: string;
  noAction?: { reason: string; evidence: string } | null;
}): string {
  if (c.kind === 'no_action') {
    const label = noActionLabel(c.noAction?.reason ?? 'other');
    const evidence = (c.noAction?.evidence || '').slice(0, 200);
    return `该 Issue 此前已由本地 agent 核实无需改动:${label}${evidence ? `。证据:${evidence}` : ''}。重复派发大概率再次得到同样结论。`;
  }
  return `该 Issue 已有在途任务(${runnerStateMeta(c.state).label}),重复派发会并行执行两份。`;
}

/**
 * 雷达派发历史(去重黑名单数据源):任务记录 → 「已处理过的 Issue」清单,
 * 由 server-render 的 oss_radar loader 现读注入周扫 prompt——同一 Issue 不重复
 * 推荐(生产背景:milvus #52049 修复已合并但 issue 没人关,雷达每轮都再扫出来)。
 * 口径:expired(从未执行)不占名单;同 issueUrl 只留最近一次;新→旧,截断 limit 条。
 */
export const RADAR_HISTORY_LIMIT = 50;
export function radarDispatchHistory(
  tasks: RunnerTaskRecord[],
  limit: number = RADAR_HISTORY_LIMIT
): RadarDispatchHistoryEntry[] {
  const seen = new Set<string>();
  const out: RadarDispatchHistoryEntry[] = [];
  const sorted = [...tasks].sort((a, b) => b.updatedAt - a.updatedAt);
  for (const t of sorted) {
    const url = t.pack?.issueUrl;
    if (!url || t.state === 'expired' || seen.has(url)) continue;
    seen.add(url);
    out.push({ issueUrl: url, outcome: dispatchOutcomeLabel(t) });
    if (out.length >= limit) break;
  }
  return out;
}

/** 单条任务 → 派发历史话术(雷达 prompt 里的「不要再推荐」理由) */
function dispatchOutcomeLabel(t: RunnerTaskRecord): string {
  switch (t.state) {
    case 'no_action':
      return `已核实无需改动(${noActionLabel(t.noAction?.reason ?? 'other')})`;
    case 'done':
      return '已派发并完成(PR 已发布)';
    case 'failed':
      return '已派发但失败';
    case 'cancelled':
      return '已派发后被终止';
    default:
      return isTerminalRunnerState(t.state) ? `已处理(${runnerStateMeta(t.state).label})` : '已派发,进行中';
  }
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
