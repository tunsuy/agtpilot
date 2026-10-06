'use client';

import React, { useRef, useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  Globe,
  Terminal,
  FileText,
  Check,
  RotateCw,
  ArrowUp,
  Lock,
  Shield,
  Copy,
  CheckCheck,
  Clock,
  Sparkles,
  ExternalLink,
  ChevronRight,
  Maximize2,
  Minimize2,
  Cpu,
  Square,
  Plus,
  PanelLeftClose,
  PanelLeft,
  ListTodo,
  Bot,
} from 'lucide-react';
import {
  Mission,
  ViewportState,
  TerminalLog,
  ApprovalRequest,
  ArtifactState,
  ConnectorApp,
} from '../types/agent';

interface CockpitViewProps {
  missions: Mission[];
  activeMissionId: string | null;
  onSelectMission: (id: string) => void;
  viewport: ViewportState;
  terminalLogs: TerminalLog[];
  approvalRequests: ApprovalRequest[];
  onApproval: (id: string, approved: boolean) => void;
  artifact: ArtifactState | null;
  rightTab: 'browser' | 'terminal' | 'artifact';
  onRightTabChange: (tab: 'browser' | 'terminal' | 'artifact') => void;
  onRunMission: (prompt: string, title?: string, missionId?: string) => void;
  onStopMission?: (missionId: string) => Promise<void> | void;
  onNewSession?: () => void;
  isSubmitting: boolean;
  connectors?: ConnectorApp[];
  onSelectModel?: (modelId: string) => Promise<void>;
}

