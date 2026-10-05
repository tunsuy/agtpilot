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
} from 'lucide-react';

interface Artifact {
  title: string;
  type: 'code' | 'html' | 'markdown' | 'chart';
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
  const [activeTab, setActiveTab] = useState<'canvas' | 'planner' | 'memory' | 'cron' | 'trace'>('canvas');
  const [copied, setCopied] = useState(false);
  const [previewMode, setPreviewMode] = useState<'render' | 'raw'>('render');

  // 当前主屏展示的生成式产物 (Artifact)
  const [currentArtifact, setCurrentArtifact] = useState<Artifact>({
    title: '自主研发个人智能体架构设计方案',
    type: 'markdown',
    content: `# agtpilot: 个人全自主智能体系统架构

## 1. 核心底座设计
本系统基于 **DeepSeek Harness 官方 Cordis 插件微内核** 构建，通过解耦的插件生态实现所有核心能力的插拔与装配。

### 核心能力矩阵:
* **开放协议**: Anthropic 官方 MCP SDK (\`@modelcontextprotocol/sdk\`)
* **隔离沙箱**: E2B 云端 Firecracker MicroVM + 本地安全 Node/Python 代码解释器
* **神经搜索**: Exa.ai 语义向量检索 + Tavily 研究级检索 + 零 Key DuckDuckGo 降级
* **智能浏览器**: Firecrawl 网页清洗 + Stagehand AI 语义操作 + Playwright 会话持久化
* **状态机编排**: 自研透明 ReAct 状态机 + Loop Detector 重复熔断 + Human-in-the-Loop 实时拦截
* **生成式产物**: 中心画布实时渲染 (Code / HTML / Markdown / Chart)
* **任务看板**: 结构化 Todo 拆解与多智能体 (Subagent) 协作调度
* **长期记忆**: 跨会话偏好持久化与上下文检索
* **定时主动任务**: 基于 Croner 的后台无人值守主动巡检
* **全链路观测**: 事件瀑布流 Trace 与实时监控指标

## 2. 状态机执行流
\`\`\`text
意图解析 → 任务看板拆解(Planner) → 检索/网页(Exa/Firecrawl) → 沙箱计算(E2B) → 画布生成(Artifact)
\`\`\`
`,
    description: 'Cordis 微内核与 10 大核心插件驱动的个人全自主智能体终极形态架构设计。',
  });

