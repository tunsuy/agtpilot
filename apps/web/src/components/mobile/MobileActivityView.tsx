'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Check,
  X,
  ShieldAlert,
  Loader2,
  CheckCircle2,
  Circle,
  XCircle,
  Terminal,
  ChevronDown,
  ChevronUp,
  ChevronRight,
  Inbox,
  Plug,
  FileText,
  HelpCircle,
} from 'lucide-react';
import { ApprovalRequest, ConnectorSuggestion, Mission, PendingQuestion, TerminalLog } from '../../types/agent';
import { KanbanPlanCard } from '../KanbanPlanCard';
import { QuestionCard } from '../QuestionCard';
import { RunnerPublishApprovalCard } from '../RunnerPublishApprovalCard';
import { TopicPickList } from '../workshops/TopicPickCard';
import { parseTopicPicks } from '../../workshops/xhs/topic-picks';
import type { NovelChainHandler } from '../workshops/NovelPackageCard';
import { MobileConversationView } from './MobileConversationView';
import { MobileChatComposer } from './MobileChatComposer';
import { isCronMission } from '../../lib/mission-wire';
import { isRunnerTaskActive, runnerStateMeta, runnerRetryable, RUNNER_RETRYABLE_LABEL, RUNNER_RETRYABLE_HINT, partitionApprovalsByMission, type RunnerTaskSummary } from '../../lib/runner-dispatch';
import { formatTokenCount } from '../../lib/mission-efficiency';
import { ConfirmModal } from '../ConfirmModal';

interface MobileActivityViewProps {
  missions: Mission[];
  activeMissionId: string | null;
  onSelectMission: (id: string) => void;
  approvalRequests: ApprovalRequest[];
  onApproval: (approvalId: string, approved: boolean, opts?: { includeClaim?: boolean }) => void;
  connectorSuggestions?: ConnectorSuggestion[];
  onConnectorAuthorize?: (s: ConnectorSuggestion) => void;
  onSkipConnectorSuggestion?: (s: ConnectorSuggestion) => void;
  /** ask_user 问题卡(模糊需求先问后猜):按来源会话归属展示 */
  pendingQuestions?: PendingQuestion[];
  onAnswerQuestion?: (
    questionId: string,
    answers: Array<{ index: number; answer: string; via: 'option' | 'free_text' }>
  ) => void;
  terminalLogs: TerminalLog[];
  /** 跳到交付物 Tab（看最终产物），不传则不显示入口 */
  onOpenDeliverable?: () => void;
  /** 续聊同一 mission（勾选选题一键成稿的移动端唯一回复入口） */
  onRunMission?: (prompt: string, title?: string, missionId?: string) => void;
  /** 小说包「下一步」链式出口(对话态 novel 卡;与桌面驾驶舱同款) */
  onRunNovelChain?: NovelChainHandler;
  /** 发送防重入(page.tsx isSubmitting):composer 发送键转圈 */
  isSubmitting?: boolean;
  /** 停止执行中任务(composer 停止钮;与桌面同口径) */
  onStopMission?: (missionId: string) => void;
}

const DANGER_STYLE: Record<ApprovalRequest['dangerLevel'], string> = {
  low: 'border-zinc-200 bg-white',
  medium: 'border-amber-200 bg-amber-50/60',
  high: 'border-red-200 bg-red-50/60',
};

const DANGER_LABEL: Record<ApprovalRequest['dangerLevel'], string> = {
  low: '低风险',
  medium: '中风险',
  high: '高风险',
};

