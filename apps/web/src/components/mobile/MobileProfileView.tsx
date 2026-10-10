'use client';

import React, { useEffect, useMemo, useState } from 'react';
import {
  User as UserIcon,
  LogOut,
  Target,
  Clock,
  Plug,
  Brain,
  ChevronRight,
  Play,
  Monitor,
  LogIn,
  Bell,
  BellOff,
  Smartphone,
  Sparkles,
} from 'lucide-react';
import { ConnectorApp, CronJobItem, GoalItem } from '../../types/agent';
import { detectPushSupport, enablePush, disablePush, getPushStatus, PushSupport, PushStatus } from '../../utils/pwaPush';

interface MobileProfileViewProps {
  userName?: string | null;
  userEmail?: string | null;
  userAvatar?: string | null;
  isLoggedIn: boolean;
  goals: GoalItem[];
  cronJobs: CronJobItem[];
  connectors: ConnectorApp[];
  memoryCount: number;
  onToggleCronJob: (id: string) => void;
  onTriggerCronJob: (id: string) => void;
  /** 打开桌面版功能页（移动端以全屏覆盖层呈现，带返回） */
  onOpenFullView: (view: 'goals' | 'connectors' | 'memories' | 'patrol' | 'workshops') => void;
  onOpenAuth: (tab: 'login' | 'register') => void;
  onLogout: () => void;
}

/**
 * 移动端"我的" —— 轻管理。
 * 原则：只读 + 开关，不做复杂编辑；重配置项引导去 Web 版。
 */
