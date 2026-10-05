'use client';

import { useState, useEffect, useRef } from 'react';
import { CopilotKit } from '@copilotkit/react-core';
import { CopilotSidebar } from '@copilotkit/react-ui';
import {
  Bot,
  Globe,
  CheckCircle2,
  Clock,
  ExternalLink,
  RotateCw,
  Copy,
  Check,
  Sparkles,
  Layers,
  Shield,
  ShieldAlert,
  SlidersHorizontal,
  ChevronRight,
  ArrowRight,
  Monitor,
  Eye,
  Calendar,
  Mail,
  FileText,
  Github,
  Database,
  Search,
  Bell,
  Activity,
  Send,
  Lock,
  Pause,
  Play,
  Share2,
  Terminal,
  Key,
  X,
  AlertCircle,
} from 'lucide-react';

interface ConnectorApp {
  id: string;
  name: string;
  category: string;
  icon: string;
  status: 'connected' | 'unconfigured';
  envVar: string;
  description: string;
  keyMasked?: string;
}

interface MissionStep {
  id: string;
  title: string;
  tool?: string;
  status: 'PENDING' | 'RUNNING' | 'DONE' | 'FAILED';
  duration?: string;
  args?: any;
}

interface Mission {
  id: string;
  title: string;
  status: 'ACTIVE' | 'DONE' | 'QUEUED' | 'WAITING_APPROVAL';
  progress: number;
  startedAt: number;
  steps: MissionStep[];
}

interface ViewportState {
  activeTab: 'browser' | 'terminal';
  url: string;
  title?: string;
  status: 'idle' | 'navigating' | 'interacting' | 'scraping';
  screenshotBase64?: string;
}

interface TerminalLog {
  id: string;
  timestamp: number;
  type: 'command' | 'stdout' | 'stderr' | 'system';
  text: string;
}

interface ApprovalRequest {
  id: string;
  action: string;
  description: string;
  dangerLevel: 'low' | 'medium' | 'high';
  params: Record<string, any>;
}