function fmtTime(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(
    d.getSeconds()
  ).padStart(2, '0')}`;
}

const STEP_ICON: Record<string, React.ComponentType<{ className?: string }>> = {
  DONE: CheckCircle2,
  RUNNING: Loader2,
  FAILED: XCircle,
  PENDING: Circle,
};

/**
 * 移动端"动态" —— 收件箱。
 * 顶部：待审批卡片（一键批准/拒绝，新请求自动滚到眼前）；
 * 中部：任务切换 chips（超 12 个可展开全部）；
 * 主体：所选任务的步骤时间线（默认最近 12 步，可展开全部；步骤正文点标题展开）+ 交付物入口 + 最近执行日志。
 */
export function MobileActivityView({
  missions,
  activeMissionId,
  onSelectMission,
  approvalRequests,
  onApproval,
  connectorSuggestions = [],
  pendingQuestions = [],
  onAnswerQuestion,
  onConnectorAuthorize,
  onSkipConnectorSuggestion,
  terminalLogs,
  onOpenDeliverable,
  onRunMission,
  onRunNovelChain,
  isSubmitting,
  onStopMission,
}: MobileActivityViewProps) {
  const [logsExpanded, setLogsExpanded] = useState(false);
  const [showAllMissions, setShowAllMissions] = useState(false);
  const [showAllSteps, setShowAllSteps] = useState(false);
  const [expandedSteps, setExpandedSteps] = useState<Record<string, boolean>>({});
  // 任务卡内容态:动态(监控:审批/时间线/看板/日志)↔ 对话(聊天流)。
  // 默认动态态(与改造前一致);切任务芯片延续当前态,切 tab 重挂载回默认,
  // 不做 per-mission 记忆
  const [chatMode, setChatMode] = useState(false);
  // 对话态发送 +1:对话流重置贴底跟随新一轮输出(卡片续聊/重新生成同享)
  const [followToken, setFollowToken] = useState(0);
  const approvalTopRef = useRef<HTMLDivElement>(null);
  const prevApprovalCount = useRef(approvalRequests.length);
  const prevSuggestionCount = useRef(connectorSuggestions.length);

  // 本地 runner 任务(派发到本地的贡献):最新一条进展实时滚动
  const [runnerTasks, setRunnerTasks] = useState<RunnerTaskSummary[]>([]);
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const r = await fetch('/api/runner/tasks/mine');
        const j = await r.json();
        if (!cancelled && j?.success && Array.isArray(j.tasks)) setRunnerTasks(j.tasks.slice(0, 10));
      } catch {
        /* 移动端弱网不打扰主流程;下个轮询窗口重试 */
      }
    };
    load();
    const timer = setInterval(load, 8_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  // 终止本地任务(执行中止损):确认弹窗确认后 POST cancel,乐观置 cancelRequested 等轮询回填终态
  const [cancelConfirmId, setCancelConfirmId] = useState<string | null>(null);
  const cancelRunnerTask = async (taskId: string) => {
    setRunnerTasks((prev) => prev.map((t) => (t.taskId === taskId ? { ...t, cancelRequested: true } : t)));
    try {
      const res = await fetch('/api/runner/tasks/cancel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskId }),
      });
      const j = await res.json();
      if (!j?.success) {
        // 失败回滚乐观标记(终态等场景由下个轮询窗口纠正)
        setRunnerTasks((prev) => prev.map((t) => (t.taskId === taskId && t.cancelRequested ? { ...t, cancelRequested: undefined } : t)));
      }
    } catch {
      /* 弱网:保持乐观标记,下个轮询窗口以云端为准 */
    }
  };

  // 新审批/新授权请求进来时自动滚到眼前（只在数量增加时触发，不打断日常滚动）
  useEffect(() => {
    const grew =
      approvalRequests.length > prevApprovalCount.current ||
      connectorSuggestions.length > prevSuggestionCount.current;
    prevApprovalCount.current = approvalRequests.length;
    prevSuggestionCount.current = connectorSuggestions.length;
    if (grew && !chatMode) {
      approvalTopRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, [approvalRequests.length, connectorSuggestions.length, chatMode]);

  const mission = useMemo(
    () => missions.find((m) => m.id === activeMissionId) || missions[0] || null,
    [missions, activeMissionId]
  );

  // 切到对话态:mission 回退(missions[0])在 activeMissionId 为 null 时
  // 「展示但未选中」→ 不触发懒回水(回水 effect 只依赖 activeMissionId)。
  // 这里补一次 onSelectMission:对齐芯片高亮 + 把终态摘要会话的全量步骤
  // 拉下来,对话流才有历史内容可渲染
  const enterChat = () => {
    setChatMode(true);
    if (mission && mission.id !== activeMissionId) onSelectMission(mission.id);
  };

  // 对话态回复出口:统一过一道 followToken +1(composer 发送、选题成稿、
  // 存草稿、重新生成都会让对话流重置贴底,跟进新一轮输出)
  const runInChat = useMemo(
    () =>
      onRunMission
        ? (text: string, title?: string, missionId?: string) => {
            setFollowToken((t) => t + 1);
            onRunMission(text, title, missionId);
          }
        : undefined,
    [onRunMission]
  );

  // 后台子任务(带 parentMissionId)不占任务切换条坑位(与桌面 sidebar 同规则):
  // 子任务进展在父会话的通知卡/活动行可见;顶层只列用户发起的会话。
  // 巡航会话不占坑(与桌面同规则):仅从巡航中心点开且正被选中时可见
  const topMissions = useMemo(
    () =>
      missions.filter(
        (m) => !m.parentMissionId && (!isCronMission(m) || m.id === activeMissionId)
      ),
    [missions, activeMissionId]
  );

  // 发布审批归回来源会话(与桌面驾驶舱同规则):切会话不再全局跟随卡片;
  // hidden 走「待你审批」下方的细条提示 + 跳回来源会话,不会静默漏掉
  const { visible: visibleApprovals, hidden: hiddenApprovals } = partitionApprovalsByMission(
    approvalRequests,
    mission?.id ?? null
  );

  // ask_user 问题卡同款归属切分(与桌面驾驶舱同规则)
  const { visible: visibleQuestions, hidden: hiddenQuestions } = partitionApprovalsByMission(
    pendingQuestions,
    mission?.id ?? null
  );

  const recentLogs = useMemo(() => {
    const scope = mission?.terminalLogs?.length ? mission.terminalLogs : terminalLogs;
    return (scope || []).slice(-40).reverse();
  }, [mission, terminalLogs]);

  return (
    // 对话态加高底部留白:给固定输入框(composer)与键盘留出空间
    <div className={`px-4 pt-4 max-w-lg mx-auto ${chatMode ? 'pb-48' : 'pb-28'}`}>
      <header className="mb-4 text-center">
        <h1 className="text-2xl font-bold text-zinc-900 tracking-tight">动态</h1>
      </header>
      <div ref={approvalTopRef} className="scroll-mt-4" />

      {/* 收件箱区(问题卡/审批/授权/本地任务):只属于动态态 —— 对话态把
          屏幕让给聊天流,审批提醒由 TabBar 角标 + 动态态承担 */}
      {!chatMode && (
      <>
      {/* ask_user 问题卡(先问后猜):排在待审批之前 —— 回答解锁的是整个任务方向 */}
      {visibleQuestions.length > 0 && onAnswerQuestion && (
        <section className="mb-5">
          <h2 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-2 px-1">
            等你回答 · {visibleQuestions.length}
          </h2>
          <ul className="space-y-2.5">
            {visibleQuestions.map((q) => (
              <li key={q.id}>
                <QuestionCard q={q} onAnswer={onAnswerQuestion} compact />
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* 其他会话的问题卡:细条提示 + 跳回来源会话 */}
      {hiddenQuestions.length > 0 && (
        <section className="mb-5">
          <ul className="space-y-2">
            {hiddenQuestions.map((q) => (
              <li key={q.id}>
                <button
                  type="button"
                  onClick={() => q.missionId && onSelectMission(q.missionId)}
                  className="w-full rounded-xl border border-sky-200 bg-sky-50/60 px-4 py-3 flex items-center justify-between gap-2 shadow-sm active:bg-sky-100/60 transition text-left"
                >
                  <span className="flex items-center gap-2 min-w-0">
                    <HelpCircle className="h-4 w-4 shrink-0 text-sky-600" />
                    <span className="text-xs text-sky-900 truncate">
                      有问题等你回答 · {missions.find((m) => m.id === q.missionId)?.title || '其他会话'}
                    </span>
                  </span>
                  <ChevronRight className="h-4 w-4 shrink-0 text-sky-600" />
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* 待审批(runner 发布审批只在来源会话展示,其他会话走下方细条提示) */}
      {visibleApprovals.length > 0 && (
        <section className="mb-5">
          <h2 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-2 px-1">
            待你审批 · {visibleApprovals.length}
          </h2>
          <ul className="space-y-2.5">
            {visibleApprovals.map((req) =>
              req.action === 'runner_publish' ? (
                // 本地贡献发布审批(M3):专用高危卡,与桌面驾驶舱同一组件(细节不缩水)
                <li key={req.id}>
                  <RunnerPublishApprovalCard req={req} onApproval={onApproval} />
                </li>
              ) : (
              <li key={req.id} className={`rounded-xl border px-4 py-3.5 shadow-sm ${DANGER_STYLE[req.dangerLevel] || DANGER_STYLE.low}`}>
                <div className="flex items-start gap-2.5">
                  <ShieldAlert
                    className={`h-5 w-5 shrink-0 mt-0.5 ${
                      req.dangerLevel === 'high' ? 'text-red-500' : req.dangerLevel === 'medium' ? 'text-amber-500' : 'text-zinc-400'
                    }`}
                  />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-zinc-900">{req.action}</p>
                    <p className="text-xs text-zinc-500 mt-1 break-words">{req.description}</p>
                    {req.params && Object.keys(req.params).length > 0 && (
                      <pre className="mt-2 text-[11px] leading-4 text-zinc-400 bg-zinc-900/5 rounded-lg px-2.5 py-2 overflow-x-auto whitespace-pre-wrap break-all">
                        {JSON.stringify(req.params, null, 2)}
                      </pre>
                    )}
                    <span
                      className={`inline-block mt-2 text-[10px] px-1.5 py-0.5 rounded ${
                        req.dangerLevel === 'high'
                          ? 'bg-red-100 text-red-600'
                          : req.dangerLevel === 'medium'
                          ? 'bg-amber-100 text-amber-700'
                          : 'bg-zinc-100 text-zinc-500'
                      }`}
                    >
                      {DANGER_LABEL[req.dangerLevel] || '未分级'}
                    </span>
                  </div>
                </div>
                <div className="mt-3 flex gap-2">
                  <button
                    type="button"
                    onClick={() => onApproval(req.id, false)}
                    className="flex-1 h-10 rounded-lg border border-zinc-200 bg-white text-sm font-medium text-zinc-600 flex items-center justify-center gap-1.5 active:bg-zinc-50 transition"
                  >
                    <X className="h-4 w-4" /> 拒绝
                  </button>
                  <button
                    type="button"
                    onClick={() => onApproval(req.id, true)}
                    className="flex-1 h-10 rounded-lg bg-zinc-900 text-sm font-medium text-white flex items-center justify-center gap-1.5 active:bg-zinc-700 transition"
                  >
                    <Check className="h-4 w-4" /> 批准
                  </button>
                </div>
              </li>
              )
            )}
          </ul>
        </section>
      )}

      {/* 其他会话的发布审批:细条提示 + 跳回来源会话(完整卡片在那里展开) */}
      {hiddenApprovals.length > 0 && (
        <section className="mb-5">
          <ul className="space-y-2">
            {hiddenApprovals.map((req) => (
              <li key={req.id}>
                <button
                  type="button"
                  onClick={() => req.missionId && onSelectMission(req.missionId)}
                  className="w-full rounded-xl border border-amber-200 bg-amber-50/60 px-4 py-3 flex items-center justify-between gap-2 shadow-sm active:bg-amber-100/60 transition text-left"
                >
                  <span className="flex items-center gap-2 min-w-0">
                    <ShieldAlert className="h-4 w-4 shrink-0 text-amber-600" />
                    <span className="text-xs text-amber-900 truncate">
                      发布审批待处理 · {missions.find((m) => m.id === req.missionId)?.title || '其他会话'}
                    </span>
                  </span>
                  <ChevronRight className="h-4 w-4 shrink-0 text-amber-600" />
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* 任务中途连接器授权请求 */}
      {connectorSuggestions.length > 0 && (
        <section className="mb-5">
          <h2 className="text-xs font-semibold text-violet-400 uppercase tracking-wider mb-2 px-1">
            待你授权 · {connectorSuggestions.length}
          </h2>
          <ul className="space-y-2.5">
            {connectorSuggestions.map((s) => (
              <li key={s.id} className="rounded-xl border border-violet-200 bg-violet-50/60 px-4 py-3.5 shadow-sm">
                <div className="flex items-start gap-2.5">
                  <Plug className="h-5 w-5 shrink-0 mt-0.5 text-violet-500" />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-zinc-900">任务需要「{s.connectorName}」</p>
                    <p className="text-xs text-zinc-500 mt-1 break-words">{s.reason}</p>
                    <p className="text-[11px] text-zinc-400 mt-1.5">
                      授权后任务原地继续；跳过后 Agent 将用浏览器兜底完成。
                    </p>
                  </div>
                </div>
                <div className="mt-3 flex gap-2">
                  <button
                    type="button"
                    onClick={() => onSkipConnectorSuggestion?.(s)}
                    className="flex-1 h-10 rounded-lg border border-zinc-200 bg-white text-sm font-medium text-zinc-600 flex items-center justify-center gap-1.5 active:bg-zinc-50 transition"
                  >
                    <X className="h-4 w-4" /> 跳过
                  </button>
                  <button
                    type="button"
                    onClick={() => onConnectorAuthorize?.(s)}
                    className="flex-1 h-10 rounded-lg bg-violet-600 text-sm font-medium text-white flex items-center justify-center gap-1.5 active:bg-violet-500 transition"
                  >
                    <Plug className="h-4 w-4" /> {s.authType === 'oauth' ? '一键授权' : '去配置'}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* 本地 runner 任务:派发到本地的贡献进展(最新一条上行事件滚动) */}
      {runnerTasks.length > 0 && (
        <section className="mb-5">
          <h2 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-2 px-1">
            本地任务 · {runnerTasks.filter((t) => isRunnerTaskActive(t.state)).length} 个在途
          </h2>
          <ul className="space-y-2">
            {runnerTasks.map((t) => {
              const meta = runnerStateMeta(t.state);
              const active = isRunnerTaskActive(t.state);
              const retryable = runnerRetryable(t);
              const cancellable = t.state === 'queued' || t.state === 'dispatched' || t.state === 'running';
              return (
                <li
                  key={t.taskId}
                  className={`rounded-xl border px-3.5 py-3 shadow-sm ${active ? 'border-sky-200 bg-white' : 'border-zinc-200 bg-white'}`}
                >
                  <div className="flex items-center gap-2">
                    {active && <Loader2 className="h-3.5 w-3.5 text-sky-500 animate-spin shrink-0" />}
                    <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded border ${meta.cls}`}>{meta.label}</span>
                    {retryable && (
                      <span
                        className="text-[10px] font-medium px-1.5 py-0.5 rounded border bg-amber-50 text-amber-700 border-amber-200 shrink-0"
                        title={RUNNER_RETRYABLE_HINT}
                      >
                        {RUNNER_RETRYABLE_LABEL}
                      </span>
                    )}
                    {/* no-action 例外终态原因(悬停看证据;与桌面端徽章同源话术) */}
                    {t.state === 'no_action' && t.noAction && (
                      <span
                        className="text-[10px] font-medium px-1.5 py-0.5 rounded border bg-teal-50 text-teal-700 border-teal-200 shrink-0"
                        title={`证据:${t.noAction.evidence}`}
                      >
                        {t.noAction.label}
                      </span>
                    )}
                    <span className="text-xs font-mono text-zinc-900 truncate flex-1 min-w-0">{t.repo}</span>
                    {t.missionId && missions.some((m) => m.id === t.missionId) && (
                      <button
                        type="button"
                        onClick={() => onSelectMission(t.missionId!)}
                        className="text-[10px] text-zinc-400 px-1.5 py-0.5 rounded border border-zinc-200 active:bg-sky-50 active:text-sky-600 shrink-0"
                        title="跳到派发它的会话"
                      >
                        会话
                      </button>
                    )}
                    {/* 终止中徽标仅在飞状态有意义(与桌面端同门控:终态任务不悬挂「终止中…」) */}
                    {t.cancelRequested && (t.state === 'dispatched' || t.state === 'running') ? (
                      <span className="text-[10px] text-amber-600 shrink-0 flex items-center gap-1">
                        <Loader2 className="h-3 w-3 animate-spin" /> 终止中…
                      </span>
                    ) : cancellable ? (
                      <button
                        type="button"
                        onClick={() => setCancelConfirmId(t.taskId)}
                        className="text-[10px] text-zinc-500 px-1.5 py-0.5 rounded border border-zinc-200 active:bg-rose-50 active:border-rose-200 active:text-rose-600 shrink-0"
                      >
                        终止
                      </button>
                    ) : null}
                    {t.state === 'done' && t.prUrl && (
                      <a
                        href={t.prUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-xs text-sky-600 hover:underline shrink-0"
                      >
                        PR
                      </a>
                    )}
                  </div>
                  {(t.latest?.text || (t.state === 'failed' && t.error)) && (
                    <p
                      className="text-[11px] text-zinc-500 mt-1.5 truncate"
                      title={t.latest?.text ?? t.error ?? ''}
                    >
                      {t.latest?.text ?? t.error?.slice(0, 120)}
                      {' · '}
                      {fmtTime(t.updatedAt)}
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      )}
      </>
      )}

      {/* 任务切换 */}
      {topMissions.length > 0 && (
        <section>
          <div className="-mx-4 px-4 overflow-x-auto scrollbar-none">
            <div className="flex gap-2 w-max pb-1">
              {(showAllMissions ? topMissions : topMissions.slice(0, 12)).map((m) => {
                const active = mission?.id === m.id;
                return (
                  <button
                    key={m.id}
                    type="button"
                    onClick={() => onSelectMission(m.id)}
                    className={`h-8 px-3.5 rounded-full text-xs font-medium whitespace-nowrap transition border ${
                      active
                        ? 'bg-zinc-900 text-white border-zinc-900'
                        : 'bg-white text-zinc-500 border-zinc-200 active:bg-zinc-50'
                    }`}
                  >
                    {m.status === 'ACTIVE' && <span className="inline-block mr-1.5 h-1.5 w-1.5 rounded-full bg-blue-400 align-middle animate-pulse" />}
                    {(m.title || '未命名任务').slice(0, 14)}
                  </button>
                );
              })}
              {topMissions.length > 12 && (
                <button
                  type="button"
                  onClick={() => setShowAllMissions((v) => !v)}
                  className="h-8 px-3.5 rounded-full text-xs font-medium whitespace-nowrap transition border bg-zinc-100 text-zinc-600 border-zinc-200 active:bg-zinc-200"
                >
                  {showAllMissions ? '收起' : `全部 ${topMissions.length}`}
                </button>
              )}
            </div>
          </div>

          {/* 任务卡内容态切换(动态监控 ↔ 对话):不占 tab,轻量 pill */}
          <div className="mt-3 flex w-fit rounded-full bg-zinc-100 p-0.5">
            <button
              type="button"
              onClick={() => setChatMode(false)}
              className={`h-7 px-3.5 rounded-full text-xs transition ${
                !chatMode ? 'bg-white shadow-sm font-medium text-zinc-900' : 'text-zinc-500 active:text-zinc-700'
              }`}
            >
              动态
            </button>
            <button
              type="button"
              onClick={enterChat}
              className={`h-7 px-3.5 rounded-full text-xs transition ${
                chatMode ? 'bg-white shadow-sm font-medium text-zinc-900' : 'text-zinc-500 active:text-zinc-700'
              }`}
            >
              对话
            </button>
          </div>

          {/* 对话态:聊天流(桌面驾驶舱对话流移植);动态态:既有任务卡原样 */}
          {mission && chatMode ? (
            <div className="mt-3">
              <MobileConversationView
                mission={mission}
                onRunMission={runInChat}
                onSelectMission={onSelectMission}
                onRunNovelChain={onRunNovelChain}
                followToken={followToken}
              />
            </div>
          ) : mission ? (
            <div className="mt-3 rounded-xl border border-zinc-200 bg-white px-4 py-4 shadow-sm">
              <div className="flex items-center justify-between mb-1">
                <p className="text-sm font-semibold text-zinc-900 truncate pr-2">{mission.title || '未命名任务'}</p>
                <span className="flex items-center gap-1 shrink-0">
                  {mission.usage && (
                    <span
                      className="text-[11px] font-mono tabular-nums text-zinc-400"
                      title={`token 累计:输入 ${mission.usage.promptTokens} / 输出 ${mission.usage.completionTokens}`}
                    >
                      {formatTokenCount(mission.usage.promptTokens)}/{formatTokenCount(mission.usage.completionTokens)}
                    </span>
                  )}
                  <span className="text-[11px] text-zinc-400">{Math.round(mission.progress || 0)}%</span>
                </span>
              </div>
              {onOpenDeliverable && (
                <button
                  type="button"
                  onClick={onOpenDeliverable}
                  className="mb-3 flex items-center gap-1 text-xs text-zinc-500 active:text-zinc-800 transition"
                >
                  <FileText className="h-3.5 w-3.5" /> 查看交付物 <ChevronRight className="h-3 w-3" />
                </button>
              )}
              {/* 任务看板卡(与桌面驾驶舱同源):钉在任务卡头部,步骤时间线
                  之前 —— plan 事件实时刷新,看板进度一眼可见;无看板(简单
                  任务/旧任务)不渲染 */}
              {mission.plan && (
                <div className="mb-3">
                  <KanbanPlanCard plan={mission.plan} />
                </div>
              )}
              {(mission.steps?.length || 0) > 12 && (
                <button
                  type="button"
                  onClick={() => setShowAllSteps((v) => !v)}
                  className="mb-2 text-[11px] text-zinc-400 active:text-zinc-600 transition"
                >
                  {showAllSteps ? '只看最近 12 步' : `展开全部 ${mission.steps?.length} 步`}
                </button>
              )}
              {mission.steps?.length ? (
                <ol className="relative">
                  {(showAllSteps ? mission.steps : mission.steps.slice(-12)).map((step, idx, arr) => {
                    const Icon = STEP_ICON[step.status] || Circle;
                    const last = idx === arr.length - 1;
                    const body = (step as any).answer || (step as any).reasoning || '';
                    const expanded = Boolean(expandedSteps[step.id]);
                    return (
                      <li key={step.id} className="relative flex gap-3 pb-3 last:pb-0">
                        {!last && <span className="absolute left-[9px] top-5 bottom-0 w-px bg-zinc-100" />}
                        <Icon
                          className={`h-[18px] w-[18px] shrink-0 mt-px z-10 bg-white ${
                            step.status === 'DONE'
                              ? 'text-emerald-500'
                              : step.status === 'RUNNING'
                              ? 'text-blue-600 animate-spin'
                              : step.status === 'FAILED'
                              ? 'text-red-500'
                              : 'text-zinc-300'
                          }`}
                        />
                        <div className="flex-1 min-w-0">
                          <button
                            type="button"
                            onClick={() => body && setExpandedSteps((p) => ({ ...p, [step.id]: !p[step.id] }))}
                            className={`w-full text-left text-[13px] leading-5 ${step.status === 'PENDING' ? 'text-zinc-400' : 'text-zinc-700'}`}
                          >
                            {step.title}
                            {body && (
                              <span className="ml-1.5 text-[11px] text-zinc-300">{expanded ? '收起' : '展开'}</span>
                            )}
                          </button>
                          {step.tool && <p className="text-[11px] text-zinc-300 mt-0.5">{step.tool}{step.duration ? ` · ${step.duration}` : ''}</p>}
                          {step.error && <p className="text-[11px] text-red-500 mt-0.5 break-words">{step.error}</p>}
                          {body && expanded &&
                            (() => {
                              // 每周选题答案 → 勾选卡片（移动端闭环唯一回复入口）
                              const parsed = onRunMission ? parseTopicPicks(String(body)) : null;
                              if (parsed && parsed.picks.length > 0 && onRunMission) {
                                return (
                                  <div className="mt-1.5">
                                    <TopicPickList
                                      compact
                                      result={parsed}
                                      missionId={mission.id}
                                      onRunMission={onRunMission}
                                    />
                                  </div>
                                );
                              }
                              return (
                                <p className="mt-1.5 text-[13px] leading-5 text-zinc-600 whitespace-pre-wrap break-words bg-zinc-50 rounded-lg px-2.5 py-2">
                                  {String(body).slice(0, 2000)}
                                </p>
                              );
                            })()}
                        </div>
                      </li>
                    );
                  })}
                </ol>
              ) : (
                <p className="text-xs text-zinc-400 py-2">暂无执行步骤</p>
              )}

              {/* 日志折叠区 */}
              {recentLogs.length > 0 && (
                <div className="mt-3 border-t border-zinc-100 pt-2">
                  <button
                    type="button"
                    onClick={() => setLogsExpanded((v) => !v)}
                    className="w-full flex items-center justify-between text-xs text-zinc-400 py-1.5 active:text-zinc-600 transition"
                  >
                    <span className="flex items-center gap-1.5">
                      <Terminal className="h-3.5 w-3.5" /> 执行日志（{recentLogs.length}）
                    </span>
                    {logsExpanded ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                  </button>
                  {logsExpanded && (
                    <div className="mt-1.5 rounded-lg bg-zinc-950 px-3 py-2.5 max-h-64 overflow-y-auto">
                      {recentLogs.map((log) => (
                        <p
                          key={log.id}
                          className={`font-mono text-[11px] leading-4 break-all ${
                            log.type === 'stderr' ? 'text-red-400' : log.type === 'command' ? 'text-emerald-400' : 'text-zinc-300'
                          }`}
                        >
                          <span className="text-zinc-600 mr-1.5">{fmtTime(log.timestamp)}</span>
                          {log.text}
                        </p>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          ) : null}
        </section>
      )}

      {/* 空态 */}
      {approvalRequests.length === 0 && missions.length === 0 && (
        <div className="mt-10 flex flex-col items-center text-center">
          <Inbox className="h-10 w-10 text-zinc-200" />
          <p className="mt-3 text-sm text-zinc-400">暂无动态</p>
          <p className="text-xs text-zinc-300 mt-1">任务执行进度和审批请求会出现在这里</p>
        </div>
      )}

      {/* 对话态固定输入框:对当前会话(含 DONE 历史)续聊 + 停止在飞任务。
          只在对话态渲染 —— 动态态回复入口已由问题卡/审批/选题卡承担 */}
      {chatMode && mission && runInChat && (
        <MobileChatComposer
          mission={mission}
          isSubmitting={Boolean(isSubmitting)}
          onRunMission={runInChat}
          onStopMission={onStopMission}
        />
      )}

      {/* 终止本地任务确认(替代原生 confirm) */}
      <ConfirmModal
        open={cancelConfirmId !== null}
        danger
        title="终止该任务?"
        message="本地执行会被停止(工作分支保留),此操作不可恢复。"
        confirmText="终止任务"
        onConfirm={() => {
          const id = cancelConfirmId;
          setCancelConfirmId(null);
          if (id) void cancelRunnerTask(id);
        }}
        onClose={() => setCancelConfirmId(null)}
      />
    </div>
  );
}
