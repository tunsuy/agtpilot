'use client';

import { useState, useEffect } from 'react';
import { CopilotKit } from '@copilotkit/react-core';
import { CopilotSidebar } from '@copilotkit/react-ui';
import { Globe, Shield, Bot, Layers, Search, Terminal, Zap } from 'lucide-react';

export default function Home() {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  return (
    <div className="flex min-h-screen flex-col bg-slate-950 text-slate-100">
      {/* Top Navbar */}
      <header className="flex h-16 items-center justify-between border-b border-slate-800 px-6 backdrop-blur">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500 to-purple-600 text-white shadow-lg shadow-indigo-500/30">
            <Bot className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-lg font-bold tracking-tight text-white flex items-center gap-2">
              agtpilot
              <span className="rounded-full bg-emerald-500/10 px-2.5 py-0.5 text-xs font-semibold text-emerald-400 border border-emerald-500/20">
                Online
              </span>
            </h1>
            <p className="text-xs text-slate-400">DeepSeek Harness + Cordis 微内核 + CopilotKit UI</p>
          </div>
        </div>
        <div className="flex items-center gap-4 text-xs text-slate-400">
          <span className="flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full bg-emerald-500 animate-pulse"></span>
            11 个原子工具已就绪
          </span>
        </div>
      </header>

      {/* Main Dashboard Workspace */}
      <main className="flex-1 p-8 max-w-6xl mx-auto w-full">
        <div className="mb-8">
          <div className="inline-flex items-center gap-2 rounded-full border border-indigo-500/30 bg-indigo-500/10 px-3 py-1 text-xs font-medium text-indigo-400 mb-3">
            <Zap className="h-3.5 w-3.5" /> 个人全自主智能体运行底座
          </div>
          <h2 className="text-3xl font-extrabold text-white tracking-tight sm:text-4xl mb-2">
            自主智能体驾驶舱
          </h2>
          <p className="text-base text-slate-400 max-w-3xl">
            在右侧 Copilot 边栏下发自然语言任务，Agent 将通过 Cordis 微内核自主调度全网检索、网页蒸馏、沙箱执行与文件操作。
          </p>
        </div>

        {/* 4 大核心原子能力展示卡片 */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 mb-12">
          {/* 1. 搜索引擎能力 */}
          <div className="rounded-2xl border border-slate-800 bg-slate-900/50 p-6 backdrop-blur transition-all hover:border-indigo-500/50 hover:bg-slate-900/80">
            <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-cyan-500/10 text-cyan-400 mb-4 border border-cyan-500/20">
              <Search className="h-6 w-6" />
            </div>
            <h3 className="text-base font-semibold text-white mb-2">全网搜索引擎</h3>
            <p className="text-xs text-slate-400 leading-relaxed mb-4">
              免 Key 原生聚合检索，自动解析高价值网页标题、直达链接与内容摘要，支持 Tavily 引擎热插拔。
            </p>
            <div className="flex flex-wrap gap-1.5 text-[11px] text-cyan-300/80 font-mono">
              <span className="rounded bg-slate-800/80 px-2 py-0.5 border border-slate-700">search_web</span>
            </div>
          </div>

          {/* 2. 持久化浏览器能力 */}
          <div className="rounded-2xl border border-slate-800 bg-slate-900/50 p-6 backdrop-blur transition-all hover:border-indigo-500/50 hover:bg-slate-900/80">
            <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-indigo-500/10 text-indigo-400 mb-4 border border-indigo-500/20">
              <Globe className="h-6 w-6" />
            </div>
            <h3 className="text-base font-semibold text-white mb-2">持久化浏览器</h3>
            <p className="text-xs text-slate-400 leading-relaxed mb-4">
              Playwright 保持登录会话、Turndown 结构化正文蒸馏，结合 Stagehand 实现 AI 语义化 DOM 观察与动作。
            </p>
            <div className="flex flex-wrap gap-1.5 text-[11px] text-indigo-300/80 font-mono">
              <span className="rounded bg-slate-800/80 px-2 py-0.5 border border-slate-700">navigate</span>
              <span className="rounded bg-slate-800/80 px-2 py-0.5 border border-slate-700">stagehand</span>
              <span className="rounded bg-slate-800/80 px-2 py-0.5 border border-slate-700">screenshot</span>
            </div>
          </div>

          {/* 3. 受控沙箱与代码解释器 */}
          <div className="rounded-2xl border border-slate-800 bg-slate-900/50 p-6 backdrop-blur transition-all hover:border-indigo-500/50 hover:bg-slate-900/80">
            <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-amber-500/10 text-amber-400 mb-4 border border-amber-500/20">
              <Terminal className="h-6 w-6" />
            </div>
            <h3 className="text-base font-semibold text-white mb-2">安全执行沙箱</h3>
            <p className="text-xs text-slate-400 leading-relaxed mb-4">
              隔离运行 Shell 终端命令、Node.js / Python 多语言解释器，支持工作区文件读写与路径防穿越。
            </p>
            <div className="flex flex-wrap gap-1.5 text-[11px] text-amber-300/80 font-mono">
              <span className="rounded bg-slate-800/80 px-2 py-0.5 border border-slate-700">run_code</span>
              <span className="rounded bg-slate-800/80 px-2 py-0.5 border border-slate-700">run_command</span>
              <span className="rounded bg-slate-800/80 px-2 py-0.5 border border-slate-700">read/write</span>
            </div>
          </div>

          {/* 4. 安全审批与防死循环 */}
          <div className="rounded-2xl border border-slate-800 bg-slate-900/50 p-6 backdrop-blur transition-all hover:border-indigo-500/50 hover:bg-slate-900/80">
            <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-emerald-500/10 text-emerald-400 mb-4 border border-emerald-500/20">
              <Shield className="h-6 w-6" />
            </div>
            <h3 className="text-base font-semibold text-white mb-2">审批与熔断底座</h3>
            <p className="text-xs text-slate-400 leading-relaxed mb-4">
              自研透明 ReAct 状态机，内置 Loop Detector 循环调用熔断，高危指令原地挂起等待人类审批。
            </p>
            <div className="flex flex-wrap gap-1.5 text-[11px] text-emerald-300/80 font-mono">
              <span className="rounded bg-slate-800/80 px-2 py-0.5 border border-slate-700">loop-detector</span>
              <span className="rounded bg-slate-800/80 px-2 py-0.5 border border-slate-700">hitl-approval</span>
            </div>
          </div>
        </div>

        {/* 架构工作流程预览 */}
        <div className="rounded-2xl border border-slate-800 bg-slate-900/30 p-6 backdrop-blur">
          <h4 className="text-sm font-semibold text-slate-300 uppercase tracking-wider mb-3">
            自主任务执行链路
          </h4>
          <div className="flex items-center gap-3 text-xs text-slate-400 flex-wrap">
            <span className="rounded-lg bg-slate-800 px-3 py-1.5 text-white border border-slate-700">
              1. 自然语言意图拆解
            </span>
            <span className="text-slate-600">→</span>
            <span className="rounded-lg bg-cyan-950/60 px-3 py-1.5 text-cyan-300 border border-cyan-800/50">
              2. 实时全网检索 (search_web)
            </span>
            <span className="text-slate-600">→</span>
            <span className="rounded-lg bg-indigo-950/60 px-3 py-1.5 text-indigo-300 border border-indigo-800/50">
              3. 目标页面深度蒸馏 (browser_navigate)
            </span>
            <span className="text-slate-600">→</span>
            <span className="rounded-lg bg-amber-950/60 px-3 py-1.5 text-amber-300 border border-amber-800/50">
              4. 隔离代码计算/保存 (sandbox_run_code)
            </span>
            <span className="text-slate-600">→</span>
            <span className="rounded-lg bg-emerald-950/60 px-3 py-1.5 text-emerald-300 border border-emerald-800/50">
              5. 综合回答与结构化结果呈现
            </span>
          </div>
        </div>
      </main>

      {/* 确保客户端完全挂载后再渲染 CopilotKit，彻底避免 SSR Hydration Mismatch */}
      {mounted && (
        <CopilotKit runtimeUrl="/api/copilotkit">
          <CopilotSidebar
            instructions="你是由 DeepSeek Harness 官方 Cordis 插件微内核驱动的个人全自主智能体驾驶舱助手 (agtpilot)。你可以自主规划多步任务，并按需调用原子工具：互联网实时检索 (search_web)、持久化浏览器网页蒸馏 (browser_navigate)、隔离代码执行 (sandbox_run_code)、终端命令 (sandbox_run_command) 以及工作区文件操作 (sandbox_read_file, sandbox_write_file)。"
            labels={{
              title: 'agtpilot 驾驶舱',
              initial: '你好！我是你的个人全自主智能体。我已经接入全网检索、持久化浏览器、沙箱代码运行与文件管理等 11 项原子能力。请输入你想要我完成的任务（例如：“搜索今天 GitHub 趋势榜前 3 的 AI 项目，并读取网页正文告诉我核心技术特点”）。',
            }}
            defaultOpen={true}
            clickOutsideToClose={false}
          />
        </CopilotKit>
      )}
    </div>
  );
}
