'use client';

import React, { useMemo, useRef, useState } from 'react';
import { ArrowUp, Loader2, Square, ChevronRight, CheckCircle2, AlertCircle, Hourglass, ShieldQuestion } from 'lucide-react';
import { Mission } from '../../types/agent';

interface MobileHomeViewProps {
  missions: Mission[];
  isSubmitting: boolean;
  userName?: string | null;
  isLoggedIn: boolean;
  approvalCount: number;
  onRunMission: (text: string, title?: string) => void;
  onStopMission: (missionId: string) => void;
  /** 点击任务 → 跳到"动态"tab 查看该任务时间线 */
  onOpenMission: (missionId: string) => void;
  onOpenApprovals: () => void;
  onRequireLogin: () => void;
}

const STATUS_META: Record<
  Mission['status'],
  { label: string; icon: React.ComponentType<{ className?: string }>; className: string }
> = {
  ACTIVE: { label: '执行中', icon: Loader2, className: 'text-blue-600 bg-blue-50' },
  QUEUED: { label: '排队中', icon: Hourglass, className: 'text-amber-600 bg-amber-50' },
  WAITING_APPROVAL: { label: '待审批', icon: ShieldQuestion, className: 'text-orange-600 bg-orange-50' },
  DONE: { label: '已完成', icon: CheckCircle2, className: 'text-emerald-600 bg-emerald-50' },
  INTERRUPTED: { label: '已中断', icon: AlertCircle, className: 'text-amber-600 bg-amber-50' },
};

