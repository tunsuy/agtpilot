'use client';

import { useState, useEffect, useRef } from 'react';
import { CopilotKit } from '@copilotkit/react-core';
import { CopilotSidebar } from '@copilotkit/react-ui';
import {
  Bot,
  Code2,
  Globe,
  Terminal,
  Play,
  FileCode,
  FolderTree,
  GitBranch,
  GitCommit,
  CheckCircle2,
  Clock,
  ExternalLink,
  RotateCw,
  Smartphone,
  Tablet,
  Laptop,
  Copy,
  Check,
  Plus,
  MessageSquare,
  Settings,
  Sparkles,
  SlidersHorizontal,
  ChevronRight,
  ShieldAlert,
  Search,
  Zap,
  Layers,
  ChevronDown,
} from 'lucide-react';

interface WorkspaceFile {
  name: string;
  path: string;
  type: 'file' | 'dir';
  language?: string;
  content?: string;
}

interface ProjectTask {
  id: string;
  title: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  subagent?: string;
  duration?: string;
}

export default function AutonomousWorkspace() {
  const [mounted, setMounted] = useState(false);

  // 工作区多模式与标签切换
  const [activeTab, setActiveTab] = useState<'editor' | 'preview' | 'diff' | 'terminal' | 'tasks'>('editor');
  const [viewportMode, setViewportMode] = useState<'desktop' | 'tablet' | 'mobile'>('desktop');
  const [selectedModel, setSelectedModel] = useState('DeepSeek-R1 (深度推理)');
  const [isCopied, setIsCopied] = useState(false);

  // 虚拟文件管理器
  const [activeFile, setActiveFile] = useState<string>('src/agent.ts');
  const [files, setFiles] = useState<Record<string, { language: string; content: string }>>({
    'src/agent.ts': {
      language: 'typescript',
      content: `import { Context } from '@deepseek-ai/cordis';
import { AgentService, OrchestratorService } from '@agtpilot/core';

export async function bootstrapAgent() {
  const ctx = new Context();
  
  // 初始化自主智能体运行时与透明状态机
  const agent = new AgentService(ctx);
  const orchestrator = new OrchestratorService(ctx);

  console.log('🚀 agtpilot 个人全自主智能体已进入就绪状态');
  return { ctx, agent, orchestrator };
}

bootstrapAgent();
`,
    },
    'src/config.json': {
      language: 'json',
      content: `{
  "agentName": "agtpilot",
  "version": "1.0.0",
  "mode": "autonomous",
  "features": {
    "e2bSandbox": true,
    "firecrawl": true,
    "mcpProtocol": true,
    "localRag": true,
    "gitPatchEngine": true
  }
}`,
    },
    'preview/index.html': {
      language: 'html',
      content: `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-slate-950 text-slate-100 min-h-screen flex items-center justify-center p-6">
  <div class="max-w-md w-full bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-2xl">
    <div class="flex items-center justify-between mb-4">
      <div class="flex items-center gap-2">
        <div class="h-3 w-3 rounded-full bg-emerald-500 animate-pulse"></div>
        <span class="text-xs font-semibold text-emerald-400 uppercase tracking-wider">实时渲染引擎就绪</span>
      </div>
      <span class="text-xs text-slate-400">v1.0</span>
    </div>
    <h2 class="text-xl font-bold text-white mb-2">智能体实时应用沙盒</h2>
    <p class="text-xs text-slate-400 leading-relaxed mb-6">
      当智能体生成前端组件、数据可视化图表或原型网页时，将实时注入此安全沙盒视口直接预览。
    </p>
    <div class="space-y-3">
      <div class="p-3 bg-slate-950 rounded-xl border border-slate-800 flex items-center justify-between">
        <span class="text-xs text-slate-300">沙箱网络隔离</span>
        <span class="text-xs text-emerald-400 font-mono">Protected</span>
      </div>
      <div class="p-3 bg-slate-950 rounded-xl border border-slate-800 flex items-center justify-between">
        <span class="text-xs text-slate-300">响应式断点</span>
        <span class="text-xs text-indigo-400 font-mono">Auto Adaptive</span>
      </div>
    </div>
  </div>
</body>
</html>`,
    },
    'docs/SPEC.md': {
      language: 'markdown',
      content: `# 项目技术需求规约

## 交付目标
构建一个具备多步骤规划、全网信息蒸馏、代码补丁精准应用与沙箱隔离验证的个人全自主智能体系统。

## 验收准则
1. 复杂长任务支持结构化看板透明拆解；
2. 高危终端指令支持实时人工确认；
3. 代码改动提供并排 Git Diff 视觉对比。
`,
    },
  });

  // 任务计划树 (Devin / Cline 风格)
  const [tasks, setTasks] = useState<ProjectTask[]>([
    {
      id: 'task-1',
      title: '复杂需求语义拆解与上下文检索',
      status: 'completed',
      duration: '1.2s',
    },
    {
      id: 'task-2',
      title: '多源网络资料深度检索与交叉比对',
      status: 'completed',
      subagent: 'WebResearcher',
      duration: '3.4s',
    },
    {
      id: 'task-3',
      title: '受控沙箱代码实现与单元测试验证',
      status: 'running',
      subagent: 'SoftwareEngineer',
    },
    {
      id: 'task-4',
      title: '生产级构建打包与 Git 变更审查准备',
      status: 'pending',
    },
  ]);

  // 终端日志流
  const [terminalLogs, setTerminalLogs] = useState<string[]>([
    '➜  agtpilot git:(main) pnpm -r build',
    '✓ @agtpilot/protocol: build complete (240ms)',
    '✓ @agtpilot/core: build complete (380ms)',
    '✓ @agtpilot/plugin-browser: Playwright headless initialized',
    '✓ @agtpilot/plugin-sandbox: E2B microVM cloud sandbox connected',
    '✓ @agtpilot/plugin-git: jsdiff fuzzy patch engine active',
    'ℹ [Agent Runtime] Waiting for user instructions...',
  ]);

  // 模拟 Git Diff
  const sampleDiff = `--- a/src/agent.ts
+++ b/src/agent.ts
@@ -10,6 +10,10 @@ export async function bootstrapAgent() {
   const agent = new AgentService(ctx);
   const orchestrator = new OrchestratorService(ctx);

+  // 挂载防死循环熔断器与高危指令人工拦截网关
+  orchestrator.enableLoopDetector({ maxRepeats: 3 });
+  orchestrator.enableHumanInTheLoop({ dangerLevels: ['high'] });
+
   console.log('🚀 agtpilot 个人全自主智能体已进入就绪状态');
   return { ctx, agent, orchestrator };
 }`;

  useEffect(() => {
    setMounted(true);
  }, []);

  const handleCopyCode = () => {
    const code = files[activeFile]?.content || '';
    navigator.clipboard.writeText(code);
    setIsCopied(true);
    setTimeout(() => setIsCopied(false), 2000);
  };

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-slate-950 text-slate-100 font-sans antialiased selection:bg-indigo-500 selection:text-white">
      {/* 1. 左侧工作区导航条 (Activity Bar) */}
      <aside className="w-14 flex-shrink-0 flex flex-col items-center justify-between border-r border-slate-800 bg-slate-950 py-4 z-20">
        <div className="flex flex-col items-center gap-6">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500 to-purple-600 text-white shadow-lg shadow-indigo-500/25">
            <Bot className="h-5 w-5" />
          </div>

          <div className="flex flex-col items-center gap-3 text-slate-400">
            <button
              onClick={() => setActiveTab('editor')}
              className={`p-2 rounded-xl transition-all ${
                activeTab === 'editor'
                  ? 'bg-indigo-600/20 text-indigo-400 border border-indigo-500/30'
                  : 'hover:bg-slate-900 hover:text-slate-200'
              }`}
              title="代码编辑器 (Editor)"
            >
              <Code2 className="h-4 w-4" />
            </button>
            <button
              onClick={() => setActiveTab('preview')}
              className={`p-2 rounded-xl transition-all ${
                activeTab === 'preview'
                  ? 'bg-indigo-600/20 text-indigo-400 border border-indigo-500/30'
                  : 'hover:bg-slate-900 hover:text-slate-200'
              }`}
              title="实时网页预览 (Live Preview)"
            >
              <Globe className="h-4 w-4" />
            </button>
            <button
              onClick={() => setActiveTab('tasks')}
              className={`p-2 rounded-xl transition-all ${
                activeTab === 'tasks'
                  ? 'bg-indigo-600/20 text-indigo-400 border border-indigo-500/30'
                  : 'hover:bg-slate-900 hover:text-slate-200'
              }`}
              title="任务推进看板 (Task Planner)"
            >
              <CheckCircle2 className="h-4 w-4" />
            </button>
            <button
              onClick={() => setActiveTab('diff')}
              className={`p-2 rounded-xl transition-all ${
                activeTab === 'diff'
                  ? 'bg-indigo-600/20 text-indigo-400 border border-indigo-500/30'
                  : 'hover:bg-slate-900 hover:text-slate-200'
              }`}
              title="Git 补丁审查 (Diff Review)"
            >
              <GitBranch className="h-4 w-4" />
            </button>
            <button
              onClick={() => setActiveTab('terminal')}
              className={`p-2 rounded-xl transition-all ${
                activeTab === 'terminal'
                  ? 'bg-indigo-600/20 text-indigo-400 border border-indigo-500/30'
                  : 'hover:bg-slate-900 hover:text-slate-200'
              }`}
              title="终端输出 (Terminal Console)"
            >
              <Terminal className="h-4 w-4" />
            </button>
          </div>
        </div>

        <div className="flex flex-col items-center gap-3 text-slate-500">
          <div className="h-2 w-2 rounded-full bg-emerald-500 animate-pulse" title="运行环境健康" />
          <button className="p-2 rounded-xl hover:bg-slate-900 hover:text-slate-300 transition-all">
            <Settings className="h-4 w-4" />
          </button>
        </div>
      </aside>

      {/* 2. 项目目录侧边栏 (File Explorer) */}
      <nav className="w-56 flex-shrink-0 flex flex-col border-r border-slate-800 bg-slate-900/40 backdrop-blur select-none">
        <div className="flex h-12 items-center justify-between px-4 border-b border-slate-800/80">
          <span className="text-xs font-bold uppercase tracking-wider text-slate-400 flex items-center gap-2">
            <FolderTree className="h-3.5 w-3.5 text-indigo-400" /> 工作区文件
          </span>
          <span className="text-[10px] text-slate-500 font-mono">agtpilot</span>
        </div>

        <div className="flex-1 overflow-y-auto p-2 space-y-1 text-xs">
          {Object.keys(files).map((filePath) => {
            const isSelected = activeFile === filePath;
            return (
              <button
                key={filePath}
                onClick={() => {
                  setActiveFile(filePath);
                  if (filePath.endsWith('.html')) {
                    setActiveTab('preview');
                  } else {
                    setActiveTab('editor');
                  }
                }}
                className={`w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-left transition-all ${
                  isSelected
                    ? 'bg-indigo-600/20 text-indigo-300 font-medium border border-indigo-500/30'
                    : 'text-slate-400 hover:bg-slate-800/50 hover:text-slate-200'
                }`}
              >
                <FileCode className="h-3.5 w-3.5 flex-shrink-0 text-slate-500" />
                <span className="truncate">{filePath}</span>
              </button>
            );
          })}
        </div>

        {/* 底部模型能级选择器 */}
        <div className="p-3 border-t border-slate-800/80 bg-slate-950/40">
          <div className="text-[10px] font-semibold uppercase text-slate-500 mb-1.5 flex items-center gap-1">
            <SlidersHorizontal className="h-3 w-3" /> 模型路由驱动
          </div>
          <select
            value={selectedModel}
            onChange={(e) => setSelectedModel(e.target.value)}
            className="w-full bg-slate-900 border border-slate-800 rounded-lg px-2 py-1 text-xs text-slate-200 focus:outline-none focus:border-indigo-500"
          >
            <option value="DeepSeek-R1 (深度推理)">DeepSeek-R1 (深度推理)</option>
            <option value="DeepSeek-V3 (极速响应)">DeepSeek-V3 (极速响应)</option>
            <option value="GPT-4o (全能旗舰)">GPT-4o (全能旗舰)</option>
            <option value="Claude 3.5 Sonnet (代码专家)">Claude 3.5 Sonnet</option>
            <option value="Ollama:Qwen2.5 (本地离线)">Ollama:Qwen2.5 (本地)</option>
          </select>
        </div>
      </nav>

      {/* 3. 中央主舞台视口 (Main Stage / Canvas / IDE) */}
      <main className="flex-1 flex flex-col min-w-0 bg-slate-950 overflow-hidden">
        {/* 顶部标签栏与控制条 */}
        <div className="h-11 border-b border-slate-800 bg-slate-900/60 flex items-center justify-between px-4">
          <div className="flex items-center gap-1 overflow-x-auto">
            <button
              onClick={() => setActiveTab('editor')}
              className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
                activeTab === 'editor'
                  ? 'bg-slate-800 text-white border border-slate-700'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <Code2 className="h-3.5 w-3.5 text-indigo-400" />
              <span>{activeFile}</span>
            </button>

            <button
              onClick={() => setActiveTab('preview')}
              className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
                activeTab === 'preview'
                  ? 'bg-slate-800 text-white border border-slate-700'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <Globe className="h-3.5 w-3.5 text-cyan-400" />
              <span>实时预览</span>
            </button>

            <button
              onClick={() => setActiveTab('tasks')}
              className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
                activeTab === 'tasks'
                  ? 'bg-slate-800 text-white border border-slate-700'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />
              <span>任务执行链路</span>
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />
            </button>

            <button
              onClick={() => setActiveTab('diff')}
              className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
                activeTab === 'diff'
                  ? 'bg-slate-800 text-white border border-slate-700'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <GitBranch className="h-3.5 w-3.5 text-purple-400" />
              <span>Git 补丁审查</span>
            </button>

            <button
              onClick={() => setActiveTab('terminal')}
              className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
                activeTab === 'terminal'
                  ? 'bg-slate-800 text-white border border-slate-700'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <Terminal className="h-3.5 w-3.5 text-amber-400" />
              <span>受控沙箱终端</span>
            </button>
          </div>

          {/* 右侧动作控制 */}
          <div className="flex items-center gap-2">
            {activeTab === 'preview' && (
              <div className="flex items-center rounded-lg bg-slate-900 border border-slate-800 p-0.5 text-xs text-slate-400">
                <button
                  onClick={() => setViewportMode('desktop')}
                  className={`p-1 rounded ${viewportMode === 'desktop' ? 'bg-slate-800 text-white' : ''}`}
                  title="桌面视口 (100%)"
                >
                  <Laptop className="h-3.5 w-3.5" />
                </button>
                <button
                  onClick={() => setViewportMode('tablet')}
                  className={`p-1 rounded ${viewportMode === 'tablet' ? 'bg-slate-800 text-white' : ''}`}
                  title="平板视口 (768px)"
                >
                  <Tablet className="h-3.5 w-3.5" />
                </button>
                <button
                  onClick={() => setViewportMode('mobile')}
                  className={`p-1 rounded ${viewportMode === 'mobile' ? 'bg-slate-800 text-white' : ''}`}
                  title="手机视口 (375px)"
                >
                  <Smartphone className="h-3.5 w-3.5" />
                </button>
              </div>
            )}

            {activeTab === 'editor' && (
              <button
                onClick={handleCopyCode}
                className="flex items-center gap-1.5 rounded-lg border border-slate-800 bg-slate-900 px-2.5 py-1 text-xs text-slate-300 hover:bg-slate-800 transition-all"
              >
                {isCopied ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <Copy className="h-3.5 w-3.5" />}
                <span>{isCopied ? '已复制' : '复制文件'}</span>
              </button>
            )}
          </div>
        </div>

        {/* 视口内容渲染区 */}
        <div className="flex-1 overflow-hidden relative">
          {/* A. 代码编辑器视图 (Editor View) */}
          {activeTab === 'editor' && (
            <div className="h-full w-full flex flex-col bg-slate-950 font-mono text-xs">
              <div className="flex-1 overflow-auto p-4 leading-relaxed text-slate-300">
                <pre>
                  <code>{files[activeFile]?.content || '// 文件为空或尚未加载'}</code>
                </pre>
              </div>
              <div className="h-7 border-t border-slate-800/80 bg-slate-900/60 px-4 flex items-center justify-between text-[11px] text-slate-500">
                <div className="flex items-center gap-4">
                  <span>UTF-8</span>
                  <span>{files[activeFile]?.language || 'text'}</span>
                  <span>Spaces: 2</span>
                </div>
                <div>行数: {files[activeFile]?.content.split('\n').length || 0}</div>
              </div>
            </div>
          )}

          {/* B. 实时安全沙箱预览 (Live Preview View) */}
          {activeTab === 'preview' && (
            <div className="h-full w-full flex flex-col bg-slate-900/30">
              {/* 模拟浏览器地址栏 */}
              <div className="h-9 border-b border-slate-800 bg-slate-900/80 px-4 flex items-center gap-3">
                <button className="text-slate-400 hover:text-slate-200">
                  <RotateCw className="h-3.5 w-3.5" />
                </button>
                <div className="flex-1 max-w-lg rounded-md bg-slate-950 border border-slate-800 px-3 py-1 text-[11px] text-slate-400 font-mono flex items-center justify-between">
                  <span>http://localhost:3000/sandbox/preview</span>
                  <span className="text-[10px] text-emerald-400 bg-emerald-500/10 px-1.5 py-0.2 rounded border border-emerald-500/20">
                    SSL Active
                  </span>
                </div>
              </div>

              {/* 预览沙盒视口 */}
              <div className="flex-1 overflow-auto flex items-center justify-center p-4">
                <div
                  className={`h-full bg-white rounded-xl shadow-2xl transition-all overflow-hidden border border-slate-800 ${
                    viewportMode === 'mobile'
                      ? 'w-[375px]'
                      : viewportMode === 'tablet'
                      ? 'w-[768px]'
                      : 'w-full'
                  }`}
                >
                  <iframe
                    title="Live App Sandbox"
                    srcDoc={files['preview/index.html']?.content || ''}
                    sandbox="allow-scripts allow-modals"
                    className="h-full w-full border-0"
                  />
                </div>
              </div>
            </div>
          )}

          {/* C. 任务执行规划看板 (Tasks View) */}
          {activeTab === 'tasks' && (
            <div className="h-full w-full overflow-y-auto p-6 max-w-4xl mx-auto space-y-4">
              <div className="flex items-center justify-between mb-2">
                <div>
                  <h3 className="text-base font-bold text-white flex items-center gap-2">
                    <CheckCircle2 className="h-4 w-4 text-emerald-400" />
                    自主任务执行拓扑与推进树
                  </h3>
                  <p className="text-xs text-slate-400 mt-1">
                    系统根据用户目标自主拆解的规划链路，支持实时监测每一步的执行用例与子智能体状态。
                  </p>
                </div>
                <div className="text-xs font-mono text-emerald-400 bg-emerald-500/10 px-3 py-1 rounded-full border border-emerald-500/20">
                  2 / 4 步骤完成 (50%)
                </div>
              </div>

              <div className="space-y-3">
                {tasks.map((task, idx) => {
                  const isDone = task.status === 'completed';
                  const isRunning = task.status === 'running';
                  return (
                    <div
                      key={task.id}
                      className={`rounded-xl border p-4 transition-all ${
                        isRunning
                          ? 'border-indigo-500 bg-indigo-950/20 shadow-lg shadow-indigo-500/10'
                          : isDone
                          ? 'border-slate-800 bg-slate-900/40 opacity-80'
                          : 'border-slate-800/60 bg-slate-900/10 text-slate-500'
                      }`}
                    >
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-3">
                          {isDone ? (
                            <CheckCircle2 className="h-4 w-4 text-emerald-400 flex-shrink-0" />
                          ) : isRunning ? (
                            <div className="h-4 w-4 rounded-full border-2 border-indigo-400 border-t-transparent animate-spin flex-shrink-0" />
                          ) : (
                            <Clock className="h-4 w-4 text-slate-600 flex-shrink-0" />
                          )}
                          <div>
                            <div className="flex items-center gap-2">
                              <span className="text-xs font-mono text-slate-500">#{idx + 1}</span>
                              <span className={`text-xs font-semibold ${isDone ? 'text-slate-300' : 'text-white'}`}>
                                {task.title}
                              </span>
                              {task.subagent && (
                                <span className="rounded bg-purple-500/10 px-2 py-0.5 text-[10px] font-mono text-purple-400 border border-purple-500/20">
                                  子智能体: {task.subagent}
                                </span>
                              )}
                            </div>
                          </div>
                        </div>

                        <div className="flex items-center gap-2 text-xs font-mono">
                          {task.duration && <span className="text-slate-500">{task.duration}</span>}
                          <span
                            className={`rounded px-2 py-0.5 text-[10px] uppercase ${
                              isDone
                                ? 'bg-emerald-500/10 text-emerald-400'
                                : isRunning
                                ? 'bg-indigo-500/10 text-indigo-400 animate-pulse'
                                : 'bg-slate-800 text-slate-500'
                            }`}
                          >
                            {task.status}
                          </span>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* D. Git 差异审查视图 (Diff View) */}
          {activeTab === 'diff' && (
            <div className="h-full w-full flex flex-col bg-slate-950 font-mono text-xs">
              <div className="h-10 border-b border-slate-800 px-4 flex items-center justify-between bg-slate-900/40">
                <span className="text-slate-300 font-semibold flex items-center gap-2">
                  <GitCommit className="h-4 w-4 text-purple-400" />
                  工作区改动审查: src/agent.ts
                </span>
                <div className="flex items-center gap-2">
                  <button className="px-3 py-1 bg-rose-950/60 hover:bg-rose-900/60 text-rose-300 border border-rose-800/50 rounded-lg text-xs transition-all">
                    放弃改动 (Reject)
                  </button>
                  <button className="px-3 py-1 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg text-xs font-medium transition-all shadow-sm">
                    接受并合并 (Accept)
                  </button>
                </div>
              </div>

              <div className="flex-1 overflow-auto p-4 leading-relaxed">
                {sampleDiff.split('\n').map((line, idx) => {
                  const isAdd = line.startsWith('+') && !line.startsWith('+++');
                  const isDel = line.startsWith('-') && !line.startsWith('---');
                  const isHunk = line.startsWith('@@');
                  return (
                    <div
                      key={idx}
                      className={`px-2 py-0.5 rounded font-mono ${
                        isAdd
                          ? 'bg-emerald-950/60 text-emerald-300'
                          : isDel
                          ? 'bg-rose-950/60 text-rose-300'
                          : isHunk
                          ? 'text-cyan-400 bg-cyan-950/20'
                          : 'text-slate-400'
                      }`}
                    >
                      {line}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* E. 受控沙箱终端 (Terminal View) */}
          {activeTab === 'terminal' && (
            <div className="h-full w-full flex flex-col bg-slate-950 font-mono text-xs text-slate-300 p-4">
              <div className="flex-1 overflow-y-auto space-y-1">
                {terminalLogs.map((log, idx) => (
                  <div key={idx} className="leading-relaxed">
                    {log}
                  </div>
                ))}
              </div>
              <div className="h-8 border-t border-slate-800/80 pt-2 flex items-center gap-2 text-slate-500">
                <span className="text-emerald-400">●</span>
                <span>受控沙箱终端进程保持活动中</span>
              </div>
            </div>
          )}
        </div>
      </main>

      {/* 4. 右侧 Copilot 对话交互驾驶舱 (Copilot Sidebar) */}
      {mounted && (
        <CopilotKit runtimeUrl="/api/copilotkit">
          <CopilotSidebar
            instructions="你是由 DeepSeek Harness 官方 Cordis 插件微内核驱动的工业级个人全自主智能体驾驶舱助手 (agtpilot)。你可以自主规划多步骤研发与调研任务，调用浏览器进行全网蒸馏、在 E2B 云端微容器或本地受控沙箱运行代码，并自动在中心工作区呈现代码、实时 Web 预览或 Git 补丁。遇到高危指令时务必主动触发安全审批。"
            labels={{
              title: 'agtpilot 助理',
              initial: '你好！我是你的个人全自主研发助手。我已就绪多步骤规划、全网深度检索、沙箱代码运行、浏览器操作与 Git 补丁应用。请下发你的任务目标（例如：“分析竞品前端架构并编写一个演示组件”，“在沙箱中运行 Python 科学计算”）。',
            }}
            defaultOpen={true}
            clickOutsideToClose={false}
          />
        </CopilotKit>
      )}
    </div>
  );
}
