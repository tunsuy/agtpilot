'use client';

import { useState, useEffect, useRef } from 'react';
import { CopilotKit } from '@copilotkit/react-core';
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
  ShieldAlert,
  ChevronRight,
  ArrowRight,
  Monitor,
  Terminal,
  Key,
  X,
  Send,
  Lock,
  Pause,
  Play,
  Share2,
  Plus,
  RefreshCw,
  AlertTriangle,
  Flame,
  CheckCheck,
  Sliders,
  Settings,
  Zap,
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

  // 视口子选项卡：真实网页截屏 vs 实时终端沙箱
  const [activeCanvasTab, setActiveCanvasTab] = useState<'browser' | 'terminal'>('browser');

  // 右侧抽屉面板：'ideas' | 'connectors' | null
  const [activeSideDrawer, setActiveSideDrawer] = useState<'ideas' | 'connectors' | null>(null);

  // 真实后端状态 (由 /api/agent/events SSE 实时同步)
  const [missions, setMissions] = useState<Mission[]>([]);
  const [activeMissionId, setActiveMissionId] = useState<string | null>(null);
  const [viewport, setViewport] = useState<ViewportState>({
    activeTab: 'browser',
    url: 'about:blank',
    title: 'Ready',
    status: 'idle',
  });
  const [terminalLogs, setTerminalLogs] = useState<TerminalLog[]>([
    {
      id: 'init-1',
      timestamp: Date.now(),
      type: 'system',
      text: '[Cordis Kernel] Autonomous runtime initialized. 43 atomic tools ready.',
    },
  ]);
  const [approvalRequests, setApprovalRequests] = useState<ApprovalRequest[]>([]);

  // 连接器生态列表
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
    if (activeCanvasTab === 'terminal') {
      terminalEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [terminalLogs, activeCanvasTab]);

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
    setActiveCanvasTab('browser');

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
  const currentMission = missions.find((m) => m.id === activeMissionId) || missions[0] || null;

  // 预设任务模板 (Ideas)
  const inspirationMissions = [
    {
      title: '出差全流程行程比价与日程排期',
      prompt: '使用智能浏览器检索旧金山开发者大会机票与酒店行情，并在终端环境生成预算报告。',
      tag: 'Stagehand + 预算',
    },
    {
      title: 'GitHub 开源项目今日技术雷达抓取',
      prompt: '访问 GitHub 趋势榜抓取今日热门 AI 开源项目，提取 Markdown 摘要并向我报告。',
      tag: 'Firecrawl + Git',
    },
    {
      title: '生产环境安全审计与沙箱命令自检',
      prompt: '在受控沙箱终端中运行自检命令，获取系统环境指标并在高危操作前请求我授权。',
      tag: 'E2B沙箱 + Sign-off',
    },
    {
      title: '全网技术论文深度蒸馏与知识沉淀',
      prompt: '使用深度检索与网页蒸馏提取 Agent 架构前沿论文，提炼核心创新要点。',
      tag: 'Exa检索 + 蒸馏',
    },
  ];

  const connectedCount = connectors.filter((c) => c.status === 'connected').length;

  if (!mounted) return null;

  return (
    <CopilotKit runtimeUrl="/api/copilotkit">
      <div className="flex h-screen w-screen overflow-hidden bg-[#090D16] text-slate-100 font-sans antialiased selection:bg-indigo-500 selection:text-white">
        {/* 全局顶栏：品牌标识、活跃状态、连接器药丸与抽屉触发 */}
        <div className="absolute top-0 left-0 right-0 h-14 border-b border-white/[0.06] bg-[#090D16]/80 backdrop-blur-xl z-30 px-5 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-gradient-to-tr from-indigo-500 to-purple-500 text-white shadow-md shadow-indigo-500/20">
              <Bot className="h-4 w-4" />
            </div>
            <div className="flex items-center gap-2">
              <span className="font-bold text-sm tracking-tight text-white">agtpilot</span>
              <span className="rounded-md bg-white/[0.06] px-1.5 py-0.5 text-[10px] font-medium text-slate-400 border border-white/[0.08]">
                Personal Autonomous Muse
              </span>
            </div>
          </div>

          <div className="flex items-center gap-3">
            {/* 实时执行状态药丸 */}
            <div className="flex items-center gap-2 bg-white/[0.04] border border-white/[0.08] px-3 py-1.5 rounded-full text-xs">
              <span className={`h-2 w-2 rounded-full ${isExecuting || (currentMission && currentMission.status === 'ACTIVE') ? 'bg-cyan-400 animate-ping' : 'bg-emerald-400'}`} />
              <span className="text-slate-300 font-medium text-[11px]">
                {currentMission && currentMission.status === 'ACTIVE'
                  ? 'Agent 正在自主执行'
                  : currentMission && currentMission.status === 'WAITING_APPROVAL'
                  ? '等待主人签批'
                  : '微内核就绪'}
              </span>
            </div>

            {/* 连接器状态胶囊 */}
            <button
              onClick={() => setActiveSideDrawer(activeSideDrawer === 'connectors' ? null : 'connectors')}
              className={`flex items-center gap-2 px-3 py-1.5 rounded-full text-xs border transition-all ${
                activeSideDrawer === 'connectors'
                  ? 'bg-indigo-500/20 border-indigo-500/40 text-indigo-300'
                  : 'bg-white/[0.04] border-white/[0.08] text-slate-300 hover:bg-white/[0.08]'
              }`}
            >
              <Layers className="h-3.5 w-3.5 text-amber-400" />
              <span className="text-[11px] font-medium">{connectedCount}/{connectors.length || 10} 应用已联通</span>
            </button>

            {/* 灵感委托库快捷按钮 */}
            <button
              onClick={() => setActiveSideDrawer(activeSideDrawer === 'ideas' ? null : 'ideas')}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs border transition-all ${
                activeSideDrawer === 'ideas'
                  ? 'bg-purple-500/20 border-purple-500/40 text-purple-300'
                  : 'bg-white/[0.04] border-white/[0.08] text-slate-300 hover:bg-white/[0.08]'
              }`}
            >
              <Sparkles className="h-3.5 w-3.5 text-purple-400" />
              <span className="text-[11px] font-medium">任务灵感库</span>
            </button>
          </div>
        </div>

        {/* 主工作台主体：上边距留出 Header 56px */}
        <div className="flex-1 flex pt-14 h-full overflow-hidden">
          {/* 1. 左侧面板：任务血缘与推进路径 (Task Lineage & Step-by-Step Stream) */}
          <aside className="w-80 flex-shrink-0 flex flex-col border-r border-white/[0.06] bg-[#0C101B]/95 backdrop-blur-md">
            {/* 任务头部信息 */}
            <div className="p-4 border-b border-white/[0.06]">
              <div className="flex items-center justify-between mb-2">
                <span className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">
                  当前目标 (Current Goal)
                </span>
                {currentMission && (
                  <span className={`text-[10px] px-2 py-0.5 rounded-full font-mono font-medium ${
                    currentMission.status === 'ACTIVE'
                      ? 'bg-cyan-500/10 text-cyan-300 border border-cyan-500/20'
                      : currentMission.status === 'WAITING_APPROVAL'
                      ? 'bg-amber-500/10 text-amber-300 border border-amber-500/20 animate-pulse'
                      : 'bg-emerald-500/10 text-emerald-300 border border-emerald-500/20'
                  }`}>
                    {currentMission.status}
                  </span>
                )}
              </div>
              <h2 className="text-xs font-semibold text-white leading-relaxed line-clamp-2">
                {currentMission ? currentMission.title : '等待主人委派新目标'}
              </h2>

              {currentMission && (
                <div className="mt-3 space-y-1.5">
                  <div className="flex items-center justify-between text-[11px] text-slate-400 font-mono">
                    <span>推进完成度</span>
                    <span className="text-emerald-400 font-bold">{currentMission.progress}%</span>
                  </div>
                  <div className="w-full bg-slate-800/80 h-1.5 rounded-full overflow-hidden">
                    <div
                      className="bg-gradient-to-r from-indigo-500 to-emerald-400 h-full transition-all duration-500"
                      style={{ width: `${currentMission.progress}%` }}
                    />
                  </div>
                </div>
              )}
            </div>

            {/* 真实推进路径步骤树 */}
            <div className="flex-1 overflow-y-auto p-4 space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">
                  原子推进路径 (Execution Steps)
                </span>
                <span className="text-[10px] text-slate-500 font-mono">
                  {currentMission ? `${currentMission.steps.filter((s) => s.status === 'DONE').length}/${currentMission.steps.length}` : '0/0'}
                </span>
              </div>

              {currentMission && currentMission.steps.length > 0 ? (
                <div className="space-y-3 mt-2">
                  {currentMission.steps.map((st, idx) => (
                    <div
                      key={st.id}
                      className={`p-3 rounded-xl border text-xs transition-all ${
                        st.status === 'RUNNING'
                          ? 'border-indigo-500/40 bg-indigo-500/[0.08] shadow-sm'
                          : st.status === 'DONE'
                          ? 'border-white/[0.04] bg-white/[0.02]'
                          : 'border-white/[0.02] bg-transparent opacity-60'
                      }`}
                    >
                      <div className="flex items-start gap-2.5">
                        <div className="mt-0.5 flex-shrink-0">
                          {st.status === 'DONE' ? (
                            <CheckCircle2 className="h-4 w-4 text-emerald-400" />
                          ) : st.status === 'RUNNING' ? (
                            <div className="h-4 w-4 rounded-full border-2 border-indigo-400 border-t-transparent animate-spin" />
                          ) : (
                            <div className="h-4 w-4 rounded-full border border-slate-700" />
                          )}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center justify-between">
                            <span className="font-medium text-slate-200 truncate">{st.title}</span>
                            <span className="text-[10px] font-mono text-slate-400 flex-shrink-0 ml-1">
                              {st.duration || (st.status === 'RUNNING' ? '执行中...' : '等待中')}
                            </span>
                          </div>
                          {st.tool && (
                            <div className="mt-1 flex items-center gap-1.5">
                              <span className="px-1.5 py-0.2 rounded bg-indigo-500/10 text-indigo-400 text-[10px] font-mono border border-indigo-500/20">
                                {st.tool}
                              </span>
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-center py-16 space-y-2 text-slate-500">
                  <Clock className="h-8 w-8 mx-auto stroke-1" />
                  <p className="text-xs">暂无正在执行的路径</p>
                  <p className="text-[11px] text-slate-600">在右侧选择灵感或在底部输入指令立即启动</p>
                </div>
              )}
            </div>

            {/* 历史任务切换 */}
            {missions.length > 1 && (
              <div className="p-3 border-t border-white/[0.06] bg-black/20">
                <span className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider block mb-2">
                  任务历史记录 ({missions.length})
                </span>
                <div className="space-y-1 max-h-28 overflow-y-auto">
                  {missions.map((m) => (
                    <button
                      key={m.id}
                      onClick={() => setActiveMissionId(m.id)}
                      className={`w-full text-left p-1.5 rounded-lg text-xs truncate transition-all ${
                        activeMissionId === m.id
                          ? 'bg-white/[0.08] text-white font-medium'
                          : 'text-slate-400 hover:text-slate-200 hover:bg-white/[0.03]'
                      }`}
                    >
                      {m.title}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </aside>

          {/* 2. 中间核心：智能体实时视窗 (Live Agent Canvas / Viewport) + 底部指挥栏 */}
          <main className="flex-1 flex flex-col min-w-0 bg-[#070A11] relative">
            {/* 视窗顶部控制条：真机 URL 胶囊 + 网页截屏与沙箱终端双 Tab 切换 */}
            <div className="h-12 border-b border-white/[0.06] bg-[#0A0E18]/80 backdrop-blur px-5 flex items-center justify-between">
              <div className="flex items-center gap-3 flex-1 mr-4">
                <div className="flex gap-1.5">
                  <div className="h-2.5 w-2.5 rounded-full bg-rose-500/70" />
                  <div className="h-2.5 w-2.5 rounded-full bg-amber-500/70" />
                  <div className="h-2.5 w-2.5 rounded-full bg-emerald-500/70" />
                </div>
                {/* 拟真居中地址栏 */}
                <div className="rounded-lg bg-black/40 border border-white/[0.06] px-3 py-1 text-xs text-slate-300 font-mono flex items-center gap-2 flex-1 max-w-xl truncate shadow-inner">
                  <Lock className="h-3 w-3 text-emerald-400 flex-shrink-0" />
                  <span className="truncate">{viewport.url || 'about:blank'}</span>
                </div>
              </div>

              {/* 双 Tab 切换 */}
              <div className="flex items-center gap-1 bg-white/[0.04] p-1 rounded-xl border border-white/[0.06]">
                <button
                  onClick={() => setActiveCanvasTab('browser')}
                  className={`flex items-center gap-1.5 px-3 py-1 rounded-lg text-xs font-medium transition-all ${
                    activeCanvasTab === 'browser'
                      ? 'bg-indigo-600 text-white shadow-md'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  <Globe className="h-3.5 w-3.5" /> 实时网页视口
                </button>
                <button
                  onClick={() => setActiveCanvasTab('terminal')}
                  className={`flex items-center gap-1.5 px-3 py-1 rounded-lg text-xs font-medium transition-all ${
                    activeCanvasTab === 'terminal'
                      ? 'bg-indigo-600 text-white shadow-md'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  <Terminal className="h-3.5 w-3.5" /> 沙箱终端日志
                </button>
              </div>
            </div>

            {/* 高危审批悬浮横幅 (Human-in-the-Loop Sign-off Floating Banner) */}
            {approvalRequests.length > 0 && (
              <div className="mx-6 mt-4 p-4 rounded-2xl bg-amber-950/40 border border-amber-500/50 shadow-2xl backdrop-blur-md z-20 flex items-center justify-between animate-fadeIn">
                <div className="flex items-center gap-3">
                  <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-amber-500/20 text-amber-400">
                    <ShieldAlert className="h-5 w-5 animate-pulse" />
                  </div>
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="text-[10px] font-bold font-mono px-2 py-0.2 rounded bg-amber-500/20 text-amber-300 border border-amber-500/30">
                        安全签批拦截 (SIGN-OFF REQUIRED)
                      </span>
                      <span className="text-xs text-slate-400 font-mono">
                        工具: <span className="text-cyan-400 font-semibold">{approvalRequests[0].action}</span>
                      </span>
                    </div>
                    <p className="text-xs font-medium text-white mt-1">
                      {approvalRequests[0].description}
                    </p>
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  <button
                    onClick={() => handleApproval(approvalRequests[0].id, false)}
                    className="text-xs bg-slate-800 hover:bg-slate-700 text-slate-300 px-3.5 py-1.5 rounded-xl border border-slate-700 transition-all font-medium"
                  >
                    拒绝 (Reject)
                  </button>
                  <button
                    onClick={() => handleApproval(approvalRequests[0].id, true)}
                    className="text-xs bg-gradient-to-r from-amber-500 to-orange-500 hover:from-amber-400 hover:to-orange-400 text-slate-950 font-bold px-4 py-1.5 rounded-xl shadow-lg transition-all"
                  >
                    签署授权并执行 (Sign-off)
                  </button>
                </div>
              </div>
            )}

            {/* 视窗主舞台画布 */}
            <div className="flex-1 p-6 overflow-y-auto flex flex-col justify-center items-center">
              {activeCanvasTab === 'browser' ? (
                viewport.screenshotBase64 ? (
                  <div className="w-full max-w-4xl flex flex-col items-center justify-center animate-fadeIn">
                    <div className="relative rounded-2xl overflow-hidden border border-white/[0.08] shadow-2xl bg-black">
                      <img
                        src={viewport.screenshotBase64}
                        alt="Live Browser Page"
                        className="w-full max-h-[520px] object-contain"
                      />
                    </div>
                    <div className="mt-3 flex items-center justify-between w-full text-[11px] text-slate-400 font-mono px-1">
                      <span>页面标题: {viewport.title || 'Loaded'}</span>
                      <span className="text-cyan-400 font-semibold">● Playwright 实时截屏已同步</span>
                    </div>
                  </div>
                ) : (
                  /* 空视口引导面板 */
                  <div className="max-w-md text-center py-12 px-6 rounded-2xl border border-white/[0.04] bg-white/[0.01]">
                    <div className="h-12 w-12 rounded-2xl bg-indigo-500/10 border border-indigo-500/20 text-indigo-400 flex items-center justify-center mx-auto mb-4">
                      <Globe className="h-6 w-6" />
                    </div>
                    <h3 className="text-sm font-semibold text-white">等待浏览操作触发</h3>
                    <p className="text-xs text-slate-400 mt-1 leading-relaxed">
                      当智能体调用浏览器导航、搜索网页或抽取内容时，Playwright/Stagehand 的实时截屏将直接渲染在此视窗中。
                    </p>
                    <button
                      onClick={() => handleRunGoal('使用智能浏览器访问 Hacker News 首页并总结前三条热点资讯', 'Hacker News 热点快报')}
                      className="mt-5 text-xs bg-indigo-600 hover:bg-indigo-500 text-white font-medium px-4 py-2 rounded-xl transition-all shadow-lg shadow-indigo-600/25"
                    >
                      运行 Hacker News 实时浏览试探
                    </button>
                  </div>
                )
              ) : (
                /* 沙箱终端实时日志 */
                <div className="w-full max-w-4xl h-full min-h-[460px] rounded-2xl border border-white/[0.08] bg-[#04060A] p-4 font-mono text-xs text-slate-300 overflow-y-auto shadow-2xl flex flex-col justify-start">
                  <div className="flex items-center justify-between pb-3 border-b border-white/[0.06] mb-3 text-[11px] text-slate-500">
                    <span>E2B & Local Sandbox Shell Output</span>
                    <span>Total Logs: {terminalLogs.length}</span>
                  </div>
                  <div className="space-y-2 flex-1">
                    {terminalLogs.map((log) => (
                      <div key={log.id} className="leading-relaxed">
                        {log.type === 'command' && (
                          <div className="text-cyan-400 font-semibold flex items-center gap-2">
                            <span className="text-slate-600 select-none">&gt;</span>
                            <span>{log.text}</span>
                          </div>
                        )}
                        {log.type === 'stdout' && (
                          <pre className="text-slate-300 whitespace-pre-wrap pl-4 border-l border-white/[0.08] font-mono text-[11px]">
                            {log.text}
                          </pre>
                        )}
                        {log.type === 'stderr' && (
                          <pre className="text-rose-400 whitespace-pre-wrap pl-4 border-l border-rose-500/30 font-mono text-[11px]">
                            {log.text}
                          </pre>
                        )}
                        {log.type === 'system' && (
                          <div className="text-emerald-400/80 italic text-[11px]">
                            {log.text}
                          </div>
                        )}
                      </div>
                    ))}
                    <div ref={terminalEndRef} />
                  </div>
                </div>
              )}
            </div>

            {/* 底部悬浮指挥栏 (Agent Command Bar) */}
            <div className="p-5 bg-gradient-to-t from-[#070A11] via-[#070A11]/90 to-transparent">
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  handleRunGoal(inputGoal);
                }}
                className="max-w-3xl mx-auto flex items-center gap-3 bg-[#0E1322] border border-white/[0.1] rounded-2xl p-2.5 focus-within:border-indigo-500/80 transition-all shadow-2xl shadow-black/80"
              >
                <div className="pl-3 text-slate-400">
                  <Sparkles className="h-4 w-4 text-indigo-400" />
                </div>
                <input
                  type="text"
                  value={inputGoal}
                  onChange={(e) => setInputGoal(e.target.value)}
                  placeholder="向你的数字主理人委派目标 (如: 调研并比价旧金山往返机票，生成预算表)..."
                  className="flex-1 bg-transparent border-none text-xs text-white placeholder-slate-500 focus:outline-none px-2"
                />
                <button
                  type="submit"
                  disabled={!inputGoal.trim() || isExecuting}
                  className="flex items-center gap-1.5 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 text-white font-medium text-xs px-4 py-2 rounded-xl transition-all shadow-md shadow-indigo-600/30"
                >
                  {isExecuting ? (
                    <RotateCw className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Send className="h-3.5 w-3.5" />
                  )}
                  <span>派发执行</span>
                </button>
              </form>
            </div>
          </main>

          {/* 3. 右侧可滑出抽屉面板 (Slide-out Drawer for Ideas / Connectors) */}
          {activeSideDrawer && (
            <aside className="w-80 flex-shrink-0 flex flex-col border-l border-white/[0.06] bg-[#0C101B]/95 backdrop-blur-md animate-fadeIn z-20">
              <div className="p-4 border-b border-white/[0.06] flex items-center justify-between">
                <div className="flex items-center gap-2">
                  {activeSideDrawer === 'ideas' ? (
                    <>
                      <Sparkles className="h-4 w-4 text-purple-400" />
                      <span className="text-xs font-bold text-white">任务委托灵感库</span>
                    </>
                  ) : (
                    <>
                      <Layers className="h-4 w-4 text-amber-400" />
                      <span className="text-xs font-bold text-white">应用生态连接器 ({connectedCount}/{connectors.length})</span>
                    </>
                  )}
                </div>
                <button
                  onClick={() => setActiveSideDrawer(null)}
                  className="text-slate-400 hover:text-white p-1 rounded-lg"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>

              <div className="flex-1 overflow-y-auto p-4 space-y-3">
                {activeSideDrawer === 'ideas' ? (
                  inspirationMissions.map((item, idx) => (
                    <div
                      key={idx}
                      className="p-3.5 rounded-xl border border-white/[0.06] bg-white/[0.02] hover:border-indigo-500/40 hover:bg-white/[0.04] transition-all flex flex-col justify-between group"
                    >
                      <div>
                        <div className="flex items-center justify-between">
                          <h4 className="text-xs font-semibold text-white group-hover:text-indigo-300 transition-colors">
                            {item.title}
                          </h4>
                        </div>
                        <p className="text-[11px] text-slate-400 mt-1 leading-relaxed">
                          {item.prompt}
                        </p>
                        <span className="inline-block mt-2 text-[10px] font-mono text-slate-400 px-1.5 py-0.5 rounded bg-white/[0.04]">
                          #{item.tag}
                        </span>
                      </div>
                      <button
                        disabled={isExecuting}
                        onClick={() => {
                          handleRunGoal(item.prompt, item.title);
                          setActiveSideDrawer(null);
                        }}
                        className="mt-3 w-full flex items-center justify-center gap-1.5 text-xs bg-indigo-600/30 hover:bg-indigo-600 text-indigo-200 hover:text-white py-1.5 rounded-lg border border-indigo-500/40 transition-all font-medium"
                      >
                        <Play className="h-3 w-3" /> 一键委托执行
                      </button>
                    </div>
                  ))
                ) : (
                  connectors.map((c) => (
                    <div
                      key={c.id}
                      className="p-3 rounded-xl border border-white/[0.06] bg-white/[0.02] flex items-center justify-between"
                    >
                      <div className="min-w-0 flex-1 pr-2">
                        <div className="flex items-center gap-2">
                          <span className="text-xs font-semibold text-white truncate">{c.name}</span>
                          <span
                            className={`text-[9px] px-1.5 py-0.2 rounded font-mono ${
                              c.status === 'connected'
                                ? 'bg-emerald-500/20 text-emerald-400'
                                : 'bg-slate-800 text-slate-500'
                            }`}
                          >
                            {c.status === 'connected' ? 'CONNECTED' : 'UNSET'}
                          </span>
                        </div>
                        <p className="text-[10px] text-slate-400 truncate mt-0.5">{c.description}</p>
                        <span className="text-[9px] font-mono text-slate-500">Env: {c.envVar}</span>
                      </div>
                      <button
                        onClick={() => {
                          setConfiguringConnector(c);
                          setApiKeyInput('');
                        }}
                        className="flex-shrink-0 text-[11px] px-2.5 py-1 rounded-lg bg-white/[0.06] hover:bg-white/[0.1] text-slate-200 transition-all font-medium"
                      >
                        {c.status === 'connected' ? '修改' : '连接'}
                      </button>
                    </div>
                  ))
                )}
              </div>
            </aside>
          )}
        </div>

        {/* 模态框：配置连接器密钥 */}
        {configuringConnector && (
          <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-50 p-4 animate-fadeIn">
            <div className="w-full max-w-md bg-[#0F1422] border border-white/[0.1] rounded-2xl p-6 shadow-2xl space-y-4">
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
                  className="w-full bg-black/50 border border-white/[0.1] rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-indigo-500"
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
                  className="text-xs bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white font-medium px-4 py-1.5 rounded-xl transition-all shadow"
                >
                  {isSavingKey ? '保存中...' : '保存并激活连接'}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </CopilotKit>
  );
}
