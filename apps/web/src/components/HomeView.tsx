'use client';

import React, { useState } from 'react';
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
} from 'lucide-react';
import { Mission, ConnectorApp } from '../types/agent';

interface HomeViewProps {
  onRunMission: (prompt: string, title?: string) => void;
  missions: Mission[];
  connectors: ConnectorApp[];
  onOpenCockpit: (missionId?: string) => void;
  onOpenConnectors: () => void;
}

export function HomeView({
  onRunMission,
  missions,
  connectors,
  onOpenCockpit,
  onOpenConnectors,
}: HomeViewProps) {
  const [promptText, setPromptText] = useState('');
  const [activeMode, setActiveMode] = useState<'research' | 'code' | 'browse' | 'general'>('research');

  const modes = [
    { id: 'research', label: '深度研究与报告', icon: Globe },
    { id: 'code', label: '沙盒代码与执行', icon: Code2 },
    { id: 'browse', label: '网页采集与交互', icon: Compass },
    { id: 'general', label: '通用多步工作流', icon: Zap },
  ] as const;

  const quickTemplates = [
    {
      title: '行业前沿深度调研',
      desc: '搜索 Hacker News 与顶级学术博客，生成多模态自主 Agent 落地架构对比报告。',
      mode: 'research',
      prompt: '深度检索并分析今日 Hacker News 及业界最新的 AI Agent 架构演进趋势，生成一份包含关键技术要点与优劣势的 Markdown 报告。',
    },
    {
      title: '沙盒环境与工具连通性自检',
      desc: '在沙盒容器中执行 Node.js、Git、Python 与内置连接器探测诊断。',
      mode: 'code',
      prompt: '在沙盒终端中运行环境诊断，检查 Node.js、Git、网络连通性以及当前加载的插件状态。',
    },
    {
      title: 'GitHub Trending 今日热门洞察',
      desc: '自主访问 GitHub 趋势榜单，提取热门 AI 仓库的核心特性与星星增长分析。',
      mode: 'browse',
      prompt: '访问 GitHub Trending 页面，分析今日最火的 3 个开源智能体项目，提取它们的核心功能与架构特点。',
    },
    {
      title: '自动化多步任务规划',
      desc: '模拟产品经理与全栈架构师，自主拆解并依次落地自动化执行流程。',
      mode: 'general',
      prompt: '帮我设计并执行一个全自动化的市场调研与代码分析流程，记录所有阶段与思考过程。',
    },
  ];

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!promptText.trim()) return;
    onRunMission(promptText.trim());
    setPromptText('');
  };

  const connectedCount = connectors.filter((c) => c.status === 'connected').length;

  return (
    <div className="w-full max-w-5xl mx-auto px-4 py-8 md:py-12 space-y-12 animate-fadeIn">
      {/* Hero Section */}
      <div className="text-center space-y-4 max-w-2xl mx-auto">
        <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-zinc-100/90 border border-zinc-200/80 text-xs text-zinc-600 shadow-2xs">
          <Sparkles className="h-3.5 w-3.5 text-zinc-800" />
          <span className="font-medium">AgtPilot 2.0 • Meta Muse & Manus 级人机协同范式</span>
        </div>

        <h1 className="text-3xl md:text-4xl font-semibold tracking-tight text-zinc-900 leading-tight">
          下一代全自主通用智能体
        </h1>

        <p className="text-sm md:text-base text-zinc-500 leading-relaxed">
          端到端调度云端实时浏览器、隔离沙盒代码环境与企业连接器。自主规划子任务、自我反思纠错，并即刻交付结构化成果。
        </p>
      </div>

      {/* Manus / Cue Style Omnibox */}
      <div className="max-w-3xl mx-auto">
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
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  handleSubmit(e);
                }
              }}
              placeholder="输入任务或直接向 AgtPilot 提问（例如：调研最新业界 AI Agent 架构，并在沙盒中完成验证）..."
              className="w-full bg-transparent border-none resize-none text-sm text-zinc-900 placeholder-zinc-400 focus:outline-none focus:ring-0 leading-relaxed font-sans"
            />
          </div>

          {/* Footer Controls */}
          <div className="px-4 py-3 bg-[#fafafa] border-t border-zinc-100 flex items-center justify-between">
            <div className="flex items-center gap-3 text-[11px] text-zinc-400 font-mono">
              <span>快捷指令: ⌘ + Enter 提交</span>
              <span className="hidden sm:inline">•</span>
              <span className="hidden sm:inline">深度反思模式已就绪</span>
            </div>

            <button
              type="submit"
              disabled={!promptText.trim()}
              className="flex items-center gap-1.5 px-4 py-2 rounded-xl bg-zinc-900 hover:bg-zinc-800 disabled:opacity-30 disabled:hover:bg-zinc-900 text-white text-xs font-medium transition shadow-xs active:scale-95"
            >
              <span>启动任务</span>
              <ArrowUp className="h-3.5 w-3.5" />
            </button>
          </div>
        </form>
      </div>

      {/* Quick Launch Templates */}
      <div className="space-y-3 max-w-4xl mx-auto">
        <div className="flex items-center justify-between">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-zinc-400">
            推荐工作流模版
          </h2>
          <span className="text-xs text-zinc-400">点击卡片快速填入并启动</span>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {quickTemplates.map((tpl, i) => (
            <div
              key={i}
              onClick={() => onRunMission(tpl.prompt, tpl.title)}
              className="group p-4 rounded-xl border border-zinc-200/80 bg-white hover:border-zinc-300 hover:shadow-xs transition cursor-pointer flex flex-col justify-between"
            >
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <span className="text-xs font-semibold text-zinc-900 group-hover:text-black">
                    {tpl.title}
                  </span>
                  <ArrowRight className="h-3.5 w-3.5 text-zinc-400 group-hover:text-zinc-800 group-hover:translate-x-0.5 transition" />
                </div>
                <p className="text-xs text-zinc-500 leading-relaxed line-clamp-2">
                  {tpl.desc}
                </p>
              </div>
              <div className="mt-3 pt-2.5 border-t border-zinc-100 flex items-center gap-2">
                <span className="text-[10px] font-mono text-zinc-400 uppercase">Template</span>
                <span className="text-[11px] text-zinc-500 font-medium truncate">
                  {tpl.mode}
                </span>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Core Capabilities Matrix (Dots & Muse 风格) */}
      <div className="space-y-4 max-w-4xl mx-auto">
        <div className="flex items-center justify-between">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-zinc-400">
            系统四大原子支柱
          </h2>
          <span className="text-xs text-zinc-400">原生插件生态与深层交互引擎</span>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3.5">
          <div className="p-4 rounded-xl border border-zinc-200/80 bg-white shadow-2xs space-y-2.5">
            <div className="h-8 w-8 rounded-lg bg-blue-50 text-blue-600 flex items-center justify-center">
              <Globe className="h-4 w-4" />
            </div>
            <div>
              <h3 className="text-xs font-semibold text-zinc-900">自主无头浏览器</h3>
              <p className="text-[11px] text-zinc-500 mt-1 leading-relaxed">
                Playwright 实时渲染网页、提取正文与交互元数据，并回传实时快照。
              </p>
            </div>
          </div>

          <div className="p-4 rounded-xl border border-zinc-200/80 bg-white shadow-2xs space-y-2.5">
            <div className="h-8 w-8 rounded-lg bg-emerald-50 text-emerald-600 flex items-center justify-center">
              <Terminal className="h-4 w-4" />
            </div>
            <div>
              <h3 className="text-xs font-semibold text-zinc-900">安全沙盒执行</h3>
              <p className="text-[11px] text-zinc-500 mt-1 leading-relaxed">
                隔离代码构建、执行测试、实时监听 stdout/stderr 命令流。
              </p>
            </div>
          </div>

          <div className="p-4 rounded-xl border border-zinc-200/80 bg-white shadow-2xs space-y-2.5">
            <div className="h-8 w-8 rounded-lg bg-amber-50 text-amber-600 flex items-center justify-center">
              <Shield className="h-4 w-4" />
            </div>
            <div>
              <h3 className="text-xs font-semibold text-zinc-900">人机协同门禁</h3>
              <p className="text-[11px] text-zinc-500 mt-1 leading-relaxed">
                敏感写操作与高危 Shell 指令主动挂起，经人工确认后方可继续推进。
              </p>
            </div>
          </div>

          <div className="p-4 rounded-xl border border-zinc-200/80 bg-white shadow-2xs space-y-2.5">
            <div className="h-8 w-8 rounded-lg bg-purple-50 text-purple-600 flex items-center justify-center">
              <FileText className="h-4 w-4" />
            </div>
            <div>
              <h3 className="text-xs font-semibold text-zinc-900">结构化产出物库</h3>
              <p className="text-[11px] text-zinc-500 mt-1 leading-relaxed">
                多轮会话生成的 Markdown 报告、代码 Diff 与数据资产统一归档与导出。
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* Recent Missions Overview */}
      {missions.length > 0 && (
        <div className="space-y-3 max-w-4xl mx-auto">
          <div className="flex items-center justify-between">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-zinc-400">
              近期运行任务 ({missions.length})
            </h2>
            <button
              onClick={() => onOpenCockpit()}
              className="text-xs text-zinc-600 hover:text-zinc-900 font-medium flex items-center gap-1 transition"
            >
              <span>进入工作台</span>
              <ArrowRight className="h-3 w-3" />
            </button>
          </div>

          <div className="space-y-2">
            {missions.slice(0, 3).map((m) => (
              <div
                key={m.id}
                onClick={() => onOpenCockpit(m.id)}
                className="p-3.5 rounded-xl border border-zinc-200/80 bg-white hover:border-zinc-300 transition cursor-pointer flex items-center justify-between"
              >
                <div className="flex items-center gap-3 min-w-0">
                  <div
                    className={`h-2.5 w-2.5 rounded-full flex-shrink-0 ${
                      m.status === 'ACTIVE'
                        ? 'bg-blue-600 animate-pulse'
                        : m.status === 'DONE'
                        ? 'bg-emerald-500'
                        : m.status === 'WAITING_APPROVAL'
                        ? 'bg-amber-500 ring-2 ring-amber-200'
                        : 'bg-zinc-400'
                    }`}
                  />
                  <div className="min-w-0">
                    <p className="text-xs font-medium text-zinc-900 truncate">
                      {m.title}
                    </p>
                    <div className="flex items-center gap-2 text-[10px] text-zinc-400 font-mono mt-0.5">
                      <span>{m.status}</span>
                      <span>•</span>
                      <span>
                        {m.steps.filter((s) => s.status === 'DONE').length} / {m.steps.length} 步骤
                      </span>
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-3">
                  <div className="w-24 bg-zinc-100 h-1.5 rounded-full overflow-hidden hidden sm:block">
                    <div
                      className="bg-zinc-800 h-full rounded-full transition-all"
                      style={{ width: `${m.progress}%` }}
                    />
                  </div>
                  <span className="text-xs font-mono font-medium text-zinc-600 w-8 text-right">
                    {m.progress}%
                  </span>
                  <ArrowRight className="h-3.5 w-3.5 text-zinc-400" />
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Ecosystem Status Bar */}
      <div className="p-4 rounded-xl border border-zinc-200/80 bg-zinc-50/50 max-w-4xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="h-8 w-8 rounded-lg bg-zinc-200 text-zinc-700 flex items-center justify-center">
            <Layers className="h-4 w-4" />
          </div>
          <div>
            <h4 className="text-xs font-semibold text-zinc-900">
              插件与服务连接状态
            </h4>
            <p className="text-[11px] text-zinc-500">
              已加载 15 个原子能力模块，{connectedCount} 个外部平台凭证已连接
            </p>
          </div>
        </div>

        <button
          onClick={onOpenConnectors}
          className="px-3.5 py-1.5 rounded-lg text-xs font-medium bg-white hover:bg-zinc-100 border border-zinc-200 text-zinc-700 shadow-2xs transition whitespace-nowrap"
        >
          管理连接器
        </button>
      </div>
    </div>
  );
}