  // 任务规划看板数据 (Planner Checklist)
  const [planTasks, setPlanTasks] = useState<PlanTaskItem[]>([
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
      title: '云端 E2B 沙箱代码执行与图表计算',
      description: '在隔离微虚拟机中运行 Python 数据分析，捕获可视化产物',
      status: 'in_progress',
      subagent: 'PythonCoder',
    },
    {
      id: 'step_4',
      title: '中心画布高保真产物呈现与归档',
      description: '在中心工作区呈现最终代码、交互式页面与总结周报',
      status: 'pending',
    },
  ]);

  // 长期记忆数据 (Memory Vault)
  const [memories] = useState([
    { category: 'PREFERENCE', title: '技术栈偏好', content: '前端采用 Next.js 15 App Router + Tailwind CSS，包管理强制使用 pnpm。' },
    { category: 'RULE', title: '安全执行红线', content: '高危 Shell 指令（如 rm, kill, drop）必须触发 Human-in-the-Loop 审批拦截。' },
    { category: 'PROJECT', title: '微内核架构规范', content: '严禁引入重型单体框架，必须基于 @deepseek-ai/cordis 插件机制扩展。' },
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
            <p className="text-xs text-slate-400">DeepSeek Cordis 微内核 + CopilotKit UI + 29 顶尖原子能力</p>
          </div>
        </div>

        {/* 导航标签切换 */}
        <div className="flex items-center gap-1 rounded-xl bg-slate-900 p-1 border border-slate-800 text-xs">
          <button
            onClick={() => setActiveTab('canvas')}
            className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 font-medium transition-all ${
              activeTab === 'canvas' ? 'bg-indigo-600 text-white shadow-sm' : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <LayoutTemplate className="h-3.5 w-3.5" /> 产物画布
          </button>
          <button
            onClick={() => setActiveTab('planner')}
            className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 font-medium transition-all ${
              activeTab === 'planner' ? 'bg-indigo-600 text-white shadow-sm' : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <CheckCircle2 className="h-3.5 w-3.5" /> 任务看板
          </button>
          <button
            onClick={() => setActiveTab('memory')}
            className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 font-medium transition-all ${
              activeTab === 'memory' ? 'bg-indigo-600 text-white shadow-sm' : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <Brain className="h-3.5 w-3.5" /> 长期记忆
          </button>
          <button
            onClick={() => setActiveTab('cron')}
            className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 font-medium transition-all ${
              activeTab === 'cron' ? 'bg-indigo-600 text-white shadow-sm' : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <Timer className="h-3.5 w-3.5" /> 定时巡检
          </button>
          <button
            onClick={() => setActiveTab('trace')}
            className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 font-medium transition-all ${
              activeTab === 'trace' ? 'bg-indigo-600 text-white shadow-sm' : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <Activity className="h-3.5 w-3.5" /> 可观测追踪
          </button>
        </div>

        <div className="flex items-center gap-3 text-xs text-slate-400">
          <span className="flex items-center gap-1.5 rounded-full bg-emerald-500/10 px-3 py-1 text-emerald-400 border border-emerald-500/20 font-mono">
            <span className="h-2 w-2 rounded-full bg-emerald-400 animate-pulse"></span>
            29 Tools Active
          </span>
        </div>
      </header>

      {/* 主屏控制中心工作区 */}
      <main className="flex-1 p-6 max-w-7xl mx-auto w-full">
        {/* TAB 1: 生成式产物中心画布 (Artifact Canvas) */}
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
            <div className="rounded-2xl border border-slate-800 bg-slate-900/60 overflow-hidden shadow-2xl backdrop-blur min-h-[580px] flex flex-col">
              {currentArtifact.type === 'html' && previewMode === 'render' ? (
                <iframe
                  title="Artifact Live Sandbox Preview"
                  srcDoc={currentArtifact.content}
                  sandbox="allow-scripts allow-modals"
                  className="w-full flex-1 min-h-[580px] bg-white rounded-b-2xl border-0"
                />
              ) : (
                <div className="p-6 font-mono text-xs leading-relaxed overflow-x-auto whitespace-pre-wrap text-slate-200 flex-1">
                  {currentArtifact.content}
                </div>
              )}
            </div>

            {/* 快速产物演示切换器 */}
            <div className="flex items-center gap-2 pt-2">
              <span className="text-xs text-slate-500">示例产物快速预览:</span>
              <button
                onClick={() =>
                  setCurrentArtifact({
                    title: '交互式数据可视化仪表盘 (HTML/React Demo)',
                    type: 'html',
                    content: `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <script src="https://cdn.tailwindcss.com"></script>
</head>
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
                    title: '自研 ReAct 死循环熔断器算法 (TypeScript)',
                    type: 'code',
                    language: 'typescript',
                    content: `/**
 * LoopDetector: 连续重复调用熔断检测器
 * 只要检测到模型对相同工具传入完全一致的参数连续超过 3 次，立即熔断截流
 */
export class LoopDetector {
  private history: string[] = [];

  recordAndCheck(toolName: string, args: Record<string, any>): boolean {
    const hash = \`\${toolName}:\${JSON.stringify(args)}\`;
    this.history.push(hash);
    if (this.history.length > 3) {
      this.history.shift();
    }
    return (
      this.history.length === 3 &&
      this.history[0] === hash &&
      this.history[1] === hash &&
      this.history[2] === hash
    );
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

        {/* TAB 3: 长期记忆库 (Memory Vault) */}
        {activeTab === 'memory' && (
          <div className="space-y-6">
            <div>
              <h2 className="text-xl font-bold text-white flex items-center gap-2">
                <Brain className="h-5 w-5 text-purple-400" />
                跨会话长期记忆库 (Long-Term Memory Vault)
              </h2>
              <p className="text-xs text-slate-400 mt-1">
                存储在 .cache/long_term_memory.json 中。Agent 在新会话启动时自动注入记忆上下文，永久遵循您的偏好与规则。
              </p>
            </div>

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

        {/* TAB 4: 定时巡检主动守护 (Cron Scheduler) */}
        {activeTab === 'cron' && (
          <div className="space-y-6">
            <div>
              <h2 className="text-xl font-bold text-white flex items-center gap-2">
                <Timer className="h-5 w-5 text-amber-400" />
                后台主动定时巡检守护 (Autonomous Cron Watcher)
              </h2>
              <p className="text-xs text-slate-400 mt-1">
                基于 Croner 引擎驱动。用户可在对话中指定定时调度规则，智能体无人值守在后台自动周期性执行。
              </p>
            </div>

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

        {/* TAB 5: 全链路追踪与可观测性 (Trace & Observability) */}
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
                <div className="text-2xl font-bold text-white mt-1">29 TOOLS</div>
              </div>
              <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-4">
                <div className="text-xs text-slate-400">累计调用事件</div>
                <div className="text-2xl font-bold text-indigo-400 mt-1">142 SPANS</div>
              </div>
              <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-4">
                <div className="text-xs text-slate-400">循环调用熔断拦截</div>
                <div className="text-2xl font-bold text-purple-400 mt-1">0 BREAKS</div>
              </div>
            </div>

            <div className="rounded-2xl border border-slate-800 bg-slate-900/50 p-5 backdrop-blur">
              <h4 className="text-sm font-semibold text-white mb-3">实时 Span 瀑布流追踪 (最近 4 条)</h4>
              <div className="space-y-2 font-mono text-xs">
                <div className="flex items-center justify-between p-2.5 rounded-lg bg-slate-950/60 border border-slate-800/80">
                  <span className="text-cyan-400">event:tool_call [search_exa]</span>
                  <span className="text-slate-400">耗时: 382ms | 状态: OK</span>
                </div>
                <div className="flex items-center justify-between p-2.5 rounded-lg bg-slate-950/60 border border-slate-800/80">
                  <span className="text-purple-400">event:tool_call [artifact_render]</span>
                  <span className="text-slate-400">耗时: 14ms | 状态: OK</span>
                </div>
                <div className="flex items-center justify-between p-2.5 rounded-lg bg-slate-950/60 border border-slate-800/80">
                  <span className="text-amber-400">event:tool_call [planner_update_task]</span>
                  <span className="text-slate-400">耗时: 9ms | 状态: OK</span>
                </div>
                <div className="flex items-center justify-between p-2.5 rounded-lg bg-slate-950/60 border border-slate-800/80">
                  <span className="text-indigo-400">event:thought [ModelStepResult]</span>
                  <span className="text-slate-400">耗时: 1,120ms | 状态: OK</span>
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
            instructions="你是由 DeepSeek Harness 官方 Cordis 插件微内核驱动的个人全自主智能体驾驶舱助手 (agtpilot)。你拥有 29 个业界顶尖 SOTA 级原子工具：Exa/Tavily 神经搜索、Firecrawl 网页爬取、Stagehand 网页操作、E2B 云端微容器沙箱、Anthropic MCP 协议扩展、artifact_render 产物画布渲染、planner_create_plan 任务拆解看板、memory_store 跨会话长期记忆以及 cron_schedule_task 定时主动巡检。你可以自主规划多步任务并安全执行。"
            labels={{
              title: 'agtpilot 驾驶舱',
              initial: '你好！我是你的个人全自主智能体。我已经接入 29 项业界顶尖原子能力：包括 Anthropic MCP 协议、E2B 云端代码解释器、Exa 神经搜索、Firecrawl 智能爬虫、中心画布实时渲染 (Artifacts)、任务拆解看板 (Todo Planner)、跨会话长期记忆与定时巡检守护。请在下方输入你想要我执行的任务。',
            }}
            defaultOpen={true}
            clickOutsideToClose={false}
          />
        </CopilotKit>
      )}
    </div>
  );
}
