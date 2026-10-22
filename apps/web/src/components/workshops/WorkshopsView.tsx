'use client';

/**
 * 工坊 · 场景化任务模版中心(从连接器页拆出的一级模块)
 *
 * 连接器页管「配了什么凭证」,工坊页管「用它们完成什么事」:
 * - 分类 Tab(全部/内容创作/办公提效/…)切换的工坊卡片网格;
 * - 每张卡片实时展示依赖数据源的连接状态(缺必需依赖时给配置入口);
 * - 本地历史支撑「上次参数回填 + 一键重跑」(周报/复盘等周期性场景);
 * - 表单提交/重跑 → buildWorkshopRun 生成结构化 Prompt → onRunPrompt 交给 Agent。
 */
import React, { useEffect, useMemo, useState } from 'react';
import dynamic from 'next/dynamic';
import { Sparkles, Play, Clock, ArrowRight, UserRoundPen, Gauge } from 'lucide-react';
import { ConnectorApp, McpConnectorInfo, Mission } from '../../types/agent';
import { loginBadgeInfo } from '../../lib/login-badge';
import type { XhsManagedRecord } from '../../lib/user-store';
import { WORKSHOPS, WORKSHOP_CATEGORIES, getWorkshop, type WorkshopDef, type WorkshopId } from './registry';
import { buildWorkshopRun, type WorkshopRunPayload } from './run';
import { recordRun, recentRuns, relativeTime, type WorkshopRunRecord } from './history';
import type { ScenarioProfile } from '../../lib/scenario-profile';
import { ScenarioProfileWizard } from './ScenarioProfileWizard';
import { WorkshopModelSettingPopover } from './WorkshopModelSettingPopover';
import { ACCENTS } from './forms/shared';

// 工坊表单按需加载：以前 14 个表单（连同各自的 skill.ts/prompt.md 提示词）
// 全部静态打进 WorkshopsView chunk，打开工坊页即下载所有工坊的提示词。
// 这里改为选中哪个工坊才拉哪个表单，工坊页首屏 chunk 大幅缩小。
const ContentWorkshopForm = dynamic(
  () => import('./forms/ContentWorkshopForm').then((m) => m.ContentWorkshopForm),
  { ssr: false }
);
const WechatMpWorkshopForm = dynamic(
  () => import('./forms/WechatMpWorkshopForm').then((m) => m.WechatMpWorkshopForm),
  { ssr: false }
);
const ZhihuWorkshopForm = dynamic(
  () => import('./forms/ZhihuWorkshopForm').then((m) => m.ZhihuWorkshopForm),
  { ssr: false }
);
const EmailTriageForm = dynamic(
  () => import('./forms/EmailTriageForm').then((m) => m.EmailTriageForm),
  { ssr: false }
);
const WeeklyReportForm = dynamic(
  () => import('./forms/WeeklyReportForm').then((m) => m.WeeklyReportForm),
  { ssr: false }
);
const PptWorkshopForm = dynamic(
  () => import('./forms/PptWorkshopForm').then((m) => m.PptWorkshopForm),
  { ssr: false }
);
const FollowBuildersForm = dynamic(
  () => import('./forms/FollowBuildersForm').then((m) => m.FollowBuildersForm),
  { ssr: false }
);
const InvestWorkshopForm = dynamic(
  () => import('./forms/InvestWorkshopForm').then((m) => m.InvestWorkshopForm),
  { ssr: false }
);
const EduWorkshopForm = dynamic(
  () => import('./forms/EduWorkshopForm').then((m) => m.EduWorkshopForm),
  { ssr: false }
);
const OssRadarForm = dynamic(
  () => import('./forms/OssRadarForm').then((m) => m.OssRadarForm),
  { ssr: false }
);
const NovelWorkshopForm = dynamic(
  () => import('./forms/NovelWorkshopForm').then((m) => m.NovelWorkshopForm),
  { ssr: false }
);

interface WorkshopsViewProps {
  connectors: ConnectorApp[];
  /** 表单/重跑产出的结构化 Prompt,作为新任务交给 Agent 并跳转任务页;带 workshop 载荷时服务端权威渲染 */
  onRunPrompt: (prompt: string, title?: string, workshop?: WorkshopRunPayload) => void | Promise<void>;
  /** 缺必需依赖时跳连接器页配置;带 depId 时连接器页自动搜索定位到对应卡片 */
  onOpenConnectors: (depId?: string) => void;
  /** 全量任务列表:小红书表单内嵌最近一次选题清单的可勾选卡片 */
  missions?: Mission[];
}