export function CockpitView({
  missions,
  activeMissionId,
  onSelectMission,
  viewport,
  terminalLogs,
  approvalRequests,
  onApproval,
  artifact,
  rightTab,
  onRightTabChange,
  onRunMission,
  onStopMission,
  onNewSession,
  isSubmitting,
  connectors,
  onSelectModel,
}: CockpitViewProps) {
  const [prompt, setPrompt] = useState('');
  const [copiedArtifact, setCopiedArtifact] = useState(false);
  const [copiedStepId, setCopiedStepId] = useState<string | null>(null);
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);
  const [isWorkbenchExpanded, setIsWorkbenchExpanded] = useState(false);
  const terminalEndRef = useRef<HTMLDivElement>(null);
  const stepsEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (rightTab === 'terminal') {
      terminalEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [terminalLogs, rightTab]);

  const currentMission =
    missions.find((m) => m.id === activeMissionId) || missions[0] || null;

  useEffect(() => {
    if (currentMission?.steps?.length) {
      stepsEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [currentMission?.steps]);

  const handleCopyArtifact = () => {
    if (!artifact?.content) return;
    navigator.clipboard.writeText(artifact.content);
    setCopiedArtifact(true);
    setTimeout(() => setCopiedArtifact(false), 2000);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!prompt.trim() || isSubmitting) return;
    onRunMission(prompt.trim(), undefined, activeMissionId || undefined);
    setPrompt('');
  };

  const handleStartNewMission = () => {
    setPrompt('');
    if (onNewSession) {
      onNewSession();
    }
  };

  const suggestions = [
    { title: '全网热点深度综述', prompt: '深入检索主流科技社区与资讯，整理今日最受关注的技术与产品热点并生成摘要。' },
    { title: '隔离环境诊断自检', prompt: '在隔离沙盒内运行环境自检探针，核验 Node.js、Python 与 Git 运行时状态。' },
    { title: '开源趋势雷达扫描', prompt: '扫描 GitHub 当前 Trending 开源热门项目，分析其核心设计与技术亮点。' },
    { title: '前沿 AI Agent 演进调研', prompt: '调研最新多模态智能体架构、工具调用与沙盒协同模式，输出结构化分析报告。' },
  ];

  return (
    <div className="flex-1 flex h-[calc(100vh-3.5rem)] w-full overflow-hidden bg-[#fbfbfd]">
      {/* ========================================================= */}
      {/* 1. 左栏：会话与任务历史列表 (Sessions & History List)       */}
      {/* ========================================================= */}
      {isSidebarOpen && (
        <aside className="w-64 flex-shrink-0 flex flex-col border-r border-zinc-200 bg-white select-none transition-all duration-200">
          {/* Header: 标题 & 新建会话 & 收起 */}
          <div className="h-12 px-3 border-b border-zinc-100 flex items-center justify-between gap-1.5">
            <button
              onClick={handleStartNewMission}
              className="flex-1 flex items-center justify-center gap-1.5 py-1.5 px-2.5 rounded-lg text-xs font-medium bg-zinc-900 hover:bg-zinc-800 text-white shadow-2xs transition"
              title="开启全新主题会话"
            >
              <Plus className="h-3.5 w-3.5" />
              <span>新建会话</span>
            </button>

            <button
              onClick={() => setIsSidebarOpen(false)}
              className="p-1.5 rounded-lg text-zinc-400 hover:text-zinc-700 hover:bg-zinc-100 transition flex-shrink-0"
              title="收起任务侧边栏"
            >
              <PanelLeftClose className="h-4 w-4" />
            </button>
          </div>

          {/* 任务列表 */}
          <div className="flex-1 overflow-y-auto p-2 space-y-1">
            <div className="px-2 py-1 text-[10px] font-semibold text-zinc-400 uppercase tracking-wider">
              历史会话 ({missions.length})
            </div>

            {missions.length === 0 ? (
              <div className="py-8 text-center text-zinc-400 text-xs">
                暂无历史任务
              </div>
            ) : (
              missions.map((m) => {
                const isActive = activeMissionId === m.id || (!activeMissionId && m.id === currentMission?.id);
                return (
                  <button
                    key={m.id}
                    onClick={() => onSelectMission(m.id)}
                    className={`w-full text-left p-2.5 rounded-xl border text-xs transition flex flex-col gap-1.5 ${
                      isActive
                        ? 'border-zinc-300 bg-zinc-100/90 text-zinc-900 shadow-2xs font-medium'
                        : 'border-transparent hover:bg-zinc-50 text-zinc-600 hover:text-zinc-900'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate leading-snug flex-1 font-medium">
                        {m.title}
                      </span>
                      <span
                        className={`text-[9px] px-1.5 py-0.2 rounded-full font-mono flex-shrink-0 ${
                          m.status === 'DONE'
                            ? 'bg-emerald-50 text-emerald-700 border border-emerald-200/60'
                            : m.status === 'ACTIVE'
                            ? 'bg-blue-50 text-blue-700 border border-blue-200/60 animate-pulse'
                            : 'bg-zinc-100 text-zinc-500'
                        }`}
                      >
                        {m.status === 'DONE' ? '已完成' : m.status === 'ACTIVE' ? `${m.progress}%` : '等待中'}
                      </span>
                    </div>

                    <div className="flex items-center justify-between text-[10px] text-zinc-400 font-mono">
                      <span>{m.steps?.length || 0} 步骤</span>
                      <span>
                        {new Date(m.startedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                      </span>
                    </div>
                  </button>
                );
              })
            )}
          </div>
        </aside>
      )}

      {/* ========================================================= */}
      {/* 2. 中间：核心交互与执行轨迹流 (Main Chat, Steps & Stream)      */}
      {/* ========================================================= */}
      <section
        className={`flex-1 flex flex-col min-w-[380px] bg-white border-r border-zinc-200 transition-all ${
          isWorkbenchExpanded ? 'hidden' : 'flex'
        }`}
      >
        {/* 顶部目标概览与进度条 */}
        <div className="p-4 border-b border-zinc-100 bg-[#fcfcfd]">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2">
              {!isSidebarOpen && (
                <button
                  onClick={() => setIsSidebarOpen(true)}
                  className="p-1 rounded-md text-zinc-400 hover:text-zinc-700 hover:bg-zinc-100 transition mr-1"
                  title="展开任务列表"
                >
                  <PanelLeft className="h-4 w-4" />
                </button>
              )}
              <span className="text-[11px] font-semibold text-zinc-400 uppercase tracking-wider flex items-center gap-1.5">
                <ListTodo className="h-3.5 w-3.5" />
                <span>任务执行流</span>
              </span>
            </div>

            <div className="flex items-center gap-2">
              {currentMission && currentMission.status !== 'DONE' && onStopMission && (
                <button
                  type="button"
                  onClick={() => onStopMission(currentMission.id)}
                  className="flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-medium bg-red-50 text-red-600 hover:bg-red-100 border border-red-200 transition shadow-2xs"
                  title="终止当前任务执行"
                >
                  <Square className="h-3 w-3 fill-red-600" />
                  <span>终止任务</span>
                </button>
              )}
              {currentMission && (
                <span className="text-xs font-mono text-zinc-700 font-semibold px-2 py-0.5 rounded-md bg-zinc-100 border border-zinc-200/80">
                  {currentMission.progress}%
                </span>
              )}
            </div>
          </div>

          {currentMission ? (
            <div>
              <h2 className="text-sm font-semibold text-zinc-900 leading-snug">
                {currentMission.title}
              </h2>
              <div className="mt-2.5 w-full bg-zinc-100 h-1.5 rounded-full overflow-hidden border border-zinc-200/60">
                <div
                  className="bg-zinc-900 h-full transition-all duration-300 rounded-full"
                  style={{ width: `${currentMission.progress}%` }}
                />
              </div>
            </div>
          ) : (
            <p className="text-xs text-zinc-400">准备就绪，随时可启动新任务。</p>
          )}
        </div>

        {/* 人机协同安全授权横幅 (如在中间流也需要响应) */}
        {approvalRequests.length > 0 && (
          <div className="m-3 p-3.5 rounded-xl border border-amber-200 bg-amber-50/90 shadow-xs flex items-center justify-between animate-fadeIn">
            <div className="flex items-center gap-2.5">
              <div className="h-8 w-8 rounded-lg bg-amber-100 text-amber-700 flex items-center justify-center flex-shrink-0">
                <Shield className="h-4 w-4" />
              </div>
              <div>
                <span className="text-xs font-semibold text-zinc-900 block">
                  需要安全审批授权: {approvalRequests[0].action}
                </span>
                <p className="text-[11px] text-zinc-600 mt-0.5">
                  {approvalRequests[0].description}
                </p>
              </div>
            </div>

            <div className="flex items-center gap-1.5 flex-shrink-0">
              <button
                onClick={() => onApproval(approvalRequests[0].id, false)}
                className="px-2.5 py-1 rounded-lg text-xs font-medium bg-white hover:bg-zinc-50 border border-zinc-200 text-zinc-700 transition"
              >
                拒绝
              </button>
              <button
                onClick={() => onApproval(approvalRequests[0].id, true)}
                className="px-3 py-1 rounded-lg text-xs font-medium bg-zinc-900 hover:bg-zinc-800 text-white transition shadow-xs"
              >
                放行
              </button>
            </div>
          </div>
        )}

        {/* 核心步骤执行树 (Execution Steps Tree) */}
        <div className="flex-1 overflow-y-auto p-4 space-y-2.5">
          {currentMission && currentMission.steps && currentMission.steps.length > 0 ? (
            <div className="space-y-2.5">
              {currentMission.steps.map((st) => (
                <div
                  key={st.id}
                  className={`p-3 rounded-xl border text-xs transition duration-150 ${
                    st.status === 'RUNNING'
                      ? 'border-blue-200 bg-blue-50/50 text-zinc-900 shadow-2xs'
                      : st.status === 'DONE'
                      ? 'border-zinc-200/80 bg-zinc-50/70 text-zinc-700'
                      : st.status === 'FAILED'
                      ? 'border-red-200 bg-red-50/60 text-red-700'
                      : 'border-zinc-100 bg-white text-zinc-400'
                  }`}
                >
                  <div className="flex items-start gap-2.5">
                    <div className="mt-0.5 flex-shrink-0">
                      {st.status === 'DONE' ? (
                        <div className="h-4 w-4 rounded-full bg-emerald-100 text-emerald-700 flex items-center justify-center">
                          <Check className="h-2.5 w-2.5" />
                        </div>
                      ) : st.status === 'RUNNING' ? (
                        <div className="h-4 w-4 rounded-full border-2 border-blue-600 border-t-transparent animate-spin" />
                      ) : st.status === 'FAILED' ? (
                        <div className="h-4 w-4 rounded-full bg-red-100 text-red-600 flex items-center justify-center font-bold text-[10px]">
                          ✕
                        </div>
                      ) : (
                        <div className="h-4 w-4 rounded-full border border-zinc-300" />
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="font-medium text-xs leading-snug">{st.title}</p>
                      <div className="flex items-center justify-between text-[10px] text-zinc-400 mt-1 font-mono">
                        <span>{st.tool || 'orchestrator'}</span>
                        <span>
                          {st.duration || (st.status === 'RUNNING' ? 'running...' : st.status === 'FAILED' ? 'aborted' : 'queued')}
                        </span>
                      </div>

                      {/* 智能体回答气泡 (支持 Markdown 格式) */}
                      {st.answer && (
                        <div className="mt-2.5 p-3 rounded-lg bg-white border border-zinc-200/90 shadow-2xs text-xs text-zinc-800 leading-relaxed group/ans relative">
                          <div className="prose prose-zinc prose-xs max-w-none break-words">
                            <ReactMarkdown remarkPlugins={[remarkGfm]}>
                              {st.answer}
                            </ReactMarkdown>
                          </div>
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              navigator.clipboard.writeText(st.answer!);
                              setCopiedStepId(st.id);
                              setTimeout(() => setCopiedStepId(null), 2000);
                            }}
                            className="absolute top-2 right-2 opacity-0 group-hover/ans:opacity-100 transition-opacity p-1 rounded bg-zinc-100 hover:bg-zinc-200 text-zinc-500 hover:text-zinc-800 text-[10px] flex items-center gap-1 shadow-2xs"
                            title="复制回复内容"
                          >
                            {copiedStepId === st.id ? (
                              <>
                                <CheckCheck className="h-3 w-3 text-emerald-600" />
                                <span className="text-emerald-600">已复制</span>
                              </>
                            ) : (
                              <>
                                <Copy className="h-3 w-3" />
                                <span>复制</span>
                              </>
                            )}
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              ))}
              <div ref={stepsEndRef} />
            </div>
          ) : (
            <div className="py-20 text-center text-zinc-400 space-y-3">
              <div className="mx-auto w-10 h-10 rounded-2xl bg-zinc-100 flex items-center justify-center text-zinc-500 shadow-2xs">
                <Bot className="h-5 w-5" />
              </div>
              <div className="space-y-1">
                <p className="text-xs font-semibold text-zinc-700">准备启动全自主执行</p>
                <p className="text-[11px] text-zinc-400 max-w-xs mx-auto">
                  在下方输入任务目标或补充指令，AgtPilot 将自主调度浏览器、沙箱与模型。
                </p>
              </div>
            </div>
          )}
        </div>

        {/* 中间底部：Linear 风格指令输入框 */}
        <div className="p-3 border-t border-zinc-200 bg-white space-y-2">
          <form
            onSubmit={handleSubmit}
            className="flex items-center gap-2 bg-[#f4f4f6] border border-zinc-200 rounded-xl p-1.5 focus-within:border-zinc-400 focus-within:bg-white transition"
          >
            <input
              type="text"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="指示 AgtPilot 进行网页浏览、代码运行、深入调研..."
              className="flex-1 bg-transparent border-none text-xs text-zinc-900 placeholder-zinc-400 focus:outline-none px-2"
            />
            {currentMission && currentMission.status !== 'DONE' && !prompt.trim() ? (
              <button
                type="button"
                onClick={() => onStopMission && onStopMission(currentMission.id)}
                className="h-7 w-7 rounded-lg bg-red-600 hover:bg-red-700 text-white flex items-center justify-center transition flex-shrink-0 shadow-2xs"
                title="终止执行当前任务"
              >
                <Square className="h-3 w-3 fill-white" />
              </button>
            ) : (
              <button
                type="submit"
                disabled={!prompt.trim() || isSubmitting}
                className="h-7 w-7 rounded-lg bg-zinc-900 hover:bg-zinc-800 disabled:opacity-20 text-white flex items-center justify-center transition flex-shrink-0"
              >
                {isSubmitting ? (
                  <RotateCw className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <ArrowUp className="h-3.5 w-3.5" />
                )}
              </button>
            )}
          </form>

          {/* 底栏模型选择与状态 */}
          {onSelectModel && connectors && (
            <div className="flex items-center justify-between px-1 text-[11px] text-zinc-400">
              <div className="flex items-center gap-1.5">
                <Cpu className="h-3 w-3 text-blue-600" />
                <span className="text-zinc-500 font-medium">模型:</span>
                <select
                  value={(connectors || []).find((c) => c.isModel && c.isDefaultModel)?.id || 'deepseek'}
                  onChange={(e) => onSelectModel(e.target.value)}
                  className="bg-transparent text-[11px] font-medium text-zinc-700 focus:outline-none cursor-pointer"
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
              <span className="font-mono">Enter 提交</span>
            </div>
          )}
        </div>
      </section>

      {/* ========================================================= */}
      {/* 3. 右侧：副驾驶执行工作台 (Browser / Terminal / Artifact)     */}
      {/* ========================================================= */}
      <main className="flex-1 flex flex-col min-w-0 bg-[#fafafa]">
        {/* 标签栏：Browser / Terminal / Deliverable / 最大化 */}
        <div className="h-11 border-b border-zinc-200 bg-white px-4 flex items-center justify-between">
          <div className="flex items-center gap-1">
            <button
              onClick={() => onRightTabChange('browser')}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition ${
                rightTab === 'browser'
                  ? 'bg-zinc-100 text-zinc-900 font-semibold'
                  : 'text-zinc-500 hover:text-zinc-900 hover:bg-zinc-50'
              }`}
            >
              <Globe className="h-3.5 w-3.5" />
              <span>实时浏览器</span>
              {viewport.status === 'navigating' && (
                <span className="h-1.5 w-1.5 rounded-full bg-blue-600 animate-ping" />
              )}
            </button>

            <button
              onClick={() => onRightTabChange('terminal')}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition ${
                rightTab === 'terminal'
                  ? 'bg-zinc-100 text-zinc-900 font-semibold'
                  : 'text-zinc-500 hover:text-zinc-900 hover:bg-zinc-50'
              }`}
            >
              <Terminal className="h-3.5 w-3.5" />
              <span>运行终端</span>
              {terminalLogs.length > 0 && (
                <span className="text-[10px] bg-zinc-200 text-zinc-600 px-1 rounded-sm">
                  {terminalLogs.length}
                </span>
              )}
            </button>

            <button
              onClick={() => onRightTabChange('artifact')}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition ${
                rightTab === 'artifact'
                  ? 'bg-zinc-100 text-zinc-900 font-semibold'
                  : 'text-zinc-500 hover:text-zinc-900 hover:bg-zinc-50'
              }`}
            >
              <FileText className="h-3.5 w-3.5" />
              <span>交付成果</span>
              {artifact && <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />}
            </button>
          </div>

          {/* 顶栏辅助控制区 */}
          <div className="flex items-center gap-2">
            {rightTab === 'browser' && viewport.url && viewport.url !== 'about:blank' && (
              <div className="flex items-center gap-1.5 text-xs text-zinc-500 font-mono truncate max-w-xs bg-zinc-50 border border-zinc-200 px-2.5 py-1 rounded-md">
                <Lock className="h-3 w-3 text-zinc-400 flex-shrink-0" />
                <span className="truncate">{viewport.url}</span>
              </div>
            )}

            {rightTab === 'artifact' && artifact && (
              <button
                onClick={handleCopyArtifact}
                className="flex items-center gap-1 text-xs text-zinc-600 hover:text-zinc-900 border border-zinc-200 px-2.5 py-1 rounded-md bg-white transition"
              >
                {copiedArtifact ? (
                  <CheckCheck className="h-3.5 w-3.5 text-emerald-600" />
                ) : (
                  <Copy className="h-3.5 w-3.5 text-zinc-400" />
                )}
                <span className="text-[11px]">{copiedArtifact ? '已复制' : '复制 Markdown'}</span>
              </button>
            )}

            <button
              onClick={() => setIsWorkbenchExpanded(!isWorkbenchExpanded)}
              className="p-1.5 rounded-lg text-zinc-400 hover:text-zinc-700 hover:bg-zinc-100 transition"
              title={isWorkbenchExpanded ? '还原视窗' : '全屏展开工作台'}
            >
              {isWorkbenchExpanded ? (
                <Minimize2 className="h-4 w-4" />
              ) : (
                <Maximize2 className="h-4 w-4" />
              )}
            </button>
          </div>
        </div>

        {/* 画布视图主体 */}
        <div className="flex-1 p-5 overflow-y-auto">
          {/* 1. 真实浏览器画板 (Browser View) */}
          {rightTab === 'browser' && (
            <div className="h-full flex flex-col items-center justify-center">
              {viewport.url && viewport.url !== 'about:blank' ? (
                <div className="w-full max-w-5xl h-[640px] rounded-2xl overflow-hidden border border-zinc-200/90 shadow-sm bg-white flex flex-col">
                  {/* Browser Chrome Header */}
                  <div className="h-10 bg-zinc-100/80 border-b border-zinc-200 px-4 flex items-center justify-between gap-3">
                    <div className="flex items-center gap-2">
                      <div className="flex gap-1.5">
                        <div className="h-2.5 w-2.5 rounded-full bg-red-400" />
                        <div className="h-2.5 w-2.5 rounded-full bg-amber-400" />
                        <div className="h-2.5 w-2.5 rounded-full bg-emerald-400" />
                      </div>
                      <div className="flex items-center gap-1.5 ml-3 px-3 py-1 rounded-lg bg-white border border-zinc-200 text-xs font-mono text-zinc-600 max-w-md truncate shadow-2xs">
                        <Lock className="h-3 w-3 text-zinc-400 flex-shrink-0" />
                        <span className="truncate">{viewport.url}</span>
                      </div>
                    </div>

                    <a
                      href={viewport.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center gap-1 text-[11px] text-zinc-500 hover:text-zinc-900 transition font-medium"
                    >
                      <span>在新标签页打开</span>
                      <ExternalLink className="h-3 w-3" />
                    </a>
                  </div>

                  {/* Browser Content */}
                  <div className="flex-1 w-full bg-white relative overflow-hidden">
                    {viewport.screenshotBase64 ? (
                      <img
                        src={viewport.screenshotBase64}
                        alt="Browser viewport snapshot"
                        className="w-full h-full object-contain bg-white"
                      />
                    ) : (
                      <iframe
                        src={viewport.url}
                        title="Browser Viewport"
                        className="w-full h-full border-none"
                        sandbox="allow-scripts allow-same-origin allow-forms"
                      />
                    )}
                  </div>
                </div>
              ) : (
                <div className="w-full max-w-2xl text-center space-y-7 animate-fadeIn">
                  <div className="space-y-2.5">
                    <h1 className="text-2xl sm:text-3xl font-semibold text-zinc-900 tracking-tight">
                      工作台实时监控就绪
                    </h1>
                    <p className="text-xs sm:text-sm text-zinc-500 max-w-lg mx-auto leading-relaxed">
                      AgtPilot 协同云端浏览器交互、沙盒代码执行与自动化工作流。选择一个推荐模版或在左侧输入指令快速启动。
                    </p>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5 text-left">
                    {suggestions.map((s, idx) => (
                      <button
                        key={idx}
                        onClick={() => onRunMission(s.prompt, s.title)}
                        className="p-4 sm:p-5 rounded-2xl border border-zinc-200/90 bg-white hover:bg-zinc-50/80 hover:border-zinc-300 hover:shadow-sm text-xs transition duration-150 shadow-2xs group flex flex-col justify-between"
                      >
                        <div>
                          <div className="flex items-center justify-between mb-2">
                            <span className="font-semibold text-sm text-zinc-900 group-hover:text-black">
                              {s.title}
                            </span>
                            <ChevronRight className="h-4 w-4 text-zinc-400 group-hover:text-zinc-700 group-hover:translate-x-0.5 transition-transform" />
                          </div>
                          <p className="text-xs text-zinc-500 line-clamp-2 leading-relaxed">
                            {s.prompt}
                          </p>
                        </div>
                        <div className="mt-3.5 pt-2.5 border-t border-zinc-100 flex items-center gap-1.5 text-[11px] text-zinc-400 font-medium group-hover:text-zinc-600">
                          <Sparkles className="h-3 w-3 text-zinc-400" />
                          <span>点击快速启动任务</span>
                        </div>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* 2. 隔离沙盒终端 (Terminal View) */}
          {rightTab === 'terminal' && (
            <div className="h-full rounded-2xl bg-zinc-950 border border-zinc-800 shadow-md flex flex-col font-mono text-xs overflow-hidden">
              <div className="h-9 bg-zinc-900/90 border-b border-zinc-800/80 px-4 flex items-center justify-between text-zinc-400">
                <div className="flex items-center gap-2">
                  <div className="flex gap-1.5">
                    <div className="h-2.5 w-2.5 rounded-full bg-red-500/80" />
                    <div className="h-2.5 w-2.5 rounded-full bg-amber-500/80" />
                    <div className="h-2.5 w-2.5 rounded-full bg-emerald-500/80" />
                  </div>
                  <span className="text-[11px] text-zinc-400 ml-2">sandbox: bash</span>
                </div>
                <span className="text-[10px] text-zinc-500">Node v20.x • Isolated Sandbox</span>
              </div>

              <div className="flex-1 p-4 overflow-y-auto space-y-1.5 text-zinc-300">
                {terminalLogs.length === 0 ? (
                  <p className="text-zinc-600 italic">等待沙盒命令执行...</p>
                ) : (
                  terminalLogs.map((log) => (
                    <div key={log.id} className="leading-relaxed break-words">
                      {log.type === 'command' && (
                        <span className="text-emerald-400 font-semibold">$ {log.text}</span>
                      )}
                      {log.type === 'stdout' && (
                        <span className="text-zinc-300 whitespace-pre-wrap">{log.text}</span>
                      )}
                      {log.type === 'stderr' && (
                        <span className="text-rose-400 whitespace-pre-wrap">{log.text}</span>
                      )}
                      {log.type === 'system' && (
                        <span className="text-zinc-500 italic"># {log.text}</span>
                      )}
                    </div>
                  ))
                )}
                <div ref={terminalEndRef} />
              </div>
            </div>
          )}

          {/* 3. 最终交付物成果 (Deliverable Artifact View) */}
          {rightTab === 'artifact' && (
            <div className="h-full max-w-4xl mx-auto rounded-2xl border border-zinc-200 bg-white shadow-sm flex flex-col overflow-hidden">
              <div className="h-12 border-b border-zinc-100 bg-zinc-50/50 px-6 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <FileText className="h-4 w-4 text-zinc-600" />
                  <span className="text-xs font-semibold text-zinc-900">
                    {artifact?.title || '任务交付物'}
                  </span>
                </div>
                {artifact?.type && (
                  <span className="text-[10px] font-mono uppercase bg-zinc-200/80 text-zinc-600 px-2 py-0.5 rounded">
                    {artifact.type}
                  </span>
                )}
              </div>

              <div className="flex-1 p-6 md:p-8 overflow-y-auto prose prose-zinc prose-sm max-w-none">
                {artifact?.content ? (
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>
                    {artifact.content}
                  </ReactMarkdown>
                ) : (
                  <div className="h-full flex flex-col items-center justify-center text-center py-16 text-zinc-400 space-y-2">
                    <FileText className="h-8 w-8 text-zinc-300" />
                    <p className="text-xs">暂无生成的结构化报告。当任务完成后，总结成果将在此展示。</p>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
