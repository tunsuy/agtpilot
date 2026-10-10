'use client';

/**
 * 工坊 · 场景化任务模版中心(从连接器页拆出的一级模块)
 *
 * 连接器页管「配了什么凭证」,工坊页管「用它们完成什么事」:
 * - 按用户场景分组的内容/办公/投研/教研工坊卡片;
 * - 每张卡片实时展示依赖数据源的连接状态(缺必需依赖时给配置入口);
 * - 本地历史支撑「上次参数回填 + 一键重跑」(周报/复盘等周期性场景);
 * - 表单提交/重跑 → buildWorkshopRun 生成结构化 Prompt → onRunPrompt 交给 Agent。
 */
import React, { useEffect, useMemo, useState } from 'react';
import { Sparkles, Play, Clock, ArrowRight } from 'lucide-react';
import { ConnectorApp, McpConnectorInfo } from '../../types/agent';
import { WORKSHOPS, WORKSHOP_CATEGORIES, getWorkshop, type WorkshopDef, type WorkshopId } from './registry';
import { buildWorkshopRun } from './run';
import { recordRun, recentRuns, relativeTime, type WorkshopRunRecord } from './history';
import { ACCENTS } from './forms/shared';
import { ContentWorkshopForm } from './forms/ContentWorkshopForm';
import { EmailTriageForm } from './forms/EmailTriageForm';
import { WeeklyReportForm } from './forms/WeeklyReportForm';
import { InvestWorkshopForm } from './forms/InvestWorkshopForm';
import { EduWorkshopForm } from './forms/EduWorkshopForm';

interface WorkshopsViewProps {
  connectors: ConnectorApp[];
  /** 表单/重跑产出的结构化 Prompt,作为新任务交给 Agent 并跳转任务页 */
  onRunPrompt: (prompt: string, title?: string) => void | Promise<void>;
  /** 缺必需依赖时跳连接器页配置 */
  onOpenConnectors: () => void;
  /** 从连接器页「工坊直达」跳转时自动打开对应工坊表单 */
  autoOpenId?: string | null;
  onAutoOpenHandled?: () => void;
}

/** id → 表单组件;新增工坊在此登记 */
const FORMS: Record<WorkshopId, React.ComponentType<{ workshop: WorkshopDef; onRun: WorkshopsViewProps['onRunPrompt']; onClose: () => void }>> = {
  xhs: ContentWorkshopForm,
  weibo: ContentWorkshopForm,
  video_douyin: ContentWorkshopForm,
  video_bilibili: ContentWorkshopForm,
  email_triage: EmailTriageForm,
  weekly: WeeklyReportForm,
  invest: InvestWorkshopForm,
  edu: EduWorkshopForm,
};