function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  const min = Math.floor(diff / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour} 小时前`;
  const day = Math.floor(hour / 24);
  return `${day} 天前`;
}

/**
 * 移动端首页 —— "遥控器"。
 * 布局自上而下：问候语 → 下任务输入框 → 审批横幅 → 进行中任务 → 最近完成。
 * 不含桌面版的营销区/连接器矩阵/目标看板，那些收进"我的"或留在 Web。
 */
export function MobileHomeView({
  missions,
  isSubmitting,
  userName,
  isLoggedIn,
  approvalCount,
  onRunMission,
  onStopMission,
  onOpenMission,
  onOpenApprovals,
  onRequireLogin,
}: MobileHomeViewProps) {
  const [draft, setDraft] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const ongoing = useMemo(
    () => missions.filter((m) => m.status === 'ACTIVE' || m.status === 'QUEUED' || m.status === 'WAITING_APPROVAL'),
    [missions]
  );
  const recentDone = useMemo(
    () => missions.filter((m) => m.status === 'DONE').slice(0, 8),
    [missions]
  );

  const submit = () => {
    const text = draft.trim();
    if (!text || isSubmitting) return;
    if (!isLoggedIn) {
      onRequireLogin();
      return;
    }
    onRunMission(text);
    setDraft('');
    if (textareaRef.current) textareaRef.current.style.height = 'auto';
  };

  const greeting = useMemo(() => {
    const h = new Date().getHours();
    if (h < 6) return '夜深了';
    if (h < 12) return '早上好';
    if (h < 14) return '中午好';
    if (h < 18) return '下午好';
    return '晚上好';
  }, []);

  return (
    <div className="px-4 pt-4 pb-28 max-w-lg mx-auto">
      {/* 问候 */}
      <header className="mb-4">
        <h1 className="text-2xl font-bold text-zinc-900 tracking-tight">
          {greeting}
          {userName ? `，${userName}` : ''}
        </h1>
        <p className="text-sm text-zinc-400 mt-1">交给你的智能体去办，手机可以放下。</p>
      </header>

      {/* 下任务输入框 */}
      <div className="rounded-2xl border border-zinc-200 bg-white shadow-sm focus-within:border-zinc-300 focus-within:ring-2 focus-within:ring-zinc-100 transition">
        <textarea
          ref={textareaRef}
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            e.target.style.height = 'auto';
            e.target.style.height = `${Math.min(e.target.scrollHeight, 140)}px`;
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              submit();
            }
          }}
          rows={1}
          placeholder="一句话派个任务，如：帮我调研下周末北京适合遛娃的地方"
          className="w-full resize-none bg-transparent px-4 pt-3.5 pb-2 text-[15px] leading-6 text-zinc-900 placeholder:text-zinc-400 focus:outline-none"
        />
        <div className="flex items-center justify-between px-3 pb-3">
          <span className="text-[11px] text-zinc-300 pl-1">Enter 发送 · Shift+Enter 换行</span>
          <button
            type="button"
            onClick={submit}
            disabled={!draft.trim() || isSubmitting}
            className={`h-9 w-9 rounded-full flex items-center justify-center transition ${
              draft.trim() && !isSubmitting
                ? 'bg-zinc-900 text-white active:scale-95'
                : 'bg-zinc-100 text-zinc-300'
            }`}
            aria-label="发送任务"
          >
            {isSubmitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowUp className="h-4 w-4" />}
          </button>
        </div>
      </div>

      {/* 待审批横幅 */}
      {approvalCount > 0 && (
        <button
          type="button"
          onClick={onOpenApprovals}
          className="mt-4 w-full flex items-center gap-3 rounded-xl border border-orange-200 bg-orange-50 px-4 py-3 text-left active:bg-orange-100 transition"
        >
          <AlertCircle className="h-5 w-5 text-orange-500 shrink-0" />
          <span className="flex-1 text-sm text-orange-800">
            有 <b>{approvalCount}</b> 个动作等你批准
          </span>
          <ChevronRight className="h-4 w-4 text-orange-400" />
        </button>
      )}

      {/* 进行中 */}
      <section className="mt-6">
        <h2 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-2 px-1">进行中</h2>
        {ongoing.length === 0 ? (
          <div className="rounded-xl border border-dashed border-zinc-200 bg-white/50 px-4 py-8 text-center">
            <p className="text-sm text-zinc-400">暂无执行中的任务</p>
            <p className="text-xs text-zinc-300 mt-1">上面输入一句话，Agent 就会开工</p>
          </div>
        ) : (
          <ul className="space-y-2.5">
            {ongoing.map((m) => {
              const meta = STATUS_META[m.status];
              const Icon = meta.icon;
              const currentStep = [...(m.steps || [])].reverse().find((s) => s.status === 'RUNNING') || (m.steps || [])[m.steps.length - 1];
              return (
                <li key={m.id}>
                  <div
                    role="button"
                    tabIndex={0}
                    onClick={() => onOpenMission(m.id)}
                    onKeyDown={(e) => e.key === 'Enter' && onOpenMission(m.id)}
                    className="rounded-xl border border-zinc-200 bg-white px-4 py-3.5 shadow-sm active:bg-zinc-50 transition cursor-pointer"
                  >
                    <div className="flex items-center gap-2.5">
                      <span className={`h-7 w-7 rounded-lg flex items-center justify-center shrink-0 ${meta.className}`}>
                        <Icon className={`h-4 w-4 ${m.status === 'ACTIVE' ? 'animate-spin' : ''}`} />
                      </span>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-zinc-900 truncate">{m.title || '未命名任务'}</p>
                        <p className="text-xs text-zinc-400 truncate mt-0.5">
                          {currentStep ? currentStep.title : meta.label} · {timeAgo(m.startedAt)}
                        </p>
                      </div>
                      <ChevronRight className="h-4 w-4 text-zinc-300 shrink-0" />
                    </div>
                    {/* 进度条 */}
                    <div className="mt-3 h-1 rounded-full bg-zinc-100 overflow-hidden">
                      <div
                        className={`h-full rounded-full transition-all duration-500 ${
                          m.status === 'WAITING_APPROVAL' ? 'bg-orange-400' : 'bg-blue-600'
                        }`}
                        style={{ width: `${Math.max(4, Math.min(100, m.progress || 0))}%` }}
                      />
                    </div>
                    {m.status === 'ACTIVE' && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          onStopMission(m.id);
                        }}
                        className="mt-2.5 flex items-center gap-1 text-[11px] text-zinc-400 active:text-red-500 transition"
                      >
                        <Square className="h-3 w-3" /> 停止任务
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* 最近完成 */}
      {recentDone.length > 0 && (
        <section className="mt-6">
          <h2 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-2 px-1">最近完成</h2>
          <ul className="rounded-xl border border-zinc-200 bg-white divide-y divide-zinc-100 overflow-hidden">
            {recentDone.map((m) => (
              <li key={m.id}>
                <button
                  type="button"
                  onClick={() => onOpenMission(m.id)}
                  className="w-full flex items-center gap-3 px-4 py-3 text-left active:bg-zinc-50 transition"
                >
                  <CheckCircle2 className="h-4 w-4 text-emerald-500 shrink-0" />
                  <span className="flex-1 text-sm text-zinc-700 truncate">{m.title || '未命名任务'}</span>
                  <span className="text-xs text-zinc-300 shrink-0">{timeAgo(m.startedAt)}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
