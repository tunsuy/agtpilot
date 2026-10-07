'use client';

import React, { useState } from 'react';
import { useSession } from 'next-auth/react';
import {
  Sparkles,
  ArrowUp,
  Globe,
  Terminal,
  Shield,
  FileText,
  Search,
  CheckCircle2,
  Clock,
  ArrowRight,
  Cpu,
  Layers,
  Zap,
  Code2,
  Compass,
  Smartphone,
  Download,
  Target,
  Brain,
  Radar,
  Lock,
  ChevronRight,
  TrendingUp,
  UserCheck,
} from 'lucide-react';
import {
  Mission,
  ConnectorApp,
  GoalItem,
  MemoryItem,
  CronJobItem,
} from '../types/agent';

interface HomeViewProps {
  onRunMission: (prompt: string, title?: string) => void;
  missions: Mission[];
  connectors: ConnectorApp[];
  goals?: GoalItem[];
  memories?: MemoryItem[];
  cronJobs?: CronJobItem[];
  onSelectModel?: (modelId: string) => Promise<void>;
  onOpenCockpit: (missionId?: string) => void;
  onOpenConnectors: () => void;
  onOpenGoals?: () => void;
  onOpenMemories?: () => void;
  onOpenPatrol?: () => void;
  onOpenDownloadApp?: () => void;
  onOpenAuth?: (tab: 'login' | 'register') => void;
}