export function MobileProfileView({
  userName,
  userEmail,
  userAvatar,
  isLoggedIn,
  goals,
  cronJobs,
  connectors,
  memoryCount,
  onToggleCronJob,
  onTriggerCronJob,
  onOpenFullView,
  onOpenAuth,
  onLogout,
}: MobileProfileViewProps) {
  const activeGoals = useMemo(() => goals.filter((g) => g.status === 'active').slice(0, 3), [goals]);
  const activeJobs = useMemo(() => cronJobs.filter((j) => j.status !== 'cancelled').slice(0, 5), [cronJobs]);
  const nativeConnected = connectors.filter((c) => c.status === 'connected').length;
  // MCP 连接器是另一套接口（/api/connectors/mcp），原生列表里看不到，
  // 这里单独拉一次做合并计数，否则网页配了 MCP、手机“我的”页仍显示 0/N。
  const [mcpConnected, setMcpConnected] = useState(0);
  const [mcpTotal, setMcpTotal] = useState(0);
  useEffect(() => {
    if (!isLoggedIn) {
      setMcpConnected(0);
      setMcpTotal(0);
      return;
    }
    fetch('/api/connectors/mcp')
      .then((r) => r.json())
      .then((d) => {
        if (Array.isArray(d.connectors)) {
          setMcpConnected(d.connectors.filter((c: any) => c.status === 'connected').length);
          setMcpTotal(d.connectors.length);
        }
      })
      .catch(() => {});
  }, [isLoggedIn, connectors.length]);
  const connectedCount = nativeConnected + mcpConnected;
  const totalCount = connectors.length + mcpTotal;

  // ---- Web Push 通知状态（客户端自治） ----
  const [pushSupport, setPushSupport] = useState<PushSupport>('unsupported');
  const [pushStatus, setPushStatus] = useState<PushStatus | null>(null);
  const [pushBusy, setPushBusy] = useState(false);

  useEffect(() => {
    const support = detectPushSupport();
    setPushSupport(support);
    if (support !== 'unsupported') {
      getPushStatus().then(setPushStatus).catch(() => {});
    }
  }, []);

  const handleTogglePush = async () => {
    if (pushBusy) return;
    if (!isLoggedIn) {
      onOpenAuth('login');
      return;
    }
    setPushBusy(true);
    try {
      if (pushStatus?.subscribed) {
        setPushStatus(await disablePush());
      } else {
        setPushStatus(await enablePush());
      }
    } finally {
      setPushBusy(false);
    }
  };

  return (
    <div className="px-4 pt-4 pb-28 max-w-lg mx-auto">
      <header className="mb-4 text-center">
        <h1 className="text-2xl font-bold text-zinc-900 tracking-tight">我的</h1>
      </header>

      {/* 账户卡片 */}
      <div className="rounded-2xl border border-zinc-200 bg-white px-4 py-4 shadow-sm flex items-center gap-3.5">
        {userAvatar ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={userAvatar} alt="" className="h-12 w-12 rounded-full object-cover" />
        ) : (
          <span className="h-12 w-12 rounded-full bg-zinc-100 flex items-center justify-center">
            <UserIcon className="h-6 w-6 text-zinc-400" />
          </span>
        )}
        <div className="flex-1 min-w-0">
          {isLoggedIn ? (
            <>
              <p className="text-sm font-semibold text-zinc-900 truncate">{userName || '已登录用户'}</p>
              <p className="text-xs text-zinc-400 truncate mt-0.5">{userEmail || ''}</p>
            </>
          ) : (
            <>
              <p className="text-sm font-semibold text-zinc-900">未登录</p>
              <p className="text-xs text-zinc-400 mt-0.5">登录后可下发任务、同步目标</p>
            </>
          )}
        </div>
        {isLoggedIn ? (
          <button
            type="button"
            onClick={onLogout}
            className="h-9 px-3 rounded-lg border border-zinc-200 text-xs text-zinc-500 flex items-center gap-1.5 active:bg-zinc-50 transition shrink-0"
          >
            <LogOut className="h-3.5 w-3.5" /> 退出
          </button>
        ) : (
          <button
            type="button"
            onClick={() => onOpenAuth('login')}
            className="h-9 px-4 rounded-lg bg-zinc-900 text-xs font-medium text-white flex items-center gap-1.5 active:bg-zinc-700 transition shrink-0"
          >
            <LogIn className="h-3.5 w-3.5" /> 登录
          </button>
        )}
      </div>

      {/* 目标进度（只读摘要） */}
      <section className="mt-5">
        <div className="flex items-center justify-between mb-2 px-1">
          <h2 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">进行中的目标</h2>
          <button
            type="button"
            onClick={() => onOpenFullView('goals')}
            className="text-[11px] text-zinc-400 flex items-center active:text-zinc-600 transition"
          >
            全部 {goals.length} <ChevronRight className="h-3 w-3" />
          </button>
        </div>
        {activeGoals.length === 0 ? (
          <div className="rounded-xl border border-dashed border-zinc-200 bg-white/50 px-4 py-5 text-center text-xs text-zinc-400">
            暂无进行中目标，去 Web 版创建
          </div>
        ) : (
          <ul className="space-y-2">
            {activeGoals.map((g) => (
              <li key={g.id} className="rounded-xl border border-zinc-200 bg-white px-4 py-3 shadow-sm">
                <div className="flex items-center gap-2">
                  <Target className="h-4 w-4 text-zinc-400 shrink-0" />
                  <p className="flex-1 text-sm text-zinc-800 truncate">{g.title}</p>
                  <span className="text-[11px] text-zinc-400 shrink-0">{Math.round(g.progress || 0)}%</span>
                </div>
                <div className="mt-2 h-1 rounded-full bg-zinc-100 overflow-hidden">
                  <div className="h-full rounded-full bg-emerald-500 transition-all" style={{ width: `${Math.max(3, Math.min(100, g.progress || 0))}%` }} />
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* 定时巡航开关 */}
      <section className="mt-5">
        <div className="flex items-center justify-between mb-2 px-1">
          <h2 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">定时巡航</h2>
          <button
            type="button"
            onClick={() => onOpenFullView('patrol')}
            className="text-[11px] text-zinc-400 flex items-center active:text-zinc-600 transition"
          >
            管理 <ChevronRight className="h-3 w-3" />
          </button>
        </div>
        {activeJobs.length === 0 ? (
          <div className="rounded-xl border border-dashed border-zinc-200 bg-white/50 px-4 py-5 text-center text-xs text-zinc-400">
            暂无定时任务
          </div>
        ) : (
          <ul className="rounded-xl border border-zinc-200 bg-white divide-y divide-zinc-100 overflow-hidden shadow-sm">
            {activeJobs.map((job) => (
              <li key={job.id} className="flex items-center gap-3 px-4 py-3">
                <Clock className="h-4 w-4 text-zinc-400 shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-zinc-800 truncate">{job.name}</p>
                  <p className="text-[11px] text-zinc-400 mt-0.5">
                    {job.pattern} · 已跑 {job.runCount} 次
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => onTriggerCronJob(job.id)}
                  className="h-7 w-7 rounded-md border border-zinc-200 flex items-center justify-center text-zinc-400 active:text-zinc-700 active:bg-zinc-50 transition shrink-0"
                  aria-label={`立即执行 ${job.name}`}
                >
                  <Play className="h-3 w-3" />
                </button>
                {/* 开关 */}
                <button
                  type="button"
                  role="switch"
                  aria-checked={job.status === 'active'}
                  onClick={() => onToggleCronJob(job.id)}
                  className={`relative h-6 w-11 rounded-full transition-colors shrink-0 ${
                    job.status === 'active' ? 'bg-emerald-500' : 'bg-zinc-200'
                  }`}
                >
                  <span
                    className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all ${
                      job.status === 'active' ? 'left-[22px]' : 'left-0.5'
                    }`}
                  />
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* 消息通知（Web Push） */}
      <section className="mt-5">
        <h2 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-2 px-1">消息通知</h2>
        <div className="rounded-xl border border-zinc-200 bg-white px-4 py-3.5 shadow-sm">
          <div className="flex items-center gap-3">
            {pushStatus?.subscribed ? (
              <Bell className="h-4 w-4 text-emerald-500 shrink-0" />
            ) : (
              <BellOff className="h-4 w-4 text-zinc-400 shrink-0" />
            )}
            <div className="flex-1 min-w-0">
              <p className="text-sm text-zinc-800">任务完成 / 待审批推送</p>
              <p className="text-[11px] text-zinc-400 mt-0.5">
                {pushSupport === 'need-install'
                  ? 'iPhone 需先"添加到主屏幕"，从主屏幕图标打开后才能收推送'
                  : pushSupport === 'unsupported'
                  ? '当前浏览器不支持 Web 推送'
                  : pushStatus?.subscribed
                  ? '已开启，锁屏与通知中心都会收到'
                  : pushStatus?.permission === 'denied'
                  ? '通知权限被拒绝，请在系统设置中允许'
                  : '未开启'}
              </p>
            </div>
            {pushSupport !== 'unsupported' && pushSupport !== 'need-install' && (
              <button
                type="button"
                role="switch"
                aria-checked={Boolean(pushStatus?.subscribed)}
                disabled={pushBusy}
                onClick={handleTogglePush}
                className={`relative h-6 w-11 rounded-full transition-colors shrink-0 disabled:opacity-50 ${
                  pushStatus?.subscribed ? 'bg-emerald-500' : 'bg-zinc-200'
                }`}
              >
                <span
                  className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all ${
                    pushStatus?.subscribed ? 'left-[22px]' : 'left-0.5'
                  }`}
                />
              </button>
            )}
            {pushSupport === 'need-install' && (
              <Smartphone className="h-4 w-4 text-zinc-300 shrink-0" />
            )}
          </div>
        </div>
      </section>

      {/* 桌面版功能入口（只读/引导去 Web） */}
      <section className="mt-5">
        <h2 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-2 px-1">更多</h2>
        <ul className="rounded-xl border border-zinc-200 bg-white divide-y divide-zinc-100 overflow-hidden shadow-sm">
          <li>
            <button type="button" onClick={() => onOpenFullView('workshops')} className="w-full flex items-center gap-3 px-4 py-3.5 text-left active:bg-zinc-50 transition">
              <Sparkles className="h-4 w-4 text-zinc-400" />
              <span className="flex-1 text-sm text-zinc-800">工坊</span>
              <span className="text-xs text-zinc-400">场景任务一键发起</span>
              <ChevronRight className="h-4 w-4 text-zinc-300" />
            </button>
          </li>
          <li>
            <button type="button" onClick={() => onOpenFullView('connectors')} className="w-full flex items-center gap-3 px-4 py-3.5 text-left active:bg-zinc-50 transition">
              <Plug className="h-4 w-4 text-zinc-400" />
              <span className="flex-1 text-sm text-zinc-800">连接器</span>
              <span className="text-xs text-zinc-400">{connectedCount}/{totalCount} 已连接</span>
              <ChevronRight className="h-4 w-4 text-zinc-300" />
            </button>
          </li>
          <li>
            <button type="button" onClick={() => onOpenFullView('memories')} className="w-full flex items-center gap-3 px-4 py-3.5 text-left active:bg-zinc-50 transition">
              <Brain className="h-4 w-4 text-zinc-400" />
              <span className="flex-1 text-sm text-zinc-800">记忆库</span>
              <span className="text-xs text-zinc-400">{memoryCount} 条</span>
              <ChevronRight className="h-4 w-4 text-zinc-300" />
            </button>
          </li>
        </ul>
        <p className="mt-2 px-1 text-[11px] text-zinc-300 flex items-center gap-1">
          <Monitor className="h-3 w-3" /> 复杂配置与驾驶舱调试建议在 Web 版操作
        </p>
      </section>
    </div>
  );
}
