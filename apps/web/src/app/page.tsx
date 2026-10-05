'use client';

import { useState, useEffect, useRef } from 'react';
import { CopilotKit } from '@copilotkit/react-core';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  Globe,
  Check,
  Terminal,
  Key,
  X,
  ArrowUp,
  Lock,
  Pause,
  Play,
  RotateCw,
  Shield,
  Layers,
  ChevronRight,
  ExternalLink,
  Search,
  FileText,
  AlertTriangle,
  Clock,
  Sparkles,
  Copy,
  CheckCheck,
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

interface ArtifactState {
  title?: string;
  type?: string;
  content: string;
}

export default function Workspace() {
  const [mounted, setMounted] = useState(false);
  const [rightTab, setRightTab] = useState<'browser' | 'terminal' | 'artifact'>('browser');
  const [showIntegrations, setShowIntegrations] = useState(false);

  // 状态流
  const [missions, setMissions] = useState<Mission[]>([]);
  const [activeMissionId, setActiveMissionId] = useState<string | null>(null);
  const [viewport, setViewport] = useState<ViewportState>({
    activeTab: 'browser',
    url: 'about:blank',
    title: 'Ready',
    status: 'idle',
  });
  const [terminalLogs, setTerminalLogs] = useState<TerminalLog[]>([]);
  const [approvalRequests, setApprovalRequests] = useState<ApprovalRequest[]>([]);
  const [artifact, setArtifact] = useState<ArtifactState | null>(null);
  const [copiedArtifact, setCopiedArtifact] = useState(false);

  // 连接器
  const [connectors, setConnectors] = useState<ConnectorApp[]>([]);
  const [configuringApp, setConfiguringApp] = useState<ConnectorApp | null>(null);
  const [keyInput, setKeyInput] = useState('');
  const [isSavingKey, setIsSavingKey] = useState(false);

  // 输入
  const [prompt, setPrompt] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const terminalEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (rightTab === 'terminal') {
      terminalEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [terminalLogs, rightTab]);

  const loadConnectors = async () => {
    try {
      const res = await fetch('/api/connectors');
      const data = await res.json();
      if (data.connectors) setConnectors(data.connectors);
    } catch (e) {
      console.error(e);
    }
  };

  const handleSaveKey = async () => {
    if (!configuringApp || !keyInput.trim()) return;
    setIsSavingKey(true);
    try {
      const res = await fetch('/api/connectors', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          envVar: configuringApp.envVar,
          value: keyInput.trim(),
        }),
      });
      const data = await res.json();
      if (data.connectors) setConnectors(data.connectors);
      setConfiguringApp(null);
      setKeyInput('');
    } catch (e) {
      console.error(e);
    } finally {
      setIsSavingKey(false);
    }
  };

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
        if (state.terminalLogs) setTerminalLogs(state.terminalLogs);
        if (state.approvalRequests) setApprovalRequests(state.approvalRequests);
        if (state.latestArtifact) setArtifact(state.latestArtifact);
      } catch (err) {
        console.error(err);
      }
    });

    eventSource.addEventListener('viewport_update', (e: MessageEvent) => {
      try {
        const vp = JSON.parse(e.data);
        setViewport((prev) => ({ ...prev, ...vp }));
        setRightTab('browser');
      } catch (err) {
        console.error(err);
      }
    });

    eventSource.addEventListener('terminal_log', (e: MessageEvent) => {
      try {
        const log = JSON.parse(e.data);
        setTerminalLogs((prev) => [...prev, log]);
      } catch (err) {
        console.error(err);
      }
    });

    eventSource.addEventListener('mission_created', (e: MessageEvent) => {
      try {
        const mission: Mission = JSON.parse(e.data);
        setMissions((prev) => [mission, ...prev.filter((m) => m.id !== mission.id)]);
        setActiveMissionId(mission.id);
      } catch (err) {
        console.error(err);
      }
    });

    eventSource.addEventListener('mission_updated', (e: MessageEvent) => {
      try {
        const updated: Mission = JSON.parse(e.data);
        setMissions((prev) => prev.map((m) => (m.id === updated.id ? updated : m)));
      } catch (err) {
        console.error(err);
      }
    });

    eventSource.addEventListener('approval_requested', (e: MessageEvent) => {
      try {
        const req: ApprovalRequest = JSON.parse(e.data);
        setApprovalRequests((prev) => [...prev.filter((r) => r.id !== req.id), req]);
      } catch (err) {
        console.error(err);
      }
    });

    eventSource.addEventListener('approval_resolved', (e: MessageEvent) => {
      try {
        const { approvalId } = JSON.parse(e.data);
        setApprovalRequests((prev) => prev.filter((r) => r.id !== approvalId));
      } catch (err) {
        console.error(err);
      }
    });

    eventSource.addEventListener('artifact_updated', (e: MessageEvent) => {
      try {
        const art = JSON.parse(e.data);
        setArtifact(art);
        setRightTab('artifact');
      } catch (err) {
        console.error(err);
      }
    });

    return () => {
      eventSource.close();
    };
  }, []);

  const handleApproval = async (approvalId: string, approved: boolean) => {
    try {
      await fetch('/api/agent/approval', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ approvalId, approved }),
      });
      setApprovalRequests((prev) => prev.filter((r) => r.id !== approvalId));
    } catch (err) {
      console.error(err);
    }
  };

  const handleRun = async (text: string, title?: string) => {
    if (!text.trim() || isSubmitting) return;
    setIsSubmitting(true);
    setRightTab('browser');

    try {
      await fetch('/api/agent/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: text.trim(), title }),
      });
      setPrompt('');
    } catch (e) {
      console.error(e);
    } finally {
      setIsSubmitting(false);
    }
  };

  const currentMission = missions.find((m) => m.id === activeMissionId) || missions[0] || null;
  const connectedCount = connectors.filter((c) => c.status === 'connected').length;

  const suggestions = [
    { title: 'Search & Summarize', prompt: 'Browse Hacker News and summarize today’s top trending stories.' },
    { title: 'Environment Diagnostic', prompt: 'Run a sandbox environment diagnostic and check Node.js & Git setup.' },
    { title: 'GitHub Trending', prompt: 'Inspect GitHub trending repositories and extract highlights into a summary.' },
    { title: 'Market Research', prompt: 'Research recent multimodal AI agent developments and create a structured brief.' },
  ];

  const handleCopyArtifact = () => {
    if (!artifact?.content) return;
    navigator.clipboard.writeText(artifact.content);
    setCopiedArtifact(true);
    setTimeout(() => setCopiedArtifact(false), 2000);
  };

  if (!mounted) return null;

  return (
    <CopilotKit runtimeUrl="/api/copilotkit">
      <div className="flex h-screen w-screen overflow-hidden bg-[#fbfbfd] text-zinc-900 font-sans antialiased selection:bg-zinc-200">
        {/* 顶部极简导航栏 (Manus/Devin Minimalist Topbar) */}
        <header className="absolute top-0 left-0 right-0 h-12 border-b border-zinc-200/80 bg-white/90 backdrop-blur z-30 px-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2 font-medium text-sm text-zinc-900">
              <div className="h-6 w-6 rounded-md bg-zinc-900 text-white flex items-center justify-center font-bold text-xs tracking-tight">
                P
              </div>
              <span className="font-semibold tracking-tight">agtpilot</span>
            </div>
            <span className="text-zinc-300">/</span>
            <span className="text-xs text-zinc-500 font-normal truncate max-w-sm">
              {currentMission ? currentMission.title : 'Workspace'}
            </span>
          </div>

          <div className="flex items-center gap-2">
            {/* 状态徽标 */}
            <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs bg-zinc-50 border border-zinc-200">
              <span
                className={`h-2 w-2 rounded-full ${
                  currentMission && currentMission.status === 'ACTIVE'
                    ? 'bg-blue-600 animate-pulse'
                    : currentMission && currentMission.status === 'WAITING_APPROVAL'
                    ? 'bg-amber-500 ring-2 ring-amber-200'
                    : 'bg-zinc-400'
                }`}
              />
              <span className="text-[11px] font-medium text-zinc-600">
                {currentMission && currentMission.status === 'ACTIVE'
                  ? 'Running'
                  : currentMission && currentMission.status === 'WAITING_APPROVAL'
                  ? 'Approval Required'
                  : 'Ready'}
              </span>
            </div>

            {/* 连接器设置按钮 */}
            <button
              onClick={() => setShowIntegrations(true)}
              className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs text-zinc-700 hover:text-zinc-900 bg-white hover:bg-zinc-50 border border-zinc-200 transition shadow-xs"
            >
              <Layers className="h-3.5 w-3.5 text-zinc-500" />
              <span className="text-[11px] font-medium">
                {connectedCount > 0 ? `${connectedCount} Connected` : 'Connectors'}
              </span>
            </button>
          </div>
        </header>

        {/* 核心双栏工作区 (Manus 3-panel inspired: Left chat/plan stream, Right live output & deliverable canvas) */}
        <div className="flex-1 flex pt-12 h-full overflow-hidden">
          {/* 左侧面板：对话、目标分解与执行日志 (Devin/Manus Left Stream) */}
          <section className="w-[440px] flex-shrink-0 flex flex-col border-r border-zinc-200 bg-white">
            {/* 任务进度 & 目标概览 */}
            <div className="p-4 border-b border-zinc-100 bg-[#fbfbfd]">
              <div className="flex items-center justify-between mb-1.5">
                <span className="text-[11px] font-semibold text-zinc-400 uppercase tracking-wider">
                  Goal & Plan
                </span>
                {currentMission && (
                  <span className="text-[11px] font-mono text-zinc-500 font-semibold">
                    {currentMission.progress}%
                  </span>
                )}
              </div>
              {currentMission ? (
                <div>
                  <h2 className="text-xs font-semibold text-zinc-900 leading-snug">
                    {currentMission.title}
                  </h2>
                  <div className="mt-2 w-full bg-zinc-200/80 h-1.5 rounded-full overflow-hidden">
                    <div
                      className="bg-zinc-900 h-full transition-all duration-300"
                      style={{ width: `${currentMission.progress}%` }}
                    />
                  </div>
                </div>
              ) : (
                <p className="text-xs text-zinc-400">Ready for instructions.</p>
              )}
            </div>

            {/* 中间执行轨迹：Subtasks / Steps Checklist */}
            <div className="flex-1 overflow-y-auto p-4 space-y-2">
              <div className="flex items-center justify-between mb-2">
                <span className="text-[11px] font-semibold text-zinc-400 uppercase tracking-wider">
                  Task Execution
                </span>
                {currentMission && (
                  <span className="text-[11px] text-zinc-400 font-mono">
                    {currentMission.steps.filter((s) => s.status === 'DONE').length} /{' '}
                    {currentMission.steps.length}
                  </span>
                )}
              </div>

              {currentMission && currentMission.steps.length > 0 ? (
                <div className="space-y-2">
                  {currentMission.steps.map((st) => (
                    <div
                      key={st.id}
                      className={`p-3 rounded-xl border text-xs transition ${
                        st.status === 'RUNNING'
                          ? 'border-blue-200 bg-blue-50/40 text-zinc-900 shadow-xs'
                          : st.status === 'DONE'
                          ? 'border-zinc-200/80 bg-zinc-50/50 text-zinc-700'
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
                          ) : (
                            <div className="h-4 w-4 rounded-full border border-zinc-300" />
                          )}
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="font-medium text-xs leading-snug">{st.title}</p>
                          <div className="flex items-center justify-between text-[10px] text-zinc-400 mt-1 font-mono">
                            <span>{st.tool || 'orchestrator'}</span>
                            <span>{st.duration || (st.status === 'RUNNING' ? 'running...' : 'queued')}</span>
                          </div>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="py-12 text-center text-zinc-400 space-y-2">
                  <div className="mx-auto w-8 h-8 rounded-full bg-zinc-100 flex items-center justify-center text-zinc-400">
                    <Clock className="h-4 w-4" />
                  </div>
                  <p className="text-xs">No active task. Choose an action below or enter a prompt.</p>
                </div>
              )}
            </div>

            {/* 历史记录快速切换 */}
            {missions.length > 1 && (
              <div className="px-4 py-2 border-t border-zinc-100 bg-[#fbfbfd]">
                <div className="flex items-center gap-1.5 overflow-x-auto py-1">
                  <span className="text-[10px] text-zinc-400 uppercase font-semibold mr-1 flex-shrink-0">
                    Recent:
                  </span>
                  {missions.slice(0, 4).map((m) => (
                    <button
                      key={m.id}
                      onClick={() => setActiveMissionId(m.id)}
                      className={`text-[11px] px-2 py-0.5 rounded-md whitespace-nowrap truncate max-w-[120px] transition ${
                        activeMissionId === m.id
                          ? 'bg-zinc-200 text-zinc-900 font-medium'
                          : 'text-zinc-500 hover:text-zinc-800 hover:bg-zinc-100'
                      }`}
                    >
                      {m.title}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* 底部输入框 (Clean Devin/Linear Style Command Bar) */}
            <div className="p-3 border-t border-zinc-200 bg-white">
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  handleRun(prompt);
                }}
                className="flex items-center gap-2 bg-[#f4f4f6] border border-zinc-200 rounded-xl p-1.5 focus-within:border-zinc-400 focus-within:bg-white transition"
              >
                <input
                  type="text"
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  placeholder="Instruct AgtPilot to browse, code, research..."
                  className="flex-1 bg-transparent border-none text-xs text-zinc-900 placeholder-zinc-400 focus:outline-none px-2"
                />
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
              </form>
            </div>
          </section>

          {/* 右侧主视窗：Manus/Devin Multi-Tab Execution Canvas */}
          <main className="flex-1 flex flex-col min-w-0 bg-[#fafafa]">
            {/* 标签栏：Browser / Terminal / Deliverable */}
            <div className="h-11 border-b border-zinc-200 bg-white px-4 flex items-center justify-between">
              <div className="flex items-center gap-1">
                <button
                  onClick={() => setRightTab('browser')}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition ${
                    rightTab === 'browser'
                      ? 'bg-zinc-100 text-zinc-900 font-semibold'
                      : 'text-zinc-500 hover:text-zinc-900 hover:bg-zinc-50'
                  }`}
                >
                  <Globe className="h-3.5 w-3.5" />
                  <span>Browser</span>
                  {viewport.status === 'navigating' && (
                    <span className="h-1.5 w-1.5 rounded-full bg-blue-600 animate-ping" />
                  )}
                </button>

                <button
                  onClick={() => setRightTab('terminal')}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition ${
                    rightTab === 'terminal'
                      ? 'bg-zinc-100 text-zinc-900 font-semibold'
                      : 'text-zinc-500 hover:text-zinc-900 hover:bg-zinc-50'
                  }`}
                >
                  <Terminal className="h-3.5 w-3.5" />
                  <span>Terminal</span>
                  {terminalLogs.length > 0 && (
                    <span className="text-[10px] bg-zinc-200 text-zinc-600 px-1 rounded-sm">
                      {terminalLogs.length}
                    </span>
                  )}
                </button>

                <button
                  onClick={() => setRightTab('artifact')}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition ${
                    rightTab === 'artifact'
                      ? 'bg-zinc-100 text-zinc-900 font-semibold'
                      : 'text-zinc-500 hover:text-zinc-900 hover:bg-zinc-50'
                  }`}
                >
                  <FileText className="h-3.5 w-3.5" />
                  <span>Deliverable</span>
                  {artifact && <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />}
                </button>
              </div>

              {/* 顶栏辅助信息 */}
              {rightTab === 'browser' && viewport.url && (
                <div className="flex items-center gap-1.5 text-xs text-zinc-500 font-mono truncate max-w-sm bg-zinc-50 border border-zinc-200 px-2.5 py-1 rounded-md">
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
                  <span className="text-[11px]">{copiedArtifact ? 'Copied' : 'Copy Markdown'}</span>
                </button>
              )}
            </div>

            {/* 人机协同安全授权横幅 (Human-in-the-Loop Sign-off Gate) */}
            {approvalRequests.length > 0 && (
              <div className="m-4 p-4 rounded-xl border border-amber-200 bg-amber-50/80 shadow-xs flex items-center justify-between animate-fadeIn">
                <div className="flex items-center gap-3">
                  <div className="h-9 w-9 rounded-lg bg-amber-100 text-amber-700 flex items-center justify-center flex-shrink-0">
                    <Shield className="h-4 w-4" />
                  </div>
                  <div>
                    <span className="text-xs font-semibold text-zinc-900 block">
                      Human Authorization Required
                    </span>
                    <p className="text-xs text-zinc-600 mt-0.5">
                      {approvalRequests[0].description} ({approvalRequests[0].action})
                    </p>
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  <button
                    onClick={() => handleApproval(approvalRequests[0].id, false)}
                    className="px-3.5 py-1.5 rounded-lg text-xs font-medium bg-white hover:bg-zinc-50 border border-zinc-200 text-zinc-700 transition"
                  >
                    Reject
                  </button>
                  <button
                    onClick={() => handleApproval(approvalRequests[0].id, true)}
                    className="px-3.5 py-1.5 rounded-lg text-xs font-medium bg-zinc-900 hover:bg-zinc-800 text-white transition shadow-xs"
                  >
                    Authorize Action
                  </button>
                </div>
              </div>
            )}

            {/* 画布视图主体 */}
            <div className="flex-1 p-5 overflow-y-auto">
              {/* 1. 真实浏览器画板 (Browser View) */}
              {rightTab === 'browser' && (
                <div className="h-full flex flex-col items-center justify-center">
                  {viewport.screenshotBase64 ? (
                    <div className="w-full max-w-4xl rounded-2xl overflow-hidden border border-zinc-200 shadow-md bg-white">
                      <div className="h-9 bg-zinc-100 border-b border-zinc-200 px-4 flex items-center gap-2">
                        <div className="flex gap-1.5">
                          <div className="h-2.5 w-2.5 rounded-full bg-zinc-300" />
                          <div className="h-2.5 w-2.5 rounded-full bg-zinc-300" />
                          <div className="h-2.5 w-2.5 rounded-full bg-zinc-300" />
                        </div>
                        <span className="text-[11px] text-zinc-500 font-mono truncate ml-2">
                          {viewport.url || 'Playwright Viewport'}
                        </span>
                      </div>
                      <img
                        src={viewport.screenshotBase64}
                        alt="Browser viewport"
                        className="w-full max-h-[580px] object-contain bg-white"
                      />
                    </div>
                  ) : (
                    /* 初始白态落地页：引导用户启动任务 */
                    <div className="w-full max-w-xl text-center space-y-6">
                      <div className="space-y-2">
                        <h1 className="text-2xl font-semibold text-zinc-900 tracking-tight">
                          Autonomous Agent Cockpit
                        </h1>
                        <p className="text-xs text-zinc-500 max-w-md mx-auto leading-relaxed">
                          AgtPilot coordinates web browsing, command sandboxing, and autonomous workflows.
                          Select an action or ask directly.
                        </p>
                      </div>

                      <div className="grid grid-cols-2 gap-3 text-left">
                        {suggestions.map((s, idx) => (
                          <button
                            key={idx}
                            onClick={() => handleRun(s.prompt, s.title)}
                            className="p-3.5 rounded-xl border border-zinc-200 bg-white hover:bg-zinc-50 hover:border-zinc-300 text-xs transition shadow-2xs group"
                          >
                            <span className="font-semibold text-zinc-900 block group-hover:text-blue-600 transition">
                              {s.title}
                            </span>
                            <span className="text-[11px] text-zinc-500 mt-1 line-clamp-2 block leading-relaxed">
                              {s.prompt}
                            </span>
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* 2. 终端沙箱日志 (Terminal Console) */}
              {rightTab === 'terminal' && (
                <div className="w-full h-full min-h-[460px] rounded-xl border border-zinc-300 bg-[#16181d] p-4 font-mono text-xs text-zinc-200 overflow-y-auto shadow-sm">
                  <div className="space-y-1.5">
                    {terminalLogs.map((log) => (
                      <div key={log.id} className="leading-relaxed">
                        {log.type === 'command' && (
                          <div className="text-blue-400 font-medium">$ {log.text}</div>
                        )}
                        {log.type === 'stdout' && (
                          <pre className="text-zinc-300 whitespace-pre-wrap pl-3 font-mono text-[11px]">
                            {log.text}
                          </pre>
                        )}
                        {log.type === 'stderr' && (
                          <pre className="text-rose-400 whitespace-pre-wrap pl-3 font-mono text-[11px]">
                            {log.text}
                          </pre>
                        )}
                        {log.type === 'system' && (
                          <div className="text-zinc-500 italic text-[11px]">{log.text}</div>
                        )}
                      </div>
                    ))}
                    <div ref={terminalEndRef} />
                  </div>
                </div>
              )}

              {/* 3. 产物输出视图 (Deliverable Artifact Markdown View - Manus Output-First Style) */}
              {rightTab === 'artifact' && (
                <div className="w-full max-w-4xl mx-auto h-full flex flex-col">
                  {artifact ? (
                    <div className="bg-white rounded-2xl border border-zinc-200 p-8 shadow-xs overflow-y-auto prose prose-zinc max-w-none text-xs">
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>
                        {artifact.content}
                      </ReactMarkdown>
                    </div>
                  ) : (
                    <div className="h-full flex flex-col items-center justify-center text-center text-zinc-400 space-y-2">
                      <FileText className="h-8 w-8 text-zinc-300" />
                      <p className="text-xs">No deliverable artifact generated yet.</p>
                      <p className="text-[11px] text-zinc-400">
                        Deliverables (summaries, reports, code) appear here when tasks finish.
                      </p>
                    </div>
                  )}
                </div>
              )}
            </div>
          </main>
        </div>

        {/* 连接器设置弹窗 (Connectors Dialog) */}
        {showIntegrations && (
          <div className="fixed inset-0 bg-black/30 backdrop-blur-xs flex items-center justify-center z-50 p-4">
            <div className="w-full max-w-lg bg-white border border-zinc-200 rounded-2xl p-6 shadow-2xl space-y-4">
              <div className="flex items-center justify-between pb-3 border-b border-zinc-100">
                <div>
                  <h3 className="text-sm font-semibold text-zinc-900">Platform Connectors</h3>
                  <p className="text-xs text-zinc-500 mt-0.5">
                    Configure environment API keys to enable agent capabilities.
                  </p>
                </div>
                <button
                  onClick={() => setShowIntegrations(false)}
                  className="text-zinc-400 hover:text-zinc-600 p-1 rounded-lg"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>

              <div className="max-h-96 overflow-y-auto space-y-2 pr-1">
                {connectors.map((c) => (
                  <div
                    key={c.id}
                    className="p-3 rounded-xl border border-zinc-200 bg-zinc-50/50 flex items-center justify-between"
                  >
                    <div className="min-w-0 pr-3">
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-semibold text-zinc-900">{c.name}</span>
                        <span
                          className={`text-[10px] font-mono px-1.5 py-0.2 rounded font-medium ${
                            c.status === 'connected'
                              ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                              : 'bg-zinc-200/60 text-zinc-500'
                          }`}
                        >
                          {c.status === 'connected' ? 'Connected' : 'Unconfigured'}
                        </span>
                      </div>
                      <p className="text-[11px] text-zinc-500 truncate mt-0.5">{c.description}</p>
                    </div>

                    <button
                      onClick={() => {
                        setConfiguringApp(c);
                        setKeyInput('');
                      }}
                      className="text-xs px-3 py-1 rounded-lg bg-white hover:bg-zinc-50 border border-zinc-200 shadow-2xs text-zinc-700 transition font-medium flex-shrink-0"
                    >
                      {c.status === 'connected' ? 'Update' : 'Configure'}
                    </button>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* 密钥输入子弹窗 */}
        {configuringApp && (
          <div className="fixed inset-0 bg-black/40 backdrop-blur-xs flex items-center justify-center z-50 p-4">
            <div className="w-full max-w-md bg-white border border-zinc-200 rounded-2xl p-6 shadow-2xl space-y-4">
              <div className="flex items-center justify-between">
                <h4 className="text-sm font-semibold text-zinc-900">Configure {configuringApp.name}</h4>
                <button
                  onClick={() => setConfiguringApp(null)}
                  className="text-zinc-400 hover:text-zinc-600"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>

              <p className="text-xs text-zinc-500">{configuringApp.description}</p>

              <div>
                <label className="text-[11px] font-mono text-zinc-500 block mb-1">
                  Env: {configuringApp.envVar}
                </label>
                <input
                  type="password"
                  value={keyInput}
                  onChange={(e) => setKeyInput(e.target.value)}
                  placeholder="Enter API key..."
                  className="w-full bg-white border border-zinc-300 rounded-lg px-3 py-2 text-xs text-zinc-900 focus:outline-none focus:border-zinc-500 focus:ring-2 focus:ring-zinc-100"
                />
              </div>

              <div className="flex justify-end gap-2 pt-2">
                <button
                  onClick={() => setConfiguringApp(null)}
                  className="text-xs text-zinc-500 hover:text-zinc-700 px-3 py-1.5 rounded-lg"
                >
                  Cancel
                </button>
                <button
                  disabled={!keyInput.trim() || isSavingKey}
                  onClick={handleSaveKey}
                  className="text-xs bg-zinc-900 hover:bg-zinc-800 disabled:opacity-30 text-white font-medium px-4 py-1.5 rounded-lg transition shadow-xs"
                >
                  {isSavingKey ? 'Saving...' : 'Save & Connect'}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </CopilotKit>
  );
}
