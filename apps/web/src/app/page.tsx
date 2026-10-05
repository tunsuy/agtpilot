'use client';

import { useState, useEffect } from 'react';
import { CopilotKit } from '@copilotkit/react-core';
import { CopilotSidebar } from '@copilotkit/react-ui';
import {
  Globe,
  Shield,
  Bot,
  Layers,
  Search,
  Terminal,
  Zap,
  LayoutTemplate,
  CheckCircle2,
  Clock,
  Brain,
  Timer,
  Activity,
  Code2,
  Copy,
  Check,
  Eye,
  FileText,
  Sparkles,
  Users,
  GitBranch,
  GitCommit,
  GitPullRequest,
  Bell,
  Monitor,
  Cpu,
  Database,
  SlidersHorizontal,
  FolderOpen,
} from 'lucide-react';

interface Artifact {
  title: string;
  type: 'code' | 'html' | 'markdown' | 'chart' | 'diff';
  content: string;
  language?: string;
  description?: string;
}

interface PlanTaskItem {
  id: string;
  title: string;
  description?: string;
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  subagent?: string;
}

export default function Home() {
  const [mounted, setMounted] = useState(false);
  const [activeTab, setActiveTab] = useState<'canvas' | 'planner' | 'memory' | 'cron' | 'desktop' | 'trace'>('canvas');
  const [copied, setCopied] = useState(false);
  const [previewMode, setPreviewMode] = useState<'render' | 'raw'>('render');
  const [modelTier, setModelTier] = useState<'reasoning' | 'fast' | 'local'>('fast');

  // 当前主屏展示的生成式产物 (Artifact / Git Diff)
  const [currentArtifact, setCurrentArtifact] = useState<Artifact>({
    title: '自主研发个人智能体全栈 SOTA 架构方案',
    type: 'markdown',
    content: `# agtpilot: 工业级个人全自主智能体系统

## 1. 核心底座设计
本系统基于 **DeepSeek Harness 官方 Cordis 插件微内核** 构建，通过解耦的插件架构装配了 **43 个顶尖原子工具**。

### 10 大核心能力矩阵:
1. **开放协议**: Anthropic 官方 MCP SDK (\`@modelcontextprotocol/sdk\`)，stdio/SSE 动态注入
2. **隔离沙箱**: E2B 云端 Firecracker MicroVM + 本地安全 Node/Python 执行器
3. **神经搜索**: Exa 向量检索 + Tavily 研究级检索 + 零 Key DuckDuckGo 智能降级
4. **智能浏览器**: Firecrawl 网页蒸馏 + Stagehand AI 语义操作 + Playwright 持久化
5. **代码工程**: Git 补丁引擎 (Aider 范式)、符号全文检索、Checkpoint 分支快照
6. **通知中枢**: 飞书/企微/钉钉/Slack Webhook 卡片与 OS 原生桌面弹窗
7. **私有知识**: 本地文件切片分块与本地向量相似度检索 (Local RAG)
8. **原生桌面**: 操作系统全屏截图、本地剪贴板读写、本地 App 唤醒 (Computer Use)
9. **智能路由**: 多模型梯度切换 (DeepSeek-R1 / V3 / Ollama) 与 Token 预算熔断
10. **状态机编排**: 自研透明 ReAct 状态机 + Loop Detector 重复熔断 + 人工实时审批

## 2. 状态机执行流
\`\`\`text
意图解析 → 任务拆解(Planner) → 知识召回(RAG) → 神经搜索(Exa) → 沙箱执行(E2B) → Git补丁应用(Git) → 画布呈现(Artifact) → 飞书通知(Notify)
\`\`\`
`,
    description: 'Cordis 微内核与 15 大核心插件驱动的个人全自主智能体终极形态架构设计。',
  });

  // 任务规划看板数据 (Planner Checklist)
  const [planTasks] = useState<PlanTaskItem[]>([
    {
      id: 'step_1',
      title: '复杂用户意图拆解与目标锚定',
      description: '分析自然语言指令，规划 4 个执行步骤并校验前置依赖',
      status: 'completed',
    },
    {
      id: 'step_2',
      title: '全网神经语义检索与结构化资料收集',
      description: '调用 Exa 与 Tavily 引擎检索最新 SOTA 库技术文档与最佳实践',
      status: 'completed',
      subagent: 'WebResearcher',
    },
    {
      id: 'step_3',
      title: '代码库精准补丁应用与单元测试',
      description: '使用 git_apply_patch 实施局部代码补丁，并在沙箱中验证构建',
      status: 'in_progress',
      subagent: 'SWE-Engineer',
    },
    {
      id: 'step_4',
      title: '中心画布高保真呈现与飞书告警通知',
      description: '在中心工作区呈现 Visual Diff，并通过飞书机器人推送通知卡片',
      status: 'pending',
    },
  ]);

  // 长期记忆数据 (Memory Vault)
  const [memories] = useState([
    { category: 'PREFERENCE', title: '技术栈偏好', content: '前端采用 Next.js 15 App Router + Tailwind CSS，包管理强制使用 pnpm。' },
    { category: 'RULE', title: '安全执行红线', content: '高危 Shell 指令（如 rm, kill, drop）必须触发 Human-in-the-Loop 审批拦截。' },
    { category: 'PROJECT', title: '微内核架构规范', content: '严禁引入重型单体框架，必须基于 @deepseek-ai/cordis 插件机制扩展。' },
    { category: 'FACT', title: '开发环境凭证', content: '已接入 E2B Cloud Sandbox 与 Firecrawl API Key，优先选用云端微容器。' },
  ]);

  // 定时任务数据 (Cron Tasks)
  const [cronJobs] = useState([
    { name: '每日 GitHub AI 趋势早报', pattern: '0 9 * * *', status: 'ACTIVE', nextRun: '明天 09:00:00', runCount: 12 },
    { name: '云端服务器健康与资源巡检', pattern: '*/30 * * * *', status: 'ACTIVE', nextRun: '22 分钟后', runCount: 84 },
  ]);

  useEffect(() => {
    setMounted(true);
  }, []);

  const handleCopyCode = () => {
    navigator.clipboard.writeText(currentArtifact.content);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const completedCount = planTasks.filter((t) => t.status === 'completed').length;
  const progressPercent = Math.round((completedCount / planTasks.length) * 100);

  return (
    <div className="flex min-h-screen flex-col bg-slate-950 text-slate-100">
      {/* 顶部导航栏 */}
      <header className="flex h-16 items-center justify-between border-b border-slate-800 px-6 backdrop-blur sticky top-0 z-30 bg-slate-950/80">
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
            <p className="text-xs text-slate-400">DeepSeek Cordis 微内核 + CopilotKit UI + 43 顶尖原子能力</p>
          </div>
        </div>

        {/* 导航标签切换 */}
        <div className="flex items-center gap-1 rounded-xl bg-slate-900 p-1 border border-slate-800 text-xs">
          <button
            onClick={() => setActiveTab('canvas')}
            className={`flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 font-medium transition-all ${
              activeTab === 'canvas' ? 'bg-indigo-600 text-white shadow-sm' : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <LayoutTemplate className="h-3.5 w-3.5" /> 产物画布
          </button>
          <button
            onClick={() => setActiveTab('planner')}
            className={`flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 font-medium transition-all ${
              activeTab === 'planner' ? 'bg-indigo-600 text-white shadow-sm' : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <CheckCircle2 className="h-3.5 w-3.5" /> 任务看板
          </button>
          <button
            onClick={() => setActiveTab('memory')}
            className={`flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 font-medium transition-all ${
              activeTab === 'memory' ? 'bg-indigo-600 text-white shadow-sm' : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <Brain className="h-3.5 w-3.5" /> 长期记忆/RAG
          </button>
          <button
            onClick={() => setActiveTab('cron')}
            className={`flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 font-medium transition-all ${
              activeTab === 'cron' ? 'bg-indigo-600 text-white shadow-sm' : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <Timer className="h-3.5 w-3.5" /> 定时/通知
          </button>
          <button
            onClick={() => setActiveTab('desktop')}
            className={`flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 font-medium transition-all ${
              activeTab === 'desktop' ? 'bg-indigo-600 text-white shadow-sm' : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <Monitor className="h-3.5 w-3.5" /> 桌面/路由
          </button>
          <button
            onClick={() => setActiveTab('trace')}
            className={`flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 font-medium transition-all ${
              activeTab === 'trace' ? 'bg-indigo-600 text-white shadow-sm' : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <Activity className="h-3.5 w-3.5" /> 可观测追踪
          </button>
        </div>

        <div className="flex items-center gap-3 text-xs text-slate-400">
          <span className="flex items-center gap-1.5 rounded-full bg-emerald-500/10 px-3 py-1 text-emerald-400 border border-emerald-500/20 font-mono">
            <span className="h-2 w-2 rounded-full bg-emerald-400 animate-pulse"></span>
            43 Tools Active
          </span>
        </div>
      </header>

      {/* 主屏控制中心工作区 */}
      <main className="flex-1 p-6 max-w-7xl mx-auto w-full">
        {/* TAB 1: 生成式产物中心画布 (Artifact Canvas & Git Diff) */}
        {activeTab === 'canvas' && (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <div className="flex items-center gap-2">
                  <span className="rounded-md bg-purple-500/10 px-2.5 py-0.5 text-xs font-mono font-semibold text-purple-400 border border-purple-500/20 uppercase">
                    {currentArtifact.type}
                  </span>
                  <h2 className="text-xl font-bold text-white">{currentArtifact.title}</h2>
                </div>
                {currentArtifact.description && (
                  <p className="text-xs text-slate-400 mt-1">{currentArtifact.description}</p>
                )}
              </div>

              <div className="flex items-center gap-2">
                {currentArtifact.type === 'html' && (
                  <div className="flex items-center rounded-lg bg-slate-900 border border-slate-800 p-0.5 text-xs">
                    <button
                      onClick={() => setPreviewMode('render')}
                      className={`px-2.5 py-1 rounded-md transition-all ${
                        previewMode === 'render' ? 'bg-indigo-600 text-white' : 'text-slate-400'
                      }`}
                    >
                      <Eye className="h-3.5 w-3.5 inline mr-1" /> 实时预览
                    </button>
                    <button
                      onClick={() => setPreviewMode('raw')}
                      className={`px-2.5 py-1 rounded-md transition-all ${
                        previewMode === 'raw' ? 'bg-indigo-600 text-white' : 'text-slate-400'
                      }`}
                    >
                      <Code2 className="h-3.5 w-3.5 inline mr-1" /> 查看源码
                    </button>
                  </div>
                )}
                <button
                  onClick={handleCopyCode}
                  className="flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-800/80 px-3 py-1.5 text-xs font-medium text-slate-200 hover:bg-slate-700 transition-all"
                >
                  {copied ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <Copy className="h-3.5 w-3.5" />}
                  {copied ? '已复制' : '复制代码/内容'}
                </button>
              </div>
            </div>

            {/* 产物主渲染视口 */}
            <div className="rounded-2xl border border-slate-800 bg-slate-900/60 overflow-hidden shadow-2xl backdrop-blur min-h-[560px] flex flex-col">
              {currentArtifact.type === 'html' && previewMode === 'render' ? (
                <iframe
                  title="Artifact Live Sandbox Preview"
                  srcDoc={currentArtifact.content}
                  sandbox="allow-scripts allow-modals"
                  className="w-full flex-1 min-h-[560px] bg-white rounded-b-2xl border-0"
                />
              ) : currentArtifact.type === 'diff' ? (
                <div className="p-6 font-mono text-xs leading-relaxed overflow-x-auto whitespace-pre text-slate-200 flex-1">
                  {currentArtifact.content.split('\n').map((line, idx) => {
                    const isAdd = line.startsWith('+');
                    const isDel = line.startsWith('-');
                    return (
                      <div
                        key={idx}
                        className={`px-2 py-0.5 rounded ${
                          isAdd
                            ? 'bg-emerald-950/70 text-emerald-300 font-semibold'
                            : isDel
                            ? 'bg-rose-950/70 text-rose-300'
                            : 'text-slate-400'
                        }`}
                      >
                        {line}
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="p-6 font-mono text-xs leading-relaxed overflow-x-auto whitespace-pre-wrap text-slate-200 flex-1">
                  {currentArtifact.content}
                </div>
              )}
            </div>

            {/* 快速产物演示切换器 */}
            <div className="flex items-center gap-2 pt-2 flex-wrap">
              <span className="text-xs text-slate-500">示例产物快速预览:</span>
              <button
                onClick={() =>
                  setCurrentArtifact({
                    title: '交互式数据可视化仪表盘 (HTML Demo)',
                    type: 'html',
                    content: `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><script src="https://cdn.tailwindcss.com"></script></head>
<body class="bg-slate-950 text-white p-6 font-sans">
  <div class="max-w-md mx-auto rounded-xl bg-slate-900 border border-slate-800 p-5 shadow-xl">
    <div class="flex items-center justify-between mb-4">
      <h3 class="text-sm font-bold text-indigo-400">实时系统吞吐量</h3>
      <span class="text-xs bg-emerald-500/20 text-emerald-400 px-2 py-0.5 rounded-full">正常运行</span>
    </div>
    <div class="text-3xl font-extrabold text-white mb-2">1,420 <span class="text-xs text-slate-400 font-normal">req/s</span></div>
    <div class="w-full bg-slate-800 h-2 rounded-full overflow-hidden mb-4">
      <div class="bg-gradient-to-r from-indigo-500 to-purple-500 h-full w-[78%]"></div>
    </div>
    <div class="grid grid-cols-2 gap-3 text-xs text-slate-400">
      <div class="p-2 bg-slate-950/60 rounded-lg">平均延迟: <span class="text-white font-bold">18ms</span></div>
      <div class="p-2 bg-slate-950/60 rounded-lg">CPU占用率: <span class="text-white font-bold">24%</span></div>
    </div>
  </div>
</body>
</html>`,
                    description: '使用 artifact_render 动态生成的轻量级 HTML 可交互监控小组件。',
                  })
                }
                className="rounded-lg bg-slate-900 border border-slate-800 px-2.5 py-1 text-xs text-slate-300 hover:border-indigo-500/50 hover:text-white"
              >
                🎨 HTML 交互监控卡
              </button>
              <button
                onClick={() =>
                  setCurrentArtifact({
                    title: 'Git 补丁差异审查 (Visual Unified Diff Review)',
                    type: 'diff',
                    content: `--- a/packages/core/src/index.ts
+++ b/packages/core/src/index.ts
@@ -102,6 +102,9 @@ export class OrchestratorService extends Service {
+    // 1. 触发自研死循环熔断器检查 (Loop Detector)
+    if (this.loopDetector.isLooping(toolName, args)) {
+      throw new Error('检测到连续 3 次相同参数调用，自动触发状态机熔断保护！');
+    }
-    console.log('执行工具调用...');
+    this.ctx.agent.emitEvent({ type: 'tool_call', payload: { toolName, args } });`,
                    description: '基于 git_diff 与 Aider 补丁机制生成的代码变动审查卡。',
                  })
                }
                className="rounded-lg bg-slate-900 border border-slate-800 px-2.5 py-1 text-xs text-slate-300 hover:border-indigo-500/50 hover:text-white"
              >
                🔀 Git Diff 审查卡
              </button>
              <button
                onClick={() =>
                  setCurrentArtifact({
                    title: '自研 ReAct 死循环熔断器算法 (TypeScript)',
                    type: 'code',
                    language: 'typescript',
                    content: `export class LoopDetector {
  private history: string[] = [];

  recordAndCheck(toolName: string, args: Record<string, any>): boolean {
    const hash = \`\${toolName}:\${JSON.stringify(args)}\`;
    this.history.push(hash);
    if (this.history.length > 3) this.history.shift();
    return this.history.length === 3 && this.history[0] === hash && this.history[1] === hash && this.history[2] === hash;
  }
}`,
                    description: '核心 Orchestrator 状态机内置的高可用防死循环算法。',
                  })
                }
                className="rounded-lg bg-slate-900 border border-slate-800 px-2.5 py-1 text-xs text-slate-300 hover:border-indigo-500/50 hover:text-white"
              >
                💻 TS 熔断器源码
              </button>
            </div>
          </div>
        )}

        {/* TAB 2: 任务规划看板与多智能体分工 (Todo Planning Checklist) */}
        {activeTab === 'planner' && (
          <div className="space-y-6">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-xl font-bold text-white flex items-center gap-2">
                  <CheckCircle2 className="h-5 w-5 text-indigo-400" />
                  自主任务规划看板 (Todo Checklist)
                </h2>
                <p className="text-xs text-slate-400 mt-1">
                  Agent 在执行复杂多步骤任务时，通过 planner_create_plan 显式拆解为透明待办树，杜绝黑盒等待。
                </p>
              </div>
              <div className="text-right">
                <span className="text-xs text-slate-400">总体完成进度</span>
                <div className="text-lg font-bold text-emerald-400 font-mono">
                  {completedCount}/{planTasks.length} ({progressPercent}%)
                </div>
              </div>
            </div>

            {/* 总体进度条 */}
            <div className="w-full bg-slate-900 h-2.5 rounded-full overflow-hidden border border-slate-800">
              <div
                className="bg-gradient-to-r from-indigo-500 to-emerald-400 h-full transition-all duration-500"
                style={{ width: `${progressPercent}%` }}
              ></div>
            </div>

            {/* 步骤清单 */}
            <div className="space-y-3">
              {planTasks.map((task, index) => {
                const isCompleted = task.status === 'completed';
                const isInProgress = task.status === 'in_progress';
                return (
                  <div
                    key={task.id}
                    className={`rounded-2xl border p-5 transition-all ${
                      isInProgress
                        ? 'border-indigo-500 bg-indigo-950/20 shadow-lg shadow-indigo-500/10'
                        : isCompleted
                        ? 'border-slate-800/80 bg-slate-900/40 opacity-80'
                        : 'border-slate-800 bg-slate-900/20 text-slate-500'
                    }`}
                  >
                    <div className="flex items-start justify-between">
                      <div className="flex items-start gap-3">
                        <div className="mt-0.5">
                          {isCompleted ? (
                            <CheckCircle2 className="h-5 w-5 text-emerald-400" />
                          ) : isInProgress ? (
                            <div className="h-5 w-5 rounded-full border-2 border-indigo-400 border-t-transparent animate-spin" />
                          ) : (
                            <Clock className="h-5 w-5 text-slate-600" />
                          )}
                        </div>
                        <div>
                          <div className="flex items-center gap-2">
                            <span className="text-xs font-mono font-bold text-slate-500">步骤 {index + 1}</span>
                            <h4
                              className={`text-sm font-semibold ${
                                isCompleted ? 'text-slate-300 line-through' : 'text-white'
                              }`}
                            >
                              {task.title}
                            </h4>
                            {task.subagent && (
                              <span className="rounded-md bg-purple-500/10 px-2 py-0.5 text-[10px] font-mono text-purple-400 border border-purple-500/20 flex items-center gap-1">
                                <Users className="h-3 w-3" /> 子智能体: {task.subagent}
                              </span>
                            )}
                          </div>
                          {task.description && (
                            <p className="text-xs text-slate-400 mt-1 leading-relaxed">{task.description}</p>
                          )}
                        </div>
                      </div>

                      <span
                        className={`rounded-full px-2.5 py-0.5 text-[11px] font-mono font-medium ${
                          isCompleted
                            ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
                            : isInProgress
                            ? 'bg-indigo-500/10 text-indigo-400 border border-indigo-500/20 animate-pulse'
                            : 'bg-slate-800 text-slate-500'
                        }`}
                      >
                        {task.status.toUpperCase()}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* TAB 3: 长期记忆库与本地 RAG (Memory Vault & Local RAG) */}
        {activeTab === 'memory' && (
          <div className="space-y-6">
            <div>
              <h2 className="text-xl font-bold text-white flex items-center gap-2">
                <Brain className="h-5 w-5 text-purple-400" />
                跨会话长期记忆与本地 RAG 知识库
              </h2>
              <p className="text-xs text-slate-400 mt-1">
                支持对用户个人偏好持久化（Memory Vault）与对本地 Markdown/代码库做切片分块语义检索（Local RAG）。
              </p>
            </div>

            {/* 本地 RAG 搜索框 */}
            <div className="rounded-2xl border border-slate-800 bg-slate-900/50 p-5 backdrop-blur">
              <h3 className="text-sm font-semibold text-white mb-2 flex items-center gap-2">
                <Database className="h-4 w-4 text-cyan-400" /> 本地私有文档语义切片检索 (rag_search)
              </h3>
              <div className="flex gap-2">
                <input
                  type="text"
                  placeholder="在本地私有文档库中检索知识 (例如: '系统如何防范死循环?')"
                  defaultValue="系统如何防范死循环?"
                  className="flex-1 rounded-xl bg-slate-950 border border-slate-800 px-4 py-2 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-indigo-500"
                />
                <button className="rounded-xl bg-indigo-600 px-4 py-2 text-xs font-semibold text-white hover:bg-indigo-500">
                  语义召回
                </button>
              </div>
              <div className="mt-3 p-3 rounded-xl bg-slate-950/80 border border-slate-800 text-xs text-slate-300 font-mono">
                <div className="text-[10px] text-cyan-400 font-bold mb-1">召回片段 [Score: 0.92] (来源: docs/architecture.md):</div>
                “系统内置 LoopDetector 模块，只要检测到模型对相同工具传入完全一致的参数连续超过 3 次，立即熔断截流，并向用户广播告警事件。”
              </div>
            </div>

            {/* 长期偏好记忆卡片 */}
            <h3 className="text-sm font-semibold text-slate-300">已沉淀的跨会话偏好记忆 (memory_store)</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {memories.map((mem, idx) => (
                <div
                  key={idx}
                  className="rounded-2xl border border-slate-800 bg-slate-900/50 p-5 backdrop-blur hover:border-purple-500/40 transition-all"
                >
                  <span className="rounded-md bg-purple-500/10 px-2 py-0.5 text-[10px] font-mono text-purple-400 border border-purple-500/20 uppercase font-semibold">
                    {mem.category}
                  </span>
                  <h4 className="text-sm font-semibold text-white mt-2 mb-1">{mem.title}</h4>
                  <p className="text-xs text-slate-400 leading-relaxed">{mem.content}</p>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* TAB 4: 定时巡检与通知中枢 (Cron Watcher & Multi-Channel Webhooks) */}
        {activeTab === 'cron' && (
          <div className="space-y-6">
            <div>
              <h2 className="text-xl font-bold text-white flex items-center gap-2">
                <Timer className="h-5 w-5 text-amber-400" />
                后台主动定时巡检守护与通知中枢 (Cron & Multi-Channel Notify)
              </h2>
              <p className="text-xs text-slate-400 mt-1">
                基于 Croner 驱动的后台无人值守主动触发，并通过飞书/钉钉/企微/Slack 及 OS 桌面原生弹窗同步结果。
              </p>
            </div>

            {/* 通知渠道状态 */}
            <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
              <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-4 flex items-center gap-3">
                <div className="h-8 w-8 rounded-lg bg-blue-500/10 text-blue-400 flex items-center justify-center border border-blue-500/20">
                  <Bell className="h-4 w-4" />
                </div>
                <div>
                  <div className="text-xs font-semibold text-white">飞书卡片 Webhook</div>
                  <div className="text-[11px] text-emerald-400">已就绪 (FEISHU)</div>
                </div>
              </div>
              <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-4 flex items-center gap-3">
                <div className="h-8 w-8 rounded-lg bg-cyan-500/10 text-cyan-400 flex items-center justify-center border border-cyan-500/20">
                  <Bell className="h-4 w-4" />
                </div>
                <div>
                  <div className="text-xs font-semibold text-white">钉钉群机器人</div>
                  <div className="text-[11px] text-emerald-400">已就绪 (DINGTALK)</div>
                </div>
              </div>
              <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-4 flex items-center gap-3">
                <div className="h-8 w-8 rounded-lg bg-emerald-500/10 text-emerald-400 flex items-center justify-center border border-emerald-500/20">
                  <Bell className="h-4 w-4" />
                </div>
                <div>
                  <div className="text-xs font-semibold text-white">企业微信机器人</div>
                  <div className="text-[11px] text-emerald-400">已就绪 (WECOM)</div>
                </div>
              </div>
              <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-4 flex items-center gap-3">
                <div className="h-8 w-8 rounded-lg bg-purple-500/10 text-purple-400 flex items-center justify-center border border-purple-500/20">
                  <Monitor className="h-4 w-4" />
                </div>
                <div>
                  <div className="text-xs font-semibold text-white">macOS 桌面弹窗</div>
                  <div className="text-[11px] text-emerald-400">原生支持 (osascript)</div>
                </div>
              </div>
            </div>

            {/* 定时巡检任务列表 */}
            <div className="space-y-4">
              {cronJobs.map((job, idx) => (
                <div
                  key={idx}
                  className="rounded-2xl border border-slate-800 bg-slate-900/50 p-5 backdrop-blur flex items-center justify-between"
                >
                  <div>
                    <div className="flex items-center gap-2">
                      <h4 className="text-sm font-semibold text-white">{job.name}</h4>
                      <span className="rounded bg-slate-800 px-2 py-0.5 text-xs font-mono text-amber-400 border border-slate-700">
                        {job.pattern}
                      </span>
                    </div>
                    <div className="flex items-center gap-4 text-xs text-slate-400 mt-2">
                      <span>下次触发: <strong className="text-slate-200">{job.nextRun}</strong></span>
                      <span>已累计触发: <strong className="text-slate-200">{job.runCount} 次</strong></span>
                    </div>
                  </div>

                  <span className="rounded-full bg-emerald-500/10 px-3 py-1 text-xs font-semibold text-emerald-400 border border-emerald-500/20 font-mono">
                    {job.status}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* TAB 5: 桌面原生控制与模型梯度路由 (Desktop & Model Router) */}
        {activeTab === 'desktop' && (
          <div className="space-y-6">
            <div>
              <h2 className="text-xl font-bold text-white flex items-center gap-2">
                <Monitor className="h-5 w-5 text-indigo-400" />
                桌面原生控制 (Computer Use) 与模型能级路由
              </h2>
              <p className="text-xs text-slate-400 mt-1">
                支持操作系统级全屏截屏、剪贴板交互、本地应用唤醒与多模型分级动态调度。
              </p>
            </div>

            {/* 1. 模型分级路由梯度选择 */}
            <div className="rounded-2xl border border-slate-800 bg-slate-900/50 p-5 backdrop-blur">
              <h3 className="text-sm font-semibold text-white mb-3 flex items-center gap-2">
                <SlidersHorizontal className="h-4 w-4 text-purple-400" /> 模型分级路由与预算熔断 (router_select_tier)
              </h3>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                <div
                  onClick={() => setModelTier('reasoning')}
                  className={`cursor-pointer rounded-xl border p-4 transition-all ${
                    modelTier === 'reasoning'
                      ? 'border-purple-500 bg-purple-950/20 shadow-md shadow-purple-500/20'
                      : 'border-slate-800 bg-slate-950/50 hover:border-slate-700'
                  }`}
                >
                  <div className="text-xs font-bold text-purple-400 uppercase">Tier 1: 深度推理 (Reasoning)</div>
                  <div className="text-sm font-semibold text-white mt-1">DeepSeek-R1 / OpenAI o1</div>
                  <p className="text-[11px] text-slate-400 mt-2">专为复杂架构规划、多步骤数学推理与代码审查设计。</p>
                </div>

                <div
                  onClick={() => setModelTier('fast')}
                  className={`cursor-pointer rounded-xl border p-4 transition-all ${
                    modelTier === 'fast'
                      ? 'border-indigo-500 bg-indigo-950/20 shadow-md shadow-indigo-500/20'
                      : 'border-slate-800 bg-slate-950/50 hover:border-slate-700'
                  }`}
                >
                  <div className="text-xs font-bold text-indigo-400 uppercase">Tier 2: 极速响应 (Fast / Daily)</div>
                  <div className="text-sm font-semibold text-white mt-1">DeepSeek-V3 / GPT-4o-mini</div>
                  <p className="text-[11px] text-slate-400 mt-2">日常工具调用、网页浏览与即时交互，高吞吐低延迟。</p>
                </div>

                <div
                  onClick={() => setModelTier('local')}
                  className={`cursor-pointer rounded-xl border p-4 transition-all ${
                    modelTier === 'local'
                      ? 'border-emerald-500 bg-emerald-950/20 shadow-md shadow-emerald-500/20'
                      : 'border-slate-800 bg-slate-950/50 hover:border-slate-700'
                  }`}
                >
                  <div className="text-xs font-bold text-emerald-400 uppercase">Tier 3: 隐私离线 (Local Ollama)</div>
                  <div className="text-sm font-semibold text-white mt-1">Qwen2.5-Coder / Llama 3</div>
                  <p className="text-[11px] text-slate-400 mt-2">数据不出本地，敏感凭证与离线环境安全运行。</p>
                </div>
              </div>
            </div>

            {/* 2. 操作系统宿主机状态 */}
            <div className="rounded-2xl border border-slate-800 bg-slate-900/50 p-5 backdrop-blur">
              <h3 className="text-sm font-semibold text-white mb-3 flex items-center gap-2">
                <Cpu className="h-4 w-4 text-emerald-400" /> 宿主操作系统环境指标 (desktop_system_info)
              </h3>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-xs font-mono">
                <div className="p-3 bg-slate-950/60 rounded-xl border border-slate-800">
                  <span className="text-slate-400 block mb-1">系统平台</span>
                  <span className="text-white font-bold text-sm">macOS (Darwin / arm64)</span>
                </div>
                <div className="p-3 bg-slate-950/60 rounded-xl border border-slate-800">
                  <span className="text-slate-400 block mb-1">可用物理内存</span>
                  <span className="text-emerald-400 font-bold text-sm">32 GB 总量 / 14 GB 空闲</span>
                </div>
                <div className="p-3 bg-slate-950/60 rounded-xl border border-slate-800">
                  <span className="text-slate-400 block mb-1">全屏视觉截屏</span>
                  <span className="text-white font-bold text-sm">desktop_screenshot 可用</span>
                </div>
                <div className="p-3 bg-slate-950/60 rounded-xl border border-slate-800">
                  <span className="text-slate-400 block mb-1">剪贴板与应用</span>
                  <span className="text-indigo-400 font-bold text-sm">pbcopy / open 可用</span>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* TAB 6: 全链路追踪与可观测性 (Trace & Observability) */}
        {activeTab === 'trace' && (
          <div className="space-y-6">
            <div>
              <h2 className="text-xl font-bold text-white flex items-center gap-2">
                <Activity className="h-5 w-5 text-cyan-400" />
                全链路可观测性仪表盘 (Trace & Observability)
              </h2>
              <p className="text-xs text-slate-400 mt-1">
                实时捕获智能体 ReAct 状态机每次事件流转、工具调用开销与健康状态。
              </p>
            </div>

            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-4">
                <div className="text-xs text-slate-400">系统健康度</div>
                <div className="text-2xl font-bold text-emerald-400 mt-1">100% HEALTHY</div>
              </div>
              <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-4">
                <div className="text-xs text-slate-400">已装配原子工具</div>
                <div className="text-2xl font-bold text-white mt-1">43 TOOLS</div>
              </div>
              <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-4">
                <div className="text-xs text-slate-400">累计调用事件</div>
                <div className="text-2xl font-bold text-indigo-400 mt-1">218 SPANS</div>
              </div>
              <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-4">
                <div className="text-xs text-slate-400">循环调用熔断拦截</div>
                <div className="text-2xl font-bold text-purple-400 mt-1">0 BREAKS</div>
              </div>
            </div>

            <div className="rounded-2xl border border-slate-800 bg-slate-900/50 p-5 backdrop-blur">
              <h4 className="text-sm font-semibold text-white mb-3">实时 Span 瀑布流追踪 (最近 5 条)</h4>
              <div className="space-y-2 font-mono text-xs">
                <div className="flex items-center justify-between p-2.5 rounded-lg bg-slate-950/60 border border-slate-800/80">
                  <span className="text-cyan-400">event:tool_call [git_diff]</span>
                  <span className="text-slate-400">耗时: 18ms | 状态: OK</span>
                </div>
                <div className="flex items-center justify-between p-2.5 rounded-lg bg-slate-950/60 border border-slate-800/80">
                  <span className="text-purple-400">event:tool_call [artifact_render]</span>
                  <span className="text-slate-400">耗时: 14ms | 状态: OK</span>
                </div>
                <div className="flex items-center justify-between p-2.5 rounded-lg bg-slate-950/60 border border-slate-800/80">
                  <span className="text-emerald-400">event:tool_call [notify_send_desktop]</span>
                  <span className="text-slate-400">耗时: 42ms | 状态: OK</span>
                </div>
                <div className="flex items-center justify-between p-2.5 rounded-lg bg-slate-950/60 border border-slate-800/80">
                  <span className="text-amber-400">event:tool_call [rag_search]</span>
                  <span className="text-slate-400">耗时: 8ms | 状态: OK</span>
                </div>
                <div className="flex items-center justify-between p-2.5 rounded-lg bg-slate-950/60 border border-slate-800/80">
                  <span className="text-indigo-400">event:thought [ModelStepResult]</span>
                  <span className="text-slate-400">耗时: 980ms | 状态: OK</span>
                </div>
              </div>
            </div>
          </div>
        )}
      </main>

      {/* 确保客户端完全挂载后再渲染 CopilotKit 侧边栏 */}
      {mounted && (
        <CopilotKit runtimeUrl="/api/copilotkit">
          <CopilotSidebar
            instructions="你是由 DeepSeek Harness 官方 Cordis 插件微内核驱动的个人全自主智能体驾驶舱助手 (agtpilot)。你拥有 43 个业界顶尖原子能力：包含 Git 补丁代码工程、飞书/企微/钉钉 Webhook 通知、本地 RAG 文档检索、桌面原生 Computer Use 截屏与剪贴板控制、多模型分级路由、E2B 云端微容器沙箱、Exa 神经搜索、Firecrawl 网页爬取、中心画布实时渲染、任务拆解看板以及长期记忆与定时巡检守护。你可以自主规划多步任务并安全执行。"
            labels={{
              title: 'agtpilot 驾驶舱',
              initial: '你好！我是你的个人全自主智能体。我已经接入 43 项业界顶尖原子能力（涵盖 Git 补丁引擎、多渠道通知外发、本地 RAG 检索、桌面级原生控制、模型分级路由、E2B 沙箱、Exa 神经搜索等）。请在下方输入你想要我执行的任务。',
            }}
            defaultOpen={true}
            clickOutsideToClose={false}
          />
        </CopilotKit>
      )}
    </div>
  );
}
