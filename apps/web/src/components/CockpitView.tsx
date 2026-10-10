'use client';

import React, { useRef, useEffect, useState } from 'react';
import { useSession } from 'next-auth/react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
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
  PanelRightClose,
  PanelRightOpen,
  ListTodo,
  Bot,
  User,
  ChevronDown,
  Wrench,
  Search,
  Code,
  AlertCircle,
  Download,
  Code2,
  Eye,
  Smartphone,
  Plug,
} from 'lucide-react';
import { XiaohongshuPreviewCard } from './XiaohongshuPreviewCard';
import { NotePackageList } from './workshops/NotePackageCard';
import { parseNotePackages } from '../lib/note-package';
import {
  Mission,
  ViewportState,
  TerminalLog,
  ApprovalRequest,
  ConnectorSuggestion,
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
  connectorSuggestions?: ConnectorSuggestion[];
  onConnectorAuthorize?: (s: ConnectorSuggestion) => void;
  onSkipConnectorSuggestion?: (s: ConnectorSuggestion) => void;
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
  connectorSuggestions = [],
  onConnectorAuthorize,
  onSkipConnectorSuggestion,
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
  const { data: session } = useSession();
  const currentUser = session?.user;
  const [prompt, setPrompt] = useState('');
  const [copiedArtifact, setCopiedArtifact] = useState(false);
  const [copiedStepId, setCopiedStepId] = useState<string | null>(null);
  const [artifactViewMode, setArtifactViewMode] = useState<'preview' | 'source' | 'social'>('preview');
  const [selectedArtifactIndex, setSelectedArtifactIndex] = useState<number>(0);
  const [expandedTools, setExpandedTools] = useState<Record<string, boolean>>({});
  const [showExecutionDetails, setShowExecutionDetails] = useState(false);
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);
  const [isWorkbenchOpen, setIsWorkbenchOpen] = useState(true);
  const [isWorkbenchExpanded, setIsWorkbenchExpanded] = useState(false);
  const terminalEndRef = useRef<HTMLDivElement>(null);
  const stepsEndRef = useRef<HTMLDivElement>(null);

  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (rightTab === 'terminal') {
      terminalEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [terminalLogs, rightTab]);

  // 如果 activeMissionId 为 null，说明用户点击了“新建会话”，界面应展示空白就绪状态，而不是强行回退到 missions[0]
  const currentMission = activeMissionId
    ? (missions.find((m) => m.id === activeMissionId) || null)
    : null;

  // 关键修复：当切换历史会话时，右侧浏览器、终端与交付成果紧密绑定当前选中的会话
  const activeViewport = currentMission?.viewport || (activeMissionId === currentMission?.id ? viewport : {
    activeTab: 'browser',
    url: 'about:blank',
    title: 'Ready',
    status: 'idle',
  });

  const activeTerminalLogs = currentMission?.terminalLogs || (activeMissionId === currentMission?.id ? terminalLogs : []);

  const activeArtifact = currentMission?.artifact || (activeMissionId === currentMission?.id ? artifact : null);

  useEffect(() => {
    if (currentMission?.steps?.length) {
      stepsEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [currentMission?.steps]);

  const handleCopyArtifact = () => {
    if (!activeArtifact?.content) return;
    navigator.clipboard.writeText(activeArtifact.content);
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
    setTimeout(() => {
      inputRef.current?.focus();
    }, 50);
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
                            : m.status === 'INTERRUPTED'
                            ? 'bg-amber-50 text-amber-700 border border-amber-200/60'
                            : 'bg-zinc-100 text-zinc-500'
                        }`}
                      >
                        {m.status === 'DONE'
                          ? '已完成'
                          : m.status === 'ACTIVE'
                          ? `${m.progress}%`
                          : m.status === 'INTERRUPTED'
                          ? '已中断'
                          : '等待中'}
                      </span>
                    </div>

                    <div className="flex items-center justify-between text-[10px] text-zinc-400 font-mono">
                      <span>会话</span>
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
        className={`flex flex-col min-w-[380px] bg-white transition-all ${
          isWorkbenchExpanded ? 'hidden' : isWorkbenchOpen ? 'flex-[0_1_44%] border-r border-zinc-200' : 'flex-1'
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
              <div className="flex items-center gap-3">
                <span className="text-[11px] font-semibold text-zinc-400 uppercase tracking-wider flex items-center gap-1.5">
                  <ListTodo className="h-3.5 w-3.5" />
                  <span>任务活动</span>
                </span>
                {currentMission && (
                  <button
                    type="button"
                    onClick={() => setShowExecutionDetails((value) => !value)}
                    className="text-[10px] text-zinc-400 hover:text-zinc-700 transition"
                  >
                    {showExecutionDetails ? '收起详情' : '查看执行详情'}
                  </button>
                )}
              </div>
            </div>

            <div className="flex items-center gap-2">
              {!isWorkbenchOpen && (
                <button
                  type="button"
                  onClick={() => setIsWorkbenchOpen(true)}
                  className="flex items-center gap-1 px-2 py-1 rounded-lg text-[10px] font-medium text-zinc-500 hover:text-zinc-800 hover:bg-zinc-100 transition"
                  title="打开执行工作区"
                >
                  <PanelRightOpen className="h-3.5 w-3.5" />
                  <span>工作区</span>
                </button>
              )}
              {currentMission && currentMission.status !== 'DONE' && onStopMission && (
                <button
                  type="button"
                  onClick={() => onStopMission(currentMission.id)}
                  className="flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-medium bg-red-50 text-red-600 hover:bg-red-100 border border-red-200 transition shadow-2xs"
                  title="终止当前执行"
                >
                  <Square className="h-3 w-3 fill-red-600" />
                  <span>终止执行</span>
                </button>
              )}
              {currentMission && (
                <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg border text-xs font-medium transition shadow-2xs">
                  {currentMission.status === 'ACTIVE' ? (
                    <div className="flex items-center gap-1.5 text-blue-700 bg-blue-50/80 -mx-1 px-1 rounded">
                      <span className="relative flex h-2 w-2">
                        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75" />
                        <span className="relative inline-flex rounded-full h-2 w-2 bg-blue-600" />
                      </span>
                      <span className="font-medium text-[11px]">正在处理...</span>
                    </div>
                  ) : currentMission.status === 'WAITING_APPROVAL' ? (
                    <div className="flex items-center gap-1.5 text-amber-700 bg-amber-50 -mx-1 px-1 rounded">
                      <Shield className="h-3 w-3 text-amber-600" />
                      <span className="text-[11px]">等待授权</span>
                    </div>
                  ) : (
                    <div className="flex items-center gap-1.5 text-zinc-600">
                      <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                      <span className="text-[11px] font-medium text-emerald-700">就绪</span>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>

          {currentMission ? (
            <div>
              <h2 className="text-sm font-semibold text-zinc-900 leading-snug">
                {currentMission.title}
              </h2>
            </div>
          ) : (
            <p className="text-xs text-zinc-400">准备就绪，随时可启动新任务或提问。</p>
          )}
        </div>

        {/* 任务中途连接器授权横幅（一键授权后任务原地继续） */}
        {connectorSuggestions.length > 0 && (
          <div className="m-3 p-3.5 rounded-xl border border-violet-200 bg-violet-50/90 shadow-xs flex items-center justify-between animate-fadeIn">
            <div className="flex items-center gap-2.5">
              <div className="h-8 w-8 rounded-lg bg-violet-100 text-violet-700 flex items-center justify-center flex-shrink-0">
                <Plug className="h-4 w-4" />
              </div>
              <div>
                <span className="text-xs font-semibold text-zinc-900 block">
                  任务需要「{connectorSuggestions[0].connectorName}」授权
                </span>
                <p className="text-[11px] text-zinc-600 mt-0.5">
                  {connectorSuggestions[0].reason} · 授权后任务原地继续，跳过则用浏览器兜底
                </p>
              </div>
            </div>

            <div className="flex items-center gap-1.5 flex-shrink-0">
              <button
                onClick={() => onSkipConnectorSuggestion?.(connectorSuggestions[0])}
                className="px-2.5 py-1 rounded-lg text-xs font-medium bg-white hover:bg-zinc-50 border border-zinc-200 text-zinc-700 transition"
              >
                跳过
              </button>
              <button
                onClick={() => onConnectorAuthorize?.(connectorSuggestions[0])}
                className="px-3 py-1 rounded-lg text-xs font-medium bg-violet-600 hover:bg-violet-500 text-white transition shadow-xs"
              >
                {connectorSuggestions[0].authType === 'oauth' ? '一键授权' : '去配置'}
              </button>
            </div>
          </div>
        )}

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

        {/* 核心会话与交互流 (Streamlined Manus / Linear Flow) */}
        <div className="flex-1 overflow-y-auto p-4 md:p-6 space-y-6">
          {currentMission && currentMission.steps && currentMission.steps.length > 0 ? (
            <div className="space-y-6 max-w-2xl mx-auto w-full">
              {(() => {
                // 将步骤按【连续工具调用】聚合为组，使长串搜索和调用收纳为单条优雅的行动链
                type RenderBlock =
                  | { type: 'user'; step: (typeof currentMission.steps)[0] }
                  | { type: 'tools'; steps: (typeof currentMission.steps); key: string }
                  | { type: 'assistant'; step: (typeof currentMission.steps)[0] };

                const blocks: RenderBlock[] = [];
                let currentTools: (typeof currentMission.steps) = [];
                // 兼容旧任务：每个用户轮次中最后一条已完成 assistant 文本视作最终答复。
                const legacyFinalAssistantIds = new Set<string>();
                let legacyCandidate: string | undefined;
                for (const step of currentMission.steps) {
                  const beginsNewTurn = step.role === 'user' || Boolean(step.userPrompt);
                  if (beginsNewTurn) {
                    if (legacyCandidate) legacyFinalAssistantIds.add(legacyCandidate);
                    legacyCandidate = undefined;
                  } else if (step.role === 'assistant' && step.status === 'DONE' && step.answer && !step.messageKind) {
                    legacyCandidate = step.id;
                  }
                }
                if (legacyCandidate) legacyFinalAssistantIds.add(legacyCandidate);

                currentMission.steps.forEach((st, idx) => {
                  const isUser = st.role === 'user' || Boolean(st.userPrompt);
                  const isAssistant = (st.role === 'assistant' || Boolean(st.answer)) && !isUser;
                  const isFinalAssistant = isAssistant && (
                    st.messageKind === 'final' ||
                    (!st.messageKind && legacyFinalAssistantIds.has(st.id))
                  );
                  // 中间模型轮次是执行过程，不再作为平级大回复；与工具调用一起归入活动块。
                  const isTool = !isUser && (!isAssistant || !isFinalAssistant);

                  if (isTool) {
                    currentTools.push(st);
                  } else {
                    if (currentTools.length > 0) {
                      blocks.push({
                        type: 'tools',
                        steps: [...currentTools],
                        key: `tools_group_${idx - currentTools.length}`,
                      });
                      currentTools = [];
                    }
                    if (isUser) {
                      blocks.push({ type: 'user', step: st });
                    } else if (isAssistant) {
                      blocks.push({ type: 'assistant', step: st });
                    }
                  }
                });

                if (currentTools.length > 0) {
                  blocks.push({
                    type: 'tools',
                    steps: currentTools,
                    key: `tools_group_final`,
                  });
                }

                return blocks.map((block) => {
                  // ================= 1. 用户提问气泡 (轻量现代感带用户专属头像) =================
                  if (block.type === 'user') {
                    const st = block.step;
                    return (
                      <div key={st.id} className="flex items-start justify-end gap-2.5 pt-2 group">
                        <div className="max-w-[85%] rounded-2xl bg-zinc-900 text-zinc-50 px-4 py-2.5 shadow-sm text-xs leading-relaxed selection:bg-zinc-700">
                          <p className="whitespace-pre-wrap font-normal">
                            {st.userPrompt || st.title}
                          </p>
                        </div>
                        {currentUser?.image ? (
                          <img
                            src={currentUser.image}
                            alt={currentUser.name || 'User'}
                            className="h-7 w-7 rounded-full object-cover border border-zinc-200 shadow-2xs flex-shrink-0 mt-0.5"
                          />
                        ) : (
                          <div className="h-7 w-7 rounded-full bg-zinc-200 text-zinc-700 border border-zinc-300/80 flex items-center justify-center flex-shrink-0 text-xs font-semibold mt-0.5 shadow-2xs">
                            {currentUser?.name ? currentUser.name.charAt(0).toUpperCase() : <User className="h-3.5 w-3.5" />}
                          </div>
                        )}
                      </div>
                    );
                  }

                  // ================= 2. 工具调用链聚合块 (Manus 风格流线手风琴) =================
                  if (block.type === 'tools') {
                    const groupSteps = block.steps;
                    const groupKey = block.key;
                    const isAnyRunning = groupSteps.some((s) => s.status === 'RUNNING');
                    const hasFailed = groupSteps.some((s) => s.status === 'FAILED');
                    const isGroupExpanded = expandedTools[groupKey] ?? (showExecutionDetails && isAnyRunning);

                    // 提取概览信息
                    const toolTypes = Array.from(new Set(groupSteps.map((s) => s.tool).filter(Boolean)));
                    const lastAction = groupSteps[groupSteps.length - 1];
                    const completedCount = groupSteps.filter((s) => s.status === 'DONE').length;
                    const lastProgressText = [...groupSteps].reverse().find((s) => s.role === 'assistant' && s.answer)?.answer;
                    const summaryLabel = isAnyRunning
                      ? lastAction.role === 'assistant'
                        ? '正在分析并规划下一步…'
                        : `正在${lastAction.tool?.includes('search') ? '搜索资料' : lastAction.tool?.includes('browser') ? '浏览网页' : lastAction.tool?.includes('sandbox') ? '运行分析' : '执行任务'}…`
                      : hasFailed
                      ? `执行过程中有步骤需要注意`
                      : `已完成 ${completedCount} 项任务活动`;

                    return (
                      <div key={groupKey} className="my-2.5 max-w-2xl mx-auto w-full animate-fadeIn">
                        <div className="rounded-xl border border-zinc-200/80 bg-zinc-50/70 hover:bg-zinc-50 transition overflow-hidden shadow-2xs">
                          {/* 聚合条目头部 */}
                          <div
                            onClick={() => {
                              setExpandedTools((prev) => ({
                                ...prev,
                                [groupKey]: !isGroupExpanded,
                              }));
                            }}
                            className="px-3.5 py-2.5 flex items-center justify-between cursor-pointer select-none"
                          >
                            <div className="flex items-center gap-2.5 min-w-0">
                              <div className="h-5 w-5 rounded-md bg-white border border-zinc-200/80 flex items-center justify-center flex-shrink-0 shadow-2xs">
                                {isAnyRunning ? (
                                  <RotateCw className="h-3 w-3 text-blue-600 animate-spin" />
                                ) : hasFailed ? (
                                  <AlertCircle className="h-3 w-3 text-red-500" />
                                ) : (
                                  <Sparkles className="h-3 w-3 text-zinc-600" />
                                )}
                              </div>

                              <div className="min-w-0">
                                <span className="text-[11px] font-medium text-zinc-700 truncate block">
                                  {summaryLabel}
                                </span>
                                {lastProgressText && (
                                  <span className="text-[10px] text-zinc-400 truncate block max-w-sm mt-0.5">
                                    {lastProgressText}
                                  </span>
                                )}
                              </div>

                              {showExecutionDetails && toolTypes.length > 0 && (
                                <div className="hidden sm:flex items-center gap-1">
                                  {toolTypes.slice(0, 3).map((t) => (
                                    <span
                                      key={t}
                                      className="text-[9px] font-mono px-1.5 py-0.2 rounded bg-zinc-200/60 text-zinc-600"
                                    >
                                      {t}
                                    </span>
                                  ))}
                                </div>
                              )}
                            </div>

                            <div className="flex items-center gap-2 flex-shrink-0">
                              <span className="text-[10px] text-zinc-400">
                                {groupSteps.length} 项活动
                              </span>
                              {showExecutionDetails && (
                                <ChevronDown
                                  className={`h-3.5 w-3.5 text-zinc-400 transition-transform duration-200 ${
                                    isGroupExpanded ? 'rotate-180' : ''
                                  }`}
                                />
                              )}
                            </div>
                          </div>

                          {/* 展开后的各子步骤列表 */}
                          {showExecutionDetails && isGroupExpanded && (
                            <div className="px-3 pb-3 pt-1 border-t border-zinc-200/50 space-y-1.5 bg-white/50">
                              {groupSteps.map((st) => {
                                const isSubExpanded = Boolean(expandedTools[st.id]);
                                const getIcon = () => {
                                  if (st.tool?.includes('search')) return <Search className="h-3 w-3 text-blue-500" />;
                                  if (st.tool?.includes('browser')) return <Globe className="h-3 w-3 text-indigo-500" />;
                                  if (st.tool?.includes('sandbox')) return <Code className="h-3 w-3 text-amber-500" />;
                                  return <Wrench className="h-3 w-3 text-zinc-500" />;
                                };

                                if (st.role === 'assistant') {
                                  return (
                                    <div key={st.id} className="rounded-lg border border-zinc-200/70 bg-white px-3 py-2.5 text-xs shadow-2xs">
                                      <div className="flex items-start gap-2">
                                        {st.status === 'RUNNING' ? (
                                          <RotateCw className="h-3 w-3 mt-0.5 text-blue-500 animate-spin flex-shrink-0" />
                                        ) : (
                                          <Sparkles className="h-3 w-3 mt-0.5 text-zinc-400 flex-shrink-0" />
                                        )}
                                        <div className="min-w-0">
                                          <p className="text-[10px] font-medium text-zinc-500 mb-0.5">阶段分析</p>
                                          <p className="text-[11px] text-zinc-600 leading-relaxed line-clamp-3 whitespace-pre-wrap">
                                            {st.answer || st.reasoning || st.title}
                                          </p>
                                        </div>
                                      </div>
                                    </div>
                                  );
                                }

                                return (
                                  <div
                                    key={st.id}
                                    className="rounded-lg border border-zinc-200/70 bg-white p-2 text-xs shadow-2xs"
                                  >
                                    <div
                                      onClick={() => {
                                        setExpandedTools((prev) => ({
                                          ...prev,
                                          [st.id]: !isSubExpanded,
                                        }));
                                      }}
                                      className="flex items-center justify-between gap-2 cursor-pointer select-none"
                                    >
                                      <div className="flex items-center gap-2 min-w-0">
                                        <div className="h-4.5 w-4.5 rounded bg-zinc-50 border border-zinc-100 flex items-center justify-center flex-shrink-0">
                                          {getIcon()}
                                        </div>
                                        <span className="font-mono text-[11px] font-semibold text-zinc-800">
                                          {st.tool || 'orchestrator'}
                                        </span>
                                        <span className="text-[10px] text-zinc-400 truncate">
                                          {st.args?.query || st.args?.url || st.args?.command || st.title}
                                        </span>
                                      </div>

                                      <div className="flex items-center gap-1.5 flex-shrink-0">
                                        {st.status === 'RUNNING' ? (
                                          <span className="text-[9px] text-blue-600 font-mono flex items-center gap-1">
                                            <span className="h-1.5 w-1.5 rounded-full bg-blue-600 animate-pulse" />
                                            执行中
                                          </span>
                                        ) : st.status === 'FAILED' ? (
                                          <span className="text-[9px] text-red-600 font-mono">失败</span>
                                        ) : (
                                          <span className="text-[9px] text-zinc-400 font-mono">
                                            {st.duration || '完成'}
                                          </span>
                                        )}
                                        <ChevronDown
                                          className={`h-3 w-3 text-zinc-300 transition-transform ${
                                            isSubExpanded ? 'rotate-180' : ''
                                          }`}
                                        />
                                      </div>
                                    </div>

                                    {/* 子步骤详细入参与出参 */}
                                    {isSubExpanded && (
                                      <div className="mt-2 pt-2 border-t border-zinc-100 space-y-1.5 text-[10px] font-mono animate-fadeIn">
                                        {st.args && (
                                          <div>
                                            <span className="text-zinc-400 uppercase text-[9px]">输入参数 (Args):</span>
                                            <pre className="mt-0.5 p-1.5 rounded bg-zinc-900 text-zinc-200 overflow-x-auto max-h-36">
                                              {JSON.stringify(st.args, null, 2)}
                                            </pre>
                                          </div>
                                        )}
                                        {st.output && (
                                          <div>
                                            <span className="text-zinc-400 uppercase text-[9px]">返回结果 (Output):</span>
                                            <pre className="mt-0.5 p-1.5 rounded bg-zinc-900 text-emerald-400 overflow-x-auto max-h-36 whitespace-pre-wrap">
                                              {typeof st.output === 'string' ? st.output : JSON.stringify(st.output, null, 2)}
                                            </pre>
                                          </div>
                                        )}
                                      </div>
                                    )}
                                  </div>
                                );
                              })}
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  }

                  // ================= 3. 智能体正式回复卡片 (精致沉浸式 Markdown) =================
                  if (block.type === 'assistant') {
                    const st = block.step;
                    // 流式中的 live step（打字机卡片）：shimmer 占位 / 打字光标 / 思考过程块
                    const isStreaming = st.status === 'RUNNING' && st.role === 'assistant';
                    // 思考过程折叠态复用 expandedTools（流式期间默认展开，结束后可收起）
                    const reasoningKey = `${st.id}_reasoning`;
                    const reasoningOpen = expandedTools[reasoningKey] ?? isStreaming;
                    // 笔记包(scenario-loop §3):流式期间不解析(文本不完整),流结束一次性切换,
                    // 避免原始 markdown → 卡片的闪烁;解析失败则保持普通 markdown 渲染
                    const parsedNote = st.answer && !isStreaming ? parseNotePackages(st.answer) : null;
                    const noteResult = parsedNote && parsedNote.packages.length > 0 ? parsedNote : null;

                    // 空壳卡（模型未产出任何文字就转入工具调用/收尾）：不渲染大卡片，
                    // 避免"已完成一轮推理"式空白卡污染时间线 —— 行动细节由工具链块呈现
                    if (!st.answer && !st.reasoning && !isStreaming) return null;

                    return (
                      <div key={st.id} className="flex items-start gap-3.5 group/ans relative">
                        <div className="h-7 w-7 rounded-xl bg-zinc-900 text-white flex items-center justify-center flex-shrink-0 shadow-2xs mt-0.5">
                          <Bot className="h-4 w-4" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <div
                            className={`rounded-2xl bg-white border p-4 md:p-5 shadow-2xs text-xs text-zinc-800 leading-relaxed relative transition-colors duration-300 ${
                              isStreaming ? 'border-blue-200/80' : 'border-zinc-200/80'
                            }`}
                          >
                            {/* 思考过程（推理模型 reasoning 流，可折叠；左竖线轻量样式，避免框中框） */}
                            {st.reasoning && (
                              <div className="mb-3">
                                <button
                                  type="button"
                                  onClick={() =>
                                    setExpandedTools((prev) => ({
                                      ...prev,
                                      [reasoningKey]: !reasoningOpen,
                                    }))
                                  }
                                  className="flex items-center gap-1.5 text-[11px] font-medium text-zinc-500 hover:text-zinc-700 select-none py-0.5"
                                >
                                  <Sparkles className={`h-3 w-3 ${isStreaming ? 'text-blue-500' : 'text-zinc-400'}`} />
                                  <span>思考过程</span>
                                  {isStreaming && (
                                    <span className="h-1 w-1 rounded-full bg-blue-500 animate-pulse" />
                                  )}
                                  <ChevronDown
                                    className={`h-3.5 w-3.5 text-zinc-400 transition-transform duration-200 ${
                                      reasoningOpen ? 'rotate-180' : ''
                                    }`}
                                  />
                                </button>
                                {reasoningOpen && (
                                  <div className="mt-1 pl-3 border-l-2 border-zinc-200 text-[11px] text-zinc-500 leading-relaxed whitespace-pre-wrap max-h-48 overflow-y-auto">
                                    {st.reasoning}
                                  </div>
                                )}
                              </div>
                            )}

                            {/* 尚无任何输出：思考 shimmer 占位（模型生成期间时间线不再静止） */}
                            {isStreaming && !st.answer && !st.reasoning ? (
                              <div className="flex items-center gap-2 text-zinc-400 py-0.5">
                                <span className="relative flex h-2 w-2">
                                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75" />
                                  <span className="relative inline-flex rounded-full h-2 w-2 bg-blue-600" />
                                </span>
                                <span className="text-[11px] font-medium">{st.title || '正在思考…'}</span>
                              </div>
                            ) : (
                              /* 正文只渲染 answer（title 不再兜底当正文，避免"深度思考中…"大字空段） */
                              st.answer && noteResult ? (
                                /* 小红书笔记包:字段级可复制卡片(复制整篇对齐发布页粘贴顺序) */
                                <NotePackageList result={noteResult} />
                              ) : (
                                st.answer && (
                                  <div className="prose prose-zinc prose-chat max-w-none break-words">
                                    <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]}>
                                      {st.answer}
                                    </ReactMarkdown>
                                    {isStreaming && (
                                      <span className="inline-block w-1.5 h-3.5 bg-zinc-800 animate-pulse ml-0.5 align-text-bottom" />
                                    )}
                                  </div>
                                )
                              )
                            )}

                            {/* 中断标记：live step 失败时明确失败态（保留已流出的部分文本） */}
                            {st.status === 'FAILED' && st.role === 'assistant' && (
                              <div className="mt-2.5 flex items-center gap-1.5 text-[11px] text-red-500">
                                <AlertCircle className="h-3.5 w-3.5" />
                                <span>回复已中断，以上为部分输出</span>
                              </div>
                            )}

                            {st.answer && !isStreaming && (
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  navigator.clipboard.writeText(st.answer!);
                                  setCopiedStepId(st.id);
                                  setTimeout(() => setCopiedStepId(null), 2000);
                                }}
                                className="absolute top-3 right-3 opacity-0 group-hover/ans:opacity-100 transition-opacity p-1.5 rounded-lg bg-zinc-50 hover:bg-zinc-100 text-zinc-500 hover:text-zinc-800 text-[10px] flex items-center gap-1 border border-zinc-200/80 shadow-2xs"
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
                            )}
                          </div>
                        </div>
                      </div>
                    );
                  }

                  return null;
                });
              })()}
              <div ref={stepsEndRef} />
            </div>
          ) : (
            <div className="py-24 text-center text-zinc-400 space-y-4 max-w-sm mx-auto">
              <div className="mx-auto w-12 h-12 rounded-2xl bg-zinc-100 border border-zinc-200/60 flex items-center justify-center text-zinc-500 shadow-2xs">
                <Bot className="h-6 w-6 text-zinc-700" />
              </div>
              <div className="space-y-1.5">
                <p className="text-sm font-semibold text-zinc-800">智能体待命就绪</p>
                <p className="text-xs text-zinc-400 leading-relaxed">
                  在下方输入探索目标或提问，AgtPilot 将自主规划子步骤、搜索网页、运行代码并交付成果。
                </p>
              </div>
            </div>
          )}
        </div>

        {/* 中间底部：Linear 风格流线输入框 */}
        <div className="p-3 md:p-4 border-t border-zinc-200/80 bg-white space-y-2">
          <form
            onSubmit={handleSubmit}
            className="flex items-center gap-2 bg-zinc-50 hover:bg-zinc-50/80 border border-zinc-200 rounded-xl px-3 py-2 focus-within:border-zinc-400 focus-within:bg-white focus-within:shadow-2xs transition"
          >
            <input
              ref={inputRef}
              type="text"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="指示 AgtPilot 进行网页浏览、代码运行、深入调研..."
              className="flex-1 bg-transparent border-none text-xs text-zinc-900 placeholder-zinc-400 focus:outline-none"
            />
            {currentMission && currentMission.status !== 'DONE' && !prompt.trim() ? (
              <button
                type="button"
                onClick={() => onStopMission && onStopMission(currentMission.id)}
                className="h-7 px-2 rounded-lg bg-red-50 hover:bg-red-100 text-red-600 border border-red-200 flex items-center gap-1 transition flex-shrink-0 text-[11px] font-medium"
                title="终止执行当前任务"
              >
                <Square className="h-3 w-3 fill-red-600" />
                <span>停止</span>
              </button>
            ) : (
              <button
                type="submit"
                disabled={!prompt.trim() || isSubmitting}
                className="h-7 w-7 rounded-lg bg-zinc-900 hover:bg-zinc-800 disabled:opacity-20 text-white flex items-center justify-center transition flex-shrink-0 shadow-2xs"
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
                <Cpu className="h-3 w-3 text-zinc-500" />
                <span className="text-zinc-400">驱动模型:</span>
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
              <span className="text-[10px] text-zinc-400 font-mono hidden sm:inline">Enter 发送</span>
            </div>
          )}
        </div>
      </section>

      {/* ========================================================= */}
      {/* 3. 右侧：副驾驶执行工作台 (Browser / Terminal / Artifact)     */}
      {/* ========================================================= */}
      {isWorkbenchOpen && (
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
              {currentMission?.status === 'ACTIVE' && activeViewport.status === 'navigating' && (
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
              {activeTerminalLogs.length > 0 && (
                <span className="text-[10px] bg-zinc-200 text-zinc-600 px-1 rounded-sm">
                  {activeTerminalLogs.length}
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
              {activeArtifact && <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />}
            </button>
          </div>

          {/* 顶栏辅助控制区 */}
          <div className="flex items-center gap-2">
            <button
              onClick={() => {
                setIsWorkbenchExpanded(false);
                setIsWorkbenchOpen(false);
              }}
              className="p-1.5 rounded-lg text-zinc-400 hover:text-zinc-700 hover:bg-zinc-100 transition"
              title="收起执行工作区"
            >
              <PanelRightClose className="h-4 w-4" />
            </button>
            {rightTab === 'browser' && activeViewport.url && activeViewport.url !== 'about:blank' && (
              <div className="flex items-center gap-1.5 text-xs text-zinc-500 font-mono truncate max-w-xs bg-zinc-50 border border-zinc-200 px-2.5 py-1 rounded-md">
                <Lock className="h-3 w-3 text-zinc-400 flex-shrink-0" />
                <span className="truncate">{activeViewport.url}</span>
              </div>
            )}

            {rightTab === 'artifact' && activeArtifact && (
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
        <div className={`flex-1 overflow-y-auto ${rightTab === 'browser' && activeViewport.url && activeViewport.url !== 'about:blank' ? 'p-0' : 'p-5'}`}>
          {/* 1. 真实浏览器画板 (Browser View) */}
          {rightTab === 'browser' && (
            <div className="h-full w-full flex flex-col">
              {activeViewport.url && activeViewport.url !== 'about:blank' ? (
                <div className="w-full h-full bg-white flex flex-col border-none">
                  {/* Browser Chrome Header */}
                  <div className="h-10 bg-zinc-100/90 border-b border-zinc-200 px-4 flex items-center justify-between gap-3 flex-shrink-0">
                    <div className="flex items-center gap-2">
                      <div className="flex gap-1.5">
                        <div className="h-2.5 w-2.5 rounded-full bg-red-400" />
                        <div className="h-2.5 w-2.5 rounded-full bg-amber-400" />
                        <div className="h-2.5 w-2.5 rounded-full bg-emerald-400" />
                      </div>
                      <div className="flex items-center gap-1.5 ml-3 px-3 py-1 rounded-lg bg-white border border-zinc-200 text-xs font-mono text-zinc-600 max-w-md truncate shadow-2xs">
                        <Lock className="h-3 w-3 text-zinc-400 flex-shrink-0" />
                        <span className="truncate">{activeViewport.url}</span>
                      </div>
                    </div>

                    <a
                      href={activeViewport.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center gap-1 text-[11px] text-zinc-500 hover:text-zinc-900 transition font-medium"
                    >
                      <span>在新标签页打开</span>
                      <ExternalLink className="h-3 w-3" />
                    </a>
                  </div>

                  {/* Browser Content */}
                  <div className="flex-1 w-full bg-white relative overflow-hidden flex flex-col">
                    {activeViewport.screenshotBase64 ? (
                      <img
                        src={activeViewport.screenshotBase64}
                        alt="Browser viewport snapshot"
                        className="w-full h-full object-contain bg-white"
                      />
                    ) : (
                      <div className="w-full h-full relative flex flex-col">
                        {/* 优雅提示条：处理外部网站 X-Frame-Options 拦截 */}
                        <div className="bg-amber-50/80 border-b border-amber-200/60 px-4 py-2 flex items-center justify-between text-xs text-amber-800 flex-shrink-0">
                          <div className="flex items-center gap-2">
                            <Shield className="h-3.5 w-3.5 text-amber-600 flex-shrink-0" />
                            <span>
                              部分站点受同源安全策略 (X-Frame-Options) 保护可能禁止内嵌预览。
                            </span>
                          </div>
                          <a
                            href={activeViewport.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1 font-medium text-amber-900 underline hover:text-black ml-2"
                          >
                            <span>在新窗口直接查看</span>
                            <ExternalLink className="h-3 w-3" />
                          </a>
                        </div>
                        <iframe
                          src={activeViewport.url}
                          title="Browser Viewport"
                          className="flex-1 w-full h-full border-none"
                          sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
                        />
                      </div>
                    )}
                  </div>
                </div>
              ) : (
                <div className="h-full flex items-center justify-center p-5">
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
              </div>

              <div className="flex-1 p-4 overflow-y-auto space-y-1.5 text-zinc-300">
                {activeTerminalLogs.length === 0 ? (
                  <p className="text-zinc-600 italic">等待沙盒命令执行...</p>
                ) : (
                  activeTerminalLogs.map((log) => (
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

          {/* 3. 最终交付物成果 (Deliverable Artifact Canvas) */}
          {rightTab === 'artifact' && (() => {
            // 提取当前任务中所有生成过的产物（支持多轮输出的多文档产物列表）
            const missionArtifacts: Array<{ title: string; type: string; content: string; id: string }> = [];
            const seen = new Set<string>();

            // 从 steps 中扫描是否有通过 artifact_render 输出的产物
            currentMission?.steps?.forEach((st) => {
              if (st.tool === 'artifact_render' && st.args?.content && !seen.has(st.args.content)) {
                seen.add(st.args.content);
                missionArtifacts.push({
                  id: st.id,
                  title: st.args.title || '交付产物',
                  type: st.args.type || 'markdown',
                  content: st.args.content,
                });
              }
            });

            // 补充绑定的最新主产物
            if (activeArtifact?.content && !seen.has(activeArtifact.content)) {
              missionArtifacts.unshift({
                id: 'active_main',
                title: activeArtifact.title || '交付产物',
                type: activeArtifact.type || 'markdown',
                content: activeArtifact.content,
              });
            }

            const currentArtifact = missionArtifacts[selectedArtifactIndex] || missionArtifacts[0] || null;

            const handleDownloadCurrent = () => {
              if (!currentArtifact?.content) return;
              const blob = new Blob([currentArtifact.content], { type: 'text/markdown;charset=utf-8;' });
              const url = URL.createObjectURL(blob);
              const link = document.createElement('a');
              link.href = url;
              link.setAttribute('download', `${currentArtifact.title || 'deliverable'}.md`);
              document.body.appendChild(link);
              link.click();
              document.body.removeChild(link);
            };

            const handleCopyCurrent = () => {
              if (!currentArtifact?.content) return;
              navigator.clipboard.writeText(currentArtifact.content);
              setCopiedArtifact(true);
              setTimeout(() => setCopiedArtifact(false), 2000);
            };

            return (
              <div className="h-full w-full rounded-2xl border border-zinc-200/90 bg-white shadow-sm flex flex-col overflow-hidden animate-fadeIn">
                {/* 顶部工具栏：标题、多文档 Tabs、预览/源码模式切换、复制与下载 */}
                <div className="h-11 border-b border-zinc-200/80 bg-zinc-50/70 px-4 flex items-center justify-between gap-3 select-none flex-shrink-0">
                  {/* 左侧：多文档标签页（Tabs） */}
                  <div className="flex items-center gap-1.5 min-w-0 overflow-x-auto scrollbar-none py-1">
                    {missionArtifacts.length > 0 ? (
                      missionArtifacts.map((art, idx) => {
                        const isTabActive = (selectedArtifactIndex === idx) || (selectedArtifactIndex >= missionArtifacts.length && idx === 0);
                        return (
                          <button
                            key={art.id}
                            onClick={() => setSelectedArtifactIndex(idx)}
                            className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium transition whitespace-nowrap ${
                              isTabActive
                                ? 'bg-white text-zinc-900 border border-zinc-200 shadow-2xs font-semibold'
                                : 'text-zinc-500 hover:text-zinc-800 hover:bg-zinc-100/60'
                            }`}
                          >
                            <FileText className="h-3 w-3 text-zinc-500" />
                            <span className="truncate max-w-[130px]">{art.title}</span>
                            <span className="text-[9px] uppercase font-mono px-1 py-0.2 rounded bg-zinc-100 text-zinc-500">
                              {art.type}
                            </span>
                          </button>
                        );
                      })
                    ) : (
                      <div className="flex items-center gap-1.5 text-xs font-medium text-zinc-600">
                        <FileText className="h-3.5 w-3.5 text-zinc-400" />
                        <span>交付画布 (Canvas)</span>
                      </div>
                    )}
                  </div>

                  {/* 右侧：预览/代码切换、复制、下载 */}
                  {currentArtifact && (
                    <div className="flex items-center gap-1.5 flex-shrink-0">
                      {/* 预览、源码与真机模拟多模切换 */}
                      <div className="flex items-center bg-zinc-200/60 p-0.5 rounded-lg text-[11px] font-medium text-zinc-600">
                        <button
                          onClick={() => setArtifactViewMode('preview')}
                          className={`flex items-center gap-1 px-2 py-0.5 rounded-md transition ${
                            artifactViewMode === 'preview'
                              ? 'bg-white text-zinc-900 shadow-2xs font-semibold'
                              : 'hover:text-zinc-900'
                          }`}
                        >
                          <Eye className="h-3 w-3" />
                          <span>文档</span>
                        </button>
                        <button
                          onClick={() => setArtifactViewMode('social')}
                          className={`flex items-center gap-1 px-2 py-0.5 rounded-md transition ${
                            artifactViewMode === 'social'
                              ? 'bg-white text-zinc-900 shadow-2xs font-semibold'
                              : 'hover:text-zinc-900'
                          }`}
                          title="切换至移动端与社交媒体 3:4 视觉卡片模拟器 (小红书/公众号/Twitter等)"
                        >
                          <Smartphone className="h-3 w-3 text-zinc-700" />
                          <span>移动端卡片</span>
                        </button>
                        <button
                          onClick={() => setArtifactViewMode('source')}
                          className={`flex items-center gap-1 px-2 py-0.5 rounded-md transition ${
                            artifactViewMode === 'source'
                              ? 'bg-white text-zinc-900 shadow-2xs font-semibold'
                              : 'hover:text-zinc-900'
                          }`}
                        >
                          <Code2 className="h-3 w-3" />
                          <span>源码</span>
                        </button>
                      </div>

                      <button
                        onClick={handleCopyCurrent}
                        className="p-1.5 rounded-lg border border-zinc-200 hover:bg-zinc-100 text-zinc-600 transition shadow-2xs"
                        title="复制 Markdown 内容"
                      >
                        {copiedArtifact ? (
                          <CheckCheck className="h-3.5 w-3.5 text-emerald-600" />
                        ) : (
                          <Copy className="h-3.5 w-3.5" />
                        )}
                      </button>

                      <button
                        onClick={handleDownloadCurrent}
                        className="p-1.5 rounded-lg border border-zinc-200 hover:bg-zinc-100 text-zinc-600 transition shadow-2xs"
                        title="下载文档文件 (.md)"
                      >
                        <Download className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  )}
                </div>

                {/* 主画布内容区 */}
                <div className="flex-1 overflow-y-auto p-4 md:p-6">
                  {currentArtifact ? (
                    artifactViewMode === 'social' ? (
                      <div className="animate-fadeIn">
                        <XiaohongshuPreviewCard
                          rawContent={currentArtifact.content}
                          title={currentArtifact.title}
                        />
                      </div>
                    ) : artifactViewMode === 'preview' ? (
                      <div className="prose prose-zinc prose-sm max-w-none leading-relaxed animate-fadeIn p-2 md:p-4">
                        <ReactMarkdown remarkPlugins={[remarkGfm]}>
                          {currentArtifact.content}
                        </ReactMarkdown>
                      </div>
                    ) : (
                      <div className="animate-fadeIn">
                        <pre className="p-4 rounded-xl bg-zinc-950 text-zinc-200 text-xs font-mono overflow-x-auto leading-relaxed border border-zinc-800">
                          <code>{currentArtifact.content}</code>
                        </pre>
                      </div>
                    )
                  ) : (
                    /* 实用型引导空状态 */
                    <div className="h-full flex flex-col items-center justify-center text-center py-16 space-y-4 max-w-xs mx-auto animate-fadeIn">
                      <div className="h-12 w-12 rounded-2xl bg-zinc-100 border border-zinc-200/80 flex items-center justify-center text-zinc-400 shadow-2xs">
                        <FileText className="h-6 w-6" />
                      </div>
                      <div className="space-y-1">
                        <p className="text-xs font-semibold text-zinc-800">暂无结构化交付物</p>
                        <p className="text-[11px] text-zinc-400 leading-relaxed">
                          任务执行中生成的完整研报、架构图或独立代码将实时同步到此处。
                        </p>
                      </div>

                      <div className="w-full pt-1 space-y-1.5">
                        <button
                          type="button"
                          onClick={() => onRunMission('请根据我们上面的对话，提炼生成一份结构化的总结分析报告并渲染到交付画布。')}
                          className="w-full py-1.5 px-3 rounded-lg border border-zinc-200 bg-zinc-50 hover:bg-zinc-100 text-zinc-700 text-xs font-medium transition flex items-center justify-center gap-1.5 shadow-2xs"
                        >
                          <Sparkles className="h-3 w-3 text-zinc-500" />
                          <span>将当前会话提炼为总结报告</span>
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            );
          })()}
        </div>
      </main>
      )}
    </div>
  );
}