/** 表单组件统一 props:scenarioProfile/onEditProfile 仅有 profileSlot 的工坊使用;onOpenConnectors 供凭证在连接器页的工坊跳转配置 */
interface WorkshopFormProps {
  workshop: WorkshopDef;
  onRun: WorkshopsViewProps['onRunPrompt'];
  onClose: () => void;
  scenarioProfile?: ScenarioProfile | null;
  onEditProfile?: () => void;
  missions?: Mission[];
  onOpenConnectors?: () => void;
}

/** id → 表单组件;新增工坊在此登记 */
const FORMS: Record<WorkshopId, React.ComponentType<any>> = {
  xhs: ContentWorkshopForm,
  wechat_mp: WechatMpWorkshopForm,
  zhihu: ZhihuWorkshopForm,
  weibo: ContentWorkshopForm,
  novel: NovelWorkshopForm,
  video_douyin: ContentWorkshopForm,
  video_bilibili: ContentWorkshopForm,
  email_triage: EmailTriageForm,
  weekly: WeeklyReportForm,
  ppt: PptWorkshopForm,
  follow_builders: FollowBuildersForm,
  invest: InvestWorkshopForm,
  edu: EduWorkshopForm,
  oss_radar: OssRadarForm,
};

export function WorkshopsView({
  connectors,
  onRunPrompt,
  onOpenConnectors,
  missions,
}: WorkshopsViewProps) {
  const [activeId, setActiveId] = useState<WorkshopId | null>(null);
  const [history, setHistory] = useState<WorkshopRunRecord[]>([]);
  const [tab, setTab] = useState<string>('all');

  // 场景档案:null = 加载中(不阻塞开表单,当无档案);{} = 已加载但无档案(未登录/失败同样降级)
  const [scenarioProfiles, setScenarioProfiles] = useState<Record<string, ScenarioProfile> | null>(null);
  // 档案向导打开的槽位;与 activeId 互斥渲染(向导保存/跳过后才进表单)
  const [wizardKey, setWizardKey] = useState<string | null>(null);
  // 本会话内跳过过向导的槽位(不落盘,刷新后再给一次机会)
  const [wizardDismissed, setWizardDismissed] = useState<string[]>([]);

  // 工坊模型设置(workshopId → {reasoningEffort}):卡片右上角思考深度入口的
  // 数据源;null = 加载中(不阻塞,当未设置)。改档即时落 user-store,
  // 巡航触发/续聊下一轮现读生效
  const [modelSettings, setModelSettings] = useState<Record<string, { reasoningEffort?: 'low' | 'medium' | 'high' | 'none'; updatedAt: number }> | null>(null);
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch('/api/workshops/model-settings');
        const data = await res.json();
        if (data.success) setModelSettings(data.settings || {});
        else setModelSettings({});
      } catch {
        setModelSettings({});
      }
    })();
  }, []);

  /** 工坊思考深度改档:乐观更新本地,失败回滚并提示(不动连接器全局) */
  const setWorkshopEffort = async (workshopId: string, effort: string) => {
    const prev = modelSettings || {};
    const next: typeof prev = effort
      ? { ...prev, [workshopId]: { reasoningEffort: effort as 'low' | 'medium' | 'high' | 'none', updatedAt: Date.now() } }
      : Object.fromEntries(Object.entries(prev).filter(([k]) => k !== workshopId));
    setModelSettings(next);
    try {
      const res = await fetch('/api/workshops/model-settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'upsert', workshopId, reasoningEffort: effort }),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error || '保存失败');
      if (data.settings) setModelSettings(data.settings);
    } catch (e: any) {
      setModelSettings(prev);
      alert(`思考深度保存失败: ${e?.message || e}`);
    }
  };

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch('/api/scenario-profiles');
        const data = await res.json();
        if (data.success) setScenarioProfiles(data.profiles || {});
        else setScenarioProfiles({});
      } catch {
        setScenarioProfiles({});
      }
    })();
  }, []);

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

  // 番茄扫码登录态(与连接器页卡片同源 /api/fanqie-managed):小说工坊的番茄依赖
  // 点亮与否看这里,不看 MCP 态 —— 本地 MCP 已撤,MCP 侧永远连不上
  const [fanqieRecord, setFanqieRecord] = useState<XhsManagedRecord | null>(null);
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch('/api/fanqie-managed');
        if (res.status === 401) return; // 未登录静默
        const data = await res.json();
        if (data.success) setFanqieRecord(data.record || null);
      } catch {
        // 后端未就绪时静默
      }
    })();
  }, []);

  useEffect(() => {
    // 拉全量历史(按工坊去重、至多 20 条):最近使用条目取前 3,卡片「上次使用」逐卡查找
    setHistory(recentRuns(20));
  }, []);

  const isConnected = (depId: string) => {
    // 番茄:「已连接」语义 = 扫码登录(托管记录),与连接器页卡片徽标同源;
    // MCP 态恒未连接(servers 已清空),按 MCP 判会让已扫码用户看到死灰点
    if (depId === 'tomato_writer') {
      return loginBadgeInfo(fanqieRecord || undefined).loggedIn;
    }
    // 电子邮件(合并卡片):发信/收信任一已配即算连接(收信可复用发信凭证)
    if (depId === 'email') {
      return (
        connectors.some(
          (c) => (c.id === 'email_smtp' || c.id === 'email_imap') && c.status === 'connected'
        ) || mcpConnectors.some((c) => c.id === 'email' && c.status === 'connected')
      );
    }
    return (
      connectors.some((c) => c.id === depId && c.status === 'connected') ||
      mcpConnectors.some((c) => c.id === depId && c.status === 'connected')
    );
  };

  const activeWorkshop = activeId ? getWorkshop(activeId) : null;
  const ActiveForm = activeId ? FORMS[activeId] : null;
  const activeProfile = activeWorkshop?.profileSlot ? scenarioProfiles?.[activeWorkshop.profileSlot] : undefined;

  /** 重跑/表单共用:取当前档案(不用 localStorage 历史里的过期快照) */
  const profileCtx = (def: WorkshopDef) =>
    def.profileSlot && scenarioProfiles?.[def.profileSlot]
      ? { scenarioProfile: scenarioProfiles[def.profileSlot] }
      : undefined;

  const handleStart = (w: WorkshopDef) => {
    // 首次使用有档案槽位的工坊:先建档案(本会话跳过过则不再弹)
    if (
      w.profileSlot &&
      scenarioProfiles &&
      !scenarioProfiles[w.profileSlot] &&
      !wizardDismissed.includes(w.profileSlot)
    ) {
      setWizardKey(w.profileSlot);
      return;
    }
    setActiveId(w.id);
  };

  const handleRerun = (record: WorkshopRunRecord) => {
    const def = getWorkshop(record.id);
    if (!def) return;
    let run;
    try {
      run = buildWorkshopRun(def.id, record.params, profileCtx(def));
    } catch (err) {
      // 小说续写/体检需要书状态(客户端无快照时 run() 诚实抛错):
      // 带 workshop 载荷直接交给服务端权威渲染(loader 现读书库;bookId 失效会在服务端报错),
      // 客户端只沿用上次标题,不拿半截状态拼 prompt。
      if (record.id !== 'novel') throw err;
      recordRun(def.id, record.title, record.params);
      setHistory(recentRuns(20));
      onRunPrompt(`(服务端渲染:${record.title})`, record.title, { id: def.id, params: record.params });
      return;
    }
    recordRun(def.id, run.title, record.params);
    setHistory(recentRuns(20));
    onRunPrompt(run.prompt, run.title, { id: def.id, params: record.params });
  };

  const rerunnable = useMemo(
    () => history.filter((r) => getWorkshop(r.id)).slice(0, 3),
    [history]
  );

  // 当前 Tab 下的工坊:全部 或 某一分类
  const visibleWorkshops = useMemo(
    () => (tab === 'all' ? WORKSHOPS : WORKSHOPS.filter((w) => w.category === tab)),
    [tab]
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

      {/* 分类 Tab + 工坊卡片(单一网格,按 Tab 过滤) */}
      <div className="space-y-3">
        <div className="-mx-4 px-4 overflow-x-auto scrollbar-none">
          <div className="flex gap-2 w-max pb-1">
            {[{ key: 'all', label: '全部' }, ...WORKSHOP_CATEGORIES].map((t) => {
              const active = tab === t.key;
              return (
                <button
                  key={t.key}
                  type="button"
                  onClick={() => setTab(t.key)}
                  className={`h-8 px-3.5 rounded-full text-xs font-medium whitespace-nowrap transition border ${
                    active
                      ? 'bg-zinc-900 text-white border-zinc-900'
                      : 'bg-white text-zinc-500 border-zinc-200 hover:border-zinc-300 hover:text-zinc-700'
                  }`}
                >
                  {t.label}
                </button>
              );
            })}
          </div>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {visibleWorkshops.map((w) => {
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
                    {/* 思考深度:任务级(本工坊)> 连接器全局;巡航触发同源生效 */}
                    <WorkshopModelSettingPopover
                      workshop={w}
                      value={modelSettings?.[w.id]?.reasoningEffort}
                      onChange={(effort) => void setWorkshopEffort(w.id, effort)}
                    />
                  </div>
                  <p className="text-xs text-zinc-500 leading-relaxed">{w.desc}</p>

                  {/* 依赖数据源状态:绿点已连接/灰点未配;点依赖项跳连接器页并搜索定位 */}
                  {w.deps.length > 0 && (
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                      {w.deps.map((d) => (
                        <button
                          key={d.id}
                          type="button"
                          onClick={() => onOpenConnectors(d.id)}
                          className="flex items-center gap-1 text-[10px] text-zinc-500 hover:text-zinc-800 transition"
                          title={
                            isConnected(d.id)
                              ? `${d.name} 已连接,点击到连接器页查看`
                              : `${d.name} 未连接,点击到连接器页定位配置`
                          }
                        >
                          <span
                            className={`h-1.5 w-1.5 rounded-full ${
                              isConnected(d.id) ? 'bg-emerald-500' : 'bg-zinc-300'
                            }`}
                          />
                          <span>{d.name}</span>
                        </button>
                      ))}
                    </div>
                  )}

                  {missingRequired.length > 0 && (
                    <button
                      type="button"
                      onClick={() => onOpenConnectors()}
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
                  <span className="text-[10px] font-mono text-zinc-400 flex items-center gap-2">
                    {(() => {
                      const last = history.find((h) => h.id === w.id);
                      return last ? `上次 ${relativeTime(last.at)}` : '尚未使用';
                    })()}
                    {w.profileSlot && scenarioProfiles?.[w.profileSlot] && (
                      <button
                        type="button"
                        onClick={() => setWizardKey(w.profileSlot!)}
                        className="flex items-center gap-0.5 text-violet-600 hover:text-violet-800 transition font-sans"
                        title="编辑场景档案"
                      >
                        <UserRoundPen className="h-3 w-3" />
                        <span>编辑档案</span>
                      </button>
                    )}
                  </span>
                  <button
                    type="button"
                    onClick={() => handleStart(w)}
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

      {/* 工坊表单弹窗 */}
      {activeWorkshop && ActiveForm && (
        <ActiveForm
          key={activeWorkshop.id}
          workshop={activeWorkshop}
          onRun={(prompt: string, title: string | undefined, workshop: WorkshopRunPayload | undefined) =>
            onRunPrompt(prompt, title, workshop)
          }
          onClose={() => setActiveId(null)}
          scenarioProfile={activeProfile ?? null}
          onEditProfile={activeWorkshop.profileSlot ? () => setWizardKey(activeWorkshop.profileSlot!) : undefined}
          missions={missions}
          onOpenConnectors={onOpenConnectors}
        />
      )}

      {/* 场景档案向导:首次使用触发,或从卡片/表单回访编辑;保存/跳过后进入表单 */}
      {wizardKey && (
        <ScenarioProfileWizard
          scenarioKey={wizardKey}
          initial={scenarioProfiles?.[wizardKey] || null}
          onComplete={(profile) => {
            setScenarioProfiles((prev) => ({ ...(prev || {}), [wizardKey]: profile }));
            setWizardKey(null);
            const def = WORKSHOPS.find((w) => w.profileSlot === wizardKey);
            if (def && !activeId) setActiveId(def.id);
          }}
          onSkip={() => {
            setWizardDismissed((prev) => [...prev, wizardKey]);
            setWizardKey(null);
            const def = WORKSHOPS.find((w) => w.profileSlot === wizardKey);
            if (def && !activeId) setActiveId(def.id);
          }}
          onClose={() => setWizardKey(null)}
        />
      )}
    </div>
  );
}