export default function MetaMuseWorkspace() {
  const [mounted, setMounted] = useState(false);

  // 导航模式：活动监控视口、任务血缘流、应用连接器、主动监控看板、委托灵感库
  const [activeView, setActiveView] = useState<'live_browser' | 'lineage' | 'connectors' | 'missions' | 'ideas'>('live_browser');

  // 视口子选项卡：真实网页截屏 vs 实时终端沙箱
  const [viewportTab, setViewportTab] = useState<'browser' | 'terminal'>('browser');

  // 真实后端状态 (由 /api/agent/events SSE 实时同步)
  const [missions, setMissions] = useState<Mission[]>([]);
  const [activeMissionId, setActiveMissionId] = useState<string | null>(null);
  const [viewport, setViewport] = useState<ViewportState>({
    activeTab: 'browser',
    url: 'https://news.ycombinator.com',
    title: 'Ready',
    status: 'idle',
  });
  const [terminalLogs, setTerminalLogs] = useState<TerminalLog[]>([
    {
      id: 'init-1',
      timestamp: Date.now(),
      type: 'system',
      text: '[Cordis Microkernel] System ready. All 43 SOTA atomic tools wired up.',
    },
  ]);
  const [approvalRequests, setApprovalRequests] = useState<ApprovalRequest[]>([]);

  // 连接器生态列表 (由 /api/connectors 真实探测)
  const [connectors, setConnectors] = useState<ConnectorApp[]>([]);
  const [configuringConnector, setConfiguringConnector] = useState<ConnectorApp | null>(null);
  const [apiKeyInput, setApiKeyInput] = useState('');
  const [isSavingKey, setIsSavingKey] = useState(false);

  // 用户指令输入
  const [inputGoal, setInputGoal] = useState('');
  const [isExecuting, setIsExecuting] = useState(false);

  const terminalEndRef = useRef<HTMLDivElement>(null);

  // 自动滚动终端
  useEffect(() => {
    if (viewportTab === 'terminal') {
      terminalEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [terminalLogs, viewportTab]);

  // 加载真实连接器状态
  const loadConnectors = async () => {
    try {
      const res = await fetch('/api/connectors');
      const data = await res.json();
      if (data.connectors) {
        setConnectors(data.connectors);
      }
    } catch (err) {
      console.error('Failed to load connectors:', err);
    }
  };

  // 保存 API Key 连接
  const handleSaveApiKey = async () => {
    if (!configuringConnector || !apiKeyInput.trim()) return;
    setIsSavingKey(true);
    try {
      const res = await fetch('/api/connectors', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          envVar: configuringConnector.envVar,
          value: apiKeyInput.trim(),
        }),
      });
      const data = await res.json();
      if (data.connectors) {
        setConnectors(data.connectors);
      }
      setConfiguringConnector(null);
      setApiKeyInput('');
    } catch (err) {
      console.error('Failed to save key:', err);
    } finally {
      setIsSavingKey(false);
    }
  };

  // 建立真实实时事件流 (Server-Sent Events)
  useEffect(() => {
    setMounted(true);
    loadConnectors();

    const eventSource = new EventSource('/api/agent/events');

    eventSource.addEventListener('init', (e: MessageEvent) => {
      try {
        const state = JSON.parse(e.data);
        if (state.missions) setMissions(state.missions);
        if (state.activeMissionId) setActiveMissionId(state.activeMissionId);
        if (state.viewport) setViewport(state.viewport);
        if (state.terminalLogs && state.terminalLogs.length > 0) setTerminalLogs(state.terminalLogs);
        if (state.approvalRequests) setApprovalRequests(state.approvalRequests);
      } catch (err) {
        console.error('SSE init error:', err);
      }
    });

    eventSource.addEventListener('viewport_update', (e: MessageEvent) => {
      try {
        const vp = JSON.parse(e.data);
        setViewport((prev) => ({ ...prev, ...vp }));
      } catch (err) {
        console.error('SSE viewport error:', err);
      }
    });

    eventSource.addEventListener('terminal_log', (e: MessageEvent) => {
      try {
        const log = JSON.parse(e.data);
        setTerminalLogs((prev) => [...prev, log]);
      } catch (err) {
        console.error('SSE log error:', err);
      }
    });

    eventSource.addEventListener('mission_created', (e: MessageEvent) => {
      try {
        const mission: Mission = JSON.parse(e.data);
        setMissions((prev) => [mission, ...prev.filter((m) => m.id !== mission.id)]);
        setActiveMissionId(mission.id);
      } catch (err) {
        console.error('SSE mission created error:', err);
      }
    });

    eventSource.addEventListener('mission_updated', (e: MessageEvent) => {
      try {
        const updated: Mission = JSON.parse(e.data);
        setMissions((prev) =>
          prev.map((m) => (m.id === updated.id ? updated : m))
        );
      } catch (err) {
        console.error('SSE mission updated error:', err);
      }
    });

    eventSource.addEventListener('approval_requested', (e: MessageEvent) => {
      try {
        const req: ApprovalRequest = JSON.parse(e.data);
        setApprovalRequests((prev) => [...prev.filter((r) => r.id !== req.id), req]);
        setActiveView('lineage'); // 自动跳转至血缘审核页
      } catch (err) {
        console.error('SSE approval error:', err);
      }
    });

    eventSource.addEventListener('approval_resolved', (e: MessageEvent) => {
      try {
        const { approvalId } = JSON.parse(e.data);
        setApprovalRequests((prev) => prev.filter((r) => r.id !== approvalId));
      } catch (err) {
        console.error('SSE approval resolved error:', err);
      }
    });

    return () => {
      eventSource.close();
    };
  }, []);

  // 提交审批结论 (Sign-off)
  const handleApproval = async (approvalId: string, approved: boolean) => {
    try {
      await fetch('/api/agent/approval', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ approvalId, approved }),
      });
      setApprovalRequests((prev) => prev.filter((r) => r.id !== approvalId));
    } catch (err) {
      console.error('Approval submit error:', err);
    }
  };

  // 发起真实任务执行
  const handleRunGoal = async (prompt: string, title?: string) => {
    if (!prompt.trim() || isExecuting) return;
    setIsExecuting(true);
    setActiveView('live_browser');

    try {
      await fetch('/api/agent/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt, title }),
      });
      setInputGoal('');
    } catch (err) {
      console.error('Run goal error:', err);
    } finally {
      setIsExecuting(false);
    }
  };

  // 获取当前主线任务
  const currentMission = missions.find((m) => m.id === activeMissionId) || missions[0] || {
    id: 'ready-mission',
    title: '系统就绪 - 等待主人分配全新目标',
    status: 'ACTIVE',
    progress: 100,
    startedAt: Date.now(),
    steps: [
      { id: 's0', title: '微内核 43 项原子能力与连接器已全部在线', status: 'DONE', duration: 'Ready' },
    ],
  };

  // 预设任务模板 (Ideas)
  const ideas = [
    {
      title: '出差全流程行程编排与日程同步',
      prompt: '使用浏览器检索旧金山开发者大会机票与酒店行情，并在终端环境生成预算报告。',
      tags: ['Stagehand', 'Playwright', '预算'],
    },
    {
      title: 'GitHub 开源项目每日技术雷达抓取',
      prompt: '访问 GitHub 趋势榜抓取今日热门 AI 开源项目，提取 Markdown 摘要并向我报告。',
      tags: ['Firecrawl', 'Git', '自动研报'],
    },
    {
      title: '生产环境安全审计与沙箱命令自检',
      prompt: '在受控沙箱终端中运行自检命令，获取系统环境指标并在高危操作前请求我授权。',
      tags: ['E2B沙箱', 'Sign-off', '安全网关'],
    },
    {
      title: '全网技术论文深度蒸馏与知识沉淀',
      prompt: '使用深度检索与网页蒸馏提取 Agent 架构前沿论文，提炼核心创新要点。',
      tags: ['Exa检索', 'Turndown', '智能蒸馏'],
    },
  ];

  if (!mounted) return null;

  return (
    <CopilotKit runtimeUrl="/api/copilotkit">
      <div className="flex h-screen w-screen overflow-hidden bg-slate-950 text-slate-100 font-sans antialiased selection:bg-indigo-500 selection:text-white">
        {/* 1. 左侧个人主理人侧边栏 (Executive Navigation) */}
        <aside className="w-64 flex-shrink-0 flex flex-col border-r border-slate-800 bg-slate-900/60 backdrop-blur z-20">
          {/* 顶部主理人标识 */}
          <div className="h-16 flex items-center gap-3 px-5 border-b border-slate-800/80">
            <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-gradient-to-tr from-indigo-500 via-purple-500 to-pink-500 text-white shadow-lg shadow-purple-500/25">
              <Bot className="h-5 w-5" />
            </div>
            <div>
              <div className="flex items-center gap-1.5">
                <span className="font-bold text-sm text-white tracking-tight">agtpilot</span>
                <span className="rounded-full bg-indigo-500/20 px-1.5 py-0.2 text-[10px] font-semibold text-indigo-400 border border-indigo-500/30">
                  Muse Pro
                </span>
              </div>
              <p className="text-[11px] text-slate-400">个人自主数字主理人</p>
            </div>
          </div>

          {/* 核心自主能力导航 */}
          <div className="p-3 space-y-1 text-xs">
            <button
              onClick={() => setActiveView('live_browser')}
              className={`w-full flex items-center justify-between px-3 py-2.5 rounded-xl transition-all ${
                activeView === 'live_browser'
                  ? 'bg-indigo-600/20 text-indigo-300 font-semibold border border-indigo-500/30 shadow-inner'
                  : 'text-slate-400 hover:bg-slate-800/60 hover:text-slate-200'
              }`}
            >
              <div className="flex items-center gap-2.5">
                <Globe className="h-4 w-4 text-cyan-400" />
                <span>实时视窗 (Live Viewport)</span>
              </div>
              {viewport.status === 'navigating' && (
                <span className="h-2 w-2 rounded-full bg-cyan-400 animate-ping" />
              )}
            </button>

            <button
              onClick={() => setActiveView('lineage')}
              className={`w-full flex items-center justify-between px-3 py-2.5 rounded-xl transition-all ${
                activeView === 'lineage'
                  ? 'bg-indigo-600/20 text-indigo-300 font-semibold border border-indigo-500/30 shadow-inner'
                  : 'text-slate-400 hover:bg-slate-800/60 hover:text-slate-200'
              }`}
            >
              <div className="flex items-center gap-2.5">
                <Activity className="h-4 w-4 text-purple-400" />
                <span>任务执行血缘 (Lineage)</span>
              </div>
              {approvalRequests.length > 0 && (
                <span className="px-1.5 py-0.2 rounded-full bg-amber-500 text-slate-950 font-bold text-[10px] animate-bounce">
                  {approvalRequests.length} 待签批
                </span>
              )}
            </button>

            <button
              onClick={() => setActiveView('connectors')}
              className={`w-full flex items-center justify-between px-3 py-2.5 rounded-xl transition-all ${
                activeView === 'connectors'
                  ? 'bg-indigo-600/20 text-indigo-300 font-semibold border border-indigo-500/30 shadow-inner'
                  : 'text-slate-400 hover:bg-slate-800/60 hover:text-slate-200'
              }`}
            >
              <div className="flex items-center gap-2.5">
                <Layers className="h-4 w-4 text-amber-400" />
                <span>应用生态连接器</span>
              </div>
              <span className="font-mono text-[10px] text-emerald-400">
                {connectors.filter((c) => c.status === 'connected').length}/{connectors.length} 就绪
              </span>
            </button>

            <button
              onClick={() => setActiveView('ideas')}
              className={`w-full flex items-center justify-between px-3 py-2.5 rounded-xl transition-all ${
                activeView === 'ideas'
                  ? 'bg-indigo-600/20 text-indigo-300 font-semibold border border-indigo-500/30 shadow-inner'
                  : 'text-slate-400 hover:bg-slate-800/60 hover:text-slate-200'
              }`}
            >
              <div className="flex items-center gap-2.5">
                <Sparkles className="h-4 w-4 text-pink-400" />
                <span>委托灵感库 (Ideas)</span>
              </div>
            </button>
          </div>

          {/* 实时活跃任务列表 */}
          <div className="mt-4 px-4 flex-1 overflow-y-auto">
            <div className="flex items-center justify-between mb-2">
              <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">
                当前任务执行序列 ({missions.length})
              </span>
            </div>
            <div className="space-y-2">
              {missions.map((m) => (
                <div
                  key={m.id}
                  onClick={() => {
                    setActiveMissionId(m.id);
                    setActiveView('lineage');
                  }}
                  className={`p-2.5 rounded-xl border text-xs cursor-pointer transition-all ${
                    activeMissionId === m.id
                      ? 'border-indigo-500/40 bg-indigo-500/10 text-white'
                      : 'border-slate-800/80 bg-slate-900/40 text-slate-400 hover:border-slate-700'
                  }`}
                >
                  <div className="flex items-center justify-between mb-1">
                    <span className="font-semibold truncate max-w-[120px]">{m.title}</span>
                    <span
                      className={`text-[9px] px-1.5 py-0.2 rounded font-mono ${
                        m.status === 'ACTIVE'
                          ? 'bg-cyan-500/20 text-cyan-300 animate-pulse'
                          : m.status === 'WAITING_APPROVAL'
                          ? 'bg-amber-500/20 text-amber-300 font-bold'
                          : 'bg-emerald-500/20 text-emerald-300'
                      }`}
                    >
                      {m.status}
                    </span>
                  </div>
                  <div className="w-full bg-slate-800 h-1 rounded-full overflow-hidden mt-1.5">
                    <div
                      className="bg-indigo-500 h-full transition-all duration-300"
                      style={{ width: `${m.progress}%` }}
                    />
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* 底部运行状态指示器 */}
          <div className="p-4 border-t border-slate-800/80 bg-slate-950/40">
            <div className="flex items-center gap-2">
              <div className="relative flex h-2.5 w-2.5">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
                <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-emerald-500" />
              </div>
              <div className="text-[11px]">
                <span className="font-medium text-slate-200">Cordis 守护中</span>
                <span className="text-slate-400 block text-[10px]">Zero-Mock 真实事件流</span>
              </div>
            </div>
          </div>
        </aside>

        {/* 2. 中间核心活动展示区 (The Meta Muse Cockpit) */}
        <main className="flex-1 flex flex-col min-w-0 bg-gradient-to-b from-slate-900/50 to-slate-950/80 relative">
          {/* 顶栏：当前主线任务状态与全局执行指标 */}
          <header className="h-16 border-b border-slate-800/80 bg-slate-900/40 px-6 flex items-center justify-between backdrop-blur">
            <div className="flex items-center gap-3">
              <span className="text-xs text-slate-400">当前任务目标:</span>
              <span className="text-sm font-bold text-white flex items-center gap-2">
                {currentMission.title}
                <span className="rounded-full bg-indigo-500/10 px-2 py-0.5 text-[10px] font-semibold text-indigo-400 border border-indigo-500/20">
                  {currentMission.status}
                </span>
              </span>
            </div>

            <div className="flex items-center gap-4 text-xs">
              <div className="flex items-center gap-2">
                <span className="text-slate-400">推进进度:</span>
                <div className="w-28 bg-slate-800 h-2 rounded-full overflow-hidden">
                  <div
                    className="bg-gradient-to-r from-indigo-500 to-purple-500 h-full transition-all duration-500"
                    style={{ width: `${currentMission.progress}%` }}
                  />
                </div>
                <span className="font-mono text-emerald-400 font-semibold">{currentMission.progress}%</span>
              </div>

              {approvalRequests.length > 0 && (
                <button
                  onClick={() => setActiveView('lineage')}
                  className="flex items-center gap-1.5 bg-amber-500/20 text-amber-300 border border-amber-500/40 px-3 py-1 rounded-lg text-xs font-semibold animate-pulse hover:bg-amber-500/30 transition-all"
                >
                  <ShieldAlert className="h-3.5 w-3.5" />
                  {approvalRequests.length} 项高危操作待签批
                </button>
              )}
            </div>
          </header>

          {/* 主舞台视口内容切换 */}
          <div className="flex-1 overflow-y-auto p-6">
            {/* A. 实时可视视口 (Live Viewport - 真实浏览器截图 + 真实沙箱终端) */}
            {activeView === 'live_browser' && (
              <div className="space-y-4 max-w-5xl mx-auto h-full flex flex-col">
                <div className="flex items-center justify-between">
                  <div>
                    <h2 className="text-base font-bold text-white flex items-center gap-2">
                      <Globe className="h-4 w-4 text-cyan-400" />
                      智能体实时执行视窗 (Live Agent Viewport)
                    </h2>
                    <p className="text-xs text-slate-400 mt-1">
                      真实透视智能体正在浏览的真实网页截屏（Playwright/Stagehand）与受控沙箱终端输出。
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    {/* 视口切换标签 */}
                    <div className="bg-slate-900 border border-slate-800 rounded-lg p-0.5 flex text-xs">
                      <button
                        onClick={() => setViewportTab('browser')}
                        className={`flex items-center gap-1.5 px-3 py-1 rounded-md transition-all ${
                          viewportTab === 'browser'
                            ? 'bg-indigo-600 text-white font-semibold shadow'
                            : 'text-slate-400 hover:text-slate-200'
                        }`}
                      >
                        <Globe className="h-3.5 w-3.5" /> 真实网页截屏
                      </button>
                      <button
                        onClick={() => setViewportTab('terminal')}
                        className={`flex items-center gap-1.5 px-3 py-1 rounded-md transition-all ${
                          viewportTab === 'terminal'
                            ? 'bg-indigo-600 text-white font-semibold shadow'
                            : 'text-slate-400 hover:text-slate-200'
                        }`}
                      >
                        <Terminal className="h-3.5 w-3.5" /> 沙箱终端日志
                      </button>
                    </div>

                    <span className="flex items-center gap-1 text-[11px] text-emerald-400 font-mono bg-emerald-500/10 px-2.5 py-1 rounded-lg border border-emerald-500/20">
                      <span className="h-2 w-2 rounded-full bg-emerald-400 animate-pulse" />
                      真实内核在线
                    </span>
                  </div>
                </div>

                {/* 视口窗口内容 */}
                <div className="flex-1 rounded-2xl border border-slate-800 bg-slate-900/60 overflow-hidden shadow-2xl flex flex-col min-h-[500px]">
                  {/* 浏览器地址栏 */}
                  <div className="h-10 bg-slate-900 border-b border-slate-800 px-4 flex items-center justify-between">
                    <div className="flex items-center gap-3 flex-1 mr-4">
                      <div className="flex gap-1.5">
                        <div className="h-2.5 w-2.5 rounded-full bg-rose-500/60" />
                        <div className="h-2.5 w-2.5 rounded-full bg-amber-500/60" />
                        <div className="h-2.5 w-2.5 rounded-full bg-emerald-500/60" />
                      </div>
                      <div className="rounded-md bg-slate-950 border border-slate-800 px-3 py-1 text-[11px] text-slate-300 font-mono flex items-center gap-2 flex-1 max-w-xl truncate">
                        <Lock className="h-3 w-3 text-emerald-400 flex-shrink-0" />
                        <span className="truncate">{viewport.url}</span>
                      </div>
                    </div>
                    <div className="text-[11px] text-indigo-400 font-mono flex-shrink-0">
                      状态: {viewport.status.toUpperCase()}
                    </div>
                  </div>

                  {/* 视口主体 */}
                  <div className="flex-1 bg-slate-950 p-4 overflow-y-auto flex flex-col justify-center">
                    {viewportTab === 'browser' ? (
                      viewport.screenshotBase64 ? (
                        <div className="w-full h-full flex flex-col items-center justify-center">
                          <img
                            src={viewport.screenshotBase64}
                            alt="Live Browser Page"
                            className="max-h-[460px] w-auto object-contain rounded-xl border border-slate-800 shadow-2xl"
                          />
                          <p className="text-[11px] text-slate-400 mt-2 font-mono">
                            页面标题: {viewport.title || 'Loaded'}
                          </p>
                        </div>
                      ) : (
                        <div className="text-center py-20 space-y-3">
                          <Globe className="h-12 w-12 text-slate-700 mx-auto animate-pulse" />
                          <h3 className="text-sm font-semibold text-slate-300">尚未触发浏览器导航</h3>
                          <p className="text-xs text-slate-400 max-w-md mx-auto">
                            当你在下方发送指令或运行灵感任务时，Playwright/Stagehand 将打开真实网页并将截屏实时流式传回此处。
                          </p>
                          <button
                            onClick={() => handleRunGoal('使用浏览器访问 Hacker News 首页并总结前三条热点资讯', 'Hacker News 热点快报')}
                            className="text-xs bg-indigo-600 hover:bg-indigo-500 text-white px-4 py-2 rounded-xl transition-all"
                          >
                            立即运行真实浏览器试探任务
                          </button>
                        </div>
                      )
                    ) : (
                      /* 沙箱终端实时日志 */
                      <div className="font-mono text-xs space-y-2 h-full min-h-[420px] bg-slate-950 p-4 rounded-xl text-slate-300 overflow-y-auto">
                        {terminalLogs.map((log) => (
                          <div key={log.id} className="leading-relaxed">
                            {log.type === 'command' && (
                              <span className="text-cyan-400 font-semibold block">{log.text}</span>
                            )}
                            {log.type === 'stdout' && (
                              <pre className="text-slate-300 whitespace-pre-wrap pl-3 border-l-2 border-slate-800 font-mono text-[11px]">
                                {log.text}
                              </pre>
                            )}
                            {log.type === 'stderr' && (
                              <pre className="text-rose-400 whitespace-pre-wrap pl-3 border-l-2 border-rose-800 font-mono text-[11px]">
                                {log.text}
                              </pre>
                            )}
                            {log.type === 'system' && (
                              <span className="text-emerald-400/80 italic block">
                                {log.text}
                              </span>
                            )}
                          </div>
                        ))}
                        <div ref={terminalEndRef} />
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}

            {/* B. 任务执行血缘流与真实签批 (Task Lineage & Real Sign-off) */}
            {activeView === 'lineage' && (
              <div className="space-y-6 max-w-4xl mx-auto">
                <div>
                  <h2 className="text-base font-bold text-white flex items-center gap-2">
                    <Activity className="h-4 w-4 text-purple-400" />
                    任务目标分解与执行血缘树 (Task Lineage)
                  </h2>
                  <p className="text-xs text-slate-400 mt-1">
                    当前任务: {currentMission.title} · 多步骤原子动作透明推进，高危动作强制挂起等待主人 Sign-off。
                  </p>
                </div>

                {/* 真实签批卡片 (Human-in-the-Loop Sign-off Cards) */}
                {approvalRequests.length > 0 && (
                  <div className="space-y-4">
                    {approvalRequests.map((req) => (
                      <div
                        key={req.id}
                        className="rounded-2xl border border-amber-500/60 bg-amber-950/20 p-5 shadow-2xl shadow-amber-500/10"
                      >
                        <div className="flex items-start justify-between">
                          <div className="flex items-start gap-3">
                            <div className="mt-1">
                              <ShieldAlert className="h-5 w-5 text-amber-400 animate-pulse" />
                            </div>
                            <div>
                              <span className="text-[10px] font-bold font-mono px-2 py-0.5 rounded bg-amber-500/20 text-amber-300 border border-amber-500/30">
                                需要主人授权签署 (SIGN-OFF REQUIRED)
                              </span>
                              <h3 className="text-sm font-semibold text-white mt-1.5">
                                {req.description}
                              </h3>
                              <p className="text-xs text-slate-300 font-mono mt-1">
                                拟调工具: <span className="text-cyan-400">{req.action}</span> · 风险等级:{' '}
                                <span className="text-rose-400 font-bold uppercase">{req.dangerLevel}</span>
                              </p>
                              {req.params && (
                                <div className="mt-2 p-2.5 rounded-lg bg-slate-900 border border-slate-800 text-[11px] font-mono text-slate-300 max-h-32 overflow-y-auto">
                                  {JSON.stringify(req.params, null, 2)}
                                </div>
                              )}
                            </div>
                          </div>

                          <div className="flex gap-2">
                            <button
                              onClick={() => handleApproval(req.id, false)}
                              className="text-xs bg-slate-800 hover:bg-slate-700 text-slate-300 px-3 py-1.5 rounded-xl border border-slate-700 transition-all"
                            >
                              拒绝 (Reject)
                            </button>
                            <button
                              onClick={() => handleApproval(req.id, true)}
                              className="text-xs bg-gradient-to-r from-amber-500 to-orange-500 hover:from-amber-400 hover:to-orange-400 text-slate-950 font-bold px-4 py-1.5 rounded-xl shadow-lg transition-all"
                            >
                              签署授权 (Sign-off)
                            </button>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {/* 真实执行步骤树 */}
                <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-6 space-y-4 shadow-xl">
                  <h3 className="text-xs font-bold text-slate-300 uppercase tracking-wider mb-4">
                    原子任务推进路径 (Execution Steps)
                  </h3>
                  <div className="space-y-4">
                    {currentMission.steps.map((st, idx) => (
                      <div key={st.id} className="flex items-start gap-4">
                        <div className="mt-0.5 flex flex-col items-center">
                          {st.status === 'DONE' ? (
                            <CheckCircle2 className="h-5 w-5 text-emerald-400" />
                          ) : st.status === 'RUNNING' ? (
                            <div className="h-5 w-5 rounded-full border-2 border-indigo-400 border-t-transparent animate-spin" />
                          ) : (
                            <div className="h-5 w-5 rounded-full border-2 border-slate-700" />
                          )}
                          {idx < currentMission.steps.length - 1 && (
                            <div className="w-0.5 h-8 bg-slate-800 my-1" />
                          )}
                        </div>
                        <div className="flex-1">
                          <div className="flex items-center justify-between">
                            <span className="text-xs font-semibold text-white">
                              {st.title}
                            </span>
                            <div className="flex items-center gap-2 font-mono text-[11px]">
                              {st.tool && (
                                <span className="bg-indigo-500/10 text-indigo-400 border border-indigo-500/20 px-1.5 py-0.2 rounded">
                                  {st.tool}
                                </span>
                              )}
                              <span className="text-slate-400">{st.duration || st.status}</span>
                            </div>
                          </div>
                          {st.args && (
                            <p className="text-[11px] text-slate-400 mt-0.5 font-mono truncate">
                              参数: {JSON.stringify(st.args)}
                            </p>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}

            {/* C. 真实应用生态连接器 (Connectors Hub - 真实嗅探环境变量) */}
            {activeView === 'connectors' && (
              <div className="space-y-6 max-w-4xl mx-auto">
                <div className="flex items-center justify-between">
                  <div>
                    <h2 className="text-base font-bold text-white flex items-center gap-2">
                      <Layers className="h-4 w-4 text-amber-400" />
                      应用生态连接器中枢 (App Connectors Hub)
                    </h2>
                    <p className="text-xs text-slate-400 mt-1">
                      后端真实探测系统环境凭证（API Keys / Tokens）。点击未配置的应用可直接录入激活。
                    </p>
                  </div>
                  <button
                    onClick={loadConnectors}
                    className="flex items-center gap-1.5 text-xs bg-slate-800 hover:bg-slate-700 text-slate-300 px-3 py-1.5 rounded-xl border border-slate-700 transition-all"
                  >
                    <RotateCw className="h-3 w-3" /> 刷新检测
                  </button>
                </div>

                <div className="grid grid-cols-2 gap-4">
                  {connectors.map((app) => (
                    <div
                      key={app.id}
                      className="p-5 rounded-2xl border border-slate-800 bg-slate-900/60 hover:border-slate-700 transition-all flex flex-col justify-between"
                    >
                      <div>
                        <div className="flex items-center justify-between mb-3">
                          <span className="text-xs font-bold text-white flex items-center gap-2">
                            {app.name}
                          </span>
                          <span
                            className={`text-[10px] px-2 py-0.5 rounded-full font-mono font-semibold ${
                              app.status === 'connected'
                                ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                                : 'bg-slate-800 text-slate-400 border border-slate-700'
                            }`}
                          >
                            {app.status === 'connected' ? '✓ CONNECTED' : 'UNCONFIGURED'}
                          </span>
                        </div>
                        <p className="text-xs text-slate-400 mb-3">{app.description}</p>
                        <div className="text-[10px] font-mono text-slate-400 flex items-center gap-2">
                          <span>Env: {app.envVar}</span>
                          {app.keyMasked && (
                            <span className="text-emerald-400 font-semibold">({app.keyMasked})</span>
                          )}
                        </div>
                      </div>

                      <div className="mt-4 pt-3 border-t border-slate-800/80 flex items-center justify-between">
                        <span className="text-[10px] text-slate-400">{app.category}</span>
                        <button
                          onClick={() => {
                            setConfiguringConnector(app);
                            setApiKeyInput('');
                          }}
                          className={`text-xs px-3 py-1 rounded-lg transition-all ${
                            app.status === 'connected'
                              ? 'bg-slate-800 hover:bg-slate-700 text-slate-300'
                              : 'bg-indigo-600 hover:bg-indigo-500 text-white font-semibold shadow'
                          }`}
                        >
                          {app.status === 'connected' ? '重新配置' : '连接授权'}
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* D. 委托灵感库 (Ideas & Delegation Library) */}
            {activeView === 'ideas' && (
              <div className="space-y-6 max-w-4xl mx-auto">
                <div>
                  <h2 className="text-base font-bold text-white flex items-center gap-2">
                    <Sparkles className="h-4 w-4 text-pink-400" />
                    个人任务委托灵感库 (Ideas & Task Delegation)
                  </h2>
                  <p className="text-xs text-slate-400 mt-1">
                    点击任意任务模板，系统将立即启动真实的自主执行流水线，驱动真实原子工具完成任务。
                  </p>
                </div>

                <div className="grid grid-cols-2 gap-4">
                  {ideas.map((item, idx) => (
                    <div
                      key={idx}
                      className="p-5 rounded-2xl border border-slate-800 bg-slate-900/60 hover:border-indigo-500/50 transition-all flex flex-col justify-between group"
                    >
                      <div>
                        <h3 className="text-sm font-bold text-white group-hover:text-indigo-300 transition-colors">
                          {item.title}
                        </h3>
                        <p className="text-xs text-slate-400 mt-2 leading-relaxed">{item.prompt}</p>
                        <div className="flex gap-1.5 mt-3">
                          {item.tags.map((tag, tIdx) => (
                            <span
                              key={tIdx}
                              className="text-[10px] px-2 py-0.5 rounded bg-slate-800 text-slate-300 font-mono"
                            >
                              #{tag}
                            </span>
                          ))}
                        </div>
                      </div>

                      <div className="mt-5 pt-3 border-t border-slate-800/80 flex items-center justify-end">
                        <button
                          disabled={isExecuting}
                          onClick={() => handleRunGoal(item.prompt, item.title)}
                          className="flex items-center gap-1.5 text-xs bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white font-semibold px-4 py-1.5 rounded-xl shadow-lg transition-all"
                        >
                          <Play className="h-3 w-3" /> 立即派发此目标
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* 3. 底部快捷意图派发栏 (Quick Goal Dispatcher) */}
          <div className="p-4 border-t border-slate-800/80 bg-slate-900/80 backdrop-blur">
            <form
              onSubmit={(e) => {
                e.preventDefault();
                handleRunGoal(inputGoal);
              }}
              className="max-w-4xl mx-auto flex items-center gap-3 bg-slate-950 border border-slate-800 rounded-2xl p-2 focus-within:border-indigo-500 transition-colors shadow-2xl"
            >
              <div className="pl-3 text-slate-400">
                <Sparkles className="h-4 w-4 text-indigo-400" />
              </div>
              <input
                type="text"
                value={inputGoal}
                onChange={(e) => setInputGoal(e.target.value)}
                placeholder="给你的自主数字主理人委派全新目标 (例如: 检索今天的 AI 前沿论文，并在沙箱中生成分析总结)..."
                className="flex-1 bg-transparent border-none text-xs text-white placeholder-slate-500 focus:outline-none px-2"
              />
              <button
                type="submit"
                disabled={!inputGoal.trim() || isExecuting}
                className="flex items-center gap-1.5 bg-gradient-to-r from-indigo-600 to-purple-600 hover:from-indigo-500 hover:to-purple-500 disabled:opacity-40 text-white font-semibold text-xs px-4 py-2 rounded-xl transition-all shadow-md shadow-indigo-600/20"
              >
                {isExecuting ? (
                  <RotateCw className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Send className="h-3.5 w-3.5" />
                )}
                <span>自主执行</span>
              </button>
            </form>
          </div>

          {/* 模态框：配置连接器密钥 */}
          {configuringConnector && (
            <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-sm flex items-center justify-center z-50 p-4">
              <div className="w-full max-w-md bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-2xl space-y-4">
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-bold text-white flex items-center gap-2">
                    <Key className="h-4 w-4 text-indigo-400" />
                    配置 {configuringConnector.name}
                  </h3>
                  <button
                    onClick={() => setConfiguringConnector(null)}
                    className="text-slate-400 hover:text-white"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>
                <p className="text-xs text-slate-400">{configuringConnector.description}</p>
                <div>
                  <label className="text-[11px] font-mono text-slate-300 block mb-1">
                    环境变量: {configuringConnector.envVar}
                  </label>
                  <input
                    type="password"
                    value={apiKeyInput}
                    onChange={(e) => setApiKeyInput(e.target.value)}
                    placeholder="输入或粘贴你的 API Key / Token..."
                    className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-indigo-500"
                  />
                </div>
                <div className="flex justify-end gap-2 pt-2">
                  <button
                    onClick={() => setConfiguringConnector(null)}
                    className="text-xs text-slate-400 hover:text-white px-3 py-1.5 rounded-lg"
                  >
                    取消
                  </button>
                  <button
                    disabled={!apiKeyInput.trim() || isSavingKey}
                    onClick={handleSaveApiKey}
                    className="text-xs bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white font-semibold px-4 py-1.5 rounded-xl transition-all"
                  >
                    {isSavingKey ? '保存中...' : '保存并激活连接'}
                  </button>
                </div>
              </div>
            </div>
          )}
        </main>

        {/* 4. 右侧 Copilot 智能体交互抽屉 */}
        <CopilotSidebar
          defaultOpen={false}
          labels={{
            title: 'agtpilot Copilot',
            initial: '你好！我是你的个人自主智能体主理人。所有指令都将驱动底层真实的 43 项原子工具完成。',
          }}
        />
      </div>
    </CopilotKit>
  );
}