export function HomeView({
  onRunMission,
  missions,
  connectors,
  goals = [],
  memories = [],
  cronJobs = [],
  onSelectModel,
  onOpenCockpit,
  onOpenConnectors,
  onOpenGoals,
  onOpenMemories,
  onOpenPatrol,
  onOpenDownloadApp,
  onOpenAuth,
}: HomeViewProps) {
  const { data: session } = useSession();
  const isLoggedIn = Boolean(session?.user);

  const [promptText, setPromptText] = useState('');
  const [activeMode, setActiveMode] = useState<'goal' | 'patrol' | 'creative' | 'research'>('goal');

  // 心智交互模式（以超级智能体为中心）
  const modes = [
    { id: 'goal', label: '长期目标拆解与推进', icon: Target },
    { id: 'patrol', label: '全天候巡航与监控', icon: Radar },
    { id: 'creative', label: '自媒体与数字内容生成', icon: Sparkles },
    { id: 'research', label: '深度调研与知识研报', icon: Globe },
  ] as const;

  // 真正围绕个人超级智能体的推荐工作流
  const superAgentWorkflows = [
    {
      title: '长期使命智能拆解与推进',
      desc: '围绕个人愿景（技能突破、个人品牌、资产增长）自动拆解多阶段里程碑并持续输出成果。',
      mode: '长期目标',
      icon: Target,
      color: 'text-rose-600 bg-rose-50 border-rose-200',
      prompt: '请帮我规划并开启一项长期愿景：“打造个人被动生产力与全自动数字资产工作流”。请拆解出可落地的阶段性里程碑，并为我执行第一个里程碑。',
    },
    {
      title: '多平台移动端视觉卡片企划',
      desc: '全自动生成爆款选题、3:4 视觉大字报切片、高网感文案，并就绪流转至手机端直接发布。',
      mode: '数字资产',
      icon: Smartphone,
      color: 'text-blue-600 bg-blue-50 border-blue-200',
      prompt: '请为我策划一份高质量的自媒体视觉图文全案：以“普通人如何把复杂重复工作托付给个人智能体”为主题，输出高点击率标题、3:4 视觉大字报封面、干货卡片与带 Emoji 标签正文。',
    },
    {
      title: '全天候行业前沿雷达巡航',
      desc: '设定常驻自动化巡航任务，无需人工值守，每天定时深度扫描最新动态并在飞书/微信生成简报。',
      mode: '自动巡航',
      icon: Radar,
      color: 'text-amber-600 bg-amber-50 border-amber-200',
      prompt: '请为我配置一项自动巡航任务：每天早晨 8 点自主检索全球最新开源 AI Agent 与自动化架构的突破性进展，生成结构化晨报并存入我的交付库。',
    },
    {
      title: '个人认知与人设记忆注入',
      desc: '向智能体传授你的工作理念、创作调性、排版审美与业务红线，打造越用越懂你的终身数字分身。',
      mode: '数字记忆',
      icon: Brain,
      color: 'text-purple-600 bg-purple-50 border-purple-200',
      prompt: '请将以下个人特质牢牢记住并纳入长效记忆库：我喜欢克制、极简、高密度、直奔主题的行文风格；在做方案时优先考虑实际落地可行性，拒绝冗长套话；交付物统一采用 GitHub 规范的 Markdown。',
    },
  ];

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!promptText.trim()) return;
    onRunMission(promptText.trim());
    setPromptText('');
  };

  const connectedCount = (connectors || []).filter((c) => c.status === 'connected').length;
  const activeGoalsCount = goals.filter((g) => g.status === 'active').length;
  const activeCronCount = cronJobs.filter((j) => j.status === 'active').length;

  return (
    <div className="w-full max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 pt-6 pb-16 md:pt-10 md:pb-24 space-y-12 animate-fadeIn">
      {/* 核心会话输入区（个人超级智能体核心入口） */}
      <div className="max-w-4xl mx-auto w-full pt-4 md:pt-10 pb-6 md:pb-10">
        <div className="text-center mb-12 md:mb-16 space-y-4">
          <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-zinc-100/90 border border-zinc-200/80 text-[11px] text-zinc-600 shadow-2xs">
            <Sparkles className="h-3 w-3 text-zinc-800" />
            <span className="font-medium">AgtPilot • 个人超级智能体人机协同范式</span>
          </div>

          <h1 className="text-3xl sm:text-4xl md:text-[2.6rem] font-semibold text-zinc-900 tracking-tight leading-tight">
            今天需要我帮你推进什么？
          </h1>

          <p className="text-xs sm:text-sm text-zinc-500 max-w-xl mx-auto leading-relaxed">
            不仅是即时问答——更是为你持续推进长期目标、全天候巡航守护、跨端直通手机并沉淀终身资产的私人操作系统
          </p>
        </div>

        <form
          onSubmit={handleSubmit}
          className="rounded-2xl border border-zinc-200 bg-white shadow-[0_8px_30px_rgb(0,0,0,0.06)] overflow-hidden transition-all focus-within:border-zinc-400 focus-within:shadow-[0_12px_40px_rgb(0,0,0,0.08)]"
        >
          {/* Mode Selector Chips */}
          <div className="flex items-center gap-1.5 px-4 pt-3.5 pb-2 border-b border-zinc-100 bg-[#fafafa]/80 overflow-x-auto">
            {modes.map((m) => {
              const Icon = m.icon;
              const isActive = activeMode === m.id;
              return (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => setActiveMode(m.id)}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap transition ${
                    isActive
                      ? 'bg-zinc-900 text-white shadow-2xs'
                      : 'text-zinc-600 hover:text-zinc-900 hover:bg-zinc-200/60'
                  }`}
                >
                  <Icon className="h-3.5 w-3.5" />
                  <span>{m.label}</span>
                </button>
              );
            })}
          </div>

          {/* Textarea Input */}
          <div className="p-4">
            <textarea
              rows={3}
              value={promptText}
              onChange={(e) => setPromptText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  handleSubmit(e);
                }
              }}
              placeholder={
                activeMode === 'goal'
                  ? '设定一个长期愿景（例如：帮我拆解“打造自媒体全自动增长工作流”的长期目标并推进第一步）...'
                  : activeMode === 'patrol'
                  ? '配置无人值守巡航（例如：每天早8点扫描 GitHub AI Trending，提取最新突破报告）...'
                  : activeMode === 'creative'
                  ? '输入内容需求（例如：以“个人超级智能体提效10倍”为主题生成 3:4 视觉大字报与多平台图文）...'
                  : '提出深度调研课题（例如：全面梳理业界 AI Agent 记忆与反思架构最佳实践）...'
              }
              className="w-full bg-transparent border-none resize-none text-sm text-zinc-900 placeholder-zinc-400 focus:outline-none focus:ring-0 leading-relaxed font-sans"
            />
          </div>

          {/* Footer Controls */}
          <div className="px-4 py-3 bg-[#fafafa] border-t border-zinc-100 flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              {/* 模型选择器 */}
              {onSelectModel && (
                <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-white border border-zinc-200/90 shadow-2xs">
                  <Cpu className="h-3.5 w-3.5 text-blue-600 flex-shrink-0" />
                  <select
                    value={(connectors || []).find((c) => c.isModel && c.isDefaultModel)?.id || 'deepseek'}
                    onChange={(e) => onSelectModel(e.target.value)}
                    className="bg-transparent text-xs font-medium text-zinc-800 focus:outline-none cursor-pointer"
                  >
                    {(connectors || [])
                      .filter((c) => c.isModel)
                      .map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                  </select>
                </div>
              )}

              <div className="hidden sm:flex items-center gap-2 text-[11px] text-zinc-400 font-mono ml-1">
                <span>Enter 发送，Shift + Enter 换行</span>
              </div>
            </div>

            <button
              type="submit"
              disabled={!promptText.trim()}
              className="flex items-center gap-1.5 px-4 py-2 rounded-xl bg-zinc-900 hover:bg-zinc-800 disabled:opacity-30 disabled:hover:bg-zinc-900 text-white text-xs font-medium transition shadow-xs active:scale-95"
            >
              <span>调度智能体执行</span>
              <ArrowUp className="h-3.5 w-3.5" />
            </button>
          </div>
        </form>

        {/* Quick Suggestion Pills */}
        <div className="flex flex-wrap items-center justify-center gap-2 mt-4 text-xs text-zinc-500">
          <span className="text-[11px] text-zinc-400 font-medium">你可以试着对我说：</span>
          {superAgentWorkflows.map((tpl, i) => (
            <button
              key={i}
              type="button"
              onClick={() => onRunMission(tpl.prompt, tpl.title)}
              className="px-2.5 py-1 rounded-full bg-white hover:bg-zinc-100 border border-zinc-200/80 text-zinc-600 hover:text-zinc-900 text-[11px] font-medium transition shadow-2xs flex items-center gap-1 active:scale-95"
            >
              <span>{tpl.title}</span>
            </button>
          ))}
        </div>
      </div>

      {/* ========================================================================= */}
      {/* 实时看板区域（登录态 vs 访客态严格隔离）                                      */}
      {/* ========================================================================= */}
      <div className="w-full pt-4">
        {isLoggedIn ? (
          /* 已登录用户：展示其实际数据大盘 */
          <div className="p-5 rounded-2xl border border-zinc-200 bg-white shadow-2xs space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-zinc-100 pb-3">
              <div className="flex items-center gap-2">
                <span className="h-2 w-2 rounded-full bg-emerald-500 animate-pulse" />
                <h3 className="text-xs font-bold uppercase tracking-wider text-zinc-900">
                  我的私人智能体实时运行大盘
                </h3>
                <span className="text-[10px] text-zinc-400 font-mono">
                  {session?.user?.email || session?.user?.name}
                </span>
              </div>
              <span className="text-[11px] text-zinc-400">
                数据实时双向同步至手机端
              </span>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3.5">
              {/* 1. 目标进度 */}
              <div
                onClick={onOpenGoals}
                className="p-3.5 rounded-xl border border-zinc-200/70 bg-zinc-50/50 hover:bg-rose-50/20 hover:border-rose-200 transition cursor-pointer group flex flex-col justify-between"
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1.5 text-xs font-semibold text-zinc-800 group-hover:text-rose-600">
                    <Target className="h-4 w-4 text-rose-500" />
                    <span>长期目标</span>
                  </div>
                  <ChevronRight className="h-3.5 w-3.5 text-zinc-400 group-hover:translate-x-0.5 transition" />
                </div>
                <div className="mt-3">
                  <span className="text-xl font-bold font-mono text-zinc-900">
                    {activeGoalsCount > 0 ? `${activeGoalsCount} 个进行中` : '0 个目标'}
                  </span>
                  <p className="text-[11px] text-zinc-500 mt-0.5 truncate">
                    {goals[0] ? `当前聚焦: ${goals[0].title}` : '点击设定长期核心使命'}
                  </p>
                </div>
              </div>

              {/* 2. 全天候巡航 */}
              <div
                onClick={onOpenPatrol}
                className="p-3.5 rounded-xl border border-zinc-200/70 bg-zinc-50/50 hover:bg-amber-50/20 hover:border-amber-200 transition cursor-pointer group flex flex-col justify-between"
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1.5 text-xs font-semibold text-zinc-800 group-hover:text-amber-600">
                    <Radar className="h-4 w-4 text-amber-500" />
                    <span>无人值守巡航</span>
                  </div>
                  <ChevronRight className="h-3.5 w-3.5 text-zinc-400 group-hover:translate-x-0.5 transition" />
                </div>
                <div className="mt-3">
                  <span className="text-xl font-bold font-mono text-zinc-900">
                    {activeCronCount} 个巡航哨兵
                  </span>
                  <p className="text-[11px] text-zinc-500 mt-0.5 truncate">
                    {cronJobs[0] ? `下次巡检: ${cronJobs[0].name}` : '全天候守护就绪'}
                  </p>
                </div>
              </div>

              {/* 3. 个人长效记忆 */}
              <div
                onClick={onOpenMemories}
                className="p-3.5 rounded-xl border border-zinc-200/70 bg-zinc-50/50 hover:bg-purple-50/20 hover:border-purple-200 transition cursor-pointer group flex flex-col justify-between"
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1.5 text-xs font-semibold text-zinc-800 group-hover:text-purple-600">
                    <Brain className="h-4 w-4 text-purple-500" />
                    <span>专属数字记忆</span>
                  </div>
                  <ChevronRight className="h-3.5 w-3.5 text-zinc-400 group-hover:translate-x-0.5 transition" />
                </div>
                <div className="mt-3">
                  <span className="text-xl font-bold font-mono text-zinc-900">
                    {memories.length} 条个性偏好
                  </span>
                  <p className="text-[11px] text-zinc-500 mt-0.5 truncate">
                    掌握你的风格、审美与红线
                  </p>
                </div>
              </div>

              {/* 4. 平台连接状态 */}
              <div
                onClick={onOpenConnectors}
                className="p-3.5 rounded-xl border border-zinc-200/70 bg-zinc-50/50 hover:bg-blue-50/20 hover:border-blue-200 transition cursor-pointer group flex flex-col justify-between"
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1.5 text-xs font-semibold text-zinc-800 group-hover:text-blue-600">
                    <Layers className="h-4 w-4 text-blue-500" />
                    <span>跨端与连接器</span>
                  </div>
                  <ChevronRight className="h-3.5 w-3.5 text-zinc-400 group-hover:translate-x-0.5 transition" />
                </div>
                <div className="mt-3">
                  <span className="text-xl font-bold font-mono text-zinc-900">
                    {connectedCount} 个渠道直连
                  </span>
                  <p className="text-[11px] text-zinc-500 mt-0.5 truncate">
                    Web API + 手机原生 App 双通
                  </p>
                </div>
              </div>
            </div>
          </div>
        ) : (
          /* 未登录访客：展示客观的概念心智大盘（用户无关的展示） */
          <div className="p-6 rounded-2xl border border-zinc-200/90 bg-gradient-to-br from-white via-zinc-50/40 to-zinc-100/50 shadow-2xs space-y-5">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-zinc-200/60 pb-4">
              <div>
                <h3 className="text-xs font-bold uppercase tracking-wider text-zinc-800">
                  个人超级智能体（Personal Super Agent）核心运转架构
                </h3>
                <p className="text-xs text-zinc-500 mt-1">
                  每个独立用户登录后，都将拥有专属的数据隔离大脑、长期愿景拆解引擎与全天候自动巡航守护
                </p>
              </div>

              {onOpenAuth && (
                <button
                  onClick={() => onOpenAuth('login')}
                  className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-xl bg-zinc-900 hover:bg-zinc-800 text-white text-xs font-medium shadow-2xs transition whitespace-nowrap self-start sm:self-auto"
                >
                  <Lock className="h-3 w-3" />
                  <span>登录查看我的专属看板</span>
                </button>
              )}
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
              <div className="p-4 rounded-xl bg-white border border-zinc-200/80 shadow-2xs space-y-2">
                <div className="flex items-center gap-2 text-rose-600 font-semibold text-xs">
                  <Target className="h-4 w-4" />
                  <span>1. 长期目标引擎</span>
                </div>
                <p className="text-[11px] text-zinc-500 leading-relaxed">
                  不再停留在单次简短对话。围绕个人长期愿景科学拆解里程碑，持续主动协同推进。
                </p>
              </div>

              <div className="p-4 rounded-xl bg-white border border-zinc-200/80 shadow-2xs space-y-2">
                <div className="flex items-center gap-2 text-amber-600 font-semibold text-xs">
                  <Radar className="h-4 w-4" />
                  <span>2. 无人值守巡航</span>
                </div>
                <p className="text-[11px] text-zinc-500 leading-relaxed">
                  24小时后台常驻守护。定期巡检行业热点、数据异常并主动推送简报，无需人工在场。
                </p>
              </div>

              <div className="p-4 rounded-xl bg-white border border-zinc-200/80 shadow-2xs space-y-2">
                <div className="flex items-center gap-2 text-purple-600 font-semibold text-xs">
                  <Brain className="h-4 w-4" />
                  <span>3. 终身记忆与人设</span>
                </div>
                <p className="text-[11px] text-zinc-500 leading-relaxed">
                  越用越懂你的数字大脑。深层记忆你的行文风格、视觉审美偏好与业务红线。
                </p>
              </div>

              <div className="p-4 rounded-xl bg-white border border-zinc-200/80 shadow-2xs space-y-2">
                <div className="flex items-center gap-2 text-blue-600 font-semibold text-xs">
                  <Smartphone className="h-4 w-4" />
                  <span>4. 跨设备双轨直通</span>
                </div>
                <p className="text-[11px] text-zinc-500 leading-relaxed">
                  网页端配置大模型与 API 凭证，手机端免密直调微信/小红书等原生 App，资产一键分发。
                </p>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* 核心工作流模版（围绕个人智能体核心场景） */}
      <div className="space-y-4 w-full">
        <div className="flex items-center justify-between">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-zinc-400">
            高频超级智能体工作流模版
          </h2>
          <span className="text-[11px] text-zinc-400">一键快速载入并执行</span>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3.5">
          {superAgentWorkflows.map((tpl, i) => {
            const Icon = tpl.icon;
            return (
              <div
                key={i}
                onClick={() => onRunMission(tpl.prompt, tpl.title)}
                className="group p-4 rounded-xl border border-zinc-200/80 bg-white hover:border-zinc-300 hover:shadow-xs transition cursor-pointer flex flex-col justify-between space-y-3"
              >
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-md border ${tpl.color}`}>
                      {tpl.mode}
                    </span>
                    <ArrowRight className="h-3.5 w-3.5 text-zinc-400 group-hover:text-zinc-800 group-hover:translate-x-0.5 transition" />
                  </div>
                  <h3 className="text-xs font-semibold text-zinc-900 group-hover:text-black">
                    {tpl.title}
                  </h3>
                  <p className="text-xs text-zinc-500 leading-relaxed line-clamp-3 mt-1.5">
                    {tpl.desc}
                  </p>
                </div>
                <div className="pt-2.5 border-t border-zinc-100 flex items-center gap-1.5 text-[11px] text-zinc-600 font-medium">
                  <Icon className="h-3.5 w-3.5" />
                  <span>立即启动工作流</span>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* 底部跨端生态与移动端直连专区 */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* 连接器状态卡片 */}
        <div className="p-4 rounded-xl border border-zinc-200/80 bg-zinc-50/50 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="h-8 w-8 rounded-lg bg-zinc-200 text-zinc-700 flex items-center justify-center flex-shrink-0">
              <Layers className="h-4 w-4" />
            </div>
            <div>
              <h4 className="text-xs font-semibold text-zinc-900">
                外部生态连接状态
              </h4>
              <p className="text-[11px] text-zinc-500">
                支持大模型、沙盒、搜索与多渠道自媒体直连，当前 {connectedCount} 个渠道就绪
              </p>
            </div>
          </div>

          <button
            onClick={onOpenConnectors}
            className="px-3 py-1.5 rounded-lg text-xs font-medium bg-white hover:bg-zinc-100 border border-zinc-200 text-zinc-700 shadow-2xs transition whitespace-nowrap flex-shrink-0"
          >
            管理连接器
          </button>
        </div>

        {/* 移动端 App 下载/直连卡片 */}
        <div className="p-4 rounded-xl border border-zinc-200/80 bg-gradient-to-r from-rose-50/40 via-white to-purple-50/40 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="h-8 w-8 rounded-lg bg-zinc-900 text-white flex items-center justify-center flex-shrink-0 shadow-2xs">
              <Smartphone className="h-4 w-4" />
            </div>
            <div>
              <h4 className="text-xs font-semibold text-zinc-900">
                AgtPilot 移动端客户端
              </h4>
              <p className="text-[11px] text-zinc-500">
                手机真机免密唤起 App、原生分享图文卡片与随时随地巡航
              </p>
            </div>
          </div>

          {onOpenDownloadApp && (
            <button
              onClick={onOpenDownloadApp}
              className="px-3 py-1.5 rounded-lg text-xs font-medium bg-zinc-900 hover:bg-zinc-800 text-white shadow-xs transition whitespace-nowrap flex-shrink-0 flex items-center gap-1.5"
            >
              <Download className="h-3 w-3" />
              <span>获取移动版</span>
            </button>
          )}
        </div>
      </div>

      {/* ========================================================================= */}
      {/* 极简产品页脚 (Centered Minimalist OS Footer)                               */}
      {/* ========================================================================= */}
      <footer className="pt-12 pb-8 border-t border-zinc-200/60 mt-14 flex flex-col items-center text-center space-y-6">
        {/* 品牌 Logo 与标题 */}
        <div className="flex items-center gap-2">
          <div className="h-6 w-6 rounded-md bg-zinc-950 flex items-center justify-center overflow-hidden flex-shrink-0">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/logo.svg" alt="AgtPilot Logo" className="h-full w-full object-cover" />
          </div>
          <span className="font-semibold text-sm tracking-tight text-zinc-900">
            AgtPilot
          </span>
          <span className="text-[10px] font-mono px-1.5 py-0.2 rounded bg-zinc-100 text-zinc-500 border border-zinc-200/80">
            v1.2.0
          </span>
        </div>

        {/* 品牌理念与隐私宣言 */}
        <p className="text-xs text-zinc-500 leading-relaxed max-w-md mx-auto">
          面向个人的新一代自主超级智能体操作系统。以长期目标为导向，沉淀数字记忆、常驻自主巡航、跨端协同执行。
        </p>

        {/* 快捷导航：居中胶囊文字链 */}
        <div className="flex flex-wrap items-center justify-center gap-x-6 gap-y-2 text-xs text-zinc-500">
          <button onClick={onOpenGoals} className="hover:text-zinc-900 transition">
            长期目标与里程碑
          </button>
          <span>•</span>
          <button onClick={onOpenPatrol} className="hover:text-zinc-900 transition">
            无人值守自动巡航
          </button>
          <span>•</span>
          <button onClick={onOpenMemories} className="hover:text-zinc-900 transition">
            专属认知与记忆库
          </button>
          <span>•</span>
          <button onClick={() => onOpenCockpit()} className="hover:text-zinc-900 transition">
            多智能体工作台
          </button>
          <span>•</span>
          <button onClick={onOpenConnectors} className="hover:text-zinc-900 transition">
            自媒体与生态连接器
          </button>
          <span>•</span>
          <button onClick={onOpenDownloadApp} className="hover:text-zinc-900 transition">
            获取移动端 (App/PWA)
          </button>
        </div>

        {/* 隐私与安全承诺 */}
        <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-zinc-100/70 border border-zinc-200/60 text-[11px] text-zinc-500 font-mono">
          <Shield className="h-3 w-3 text-emerald-600" />
          <span>本地隔离存储 · 凭证自主管控 · 隐私零泄露</span>
        </div>

        {/* 底部版权与健康状态 */}
        <div className="pt-4 border-t border-zinc-100 w-full flex flex-col sm:flex-row items-center justify-between gap-3 text-[11px] text-zinc-400 font-mono">
          <div className="flex items-center gap-2 mx-auto sm:mx-0">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />
            <span>Autonomous Engine Ready</span>
            <span>•</span>
            <span>Local Priority</span>
          </div>
          <div className="mx-auto sm:mx-0">
            © 2026 AgtPilot. Personal Super Agent OS.
          </div>
        </div>
      </footer>
    </div>
  );
}
