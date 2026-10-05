'use client';

import { CopilotKit } from '@copilotkit/react-core';
import { CopilotSidebar } from '@copilotkit/react-ui';
import { Globe, Shield, Terminal, Zap, Bot, Layers } from 'lucide-react';

export default function Home() {
  return (
    <CopilotKit runtimeUrl="/api/copilotkit">
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
                  Ready
                </span>
              </h1>
              <p className="text-xs text-slate-400">DeepSeek Harness + CopilotKit UI + Playwright</p>
            </div>
          </div>
          <div className="flex items-center gap-4 text-xs text-slate-400">
            <span className="flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full bg-emerald-500"></span>
              Microkernel Active
            </span>
          </div>
        </header>

        {/* Main Dashboard Workspace */}
        <main className="flex-1 p-8 max-w-6xl mx-auto w-full">
          <div className="mb-8">
            <h2 className="text-3xl font-extrabold text-white tracking-tight sm:text-4xl mb-2">
              个人全自主智能体驾驶舱
            </h2>
            <p className="text-base text-slate-400">
              点击右侧 Copilot 边栏下发自然语言任务，Agent 将调用原子浏览器插件与沙盒进行全自主执行。
            </p>
          </div>

          {/* Atomic Capabilities Grid */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-12">
            <div className="rounded-2xl border border-slate-800 bg-slate-900/50 p-6 backdrop-blur transition-all hover:border-slate-700">
              <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-indigo-500/10 text-indigo-400 mb-4 border border-indigo-500/20">
                <Globe className="h-6 w-6" />
              </div>
              <h3 className="text-lg font-semibold text-white mb-2">持久化浏览器</h3>
              <p className="text-sm text-slate-400">
                由 Playwright 与 Stagehand 驱动，保持登录状态、自动蒸馏网页 Markdown 与执行复杂交互动作。
              </p>
            </div>

            <div className="rounded-2xl border border-slate-800 bg-slate-900/50 p-6 backdrop-blur transition-all hover:border-slate-700">
              <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-purple-500/10 text-purple-400 mb-4 border border-purple-500/20">
                <Layers className="h-6 w-6" />
              </div>
              <h3 className="text-lg font-semibold text-white mb-2">Cordis 插件底座</h3>
              <p className="text-sm text-slate-400">
                基于 DeepSeek Harness 官方插件微内核，全生命周期动态挂载、类型安全与依赖注入。
              </p>
            </div>

            <div className="rounded-2xl border border-slate-800 bg-slate-900/50 p-6 backdrop-blur transition-all hover:border-slate-700">
              <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-emerald-500/10 text-emerald-400 mb-4 border border-emerald-500/20">
                <Shield className="h-6 w-6" />
              </div>
              <h3 className="text-lg font-semibold text-white mb-2">安全审批与防熔断</h3>
              <p className="text-sm text-slate-400">
                内置 Loop Detector 防死循环机制，高危敏感操作原地冻结等待人类审批确认。
              </p>
            </div>
          </div>
        </main>

        {/* CopilotKit Embedded Sidebar */}
        <CopilotSidebar
          instructions="你是由 DeepSeek Harness 和 Cordis 微内核驱动的个人自主 Agent 助理。你可以自主规划并调用浏览器自动化工具完成复杂调研任务。"
          labels={{
            title: 'agtpilot Assistant',
            initial: '你好！我是你的个人全自主智能体。请输入你想要我帮你调研或执行的任务（例如：“帮我检索今天的 Hacker News 头条新闻”）。',
          }}
          defaultOpen={true}
          clickOutsideToClose={false}
        />
      </div>
    </CopilotKit>
  );
}
