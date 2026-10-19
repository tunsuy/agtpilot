'use client';

import React, { useRef, useEffect, useState } from 'react';
import { copyToClipboard } from '../utils/nativeBridge';
import {useSession } from 'next-auth/react';
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
  ArrowDown,
  Lock,
  Shield,
  Coins,
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
  Activity,
  Search,
  Code,
  AlertCircle,
  HelpCircle,
  Download,
  Code2,
  Eye,
  Smartphone,
  Plug,
  FileDown,
  Trash2,
  Loader2,
} from 'lucide-react';
import { XiaohongshuPreviewCard } from './XiaohongshuPreviewCard';
import { ActivityFeedView } from './ActivityFeedView';
import { NotePackageList } from './workshops/NotePackageCard';
import { parseNotePackages } from '../workshops/xhs/note-package';
import { ArticlePackageList } from './workshops/ArticlePackageCard';
import { parseArticlePackages } from '../workshops/shared/article-package';
import { buildDraftDeliveryIndex } from '../lib/draft-delivery';
import { isRunnerTaskActive, runnerStateMeta, partitionApprovalsByMission, type RunnerTaskSummary } from '../lib/runner-dispatch';
import { TopicPickList } from './workshops/TopicPickCard';
import { parseTopicPicks } from '../workshops/xhs/topic-picks';
import { OssOpportunityList, parseOssDeliverable } from './workshops/OssOpportunityCard';
import { NovelPackageCard, type NovelChainHandler } from './workshops/NovelPackageCard';
import type { WorkshopRunPayload } from './workshops/run';
import { parseNovelPackage, assembleNovelDelivery } from '../workshops/novel/novel-package';
import { resolveDeliveryContract } from '../workshops/novel/delivery';
import { collectWorkshopDeliveries } from '../lib/workshop-delivery-view';
import { deliveredFieldsFromSteps, DELIVER_FIELD_TOOL } from '../lib/workshop-delivery';
import { RunnerPublishApprovalCard } from './RunnerPublishApprovalCard';
import { parseOssOpportunities } from '../workshops/oss_radar/opportunities';
import { hasWorkshopDeliverable } from '../workshops/deliverable';
import { resolveArtifactDraft } from '../workshops/registry';
import { splitStepsIntoBlocks, groupBlocksIntoTurns, findRetryPrompt, processElapsedMs, findFinalAnswerIndex, turnCreatesPlan } from '../lib/cockpit-blocks';
import { KanbanPlanCard } from './KanbanPlanCard';
import { sourcesForAnswer } from '../lib/search-sources';
import { narrateStep, formatActivityDuration } from '../lib/activity-narration';
import { formatTokenCount } from '../lib/mission-efficiency';
import {
  Mission,
  ViewportState,
  TerminalLog,
  ApprovalRequest,
  ConnectorSuggestion,
  PendingQuestion,
  ArtifactState,
  ConnectorApp,
} from '../types/agent';
import { QuestionCard } from './QuestionCard';

/**
 * 跳动的已耗时徽标（叶子组件自持 1s 定时器，只重渲染自身）：
 * 任务执行中 / 思考占位附带已耗时，慢模型首 token 前的长静默窗口
 * 持续有数字变化，不再「看似卡死」。<60s 显示秒，超 1 分钟显示 m+s。
 */
function ElapsedTick({
  startedAt,
  className,
}: {
  startedAt?: number;
  className?: string;
}) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!startedAt) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [startedAt]);
  if (!startedAt) return null;
  const total = Math.floor(Math.max(0, now - startedAt) / 1000);
  return (
    <span className={className || 'font-mono'}>
      {total < 60 ? `${total}s` : `${Math.floor(total / 60)}m${total % 60}s`}
    </span>
  );
}

