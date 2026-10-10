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
} from 'lucide-react';
import { ApprovalRequest, ConnectorSuggestion, Mission, TerminalLog } from '../../types/agent';

interface MobileActivityViewProps {
  missions: Mission[];
  activeMissionId: string | null;
  onSelectMission: (id: string) => void;
  approvalRequests: ApprovalRequest[];
  onApproval: (approvalId: string, approved: boolean) => void;
  connectorSuggestions?: ConnectorSuggestion[];
  onConnectorAuthorize?: (s: ConnectorSuggestion) => void;
  onSkipConnectorSuggestion?: (s: ConnectorSuggestion) => void;
  terminalLogs: TerminalLog[];
  /** 跳到交付物 Tab（看最终产物），不传则不显示入口 */
  onOpenDeliverable?: () => void;
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
  onConnectorAuthorize,
  onSkipConnectorSuggestion,
  terminalLogs,
  onOpenDeliverable,
}: MobileActivityViewProps) {
  const [logsExpanded, setLogsExpanded] = useState(false);
  const [showAllMissions, setShowAllMissions] = useState(false);
  const [showAllSteps, setShowAllSteps] = useState(false);
  const [expandedSteps, setExpandedSteps] = useState<Record<string, boolean>>({});
  const approvalTopRef = useRef<HTMLDivElement>(null);
  const prevApprovalCount = useRef(approvalRequests.length);
  const prevSuggestionCount = useRef(connectorSuggestions.length);

  // 新审批/新授权请求进来时自动滚到眼前（只在数量增加时触发，不打断日常滚动）
  useEffect(() => {
    const grew =
      approvalRequests.length > prevApprovalCount.current ||
      connectorSuggestions.length > prevSuggestionCount.current;
    prevApprovalCount.current = approvalRequests.length;
    prevSuggestionCount.current = connectorSuggestions.length;
    if (grew) {
      approvalTopRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, [approvalRequests.length, connectorSuggestions.length]);

  const mission = useMemo(
    () => missions.find((m) => m.id === activeMissionId) || missions[0] || null,
    [missions, activeMissionId]
  );

  const recentLogs = useMemo(() => {
    const scope = mission?.terminalLogs?.length ? mission.terminalLogs : terminalLogs;
    return (scope || []).slice(-40).reverse();
  }, [mission, terminalLogs]);

  return (
    <div className="px-4 pt-4 pb-28 max-w-lg mx-auto">
      <header className="mb-4 text-center">
        <h1 className="text-2xl font-bold text-zinc-900 tracking-tight">动态</h1>
      </header>
      <div ref={approvalTopRef} className="scroll-mt-4" />

      {/* 待审批 */}
      {approvalRequests.length > 0 && (
        <section className="mb-5">
          <h2 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-2 px-1">
            待你审批 · {approvalRequests.length}
          </h2>
          <ul className="space-y-2.5">
            {approvalRequests.map((req) => (
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

      {/* 任务切换 */}
      {missions.length > 0 && (
        <section>
          <div className="-mx-4 px-4 overflow-x-auto scrollbar-none">
            <div className="flex gap-2 w-max pb-1">
              {(showAllMissions ? missions : missions.slice(0, 12)).map((m) => {
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
              {missions.length > 12 && (
                <button
                  type="button"
                  onClick={() => setShowAllMissions((v) => !v)}
                  className="h-8 px-3.5 rounded-full text-xs font-medium whitespace-nowrap transition border bg-zinc-100 text-zinc-600 border-zinc-200 active:bg-zinc-200"
                >
                  {showAllMissions ? '收起' : `全部 ${missions.length}`}
                </button>
              )}
            </div>
          </div>

          {/* 步骤时间线 */}
          {mission && (
            <div className="mt-3 rounded-xl border border-zinc-200 bg-white px-4 py-4 shadow-sm">
              <div className="flex items-center justify-between mb-1">
                <p className="text-sm font-semibold text-zinc-900 truncate pr-2">{mission.title || '未命名任务'}</p>
                <span className="text-[11px] text-zinc-400 shrink-0">{Math.round(mission.progress || 0)}%</span>
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
                          {body && expanded && (
                            <p className="mt-1.5 text-[12px] leading-5 text-zinc-600 whitespace-pre-wrap break-words bg-zinc-50 rounded-lg px-2.5 py-2">
                              {String(body).slice(0, 2000)}
                            </p>
                          )}
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
          )}
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
    </div>
  );
}