export function WorkshopsView({
  connectors,
  onRunPrompt,
  onOpenConnectors,
  autoOpenId,
  onAutoOpenHandled,
}: WorkshopsViewProps) {
  const [activeId, setActiveId] = useState<WorkshopId | null>(null);
  const [history, setHistory] = useState<WorkshopRunRecord[]>([]);

  // MCP 连接器状态:数据源状态点需要(与 ConnectorsView 同源 /api/connectors/mcp)
  const [mcpConnectors, setMcpConnectors] = useState<McpConnectorInfo[]>([]);
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch('/api/connectors/mcp');
        const data = await res.json();
        if (data.success) setMcpConnectors(data.connectors || []);
      } catch {
        // 未登录/后端未就绪时静默
      }
    })();
  }, []);

  useEffect(() => {
    // 拉全量历史(按工坊去重、至多 20 条):最近使用条目取前 3,卡片「上次使用」逐卡查找
    setHistory(recentRuns(20));
  }, []);

  // 从连接器页「工坊直达」跳转:自动打开对应工坊表单
  useEffect(() => {
    if (!autoOpenId) return;
    const def = getWorkshop(autoOpenId);
    if (def) {
      setActiveId(def.id);
      onAutoOpenHandled?.();
    }
  }, [autoOpenId]);

  const isConnected = (depId: string) =>
    connectors.some((c) => c.id === depId && c.status === 'connected') ||
    mcpConnectors.some((c) => c.id === depId && c.status === 'connected');

  const activeWorkshop = activeId ? getWorkshop(activeId) : null;
  const ActiveForm = activeId ? FORMS[activeId] : null;

  const handleRerun = (record: WorkshopRunRecord) => {
    const def = getWorkshop(record.id);
    if (!def) return;
    const run = buildWorkshopRun(def.id, record.params);
    recordRun(def.id, run.title, record.params);
    setHistory(recentRuns(20));
    onRunPrompt(run.prompt, run.title);
  };

  const rerunnable = useMemo(
    () => history.filter((r) => getWorkshop(r.id)).slice(0, 3),
    [history]
  );

  return (
    <div className="w-full max-w-5xl mx-auto px-4 py-8 md:py-12 space-y-8 animate-fadeIn">
      {/* Header */}
      <div>
        <div className="flex items-center gap-2.5">
          <div className="p-1.5 rounded-xl bg-violet-50 text-violet-600 border border-violet-200/60 shadow-2xs">
            <Sparkles className="h-5 w-5" />
          </div>
          <h1 className="text-2xl font-semibold tracking-tight text-zinc-900">工坊</h1>
        </div>
        <p className="text-xs text-zinc-500 mt-1 max-w-xl leading-relaxed">
          高频场景一键成任务:Agent 按你的选项取材、创作、汇总,关键动作发布/发送前都经你确认。
        </p>
      </div>

      {/* 最近使用:一键重跑(周报/复盘等周期性场景) */}
      {rerunnable.length > 0 && (
        <div className="space-y-3">
          <div className="flex items-center gap-1.5 text-xs font-medium text-zinc-400">
            <Clock className="h-3.5 w-3.5" />
            <span>最近使用 · 沿用上次参数重跑</span>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            {rerunnable.map((r) => {
              const def = getWorkshop(r.id)!;
              return (
                <button
                  key={r.id}
                  type="button"
                  onClick={() => handleRerun(r)}
                  className="group flex items-center justify-between gap-3 p-3 rounded-xl border border-zinc-200 bg-white hover:border-zinc-300 hover:shadow-xs transition text-left"
                  title={`用上次的参数重跑:${r.title}`}
                >
                  <div className="min-w-0">
                    <div className="text-xs font-semibold text-zinc-800 truncate">{r.title}</div>
                    <div className="text-[10px] text-zinc-400 mt-0.5">{relativeTime(r.at)}</div>
                  </div>
                  <span className="flex shrink-0 items-center gap-1 px-2.5 py-1 rounded-lg text-[11px] font-medium bg-zinc-100 text-zinc-600 group-hover:bg-zinc-900 group-hover:text-white transition">
                    <Play className="h-3 w-3" />
                    <span>重跑</span>
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* 工坊卡片:按场景分组 */}
      {WORKSHOP_CATEGORIES.map((cat) => {
        const items = WORKSHOPS.filter((w) => w.category === cat.key);
        if (items.length === 0) return null;
        return (
          <div key={cat.key} className="space-y-3">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-zinc-400">
              {cat.label}
            </h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {items.map((w) => {
                const Icon = w.icon;
                const accent = ACCENTS[w.accent];
                const missingRequired = w.deps.filter((d) => d.required && !isConnected(d.id));
                return (
                  <div
                    key={w.id}
                    className="p-5 rounded-2xl border border-zinc-200 bg-white hover:border-zinc-300 hover:shadow-xs transition flex flex-col justify-between"
                  >
                    <div className="space-y-3">
                      <div className="flex items-start justify-between gap-3">
                        <div className="flex items-center gap-3">
                          <div className={`h-10 w-10 rounded-xl flex items-center justify-center shadow-2xs ${accent.iconBg}`}>
                            <Icon className="h-5 w-5" />
                          </div>
                          <h3 className="text-xs font-semibold text-zinc-900">{w.name}</h3>
                        </div>
                      </div>
                      <p className="text-xs text-zinc-500 leading-relaxed">{w.desc}</p>

                      {/* 依赖数据源状态:绿点已连接/灰点未配;必需缺失给配置入口 */}
                      {w.deps.length > 0 && (
                        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                          {w.deps.map((d) => (
                            <span
                              key={d.id}
                              className="flex items-center gap-1 text-[10px] text-zinc-500"
                              title={isConnected(d.id) ? `${d.name} 已连接` : `${d.name} 未连接`}
                            >
                              <span
                                className={`h-1.5 w-1.5 rounded-full ${
                                  isConnected(d.id) ? 'bg-emerald-500' : 'bg-zinc-300'
                                }`}
                              />
                              <span>{d.name}</span>
                            </span>
                          ))}
                        </div>
                      )}

                      {missingRequired.length > 0 && (
                        <button
                          type="button"
                          onClick={onOpenConnectors}
                          className="flex items-center gap-1.5 text-[11px] font-medium text-amber-700 hover:text-amber-800 transition"
                        >
                          <span>
                            需先配置{missingRequired.map((d) => d.name).join('、')}——去连接器页配置
                          </span>
                          <ArrowRight className="h-3 w-3" />
                        </button>
                      )}
                    </div>

                    <div className="pt-3 mt-1 border-t border-zinc-100 flex items-center justify-between">
                      <span className="text-[10px] font-mono text-zinc-400">
                        {(() => {
                          const last = history.find((h) => h.id === w.id);
                          return last ? `上次 ${relativeTime(last.at)}` : '尚未使用';
                        })()}
                      </span>
                      <button
                        type="button"
                        onClick={() => setActiveId(w.id)}
                        className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-white text-xs font-medium transition shadow-xs ${accent.btn}`}
                      >
                        <Sparkles className="h-3 w-3" />
                        <span>开始</span>
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}

      {/* 工坊表单弹窗 */}
      {activeWorkshop && ActiveForm && (
        <ActiveForm
          key={activeWorkshop.id}
          workshop={activeWorkshop}
          onRun={(prompt, title) => onRunPrompt(prompt, title)}
          onClose={() => setActiveId(null)}
        />
      )}
    </div>
  );
}