interface CockpitViewProps {
  missions: Mission[];
  activeMissionId: string | null;
  onSelectMission: (id: string) => void;
  viewport: ViewportState;
  terminalLogs: TerminalLog[];
  approvalRequests: ApprovalRequest[];
  onApproval: (id: string, approved: boolean, opts?: { includeClaim?: boolean }) => void;
  connectorSuggestions?: ConnectorSuggestion[];
  onConnectorAuthorize?: (s: ConnectorSuggestion) => void;
  onSkipConnectorSuggestion?: (s: ConnectorSuggestion) => void;
  /** ask_user 问题卡(模糊需求先问后猜):按来源会话归属展示 */
  pendingQuestions?: PendingQuestion[];
  onAnswerQuestion?: (
    questionId: string,
    answers: Array<{ index: number; answer: string; via: 'option' | 'free_text' }>
  ) => void;
  artifact: ArtifactState | null;
  rightTab: 'browser' | 'terminal' | 'artifact' | 'activity';
  onRightTabChange: (tab: 'browser' | 'terminal' | 'artifact' | 'activity') => void;
  onRunMission: (prompt: string, title?: string, missionId?: string) => void;
  /** 小说包「下一步」出口(开书三段化串联):工坊载荷走服务端权威渲染,
   *  prompt 只作乐观气泡展示。续写包/大纲包之外的历史任务不触发。 */
  onRunNovelChain?: (workshop: WorkshopRunPayload, display: { prompt: string; title?: string }) => void;
  onStopMission?: (missionId: string) => Promise<void> | void;
  /** 删除历史会话(仅已完成/已中断可删;执行中任务先停止再删) */
  onDeleteMission?: (missionId: string) => Promise<void> | void;
  onNewSession?: () => void;
  isSubmitting: boolean;
  connectors?: ConnectorApp[];
  onSelectModel?: (modelId: string) => Promise<void>;
  /** 跳到设备页看本地任务(会话卡「本地 · …」chip 点击;不传则不显示 chip) */
  onOpenRunnerTask?: (taskId: string) => void;
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
  pendingQuestions = [],
  onAnswerQuestion,
  artifact,
  rightTab,
  onRightTabChange,
  onRunMission,
  onRunNovelChain,
  onStopMission,
  onDeleteMission,
  onNewSession,
  isSubmitting,
  connectors,
  onSelectModel,
  onOpenRunnerTask,
}: CockpitViewProps) {
  const { data: session } = useSession();
  const currentUser = session?.user;
  const [prompt, setPrompt] = useState('');
  const [copiedArtifact, setCopiedArtifact] = useState(false);
  const [copiedStepId, setCopiedStepId] = useState<string | null>(null);
  const [artifactViewMode, setArtifactViewMode] = useState<'preview' | 'source' | 'social'>('preview');
  const [selectedArtifactIndex, setSelectedArtifactIndex] = useState<number>(0);
  const [expandedTools, setExpandedTools] = useState<Record<string, boolean>>({});
  // 小红书托管写操作状态(连接器页 opt-in):笔记包「存入草稿箱」按钮的前提。
  // 判定与 xhs-managed 的 shouldInjectWriteTool 同规则(enabled + riskAckAt)
  const [xhsDraftEnabled, setXhsDraftEnabled] = useState(false);
  // 知乎托管写操作状态(同规则):文章包「存入知乎草稿」按钮的前提
  const [zhihuDraftEnabled, setZhihuDraftEnabled] = useState(false);
  // 本地 runner 任务(会话 ↔ 设备任务互跳):会话卡 chip 显示该会话派出的最新任务状态。
  // 只在能跳转(onOpenRunnerTask 提供设备页入口)时才轮询,避免无谓请求
  const [runnerTasks, setRunnerTasks] = useState<RunnerTaskSummary[]>([]);
  useEffect(() => {
    if (!onOpenRunnerTask) return;
    let cancelled = false;
    const load = async () => {
      try {
        const r = await fetch('/api/runner/tasks/mine');
        const j = await r.json();
        if (!cancelled && j?.success && Array.isArray(j.tasks)) setRunnerTasks(j.tasks.slice(0, 50));
      } catch {
        /* chip 是增强信息,失败不打扰会话主流程;下个轮询窗口重试 */
      }
    };
    load();
    const timer = setInterval(load, 10_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [onOpenRunnerTask]);
  const runnerTaskForMission = (missionId: string): RunnerTaskSummary | null =>
    runnerTasks.find((t) => t.missionId === missionId) ?? null;
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch('/api/xhs-managed');
        const data = await res.json();
        if (data.success) {
          setXhsDraftEnabled(Boolean(data.record?.enabled && data.record?.riskAckAt));
        }
      } catch {
        // 未登录/后端未就绪时静默:按钮不出现即可,不阻断会话渲染
      }
    })();
    (async () => {
      try {
        const res = await fetch('/api/zhihu-managed');
        const data = await res.json();
        if (data.success) {
          setZhihuDraftEnabled(Boolean(data.record?.enabled && data.record?.riskAckAt));
        }
      } catch {
        // 同上:静默降级
      }
    })();
  }, []);
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);
  const [isWorkbenchOpen, setIsWorkbenchOpen] = useState(true);
  const [isWorkbenchExpanded, setIsWorkbenchExpanded] = useState(false);
  // 侧栏会话删除的二次确认态:第一次点垃圾桶只亮红(防误删),3s 内再点才真删
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const confirmDeleteTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    return () => {
      if (confirmDeleteTimerRef.current) clearTimeout(confirmDeleteTimerRef.current);
    };
  }, []);
  const terminalEndRef = useRef<HTMLDivElement>(null);
  const stepsEndRef = useRef<HTMLDivElement>(null);
  /** 对话流滚动容器:智能跟随(贴底才自动滚动),上翻时出「回到底部」按钮 */
  const flowScrollRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);
  const [showJumpToBottom, setShowJumpToBottom] = useState(false);

  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (rightTab === 'terminal') {
      terminalEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [terminalLogs, rightTab]);

  // 输入框随内容自动长高(多行自适应,上限约 10 行后内部滚动)
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [prompt]);

  // 如果 activeMissionId 为 null，说明用户点击了“新建会话”，界面应展示空白就绪状态，而不是强行回退到 missions[0]
  const currentMission = activeMissionId
    ? (missions.find((m) => m.id === activeMissionId) || null)
    : null;

  // runner 发布审批归回来源会话:切会话不再全局跟随卡片(旧行为把无关审批
  // 糊在每个会话顶上);hidden 走下方细条提示 + 跳转,Navbar 角标仍全量计数。
  // 不带 missionId 的会话内安全审批恒可见,行为不变。
  const { visible: visibleApprovals, hidden: hiddenApprovals } = partitionApprovalsByMission(
    approvalRequests,
    activeMissionId
  );

  // ask_user 问题卡同款归属切分:只在来源会话展示,其他会话走细条提示
  const { visible: visibleQuestions, hidden: hiddenQuestions } = partitionApprovalsByMission(
    pendingQuestions,
    activeMissionId
  );

  // 投递目标按任务来源工坊路由(工坊包声明驱动,不嗅探任务标题):知乎工坊的
  // 文章包走知乎托管存草稿,其余文章包走公众号草稿箱;笔记包格式仅 xhs 产出。
  // 托管门(zhihu/xhs)由连接器页 opt-in 状态决定,无门工坊(公众号凭证内置)恒开。
  const articleDraft = resolveArtifactDraft(currentMission?.workshopId, 'article-package');
  const noteDraft = resolveArtifactDraft(currentMission?.workshopId, 'note-package');
  // 已落稿索引(防重复投递):扫 mission 步骤,落稿工具 DONE 且标题/正文命中本篇
  // → 卡片按钮转「已存入草稿箱」;任务在飞(ACTIVE/待审批)期间按钮一律禁用
  const articleDelivered = buildDraftDeliveryIndex(currentMission?.steps, articleDraft?.deliverTool);
  const noteDelivered = buildDraftDeliveryIndex(currentMission?.steps, noteDraft?.deliverTool);

  // 任务进入 ACTIVE（新任务 / 续聊 / 选中运行中会话）时自动切到「执行动态」：
  // 用户第一眼看到 agent 正在做什么；浏览中不再被视口更新抢走焦点（见 page.tsx 粘性规则）
  const prevMissionStatusRef = useRef<string | null>(null);
  useEffect(() => {
    const status = currentMission?.status || null;
    const prev = prevMissionStatusRef.current;
    prevMissionStatusRef.current = status;
    if (status === 'ACTIVE' && prev !== 'ACTIVE') {
      onRightTabChange('activity');
    }
  }, [currentMission?.id, currentMission?.status, onRightTabChange]);

  // 关键修复：当切换历史会话时，右侧浏览器、终端与交付成果紧密绑定当前选中的会话
  const activeViewport = currentMission?.viewport || (activeMissionId === currentMission?.id ? viewport : {
    activeTab: 'browser',
    url: 'about:blank',
    title: 'Ready',
    status: 'idle',
  });

  const activeTerminalLogs = currentMission?.terminalLogs || (activeMissionId === currentMission?.id ? terminalLogs : []);

  // 严格按当前会话归属取产物:历史会话没有 artifact 时不再回退全局
  // latestArtifact —— 那是"最近一次"产物,常属于别的任务,切换历史会话时
  // 右栏"成果"会把不属于它的交付物串台展示
  const activeArtifact =
    currentMission?.artifact ||
    (artifact && artifact.taskId === currentMission?.id ? artifact : null);

  // 智能滚动跟随:只有用户本来就贴在底部时新内容才自动滚动,
  // 上翻阅读历史不再被强行拽回;切换会话时重置为贴底态
  useEffect(() => {
    atBottomRef.current = true;
    setShowJumpToBottom(false);
    // 会话切换后产物列表整体更换,选中索引一并归零,避免停留在越界/错位项
    setSelectedArtifactIndex(0);
  }, [currentMission?.id]);

  useEffect(() => {
    if (currentMission?.steps?.length && atBottomRef.current) {
      stepsEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [currentMission?.steps]);

  const handleFlowScroll = () => {
    const el = flowScrollRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    atBottomRef.current = nearBottom;
    setShowJumpToBottom(!nearBottom);
  };

  const jumpToBottom = () => {
    atBottomRef.current = true;
    setShowJumpToBottom(false);
    stepsEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  const handleCopyArtifact = async () => {
    if (!activeArtifact?.content) return;
    // http 部署无 navigator.clipboard,copyToClipboard 内含 execCommand 降级
    if (!(await copyToClipboard(activeArtifact.content))) return;
    setCopiedArtifact(true);
    setTimeout(() => setCopiedArtifact(false), 2000);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!prompt.trim() || isSubmitting) return;
    onRunMission(prompt.trim(), undefined, activeMissionId || undefined);
    setPrompt('');
    // 发送后回到贴底态,跟进新一轮输出
    atBottomRef.current = true;
    setShowJumpToBottom(false);
  };

  /** 多行输入:Enter 发送、Shift+Enter 换行;中文输入法组词期间的回车不触发发送 */
  const handleInputKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      handleSubmit(e);
    }
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
                // 执行中/等待中的任务不能删(执行回路还在写盘);完成后与中断的可删
                const deletable = m.status === 'DONE' || m.status === 'INTERRUPTED';
                // 该会话派出的最新本地任务(互跳 chip;状态徽章样式与设备页同源)
                const rt = runnerTaskForMission(m.id);
                const confirmingDelete = confirmDeleteId === m.id;
                const handleDeleteClick = (e: React.MouseEvent) => {
                  e.stopPropagation();
                  if (!onDeleteMission) return;
                  if (!confirmingDelete) {
                    // 第一次点击:亮红进入待确认态,3s 无操作自动退回
                    setConfirmDeleteId(m.id);
                    if (confirmDeleteTimerRef.current) clearTimeout(confirmDeleteTimerRef.current);
                    confirmDeleteTimerRef.current = setTimeout(() => {
                      setConfirmDeleteId((cur) => (cur === m.id ? null : cur));
                    }, 3000);
                    return;
                  }
                  if (confirmDeleteTimerRef.current) clearTimeout(confirmDeleteTimerRef.current);
                  setConfirmDeleteId(null);
                  onDeleteMission(m.id);
                };
                return (
                  <div key={m.id} className="relative group/mission">
                    <button
                      onClick={() => onSelectMission(m.id)}
                      className={`w-full text-left p-2.5 rounded-xl border text-xs transition flex flex-col gap-1.5 ${
                        isActive
                          ? 'border-zinc-300 bg-zinc-100/90 text-zinc-900 shadow-2xs font-medium'
                          : 'border-transparent hover:bg-zinc-50 text-zinc-600 hover:text-zinc-900'
                      } ${deletable ? 'pr-8' : ''}`}
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

                    <div className="flex items-center justify-between gap-2 text-[10px] text-zinc-400 font-mono">
                      <span className="flex items-center gap-1.5 min-w-0">
                        <span className="shrink-0">会话</span>
                        {rt && onOpenRunnerTask && (
                          <span
                            role="button"
                            tabIndex={0}
                            onClick={(e) => {
                              e.stopPropagation();
                              onOpenRunnerTask(rt.taskId);
                            }}
                            className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md border text-[9px] font-medium font-sans truncate cursor-pointer transition ${runnerStateMeta(rt.state).cls}`}
                            title="此会话派发的本地任务 —— 点击到设备页看执行进展"
                          >
                            {isRunnerTaskActive(rt.state) && <Loader2 className="h-2.5 w-2.5 animate-spin shrink-0" />}
                            <span className="truncate">
                              本地 · {rt.state === 'running' ? '执行中' : rt.state === 'awaiting_approval' ? '待审批' : rt.state === 'finishing' ? '发布中' : rt.state === 'done' ? '完成' : rt.state === 'no_action' ? '无需改动' : rt.state === 'failed' ? '失败' : rt.state === 'cancelled' ? '已终止' : rt.state === 'expired' ? '过期' : '排队'}
                            </span>
                          </span>
                        )}
                      </span>
                      <span>
                        {new Date(m.startedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                      </span>
                    </div>
                    </button>

                    {/* 删除会话:悬停浮现;两步确认(首点亮红,3s 内再点真删) */}
                    {deletable && (
                      <button
                        type="button"
                        onClick={handleDeleteClick}
                        className={`absolute top-2 right-2 p-1 rounded-md transition ${
                          confirmingDelete
                            ? 'opacity-100 bg-red-50 text-red-600 border border-red-200'
                            : 'opacity-0 group-hover/mission:opacity-100 text-zinc-400 hover:text-red-600 hover:bg-red-50'
                        }`}
                        title={confirmingDelete ? '再点一次确认删除(会话记录不可恢复)' : '删除会话'}
                      >
                        <Trash2 className="h-3 w-3" />
                      </button>
                    )}
                  </div>
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
                      <span className="font-medium text-[11px]">正在处理…</span>
                      {currentMission.startedAt && (
                        <span className="text-[11px] font-mono text-blue-600/80">
                          · <ElapsedTick startedAt={currentMission.startedAt} />
                        </span>
                      )}
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
              {currentMission && currentMission.usage && (
                <div
                  className="flex items-center gap-1 px-2.5 py-1 rounded-lg border border-zinc-200 bg-white text-[11px] font-medium text-zinc-500 transition shadow-2xs"
                  title={`token 累计:输入 ${currentMission.usage.promptTokens} / 输出 ${currentMission.usage.completionTokens}(每步模型调用实时入账)`}
                >
                  <Coins className="h-3 w-3 text-zinc-400" />
                  <span className="font-mono tabular-nums">
                    {formatTokenCount(currentMission.usage.promptTokens)} / {formatTokenCount(currentMission.usage.completionTokens)}
                  </span>
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

        {/* ask_user 问题卡(先问后猜):agent 遇到模糊需求弹卡等回答,
            只在来源会话展示;回答后任务原地续跑 */}
        {visibleQuestions.length > 0 && onAnswerQuestion && (
          <div className="m-3 space-y-2">
            {visibleQuestions.map((q) => (
              <QuestionCard key={q.id} q={q} onAnswer={onAnswerQuestion} />
            ))}
          </div>
        )}

        {/* 其他会话的问题卡:细条提示 + 跳回来源会话(与发布审批同规则) */}
        {hiddenQuestions.length > 0 && (
          <div className="m-3 px-3.5 py-2 rounded-xl border border-sky-200/70 bg-sky-50/60 flex items-center justify-between gap-2 animate-fadeIn">
            <span className="inline-flex items-center gap-1.5 text-[11px] font-medium text-sky-800 min-w-0 truncate">
              <HelpCircle className="h-3 w-3 flex-shrink-0" />
              另有 {hiddenQuestions.length} 个问题等你回答(来自其他会话)
            </span>
            <div className="flex items-center gap-1.5 flex-shrink-0">
              {hiddenQuestions.map((q) => (
                <button
                  key={q.id}
                  onClick={() => q.missionId && onSelectMission(q.missionId)}
                  className="px-2.5 py-1 rounded-lg text-xs font-medium bg-white hover:bg-sky-50 border border-zinc-200 text-zinc-700 transition max-w-[10rem] truncate"
                >
                  {missions.find((m) => m.id === q.missionId)?.title || '未知会话'}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* 人机协同安全授权横幅 (如在中间流也需要响应)。
            多张审批全部堆叠展示：只渲染 [0] 时，排在后面的卡片要么看不见
            要么被误当成同一张点两次——正是「点了两次才生效」的观感来源。
            runner 发布审批带来源会话,只在其所属会话内展示(visibleApprovals) */}
        {visibleApprovals.length > 0 && (
          <div className="m-3 space-y-2 animate-fadeIn">
            {visibleApprovals.length > 1 && (
              <span className="inline-flex items-center gap-1 text-[11px] font-medium text-amber-700">
                <Shield className="h-3 w-3" />
                {visibleApprovals.length} 项待审批
              </span>
            )}
            {visibleApprovals.map((req) =>
              req.action === 'runner_publish' ? (
                // 本地贡献发布审批(M3):专用高危卡(PR 终稿/diffstat/固化命令集/认领留言勾选)
                <RunnerPublishApprovalCard key={req.id} req={req} onApproval={onApproval} />
              ) : (
              <div
                key={req.id}
                className="p-3.5 rounded-xl border border-amber-200 bg-amber-50/90 shadow-xs flex items-center justify-between"
              >
                <div className="flex items-center gap-2.5 min-w-0">
                  <div className="h-8 w-8 rounded-lg bg-amber-100 text-amber-700 flex items-center justify-center flex-shrink-0">
                    <Shield className="h-4 w-4" />
                  </div>
                  <div className="min-w-0">
                    <span className="text-xs font-semibold text-zinc-900 block truncate">
                      需要安全审批授权: {req.action}
                    </span>
                    <p className="text-[11px] text-zinc-600 mt-0.5 line-clamp-2">
                      {req.description}
                    </p>
                  </div>
                </div>

                <div className="flex items-center gap-1.5 flex-shrink-0">
                  <button
                    onClick={() => onApproval(req.id, false)}
                    className="px-2.5 py-1 rounded-lg text-xs font-medium bg-white hover:bg-zinc-50 border border-zinc-200 text-zinc-700 transition"
                  >
                    拒绝
                  </button>
                  <button
                    onClick={() => onApproval(req.id, true)}
                    className="px-3 py-1 rounded-lg text-xs font-medium bg-zinc-900 hover:bg-zinc-800 text-white transition shadow-xs"
                  >
                    放行
                  </button>
                </div>
              </div>
              )
            )}
          </div>
        )}

        {/* 其他会话的发布审批:卡片归回来源会话后,这里留一条细提示 + 跳转入口,
            避免「切走就找不到审批」(点标题跳回来源会话,完整卡片在那里展开) */}
        {hiddenApprovals.length > 0 && (
          <div className="m-3 px-3.5 py-2 rounded-xl border border-amber-200/70 bg-amber-50/60 flex items-center justify-between gap-2 animate-fadeIn">
            <span className="inline-flex items-center gap-1.5 text-[11px] font-medium text-amber-800 min-w-0 truncate">
              <Shield className="h-3 w-3 flex-shrink-0" />
              另有 {hiddenApprovals.length} 项发布审批待处理(来自其他会话)
            </span>
            <div className="flex items-center gap-1.5 flex-shrink-0">
              {hiddenApprovals.map((req) => (
                <button
                  key={req.id}
                  onClick={() => req.missionId && onSelectMission(req.missionId)}
                  className="px-2.5 py-1 rounded-lg text-xs font-medium bg-white hover:bg-zinc-50 border border-zinc-200 text-zinc-700 transition max-w-[10rem] truncate"
                >
                  {missions.find((m) => m.id === req.missionId)?.title || '未知会话'}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* 核心会话与交互流 (Streamlined Manus / Linear Flow) */}
        <div className="flex-1 relative min-h-0">
        <div className="absolute inset-0 overflow-y-auto p-4 md:p-6 space-y-6" ref={flowScrollRef} onScroll={handleFlowScroll}>
          {currentMission && currentMission.steps && currentMission.steps.length > 0 ? (
            <div className="space-y-5 max-w-2xl mx-auto w-full">
              {(() => {
                // 分块逻辑抽为纯函数(lib/cockpit-blocks):用户气泡 / 工具链聚合块 /
                // 正式回复卡。叙述模式默认在会话流(工具步骤翻译成人话动作);
                // 原始工具名与入参出参默认在右侧「执行动态」tab 查看
                const { blocks } = splitStepsIntoBlocks(currentMission.steps);

                // 逐字段交付(novel 设定包/大纲包)· mission 级渐进卡:契约经
                // mission.deliveryContract.id 现场重建,字段跨轮累积(steps 是持久
                // 事实源,注册表只是轮内缓存),卡只钉在最后一个含交付步的轮之后
                // (一张、最新位置)。文本解析路径无 deliveryContract → 全为 null,
                // 卡片不钉,行为与从前逐字节一致。
                const deliveryContract = currentMission.deliveryContract
                  ? resolveDeliveryContract(currentMission.deliveryContract.id)
                  : undefined;
                const deliveryProgress = collectWorkshopDeliveries(currentMission.steps, deliveryContract);
                const deliveryPkg =
                  deliveryProgress && deliveryContract
                    ? assembleNovelDelivery(deliveryContract.id, deliveredFieldsFromSteps(currentMission.steps))
                    : null;
                const groupedTurns = groupBlocksIntoTurns(blocks);
                let lastDeliveryTurnKey: string | null = null;
                if (deliveryProgress) {
                  for (const t of groupedTurns) {
                    if (t.type !== 'agent') continue;
                    const has = t.items.some(
                      (b) => b.type === 'tools' && b.steps.some((s) => s.tool === DELIVER_FIELD_TOOL)
                    );
                    if (has) lastDeliveryTurnKey = t.key;
                  }
                }

                return (
                  <>
                  {groupedTurns.map((turn) => {
                  // ================= 1. 用户提问气泡 (轻量现代感带用户专属头像) =================
                  if (turn.type === 'user') {
                    const st = turn.step;
                    // 排队中的追问:置灰 + 「排队中」提示(不打断在飞轮次,
                    // 下一步注入或轮末派发时由后端清除转正)
                    const isQueued = Boolean(st.queued);
                    return (
                      <div key={st.id} className="flex items-start justify-end gap-2.5 pt-2 group">
                        <div
                          className={
                            isQueued
                              ? 'max-w-[85%] rounded-2xl bg-zinc-100 text-zinc-400 border border-zinc-200 px-4 py-2.5 shadow-sm text-sm leading-relaxed italic selection:bg-zinc-200'
                              : 'max-w-[85%] rounded-2xl bg-zinc-900 text-zinc-50 px-4 py-2.5 shadow-sm text-sm leading-relaxed selection:bg-zinc-700'
                          }
                        >
                          <p className="whitespace-pre-wrap font-normal">
                            {st.userPrompt || st.title}
                          </p>
                          {isQueued && (
                            <p className="mt-1 text-[10px] not-italic text-zinc-400 flex items-center gap-1">
                              <Clock className="h-3 w-3" />
                              排队中，将在当前步骤完成后注入（不打断任务）
                            </p>
                          )}
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

                  // ======== 2. Agent 作答轮(Claude Code 式平铺流) ========
                  // 不再把整轮包进一张回复卡:轮首小标记 + 左竖线 rail 锚定
                  // 归属,工具活动/思考/正文作为流内一级块按时间平铺 —— 多轮
                  // 任务的每轮回复各自成段,不再堆进越撑越长的大框
                  // 空壳块(无文本也无流式)过滤后为空则整轮不渲染,不出白卡
                  const renderable = turn.items.filter(
                    (b) =>
                      b.type === 'tools' ||
                      Boolean(b.step.answer || b.step.reasoning) ||
                      b.step.status === 'RUNNING'
                  );
                  if (renderable.length === 0) return null;
                  const turnStreaming = turn.items.some(
                    (b) => b.type === 'assistant' && b.step.status === 'RUNNING'
                  );
                  // 整轮过程折叠:最终回复正文首字一出(或历史轮已带最终答复),
                  // 本轮全部过程(工具行 + 中间思考)收成一行「任务过程 · N 项」
                  // 摘要 —— 块与块的先后顺序不变,收起只发生在轮内过程区,最终
                  // 答复块始终可见;未手动操作前默认值随 finalIdx 翻转,手动后
                  // 尊重用户选择(与思考过程折叠同一 expandedTools 字典范式)。
                  // 边界取最后一个带正文的回复块而非第一个 —— 中间轮思考卡也
                  // 常带短叙述正文,首中会把其后的工具行/思考卡留在折叠区外
                  // (生产实测),取最后一个则边界随回复生成单调前移不回弹。
                  // 工坊成品豁免:步数耗尽强制总结会把成品清单留在中间 step,
                  // 带谓词时边界前移到成品块,卡片收尾直接可见(见 cockpit-blocks)
                  const finalIdx = findFinalAnswerIndex(renderable, hasWorkshopDeliverable);
                  const processBlocks = finalIdx >= 0 ? renderable.slice(0, finalIdx) : renderable;
                  const finalBlocks = finalIdx >= 0 ? renderable.slice(finalIdx) : [];
                  const turnOpen = expandedTools[turn.key] ?? finalIdx < 0;
                  // 摘要行计数:工具块数真实动作行,思考块计 1;
                  // 耗时取首步开始 → 末步结束的墙钟时间(思考/检索间隙也计入)
                  const processCount = processBlocks.reduce(
                    (n, b) =>
                      n +
                      (b.type === 'tools'
                        ? b.steps.filter((s) => s.tool || s.status === 'FAILED').length
                        : 1),
                    0
                  );
                  const processFailed = processBlocks.reduce(
                    (n, b) =>
                      n +
                      (b.type === 'tools'
                        ? b.steps.filter((s) => s.status === 'FAILED').length
                        : 0),
                    0
                  );
                  const elapsedLabel = (() => {
                    const ms = processElapsedMs(
                      processBlocks.flatMap((b) => (b.type === 'tools' ? b.steps : [b.step]))
                    );
                    return ms !== undefined ? formatActivityDuration(`${ms}ms`) : undefined;
                  })();
                  return (
                    <div key={turn.key} className="space-y-2.5">
                      {/* 轮首标记:轻量「谁在说话」锚(流式时蓝点亮起) */}
                      <div className="flex items-center gap-1.5 pl-0.5">
                        <div className="h-5 w-5 rounded-lg bg-zinc-900 text-white flex items-center justify-center shadow-2xs">
                          <Bot className="h-3 w-3" />
                        </div>
                        {turnStreaming && (
                          <span className="relative flex h-1.5 w-1.5">
                            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75" />
                            <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-blue-600" />
                          </span>
                        )}
                      </div>
                      {/* 左竖线 rail:同轮块视觉连续(替代原卡片边框),流式时变蓝 */}
                      <div
                        className={`ml-2.5 pl-4 border-l space-y-2.5 transition-colors duration-300 ${
                          turnStreaming ? 'border-blue-300/70' : 'border-zinc-200/80'
                        }`}
                      >
                        {/* 任务看板卡:看板在本轮立起来(planner_create_plan 落在
                            本轮过程块)即在本轮钉挂 —— 看板按提示词先于执行创建,
                            顶部即其真实时间线位置。不参与整轮过程折叠:受控进展
                            播报开始吐正文后过程区会收起,看板进度不能跟着消失;
                            状态经 mission.plan 实时刷新,重建看板自动替换 */}
                        {turnCreatesPlan(turn.items) && currentMission.plan && (
                          <KanbanPlanCard plan={currentMission.plan} />
                        )}
                        {/* 逐字段交付渐进卡:钉在最后一个含交付步的轮(KanbanPlanCard 同款
                            钉挂,不参与整轮过程折叠 —— 交付进度受控播报开始吐正文后不能
                            跟着收起)。字段取 mission 级累积,pkg 经 assembleNovelDelivery
                            由已交付字段拼成,progress 驱动骨架行/角标/入库门 */}
                        {turn.key === lastDeliveryTurnKey && deliveryProgress && deliveryPkg && (
                          <NovelPackageCard
                            pkg={deliveryPkg}
                            onChain={onRunNovelChain}
                            progress={deliveryProgress}
                          />
                        )}
                        {/* 整轮过程折叠开关:最终回复开始流式输出时,本轮全部
                            过程(工具行 + 中间思考)自动收成这一行,点开原地
                            展开回看完整时间线 */}
                        {finalIdx > 0 && (
                          <button
                            type="button"
                            onClick={() =>
                              setExpandedTools((prev) => ({
                                ...prev,
                                [turn.key]: !turnOpen,
                              }))
                            }
                            className="flex items-center gap-1.5 text-[11px] font-medium text-zinc-500 hover:text-zinc-700 select-none py-0.5"
                          >
                            <Wrench className="h-3 w-3 text-zinc-400" />
                            <span>任务过程 · {processCount} 项</span>
                            {elapsedLabel && (
                              <span className="text-[10px] text-zinc-400 font-mono">{elapsedLabel}</span>
                            )}
                            {processFailed > 0 && (
                              <span className="text-red-500">· {processFailed} 项失败</span>
                            )}
                            <ChevronDown
                              className={`h-3.5 w-3.5 text-zinc-400 transition-transform duration-200 ${
                                turnOpen ? 'rotate-180' : ''
                              }`}
                            />
                          </button>
                        )}
                        {(turnOpen ? processBlocks : []).concat(finalBlocks).map((block) => {
                  // ================= 2a. 工具活动时间线(逐行叙述,无入参出参) =================
                  // Claude Code 式:每个动作一行,行内是用户可读的行动语言(与右侧
                  // 「动态」tab 同源 narrateStep);失败行红显,执行异常在对话上下文
                  // 里可见,不只沉在右侧。原始工具名与入参出参的唯一展示位是动态区
                  if (block.type === 'tools') {
                    const rows = block.steps.filter((s) => s.tool || s.status === 'FAILED');
                    return (
                      <div key={block.key} className="space-y-1">
                        {rows.map((st) => {
                          const narrated = narrateStep(st);
                          if (!narrated) return null;
                          const isRunning = st.status === 'RUNNING';
                          const isFailed = st.status === 'FAILED';
                          const getActivityIcon = () => {
                            if (isFailed) return <AlertCircle className="h-3 w-3 text-red-500" />;
                            if (isRunning) return <RotateCw className="h-3 w-3 text-blue-600 animate-spin" />;
                            if (narrated.kind === 'search') return <Search className="h-3 w-3 text-blue-500" />;
                            if (narrated.kind === 'browser') return <Globe className="h-3 w-3 text-indigo-500" />;
                            if (narrated.kind === 'sandbox') return <Code className="h-3 w-3 text-amber-500" />;
                            return <Wrench className="h-3 w-3 text-zinc-400" />;
                          };
                          return (
                            <div key={st.id} className="flex items-center gap-2 min-w-0 animate-fadeIn">
                              <div className="h-4.5 w-4.5 rounded bg-zinc-50 border border-zinc-100 flex items-center justify-center flex-shrink-0">
                                {getActivityIcon()}
                              </div>
                              <span
                                className={`text-[11px] font-medium truncate flex-shrink-0 ${
                                  isFailed ? 'text-red-600' : 'text-zinc-700'
                                }`}
                              >
                                {isRunning ? `正在${narrated.label}` : narrated.label}
                              </span>
                              {narrated.detail && (
                                <span className="text-[10px] text-zinc-400 truncate">{narrated.detail}</span>
                              )}
                              <span className="ml-auto flex-shrink-0">
                                {isRunning ? (
                                  <span className="text-[9px] text-blue-600 font-mono flex items-center gap-1">
                                    <span className="h-1.5 w-1.5 rounded-full bg-blue-600 animate-pulse" />
                                    执行中
                                  </span>
                                ) : isFailed ? (
                                  <span className="text-[9px] text-red-600 font-mono">失败</span>
                                ) : (
                                  <span className="text-[9px] text-zinc-400 font-mono">
                                    {formatActivityDuration(st.duration) ?? '完成'}
                                  </span>
                                )}
                              </span>
                            </div>
                          );
                        })}
                      </div>
                    );
                  }

                  // ================= 3. 智能体回复块 (流内裸排 Markdown,思考可折叠) =================
                  if (block.type === 'assistant') {
                    const st = block.step;
                    // 流式中的 live step（打字机卡片）：shimmer 占位 / 打字光标 / 思考过程块
                    const isStreaming = st.status === 'RUNNING' && st.role === 'assistant';
                    // 思考过程折叠态复用 expandedTools(流式期间默认展开,正文
                    // 开始输出后随工具过程一起默认收起,避免顶到正在打字的答复;
                    // 手动展开/收起后尊重用户选择,收尾后默认保持收起)。
                    // 整轮收起时(finalIdx > 0 且未展开)最终答复自带的思考流
                    // 一并归入「任务过程」—— 不再单独挂在正文上方(用户要的是
                    // 全部按时间线收成一行);展开轮次时按时间线原位恢复。
                    // finalIdx ≤ 0(纯对话轮,无过程行可展开)不隐藏,思考流
                    // 仍走自身折叠开关,否则简单问答的思考永久不可见
                    const reasoningKey = `${st.id}_reasoning`;
                    const reasoningOpen = expandedTools[reasoningKey] ?? (isStreaming && !st.answer);
                    const reasoningInSection = turnOpen || finalIdx <= 0;
                    // 笔记包(scenario-loop §3):流式期间不解析(文本不完整),流结束一次性切换,
                    // 避免原始 markdown → 卡片的闪烁;解析失败则保持普通 markdown 渲染
                    const parsedNote = st.answer && !isStreaming ? parseNotePackages(st.answer) : null;
                    const noteResult = parsedNote && parsedNote.packages.length > 0 ? parsedNote : null;
                    // 每周选题勾选卡(scenario-loop P1):选题头与笔记包头不相交,先试选题;
                    // 勾选后「成稿选中」续聊本 mission —— 选题→成稿多步工作流的人工确认点
                    const parsedPicks = st.answer && !isStreaming ? parseTopicPicks(st.answer) : null;
                    const pickResult = parsedPicks && parsedPicks.picks.length > 0 ? parsedPicks : null;
                    // 公众号文章包(草稿箱直投):文章包四头全命中 parseNotePackages(会误判),
                    // 【摘要】是互斥锚 —— article 必须先于 note 判定(渲染顺序固化,测试反证锚定)
                    const parsedArticle = st.answer && !isStreaming ? parseArticlePackages(st.answer) : null;
                    const articleResult =
                      parsedArticle && parsedArticle.packages.length > 0 ? parsedArticle : null;
                    // 开源贡献机会(开源贡献雷达):有效性要求【项目】+ 至少一条链接,
                    // 与选题/文章包/笔记包三种格式的字段头互不相交(解析器测试双向锚定),顺序不敏感
                    const parsedOss = st.answer && !isStreaming ? parseOssOpportunities(st.answer) : null;
                    const ossResult =
                      parsedOss && parsedOss.opportunities.length > 0 ? parsedOss : null;
                    // 小说包(novel 工坊):开书包锚【设定集】+【粗纲】,续写包锚【书号】(nv_ 前缀)
                    // +【本章摘要】——【本章摘要】不命中文章包的【摘要】锚(其正则要求「摘要」顶格),
                    // 与选题/笔记/文章/开源四种格式字段头互不相交(解析器测试双向锚定),顺序不敏感
                    const parsedNovelRaw = st.answer && !isStreaming ? parseNovelPackage(st.answer) : null;
                    // 去重护栏:逐字段交付已齐全且文本 fallback 又解析出同 kind 包时,
                    // 跳过文本卡(防 wrap-up 复述已交付内容渲染出双卡)——渐进卡已是权威
                    const parsedNovel =
                      parsedNovelRaw && deliveryProgress?.complete && deliveryPkg && deliveryPkg.kind === parsedNovelRaw.kind
                        ? null
                        : parsedNovelRaw;
                    // 搜索来源引用(ChatGPT 式):最终答复收尾后,取本轮(上一条
                    // 最终答复之后)检索步骤的结构化结果,渲染可跳转的来源卡
                    const answerIndex = currentMission.steps.findIndex((s) => s.id === st.id);
                    const searchSources =
                      st.messageKind === 'final' && st.answer && !isStreaming && answerIndex >= 0
                        ? sourcesForAnswer(currentMission.steps, answerIndex)
                        : [];
                    // 内联角标来源:流式期间即取(来源来自答复之前的步骤,已稳定;
                    // 模型被要求以 markdown 链接引用检索结果,按 URL 匹配渲染成
                    // 角标)。序号与收尾后的来源卡同一顺序,药丸即图例
                    const inlineSources =
                      (st.messageKind === 'final' || (isStreaming && st.role === 'assistant')) &&
                      st.answer &&
                      answerIndex >= 0
                        ? sourcesForAnswer(currentMission.steps, answerIndex)
                        : [];
                    const inlineSourceIndex = new Map(inlineSources.map((s, i) => [s.url, i + 1]));

                    // 空壳卡（模型未产出任何文字就转入工具调用/收尾）：不渲染大卡片，
                    // 避免"已完成一轮推理"式空白卡污染时间线 —— 行动细节由工具链块呈现
                    if (!st.answer && !st.reasoning && !isStreaming) return null;

                    return (
                      <div key={st.id} className="group/ans relative text-sm text-zinc-800 leading-relaxed">
                            {/* 思考过程（推理模型 reasoning 流，可折叠；左竖线轻量样式，避免框中框）。
                                整轮收起时不渲染 —— 最终答复的思考流已归入「任务过程」行 */}
                            {st.reasoning && reasoningInSection && (
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
                                  {/* 流式态补已耗时:思考稀疏流出时(长上下文
                                      模型每秒仅数十字)耗时表此前只挂在无输出占位上,
                                      一出字就消失,静默期看似「没有任何动作」 */}
                                  {isStreaming && st.startedAt && (
                                    <span className="text-[10px] font-mono text-zinc-400">
                                      · <ElapsedTick startedAt={st.startedAt} />
                                    </span>
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

                            {/* 尚无任何输出：思考 shimmer 占位（模型生成期间时间线不再静止）；
                                附带跳动的已耗时，长静默窗口也能看出「活着」 */}
                            {isStreaming && !st.answer && !st.reasoning ? (
                              <div className="flex items-center gap-2 text-zinc-400 py-0.5">
                                <span className="relative flex h-2 w-2">
                                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75" />
                                  <span className="relative inline-flex rounded-full h-2 w-2 bg-blue-600" />
                                </span>
                                <span className="text-[11px] font-medium">{st.title || '正在思考…'}</span>
                                {st.startedAt && (
                                  <span className="text-[10px] font-mono text-zinc-400">
                                    · <ElapsedTick startedAt={st.startedAt} />
                                  </span>
                                )}
                              </div>
                            ) : (
                              /* 正文只渲染 answer（title 不再兜底当正文，避免"深度思考中…"大字空段） */
                              st.answer && pickResult ? (
                                /* 每周选题:可勾选卡片,勾选后一键成稿续聊本任务 */
                                <TopicPickList
                                  result={pickResult}
                                  missionId={activeMissionId || currentMission?.id}
                                  onRunMission={onRunMission}
                                />
                              ) : st.answer && parsedNovel ? (
                                /* 小说包(开书三段化):设定包/大纲包/续写包/文风锚包各一张卡,
                                   「存入书库」落状态库,「继续:下一步」串下一段任务;
                                   续写包/大纲包书号入库前按用户书库校验,未命中给下拉指认(绝不猜归属) */
                                <NovelPackageCard pkg={parsedNovel} onChain={onRunNovelChain} />
                              ) : st.answer && ossResult ? (
                                /* 开源贡献机会:卡片可派发到本地(missionId 关联当前会话,任务↔会话可互跳) */
                                <OssOpportunityList result={ossResult} missionId={activeMissionId || currentMission?.id} />
                              ) : st.answer && articleResult ? (
                                /* 文章包:先于笔记包判定(【摘要】互斥锚);投草稿走续聊 + 审批门。
                                   投递目标按 mission.workshopId 经工坊包声明路由(zhihu 工坊 →
                                   知乎托管,其余 → 公众号) */
                                <ArticlePackageList
                                  result={articleResult}
                                  missionId={activeMissionId || currentMission?.id}
                                  onRunMission={onRunMission}
                                  draft={articleDraft}
                                  draftEnabled={articleDraft?.managedGate !== 'zhihu' || zhihuDraftEnabled}
                                  missionStatus={currentMission?.status}
                                  draftDelivered={articleDelivered}
                                />
                              ) : st.answer && noteResult ? (
                                /* 小红书笔记包:字段级可复制卡片 + 开启托管写操作后的「存草稿箱」(续聊 + 审批门) */
                                <NotePackageList
                                  result={noteResult}
                                  missionId={activeMissionId || currentMission?.id}
                                  onRunMission={onRunMission}
                                  draft={noteDraft}
                                  draftEnabled={noteDraft?.managedGate !== 'xhs' || xhsDraftEnabled}
                                  missionStatus={currentMission?.status}
                                  draftDelivered={noteDelivered}
                                />
                              ) : (
                                st.answer && (
                                  <div className="prose prose-zinc prose-chat max-w-none break-words">
                                    <ReactMarkdown
                                      remarkPlugins={[remarkGfm, remarkBreaks]}
                                      components={{
                                        /* 内联引用角标:模型以 markdown 链接引用检索
                                           结果(search_web 工具描述要求),URL 命中本
                                           轮来源集合时收成上标角标 [n](n 与底部来源
                                           药丸同序);其余链接按普通外链渲染 */
                                        a: ({ href, children }) => {
                                          const num = href ? inlineSourceIndex.get(href) : undefined;
                                          if (num !== undefined) {
                                            return (
                                              <a
                                                href={href}
                                                target="_blank"
                                                rel="noopener noreferrer"
                                                title={inlineSources[num - 1].title}
                                                className="no-underline text-blue-600 hover:text-blue-700 text-[10px] align-super"
                                              >
                                                [{num}]
                                              </a>
                                            );
                                          }
                                          return (
                                            <a href={href} target="_blank" rel="noopener noreferrer">
                                              {children}
                                            </a>
                                          );
                                        },
                                      }}
                                    >
                                      {st.answer}
                                    </ReactMarkdown>
                                    {isStreaming && (
                                      <span className="inline-block w-1.5 h-3.5 bg-zinc-800 animate-pulse ml-0.5 align-text-bottom" />
                                    )}
                                  </div>
                                )
                              )
                            )}

                            {/* 搜索来源卡(ChatGPT 式):编号药丸 + favicon + 页面标题,
                                新标签直达原始网页;无搜索结果或流式中不渲染。
                                展示标题而非域名 —— 同域多结果(如一页页知乎)不再
                                长得一模一样;域名靠 favicon + hover 提示呈现 */}
                            {searchSources.length > 0 && (
                              <div className="mt-2.5 flex items-center gap-1.5 flex-wrap">
                                {searchSources.map((src, idx) => (
                                  <a
                                    key={src.url}
                                    href={src.url}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    title={`${src.title} · ${src.host}`}
                                    className="flex items-center gap-1.5 max-w-[240px] px-2 py-0.5 rounded-full border border-zinc-200 bg-white hover:border-zinc-300 hover:bg-zinc-50 text-[11px] text-zinc-600 hover:text-zinc-800 transition shadow-2xs"
                                  >
                                    {/* eslint-disable-next-line @next/next/no-img-element -- 站点 favicon 走外部域名,无需 next/image 优化 */}
                                    <img
                                      src={`https://www.google.com/s2/favicons?domain=${src.host}&sz=32`}
                                      alt=""
                                      className="h-3.5 w-3.5 rounded-sm flex-shrink-0"
                                      onError={(e) => {
                                        e.currentTarget.style.display = 'none';
                                      }}
                                    />
                                    <span className="text-zinc-400 font-mono text-[9px] flex-shrink-0">{idx + 1}</span>
                                    <span className="truncate">{src.title}</span>
                                  </a>
                                ))}
                              </div>
                            )}

                            {/* 中断标记:live step 失败时明确失败态(保留已流出的部分文本)+ 重新生成入口 */}
                            {st.status === 'FAILED' && st.role === 'assistant' && (
                              <div className="mt-2.5 flex items-center justify-between gap-2">
                                <div className="flex items-center gap-1.5 text-[11px] text-red-500">
                                  <AlertCircle className="h-3.5 w-3.5" />
                                  <span>回复已中断，以上为部分输出</span>
                                </div>
                                {(() => {
                                  const retryPrompt = findRetryPrompt(currentMission.steps, st.id);
                                  if (!retryPrompt || currentMission.status === 'ACTIVE') return null;
                                  return (
                                    <button
                                      type="button"
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        atBottomRef.current = true;
                                        setShowJumpToBottom(false);
                                        onRunMission(retryPrompt, undefined, currentMission.id);
                                      }}
                                      className="flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11px] font-medium bg-white text-zinc-700 border border-zinc-200 hover:border-zinc-400 hover:bg-zinc-50 transition shadow-2xs"
                                      title="用同一问题在本会话重新生成"
                                    >
                                      <RotateCw className="h-3 w-3" />
                                      <span>重新生成</span>
                                    </button>
                                  );
                                })()}
                              </div>
                            )}

                            {st.answer && !isStreaming && (
                              <button
                                type="button"
                                onClick={async (e) => {
                                  e.stopPropagation();
                                  if (!(await copyToClipboard(st.answer!))) return;
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
                    );
                  }

                  return null;
                        })}
                      </div>
                    </div>
                  );
                })}
                </>
                );
              })()}
              {/* 步骤间隙的「任务还活着」指示:mission 仍在跑但此刻没有任何 RUNNING
                  步骤(上一工具已完成、下一轮模型还没吐 start-step —— 中转延迟或
                  瞬时卡住时这个窗口可长达数分钟),会话流此前会静止在「已完成 x
                  项活动」,看起来像卡死。补一行持续跳动的衔接指示 + 间隙已耗时 */}
              {currentMission.status === 'ACTIVE' &&
                !currentMission.steps.some((s) => s.status === 'RUNNING') && (
                  <div className="flex items-center gap-2 text-zinc-400 py-0.5 pl-[26px]">
                    <span className="relative flex h-2 w-2">
                      <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75" />
                      <span className="relative inline-flex rounded-full h-2 w-2 bg-blue-600" />
                    </span>
                    <span className="text-[11px] font-medium">正在衔接下一步…</span>
                    <span className="text-[10px] font-mono text-zinc-400">
                      ·{' '}
                      <ElapsedTick
                        startedAt={(() => {
                          const steps = currentMission.steps;
                          for (let i = steps.length - 1; i >= 0; i--) {
                            if (!steps[i].startedAt) continue;
                            const ms = steps[i].duration
                              ? Number.parseInt(String(steps[i].duration).replace(/[^\d]/g, ''), 10)
                              : 0;
                            return steps[i].startedAt! + (Number.isFinite(ms) ? ms : 0);
                          }
                          return currentMission.startedAt;
                        })()}
                      />
                    </span>
                  </div>
                )}
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
        {/* 上翻阅读历史时的「回到底部」浮动按钮(智能跟随:贴底才自动滚动) */}
        {showJumpToBottom && (
          <button
            type="button"
            onClick={jumpToBottom}
            className="absolute bottom-3 left-1/2 -translate-x-1/2 flex items-center gap-1 px-3 py-1.5 rounded-full bg-white border border-zinc-200 text-[11px] font-medium text-zinc-600 shadow-md hover:bg-zinc-50 transition z-10 animate-fadeIn"
            title="回到最新消息"
          >
            <ArrowDown className="h-3 w-3" />
            <span>回到底部</span>
          </button>
        )}
        </div>

        {/* 中间底部：Linear 风格流线输入框(多行自适应:Enter 发送 / Shift+Enter 换行) */}
        <div className="p-3 md:p-4 border-t border-zinc-200/80 bg-white space-y-2">
          <form
            onSubmit={handleSubmit}
            className="flex items-end gap-2 bg-zinc-50 hover:bg-zinc-50/80 border border-zinc-200 rounded-xl px-3 py-2 focus-within:border-zinc-400 focus-within:bg-white focus-within:shadow-2xs transition"
          >
            <textarea
              ref={inputRef}
              rows={1}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={handleInputKeyDown}
              placeholder="指示 AgtPilot 进行网页浏览、代码运行、深入调研..."
              className="flex-1 resize-none bg-transparent border-none text-xs text-zinc-900 placeholder-zinc-400 focus:outline-none leading-relaxed py-1 max-h-[200px] overflow-y-auto"
            />
            <div className="flex items-center gap-1.5 flex-shrink-0 pb-0.5">
              {/* 执行中停止键常驻:打字不再把它顶掉,随时可终止;有文字时并排出现发送键 */}
              {currentMission && currentMission.status !== 'DONE' && (
                <button
                  type="button"
                  onClick={() => onStopMission && onStopMission(currentMission.id)}
                  className="h-7 px-2 rounded-lg bg-red-50 hover:bg-red-100 text-red-600 border border-red-200 flex items-center gap-1 transition text-[11px] font-medium"
                  title="终止执行当前任务"
                >
                  <Square className="h-3 w-3 fill-red-600" />
                  <span>停止</span>
                </button>
              )}
              {(!currentMission || currentMission.status === 'DONE' || prompt.trim()) && (
                <button
                  type="submit"
                  disabled={!prompt.trim() || isSubmitting}
                  className="h-7 w-7 rounded-lg bg-zinc-900 hover:bg-zinc-800 disabled:opacity-20 text-white flex items-center justify-center transition shadow-2xs"
                  title="发送 (Enter)"
                >
                  {isSubmitting ? (
                    <RotateCw className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <ArrowUp className="h-3.5 w-3.5" />
                  )}
                </button>
              )}
            </div>
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
              <span className="text-[10px] text-zinc-400 font-mono hidden sm:inline">Enter 发送 · Shift+Enter 换行</span>
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
          <div className="flex items-center gap-1 min-w-0 overflow-x-auto scrollbar-none">
            <button
              onClick={() => onRightTabChange('browser')}
              title="实时浏览器"
              className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium transition whitespace-nowrap flex-shrink-0 ${
                rightTab === 'browser'
                  ? 'bg-zinc-100 text-zinc-900 font-semibold'
                  : 'text-zinc-500 hover:text-zinc-900 hover:bg-zinc-50'
              }`}
            >
              <Globe className="h-3.5 w-3.5" />
              <span>浏览器</span>
              {currentMission?.status === 'ACTIVE' && activeViewport.status === 'navigating' && (
                <span className="h-1.5 w-1.5 rounded-full bg-blue-600 animate-ping" />
              )}
            </button>

            <button
              onClick={() => onRightTabChange('terminal')}
              title="运行终端"
              className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium transition whitespace-nowrap flex-shrink-0 ${
                rightTab === 'terminal'
                  ? 'bg-zinc-100 text-zinc-900 font-semibold'
                  : 'text-zinc-500 hover:text-zinc-900 hover:bg-zinc-50'
              }`}
            >
              <Terminal className="h-3.5 w-3.5" />
              <span>终端</span>
              {activeTerminalLogs.length > 0 && (
                <span className="text-[10px] bg-zinc-200 text-zinc-600 px-1 rounded-sm">
                  {activeTerminalLogs.length}
                </span>
              )}
            </button>

            <button
              onClick={() => onRightTabChange('activity')}
              title="执行动态：智能体每一步行动的用户视角活动流"
              className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium transition whitespace-nowrap flex-shrink-0 ${
                rightTab === 'activity'
                  ? 'bg-zinc-100 text-zinc-900 font-semibold'
                  : 'text-zinc-500 hover:text-zinc-900 hover:bg-zinc-50'
              }`}
            >
              <Activity className="h-3.5 w-3.5" />
              <span>动态</span>
              {currentMission?.status === 'ACTIVE' && (
                <span className="h-1.5 w-1.5 rounded-full bg-blue-600 animate-pulse" />
              )}
            </button>

            <button
              onClick={() => onRightTabChange('artifact')}
              title="交付成果"
              className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium transition whitespace-nowrap flex-shrink-0 ${
                rightTab === 'artifact'
                  ? 'bg-zinc-100 text-zinc-900 font-semibold'
                  : 'text-zinc-500 hover:text-zinc-900 hover:bg-zinc-50'
              }`}
            >
              <FileText className="h-3.5 w-3.5" />
              <span>成果</span>
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
            {/* 当前页面地址不在 tab 栏重复显示：浏览器画布本体顶部已有完整地址栏，
                这里再放一份既冗余又挤占 tab 横向空间（窄屏下被挤换行的元凶） */}

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

          {/* 3. 执行动态(内部原始视角:工具名/入参出参,默认原始模式;叙述在会话流) */}
          {rightTab === 'activity' && <ActivityFeedView steps={currentMission?.steps || []} />}

          {/* 4. 最终交付物成果 (Deliverable Artifact Canvas) */}
          {rightTab === 'artifact' && (() => {
            // 提取当前任务中所有生成过的产物（支持多轮输出的多文档产物列表）
            type FileMeta = { fileId: string; fileName: string; mime: string; sizeBytes: number };
            const missionArtifacts: Array<{ title: string; type: string; content: string; id: string; fileMeta?: FileMeta }> = [];
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
                fileMeta: activeArtifact.fileMeta as FileMeta | undefined,
              });
            }

            const currentArtifact = missionArtifacts[selectedArtifactIndex] || missionArtifacts[0] || null;

            // 机会清单交付物分支:不绑定 artifact type,解析出有效清单则预览态优先渲可派发卡片
            const canvasOss =
              currentArtifact && artifactViewMode === 'preview'
                ? parseOssDeliverable(currentArtifact.content)
                : null;

            const handleDownloadCurrent = () => {
              if (!currentArtifact?.content) return;
              // file 产物(如 .pptx):本体在服务端文件库,走下载路由(cookie 鉴权)
              if (currentArtifact.type === 'file' && currentArtifact.fileMeta?.fileId) {
                const link = document.createElement('a');
                link.href = `/api/artifacts/file?fileId=${encodeURIComponent(currentArtifact.fileMeta.fileId)}`;
                link.setAttribute('download', currentArtifact.fileMeta.fileName || '');
                document.body.appendChild(link);
                link.click();
                document.body.removeChild(link);
                return;
              }
              // html 产物(如 bento 演示页)按网页下载,其余仍为 Markdown 文档
              const isHtml = currentArtifact.type === 'html';
              const blob = new Blob([currentArtifact.content], {
                type: isHtml ? 'text/html;charset=utf-8;' : 'text/markdown;charset=utf-8;',
              });
              const url = URL.createObjectURL(blob);
              const link = document.createElement('a');
              const baseTitle = currentArtifact.title || 'deliverable';
              link.href = url;
              link.setAttribute(
                'download',
                isHtml
                  ? /\.html?$/i.test(baseTitle)
                    ? baseTitle
                    : `${baseTitle}.bento.html`
                  : `${baseTitle}.md`
              );
              document.body.appendChild(link);
              link.click();
              document.body.removeChild(link);
            };

            const handleCopyCurrent = async () => {
              if (!currentArtifact?.content) return;
              if (!(await copyToClipboard(currentArtifact.content))) return;
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
                        title={
                          currentArtifact?.type === 'file'
                            ? `下载文件 (${currentArtifact.fileMeta?.fileName || '附件'})`
                            : currentArtifact?.type === 'html'
                              ? '下载演示页 (.html)'
                              : '下载文档文件 (.md)'
                        }
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
                      currentArtifact.type === 'file' ? (
                        /* file 产物(ppt-master 真 .pptx 等二进制):本体在服务端文件库,
                           画布只出下载卡片 + 人类可读摘要,不经模型上下文。 */
                        <div className="animate-fadeIn w-full min-w-0 space-y-4">
                          <div className="rounded-2xl border border-zinc-200 bg-zinc-50/60 p-6 flex flex-col sm:flex-row items-center gap-4 shadow-2xs">
                            <div className="h-14 w-14 rounded-2xl bg-sky-50 border border-sky-200/70 flex items-center justify-center flex-shrink-0">
                              <FileDown className="h-7 w-7 text-sky-600" />
                            </div>
                            <div className="min-w-0 text-center sm:text-left">
                              <p className="text-sm font-semibold text-zinc-900 truncate max-w-full">
                                {currentArtifact.fileMeta?.fileName || currentArtifact.title || '交付文件'}
                              </p>
                              <p className="text-[11px] text-zinc-400 mt-0.5 font-mono">
                                {currentArtifact.fileMeta
                                  ? `${(currentArtifact.fileMeta.sizeBytes / 1024).toFixed(0)} KB · ${currentArtifact.fileMeta.mime.split('/').pop()}`
                                  : '文件产物'}
                              </p>
                            </div>
                            <a
                              href={`/api/artifacts/file?fileId=${encodeURIComponent(currentArtifact.fileMeta?.fileId || '')}`}
                              download={currentArtifact.fileMeta?.fileName || undefined}
                              className={`ml-auto flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-medium shadow-xs transition ${
                                currentArtifact.fileMeta?.fileId
                                  ? 'bg-zinc-900 hover:bg-zinc-800 text-white'
                                  : 'bg-zinc-100 text-zinc-400 pointer-events-none'
                              }`}
                            >
                              <Download className="h-3.5 w-3.5" />
                              <span>下载文件</span>
                            </a>
                          </div>
                          <div className="prose prose-zinc prose-sm max-w-none leading-relaxed px-2">
                            <ReactMarkdown remarkPlugins={[remarkGfm]}>
                              {currentArtifact.content}
                            </ReactMarkdown>
                          </div>
                        </div>
                      ) : currentArtifact.type === 'html' ? (
                        /* html 产物(bento 演示页/自包含网页):iframe srcDoc 沙箱放映。
                           不给 allow-same-origin —— 演示页脚本运行在独立源,拿不到主站
                           cookie/storage;allow-scripts 保证其翻页/动画/图表可用。 */
                        <div className="animate-fadeIn w-full min-w-0">
                          <iframe
                            title={currentArtifact.title || '演示页'}
                            srcDoc={currentArtifact.content}
                            sandbox="allow-scripts allow-popups"
                            className="w-full aspect-video rounded-xl border border-zinc-200 bg-white shadow-2xs"
                          />
                          <p className="mt-2 text-[11px] text-zinc-400 leading-relaxed">
                            网页演示页:画面内可翻页放映;点右上下载按钮保存 .bento.html,双击即可离线放映,浏览器内可继续编辑。
                          </p>
                        </div>
                      ) : canvasOss ? (
                        /* 机会清单交付物(开源雷达):可派发卡片,与交付库同分支 */
                        <div className="animate-fadeIn w-full min-w-0">
                          <OssOpportunityList result={canvasOss} missionId={currentMission?.id} />
                        </div>
                      ) : (
                        <div className="prose prose-zinc prose-sm max-w-none leading-relaxed animate-fadeIn p-2 md:p-4">
                          <ReactMarkdown remarkPlugins={[remarkGfm]}>
                            {currentArtifact.content}
                          </ReactMarkdown>
                        </div>
                      )
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
