'use client';

/**
 * 开源贡献机会卡片(开源贡献雷达工坊交付物)
 *
 * 把 parseOssOpportunities 的结构化结果渲染成「可直达、可复制、可派发」的机会卡:
 * 项目 + 类型/难度徽章 + 简介 + Issue 直达链接(新标签打开)+ 匹配点 + 第一步。
 *
 * 工坊本身红线是全程只读(检索/解析不改任何东西);卡片上的两个动作都不越线:
 * - 「复制交接包」:T0 人工降级路径,粘进任意本地 coding agent 会话人工干;
 * - 「派发到本地」:入用户任务队列,由本地 runner 驱动用户自己的 claude CLI 执行
 *   Phase 1(只修 Issue、禁 push/禁网),push/PR 走云端审批门(M3)——发布永远人工。
 * 状态徽章从 /api/runner/tasks/mine 回流(queued→…→done/failed),按 Issue 链接匹配。
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Copy, Check, Radar, ChevronDown, ExternalLink, Send, MonitorSmartphone } from 'lucide-react';
import { copyToClipboard } from '../../utils/nativeBridge';
import {
  buildOssOpportunityCopyText,
  type OssOpportunity,
  type OssOpportunityParseResult,
} from '../../workshops/oss_radar/opportunities';
import { handoffPackFor, pickIssueUrl, runnerStateMeta, runnerRetryable, RUNNER_RETRYABLE_LABEL, RUNNER_RETRYABLE_HINT, type RunnerTaskSummary } from '../../lib/runner-dispatch';
import { DispatchRunnerModal } from './DispatchRunnerModal';

/** 单字段复制按钮:成功打勾、失败明示,不静默假成功(与笔记包卡同款) */
function CopyButton({ text, label }: { text: string; label?: string }) {
  const [state, setState] = useState<'idle' | 'ok' | 'fail'>('idle');
  const handleCopy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    const ok = await copyToClipboard(text);
    setState(ok ? 'ok' : 'fail');
    setTimeout(() => setState('idle'), 2000);
  };
  return (
    <button
      type="button"
      onClick={handleCopy}
      className="flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[10px] font-medium text-zinc-400 hover:text-zinc-700 hover:bg-zinc-100 transition"
      title="复制"
    >
      {state === 'ok' ? (
        <Check className="h-3 w-3 text-emerald-600" />
      ) : (
        <Copy className="h-3 w-3" />
      )}
      {state === 'fail' ? <span className="text-red-500">复制失败</span> : state === 'ok' ? '已复制' : label || '复制'}
    </button>
  );
}

/** 难度徽章配色:低=绿 / 中=琥珀 / 高=玫红;未知难度灰 */
function difficultyClass(difficulty: string): string {
  if (difficulty.startsWith('低')) return 'bg-emerald-50 text-emerald-700 border-emerald-200';
  if (difficulty.startsWith('中')) return 'bg-amber-50 text-amber-700 border-amber-200';
  if (difficulty.startsWith('高')) return 'bg-rose-50 text-rose-700 border-rose-200';
  return 'bg-zinc-50 text-zinc-600 border-zinc-200';
}

