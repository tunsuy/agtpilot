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
            18 个 SOTA 原子工具已就绪
          </span>
        </div>
      </header>

      {/* Main Dashboard Workspace */}
      <main className="flex-1 p-8 max-w-6xl mx-auto w-full">
        <div className="mb-8">
          <div className="inline-flex items-center gap-2 rounded-full border border-indigo-500/30 bg-indigo-500/10 px-3 py-1 text-xs font-medium text-indigo-400 mb-3">
            <Zap className="h-3.5 w-3.5" /> 业界顶级 SOTA 库驱动的个人全自主智能体运行底座
          </div>
          <h2 className="text-3xl font-extrabold text-white tracking-tight sm:text-4xl mb-2">
            自主智能体驾驶舱
          </h2>
          <p className="text-base text-slate-400 max-w-3xl">
            在右侧 Copilot 边栏下发自然语言任务，Agent 通过 Cordis 微内核自主调度 Anthropic MCP 协议、E2B 云端沙箱、Exa/Tavily 神经检索、Firecrawl/Stagehand AI 浏览器。
          </p>
        </div>

        {/* 5 大核心原子能力展示卡片 */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5 mb-10">
          {/* 1. MCP 开放协议 */}
          <div className="rounded-2xl border border-slate-800 bg-slate-900/50 p-6 backdrop-blur transition-all hover:border-purple-500/50 hover:bg-slate-900/80">
            <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-purple-500/10 text-purple-400 mb-4 border border-purple-500/20">
              <Layers className="h-6 w-6" />
            </div>
            <h3 className="text-base font-semibold text-white mb-2">Anthropic MCP 生态</h3>
            <p className="text-xs text-slate-400 leading-relaxed mb-4">
              集成官方 @modelcontextprotocol/sdk，支持 stdio 与 SSE 远程 MCP 服务秒级挂载，动态注入海量外部生态工具。
            </p>
            <div className="flex flex-wrap gap-1.5 text-[11px] text-purple-300/80 font-mono">
              <span className="rounded bg-slate-800/80 px-2 py-0.5 border border-slate-700">mcp_connect_stdio</span>
              <span className="rounded bg-slate-800/80 px-2 py-0.5 border border-slate-700">mcp_connect_sse</span>
              <span className="rounded bg-slate-800/80 px-2 py-0.5 border border-slate-700">mcp_list</span>
            </div>
          </div>

          {/* 2. E2B 云端与本地沙箱 */}
          <div className="rounded-2xl border border-slate-800 bg-slate-900/50 p-6 backdrop-blur transition-all hover:border-amber-500/50 hover:bg-slate-900/80">
            <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-amber-500/10 text-amber-400 mb-4 border border-amber-500/20">
              <Terminal className="h-6 w-6" />
            </div>
            <h3 className="text-base font-semibold text-white mb-2">E2B 云端 MicroVM 与沙箱</h3>
            <p className="text-xs text-slate-400 leading-relaxed mb-4">
              集成业界顶级 @e2b/code-interpreter 云端 Firecracker 硬件虚拟化微容器，兼备本地受控 Node/Python/Shell 与路径防穿越。
            </p>
            <div className="flex flex-wrap gap-1.5 text-[11px] text-amber-300/80 font-mono">
              <span className="rounded bg-slate-800/80 px-2 py-0.5 border border-slate-700">e2b_run_python</span>
              <span className="rounded bg-slate-800/80 px-2 py-0.5 border border-slate-700">sandbox_run_code</span>
              <span className="rounded bg-slate-800/80 px-2 py-0.5 border border-slate-700">sandbox_run_command</span>
            </div>
          </div>

          {/* 3. Exa / Tavily 智能检索 */}
          <div className="rounded-2xl border border-slate-800 bg-slate-900/50 p-6 backdrop-blur transition-all hover:border-cyan-500/50 hover:bg-slate-900/80">
            <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-cyan-500/10 text-cyan-400 mb-4 border border-cyan-500/20">
              <Search className="h-6 w-6" />
            </div>
            <h3 className="text-base font-semibold text-white mb-2">Exa / Tavily 神经搜索</h3>
            <p className="text-xs text-slate-400 leading-relaxed mb-4">
              集成 Exa 语义神经网络检索与 Tavily 专为 LLM 设计的研究型搜索，内置零 Key DuckDuckGo 智能兜底。
            </p>
            <div className="flex flex-wrap gap-1.5 text-[11px] text-cyan-300/80 font-mono">
              <span className="rounded bg-slate-800/80 px-2 py-0.5 border border-slate-700">search_exa</span>
              <span className="rounded bg-slate-800/80 px-2 py-0.5 border border-slate-700">search_tavily</span>
              <span className="rounded bg-slate-800/80 px-2 py-0.5 border border-slate-700">search_web</span>
            </div>
          </div>

          {/* 4. Firecrawl / Stagehand / Playwright 智能浏览器 */}
          <div className="rounded-2xl border border-slate-800 bg-slate-900/50 p-6 backdrop-blur transition-all hover:border-indigo-500/50 hover:bg-slate-900/80">
            <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-indigo-500/10 text-indigo-400 mb-4 border border-indigo-500/20">
              <Globe className="h-6 w-6" />
            </div>
            <h3 className="text-base font-semibold text-white mb-2">Firecrawl & Stagehand 浏览器</h3>
            <p className="text-xs text-slate-400 leading-relaxed mb-4">
              集成 Firecrawl 智能页面清洗转 Markdown、Stagehand AI 语义操作（act/observe）与 Playwright 登录态保活。
            </p>
            <div className="flex flex-wrap gap-1.5 text-[11px] text-indigo-300/80 font-mono">
              <span className="rounded bg-slate-800/80 px-2 py-0.5 border border-slate-700">firecrawl_scrape</span>
              <span className="rounded bg-slate-800/80 px-2 py-0.5 border border-slate-700">stagehand_act</span>
              <span className="rounded bg-slate-800/80 px-2 py-0.5 border border-slate-700">browser_navigate</span>
            </div>
          </div>

          {/* 5. 安全审批与防死循环 */}
          <div className="rounded-2xl border border-slate-800 bg-slate-900/50 p-6 backdrop-blur transition-all hover:border-emerald-500/50 hover:bg-slate-900/80 md:col-span-2 lg:col-span-2">
            <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-emerald-500/10 text-emerald-400 mb-4 border border-emerald-500/20">
              <Shield className="h-6 w-6" />
            </div>
            <h3 className="text-base font-semibold text-white mb-2">Cordis 微内核与安全熔断底座</h3>
            <p className="text-xs text-slate-400 leading-relaxed mb-4">
              自主实现透明 ReAct 状态机：内置 Loop Detector 连续重复调用熔断、高危工具 Human-in-the-Loop 实时拦截审批，保证自主执行绝对安全受控。
            </p>
            <div className="flex flex-wrap gap-1.5 text-[11px] text-emerald-300/80 font-mono">
              <span className="rounded bg-slate-800/80 px-2 py-0.5 border border-slate-700">Loop-Detector-3-Repeats</span>
              <span className="rounded bg-slate-800/80 px-2 py-0.5 border border-slate-700">Human-In-The-Loop</span>
              <span className="rounded bg-slate-800/80 px-2 py-0.5 border border-slate-700">Cordis-Microkernel</span>
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
              1. 复杂意图拆解与规划
            </span>
            <span className="text-slate-600">→</span>
            <span className="rounded-lg bg-cyan-950/60 px-3 py-1.5 text-cyan-300 border border-cyan-800/50">
              2. 神经/实时检索 (Exa / Tavily / DDG)
            </span>
            <span className="text-slate-600">→</span>
            <span className="rounded-lg bg-indigo-950/60 px-3 py-1.5 text-indigo-300 border border-indigo-800/50">
              3. 网页解析与 AI 交互 (Firecrawl / Stagehand)
            </span>
            <span className="text-slate-600">→</span>
            <span className="rounded-lg bg-amber-950/60 px-3 py-1.5 text-amber-300 border border-amber-800/50">
              4. 隔离安全沙箱计算 (E2B / Local Sandbox)
            </span>
            <span className="text-slate-600">→</span>
            <span className="rounded-lg bg-purple-950/60 px-3 py-1.5 text-purple-300 border border-purple-800/50">
              5. 外部生态系统联动 (MCP 插件)
            </span>
          </div>
        </div>
      </main>

      {/* 确保客户端完全挂载后再渲染 CopilotKit，彻底避免 SSR Hydration Mismatch */}
      {mounted && (
        <CopilotKit runtimeUrl="/api/copilotkit">
          <CopilotSidebar
            instructions="你是由 DeepSeek Harness 官方 Cordis 插件微内核驱动的个人全自主智能体驾驶舱助手 (agtpilot)。你拥有业界 SOTA 级的原子工具矩阵：Exa/Tavily 神经搜索、Firecrawl 网页爬取、Stagehand 网页操作、E2B 云端沙箱计算、本地命令与代码解释器，以及 Anthropic MCP 协议扩展。你可以自主规划多步任务并安全执行。"
            labels={{
              title: 'agtpilot 驾驶舱',
              initial: '你好！我是你的个人全自主智能体。我已经接入业界顶级 SOTA 能力矩阵：Anthropic MCP 协议、E2B 云端微容器代码解释器、Exa/Tavily 神经检索、Firecrawl 网页清洗与 Stagehand AI 浏览器。请在下方输入你想要我执行的任务。',
            }}
            defaultOpen={true}
            clickOutsideToClose={false}
          />
        </CopilotKit>
      )}
    </div>
  );
}