/** 任务状态徽章(M2 事件回流):状态机 9 态话术与设备页任务列表共用 runnerStateMeta */
function TaskStateBadge({ task }: { task: RunnerTaskSummary }) {
  const meta = runnerStateMeta(task.state);
  const retryable = runnerRetryable(task);
  return (
    <span className="inline-flex items-center gap-1 min-w-0">
      <span
        className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[10px] font-medium border ${meta.cls} min-w-0`}
        title={task.state === 'failed' && task.error ? task.error : `任务 ${task.taskId} · 分支 ${task.workBranch}`}
      >
        <MonitorSmartphone className="h-3 w-3 shrink-0" />
        <span className="truncate">{meta.label}</span>
        {task.state === 'done' && task.prUrl && (
          <a
            href={task.prUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="underline shrink-0"
            onClick={(e) => e.stopPropagation()}
          >
            PR
          </a>
        )}
      </span>
      {retryable && (
        <span
          className="inline-flex items-center px-1.5 py-0.5 rounded-md text-[10px] font-medium border shrink-0 bg-amber-50 text-amber-700 border-amber-200"
          title={RUNNER_RETRYABLE_HINT}
        >
          {RUNNER_RETRYABLE_LABEL}
        </span>
      )}
    </span>
  );
}

function OssOpportunityCard({
  opp,
  task,
  onDispatch,
}: {
  opp: OssOpportunity;
  /** 该机会最近一次派发任务(按 Issue 链接匹配;无则不显示徽章) */
  task?: RunnerTaskSummary | null;
  /** 打开派发弹窗;不可派发(项目名/链接不合规)时不传,卡片回到纯只读 */
  onDispatch?: () => void;
}) {
  const [copyState, setCopyState] = useState<'idle' | 'ok' | 'fail'>('idle');
  const handoff = useMemo(() => handoffPackFor(opp), [opp]);

  const handleCopyAll = async () => {
    const ok = await copyToClipboard(buildOssOpportunityCopyText(opp));
    setCopyState(ok ? 'ok' : 'fail');
    setTimeout(() => setCopyState('idle'), 2000);
  };

  return (
    <div className="rounded-xl border border-zinc-200 bg-white overflow-hidden">
      {/* 卡头:机会编号 + 类型/难度徽章 + 复制整条 */}
      <div className="flex items-center justify-between gap-2 px-4 py-2.5 bg-zinc-50/70 border-b border-zinc-100">
        <span className="flex items-center gap-1.5 text-[11px] font-semibold text-zinc-700 min-w-0">
          <Radar className="h-3.5 w-3.5 text-sky-500 shrink-0" />
          <span className="truncate">机会 #{opp.number}</span>
          {opp.kind && (
            <span className="shrink-0 px-1.5 py-0.5 rounded-md bg-sky-50 text-sky-700 text-[10px] font-medium border border-sky-100">
              {opp.kind}
            </span>
          )}
          {opp.difficulty && (
            <span
              className={`shrink-0 px-1.5 py-0.5 rounded-md text-[10px] font-medium border ${difficultyClass(opp.difficulty)}`}
            >
              {opp.difficulty}
            </span>
          )}
        </span>
        <button
          type="button"
          onClick={handleCopyAll}
          className="shrink-0 flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-sky-600 hover:bg-sky-700 text-white text-[11px] font-medium transition shadow-xs"
        >
          {copyState === 'ok' ? (
            <>
              <Check className="h-3 w-3" />
              已复制整条
            </>
          ) : copyState === 'fail' ? (
            <span className="text-red-100">复制失败</span>
          ) : (
            <>
              <Copy className="h-3 w-3" />
              复制整条
            </>
          )}
        </button>
      </div>

      <div className="p-4 space-y-3">
        {/* 项目名(等宽) */}
        <div className="group flex items-start justify-between gap-2">
          <div className="min-w-0">
            <span className="text-[10px] font-medium text-zinc-400 uppercase tracking-wide">项目</span>
            <p className="text-sm font-semibold font-mono text-zinc-900 mt-0.5 break-all">{opp.project}</p>
          </div>
          <span className="opacity-0 group-hover:opacity-100 transition mt-3">
            <CopyButton text={opp.project} />
          </span>
        </div>

        {/* 简介 */}
        {opp.summary && <p className="text-xs text-zinc-600 leading-relaxed break-words">{opp.summary}</p>}

        {/* 直达链接:每行一条,新标签打开 + 单条复制 */}
        <div className="space-y-1">
          <span className="text-[10px] font-medium text-zinc-400 uppercase tracking-wide">直达链接</span>
          {opp.links.map((url) => (
            <div key={url} className="group flex items-center justify-between gap-2">
              <a
                href={url}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1 min-w-0 text-xs text-sky-700 hover:text-sky-900 hover:underline transition"
                title={url}
              >
                <ExternalLink className="h-3 w-3 shrink-0" />
                <span className="truncate">{url}</span>
              </a>
              <span className="opacity-0 group-hover:opacity-100 transition shrink-0">
                <CopyButton text={url} label="复制链接" />
              </span>
            </div>
          ))}
        </div>

        {/* 为什么适合你 */}
        {opp.fit && (
          <div className="px-2.5 py-2 rounded-lg bg-sky-50/60 border border-sky-100/70">
            <span className="text-[10px] font-medium text-sky-600 uppercase tracking-wide">为什么适合你</span>
            <p className="text-xs text-zinc-700 leading-relaxed mt-0.5 break-words">{opp.fit}</p>
          </div>
        )}

        {/* 建议第一步 */}
        {opp.firstStep && (
          <div className="flex items-start gap-1.5 px-2.5 py-2 rounded-lg bg-zinc-50 text-[11px] text-zinc-600 leading-relaxed">
            <span className="shrink-0">👉</span>
            <span className="break-words">{opp.firstStep}</span>
          </div>
        )}

        {/* 派发动作行:状态徽章 + 复制交接包(T0 降级)+ 派发到本地(M2) */}
        {(handoff || task) && (
          <div className="flex items-center justify-between gap-2 pt-2.5 border-t border-zinc-100">
            <div className="min-w-0">{task ? <TaskStateBadge task={task} /> : <span />}</div>
            <div className="flex items-center gap-1.5 shrink-0">
              {handoff && <CopyButton text={handoff} label="复制交接包" />}
              {handoff && onDispatch && (
                <button
                  type="button"
                  onClick={onDispatch}
                  className="flex items-center gap-1 px-2.5 py-1 rounded-lg border border-sky-200 bg-sky-50 text-sky-700 text-[11px] font-medium hover:bg-sky-100 transition"
                  title="任务入队,由你本地 runner 驱动 claude CLI 执行;push/PR 走云端审批"
                >
                  <Send className="h-3 w-3" />
                  派发到本地
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/** 机会列表:多卡垂直堆叠 + 派发弹窗 + 任务状态回流 + 尾部「其他输出内容」折叠 */
export function OssOpportunityList({
  result,
  missionId,
}: {
  result: OssOpportunityParseResult;
  /** 派发时所处的会话 id:随任务包入队,设备任务 ↔ 会话互跳的关联键 */
  missionId?: string;
}) {
  const [showFallback, setShowFallback] = useState(false);
  const [tasks, setTasks] = useState<RunnerTaskSummary[]>([]);
  const [dispatchOpp, setDispatchOpp] = useState<OssOpportunity | null>(null);

  const refreshTasks = useCallback(async () => {
    try {
      const r = await fetch('/api/runner/tasks/mine');
      const j = await r.json();
      if (j?.success && Array.isArray(j.tasks)) setTasks(j.tasks as RunnerTaskSummary[]);
    } catch {
      /* 状态徽章是增强信息,拉取失败不打扰工坊主流程 */
    }
  }, []);

  useEffect(() => {
    refreshTasks();
    const timer = setInterval(refreshTasks, 15000); // 客户端轮询(与 DevicesView 同款,无常驻服务)
    return () => clearInterval(timer);
  }, [refreshTasks]);

  // tasks 新→旧排序(runner-bridge 保证),find 即取该 Issue 最近一次派发
  const taskFor = (opp: OssOpportunity): RunnerTaskSummary | null => {
    const url = pickIssueUrl(opp.links);
    return url ? (tasks.find((t) => t.issueUrl === url) ?? null) : null;
  };

  return (
    <div className="space-y-3">
      {result.opportunities.map((opp) => (
        <OssOpportunityCard
          key={`${opp.number}-${opp.project}`}
          opp={opp}
          task={taskFor(opp)}
          onDispatch={() => setDispatchOpp(opp)}
        />
      ))}
      <p className="text-[10px] text-zinc-400 leading-relaxed">
        想贡献哪条:「派发到本地」交给你自己的 runner + claude CLI 干 Phase 1(只修 Issue、禁
        push/禁网),push/PR 走云端审批;「复制交接包」随时可人工接管——发送前逐条经你审批,发布永远人工。
      </p>
      {dispatchOpp && (
        <DispatchRunnerModal
          opp={dispatchOpp}
          missionId={missionId}
          onClose={() => setDispatchOpp(null)}
          onDispatched={() => {
            setDispatchOpp(null);
            refreshTasks();
          }}
        />
      )}
      {result.fallback && (
        <div className="rounded-xl border border-zinc-200 overflow-hidden">
          <button
            type="button"
            onClick={() => setShowFallback((v) => !v)}
            className="w-full flex items-center justify-between px-4 py-2 text-[11px] font-medium text-zinc-500 hover:text-zinc-700 hover:bg-zinc-50 transition"
          >
            <span>其他输出内容(检索时间 / 数据源说明)</span>
            <ChevronDown className={`h-3.5 w-3.5 transition ${showFallback ? 'rotate-180' : ''}`} />
          </button>
          {showFallback && (
            <pre className="px-4 pb-3 text-[10px] leading-relaxed text-zinc-500 whitespace-pre-wrap break-words max-h-48 overflow-y-auto">
              {result.fallback}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
