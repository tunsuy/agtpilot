'use client';

import { useState, useEffect, useRef } from 'react';
import { CopilotKit } from '@copilotkit/react-core';
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
  Plus,
  RotateCw,
  Shield,
  Layers,
  ChevronRight,
  ExternalLink,
  Command,
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

export default function Workspace() {
  const [mounted, setMounted] = useState(false);
  const [activeTab, setActiveTab] = useState<'preview' | 'terminal'>('preview');
  const [showIntegrations, setShowIntegrations] = useState(false);

  // 状态流
  const [missions, setMissions] = useState<Mission[]>([]);
  const [activeMissionId, setActiveMissionId] = useState<string | null>(null);
  const [viewport, setViewport] = useState<ViewportState>({
    activeTab: 'browser',
    url: '',
    title: '',
    status: 'idle',
  });
  const [terminalLogs, setTerminalLogs] = useState<TerminalLog[]>([]);
  const [approvalRequests, setApprovalRequests] = useState<ApprovalRequest[]>([]);

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
    if (activeTab === 'terminal') {
      terminalEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [terminalLogs, activeTab]);

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
      } catch (err) {
        console.error(err);
      }
    });

    eventSource.addEventListener('viewport_update', (e: MessageEvent) => {
      try {
        const vp = JSON.parse(e.data);
        setViewport((prev) => ({ ...prev, ...vp }));
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
    setActiveTab('preview');

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
    { title: 'Search & Summarize', prompt: 'Browse Hacker News and summarize today’s top 3 trending discussions.' },
    { title: 'Security Audit', prompt: 'Run a sandbox environment diagnostic and check system configurations.' },
    { title: 'GitHub Radar', prompt: 'Inspect GitHub trending repositories and extract highlights into a summary.' },
    { title: 'Flight & Hotel Research', prompt: 'Search travel options and compare accommodations for next week.' },
  ];

  if (!mounted) return null;

  return (
    <CopilotKit runtimeUrl="/api/copilotkit">
      <div className="flex h-screen w-screen overflow-hidden bg-[#0d0f12] text-zinc-100 font-sans antialiased selection:bg-zinc-700 selection:text-white">
        {/* 顶部简洁导航 */}
        <header className="absolute top-0 left-0 right-0 h-12 border-b border-zinc-800/60 bg-[#0d0f12]/90 backdrop-blur z-30 px-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <span className="font-semibold text-sm tracking-tight text-white">agtpilot</span>
            <span className="text-zinc-600">/</span>
            <span className="text-xs text-zinc-400 font-normal">
              {currentMission ? currentMission.title : 'Workspace'}
            </span>
          </div>

          <div className="flex items-center gap-2">
            {/* 状态点 */}
            <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs text-zinc-400 bg-zinc-900 border border-zinc-800">
              <span
                className={`h-1.5 w-1.5 rounded-full ${
                  currentMission && currentMission.status === 'ACTIVE'
                    ? 'bg-blue-400 animate-pulse'
                    : currentMission && currentMission.status === 'WAITING_APPROVAL'
                    ? 'bg-amber-400'
                    : 'bg-zinc-500'
                }`}
              />
              <span className="text-[11px]">
                {currentMission && currentMission.status === 'ACTIVE'
                  ? 'Running'
                  : currentMission && currentMission.status === 'WAITING_APPROVAL'
                  ? 'Action Required'
                  : 'Idle'}
              </span>
            </div>

            {/* 应用连接 */}
            <button
              onClick={() => setShowIntegrations(true)}
              className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs text-zinc-300 hover:text-white bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 transition"
            >
              <Layers className="h-3 w-3 text-zinc-400" />
              <span className="text-[11px]">
                {connectedCount > 0 ? `${connectedCount} Apps` : 'Connect Apps'}
              </span>
            </button>
          </div>
        </header>

        {/* 核心工作区分栏 */}
        <div className="flex-1 flex pt-12 h-full overflow-hidden">
          {/* 左侧：任务活动与历史 (Quiet Sidebar) */}
          <aside className="w-72 flex-shrink-0 flex flex-col border-r border-zinc-800/60 bg-[#101217]">
            {/* 当前任务活动 */}
            <div className="p-4 border-b border-zinc-800/50">
              <div className="flex items-center justify-between mb-2">
                <span className="text-[11px] font-medium text-zinc-400 uppercase tracking-wider">
                  Current Task
                </span>
                {currentMission && (
                  <span className="text-[10px] font-mono text-zinc-500">
                    {currentMission.progress}%
                  </span>
                )}
              </div>

              {currentMission ? (
                <div>
                  <h2 className="text-xs font-medium text-zinc-200 line-clamp-2 leading-relaxed">
                    {currentMission.title}
                  </h2>
                  <div className="mt-2.5 w-full bg-zinc-800/80 h-1 rounded-full overflow-hidden">
                    <div
                      className="bg-blue-500 h-full transition-all duration-300"
                      style={{ width: `${currentMission.progress}%` }}
                    />
                  </div>
                </div>
              ) : (
                <p className="text-xs text-zinc-500">No active task running.</p>
              )}
            </div>

            {/* 执行步骤 (Activity List) */}
            <div className="flex-1 overflow-y-auto p-4 space-y-1">
              <span className="text-[11px] font-medium text-zinc-400 uppercase tracking-wider block mb-2.5">
                Steps
              </span>

              {currentMission && currentMission.steps.length > 0 ? (
                <div className="space-y-2">
                  {currentMission.steps.map((st) => (
                    <div
                      key={st.id}
                      className={`p-2.5 rounded-lg text-xs transition ${
                        st.status === 'RUNNING'
                          ? 'bg-zinc-800/60 text-zinc-100 border border-zinc-700/60'
                          : st.status === 'DONE'
                          ? 'text-zinc-300'
                          : 'text-zinc-500'
                      }`}
                    >
                      <div className="flex items-start gap-2">
                        <div className="mt-0.5 flex-shrink-0">
                          {st.status === 'DONE' ? (
                            <Check className="h-3.5 w-3.5 text-zinc-400" />
                          ) : st.status === 'RUNNING' ? (
                            <div className="h-3.5 w-3.5 rounded-full border border-blue-400 border-t-transparent animate-spin" />
                          ) : (
                            <div className="h-3.5 w-3.5 rounded-full border border-zinc-700" />
                          )}
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="font-normal truncate leading-snug">{st.title}</p>
                          <div className="flex items-center justify-between text-[10px] text-zinc-500 mt-1 font-mono">
                            <span>{st.tool || 'system'}</span>
                            <span>{st.duration || (st.status === 'RUNNING' ? 'running' : 'pending')}</span>
                          </div>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-xs text-zinc-600 py-6 text-center">
                  Steps will appear here when a task begins.
                </p>
              )}
            </div>

            {/* 历史任务 (Past Tasks) */}
            {missions.length > 1 && (
              <div className="p-3 border-t border-zinc-800/50 bg-[#0d0f12]/60">
                <span className="text-[10px] font-medium text-zinc-500 uppercase tracking-wider block mb-2">
                  Recent
                </span>
                <div className="space-y-1 max-h-32 overflow-y-auto">
                  {missions.map((m) => (
                    <button
                      key={m.id}
                      onClick={() => setActiveMissionId(m.id)}
                      className={`w-full text-left px-2 py-1.5 rounded text-xs truncate transition ${
                        activeMissionId === m.id
                          ? 'bg-zinc-800 text-white font-medium'
                          : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-900'
                      }`}
                    >
                      {m.title}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </aside>

          {/* 右侧主工作台：自然输入与实时预览 (Clean Main Canvas) */}
          <main className="flex-1 flex flex-col min-w-0 bg-[#0d0f12]">
            {/* 顶栏控制：Tab 切换与轻量地址展示 */}
            <div className="h-10 border-b border-zinc-800/60 bg-[#101217] px-4 flex items-center justify-between">
              <div className="flex items-center gap-1">
                <button
                  onClick={() => setActiveTab('preview')}
                  className={`px-3 py-1 rounded text-xs font-medium transition ${
                    activeTab === 'preview'
                      ? 'bg-zinc-800 text-white'
                      : 'text-zinc-400 hover:text-zinc-200'
                  }`}
                >
                  Browser
                </button>
                <button
                  onClick={() => setActiveTab('terminal')}
                  className={`px-3 py-1 rounded text-xs font-medium transition ${
                    activeTab === 'terminal'
                      ? 'bg-zinc-800 text-white'
                      : 'text-zinc-400 hover:text-zinc-200'
                  }`}
                >
                  Terminal
                </button>
              </div>

              {viewport.url && activeTab === 'preview' && (
                <div className="flex items-center gap-1.5 text-xs text-zinc-400 font-mono truncate max-w-md">
                  <Lock className="h-3 w-3 text-zinc-500 flex-shrink-0" />
                  <span className="truncate">{viewport.url}</span>
                </div>
              )}
            </div>

            {/* 关键审批提示栏 (Polite, Clear Permission Card) */}
            {approvalRequests.length > 0 && (
              <div className="m-4 p-4 rounded-xl border border-zinc-700 bg-zinc-900/95 shadow-xl flex items-center justify-between animate-fadeIn">
                <div className="flex items-center gap-3">
                  <div className="h-8 w-8 rounded-lg bg-zinc-800 flex items-center justify-center text-zinc-300">
                    <Shield className="h-4 w-4" />
                  </div>
                  <div>
                    <span className="text-xs font-medium text-white block">
                      Permission required to proceed
                    </span>
                    <p className="text-xs text-zinc-400 mt-0.5">
                      {approvalRequests[0].description} ({approvalRequests[0].action})
                    </p>
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  <button
                    onClick={() => handleApproval(approvalRequests[0].id, false)}
                    className="px-3 py-1.5 rounded-lg text-xs font-medium bg-zinc-800 hover:bg-zinc-700 text-zinc-300 transition"
                  >
                    Decline
                  </button>
                  <button
                    onClick={() => handleApproval(approvalRequests[0].id, true)}
                    className="px-3 py-1.5 rounded-lg text-xs font-medium bg-white hover:bg-zinc-200 text-zinc-900 transition"
                  >
                    Allow
                  </button>
                </div>
              </div>
            )}

            {/* 主视窗画布 (Preview or Empty State) */}
            <div className="flex-1 p-6 overflow-y-auto flex flex-col justify-center items-center">
              {activeTab === 'preview' ? (
                viewport.screenshotBase64 ? (
                  <div className="w-full max-w-4xl flex flex-col items-center">
                    <div className="w-full rounded-xl overflow-hidden border border-zinc-800 shadow-xl bg-black">
                      <img
                        src={viewport.screenshotBase64}
                        alt="Browser viewport"
                        className="w-full max-h-[500px] object-contain"
                      />
                    </div>
                    {viewport.title && (
                      <span className="text-xs text-zinc-500 mt-2 font-mono">
                        {viewport.title}
                      </span>
                    )}
                  </div>
                ) : (
                  /* 清爽空白态 (Clean, Calm Prompt Canvas) */
                  <div className="w-full max-w-xl text-center space-y-6">
                    <div className="space-y-2">
                      <h1 className="text-xl font-medium text-white tracking-tight">
                        What can AgtPilot do for you?
                      </h1>
                      <p className="text-xs text-zinc-400 max-w-md mx-auto leading-relaxed">
                        Delegate research, web browsing, data extraction, or sandbox tasks.
                      </p>
                    </div>

                    <div className="grid grid-cols-2 gap-2 text-left">
                      {suggestions.map((s, idx) => (
                        <button
                          key={idx}
                          onClick={() => handleRun(s.prompt, s.title)}
                          className="p-3 rounded-lg border border-zinc-800/80 bg-zinc-900/40 hover:bg-zinc-800/60 hover:border-zinc-700 text-xs transition group"
                        >
                          <span className="font-medium text-zinc-200 group-hover:text-white block">
                            {s.title}
                          </span>
                          <span className="text-[11px] text-zinc-500 mt-1 line-clamp-2 block leading-relaxed">
                            {s.prompt}
                          </span>
                        </button>
                      ))}
                    </div>
                  </div>
                )
              ) : (
                /* 终端日志 (Terminal Output) */
                <div className="w-full max-w-4xl h-full min-h-[460px] rounded-xl border border-zinc-800 bg-[#090a0d] p-4 font-mono text-xs text-zinc-300 overflow-y-auto">
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
            </div>

            {/* 底部输入框 (Claude / Linear Style Input) */}
            <div className="p-4 border-t border-zinc-800/60 bg-[#101217]">
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  handleRun(prompt);
                }}
                className="max-w-3xl mx-auto flex items-center gap-2 bg-[#0d0f12] border border-zinc-700/80 rounded-xl p-2 focus-within:border-zinc-500 transition shadow-sm"
              >
                <input
                  type="text"
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  placeholder="Ask AgtPilot to research, browse, code, or execute a task..."
                  className="flex-1 bg-transparent border-none text-xs text-white placeholder-zinc-500 focus:outline-none px-2"
                />
                <button
                  type="submit"
                  disabled={!prompt.trim() || isSubmitting}
                  className="h-7 w-7 rounded-lg bg-white hover:bg-zinc-200 disabled:opacity-30 text-zinc-900 flex items-center justify-center transition flex-shrink-0"
                >
                  {isSubmitting ? (
                    <RotateCw className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <ArrowUp className="h-3.5 w-3.5" />
                  )}
                </button>
              </form>
            </div>
          </main>
        </div>

        {/* 应用生态抽屉 (Clean Integrations Dialog) */}
        {showIntegrations && (
          <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4">
            <div className="w-full max-w-lg bg-[#14161d] border border-zinc-800 rounded-2xl p-6 shadow-2xl space-y-4">
              <div className="flex items-center justify-between pb-3 border-b border-zinc-800">
                <div>
                  <h3 className="text-sm font-medium text-white">Connected Apps</h3>
                  <p className="text-xs text-zinc-400 mt-0.5">
                    Connect your API keys and accounts to allow AgtPilot to automate workflows.
                  </p>
                </div>
                <button
                  onClick={() => setShowIntegrations(false)}
                  className="text-zinc-400 hover:text-white p-1 rounded-lg"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>

              <div className="max-h-96 overflow-y-auto space-y-2 pr-1">
                {connectors.map((c) => (
                  <div
                    key={c.id}
                    className="p-3 rounded-xl border border-zinc-800/80 bg-zinc-900/40 flex items-center justify-between"
                  >
                    <div className="min-w-0 pr-3">
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-medium text-white">{c.name}</span>
                        <span
                          className={`text-[10px] font-mono px-1.5 py-0.2 rounded ${
                            c.status === 'connected'
                              ? 'bg-zinc-800 text-zinc-300'
                              : 'bg-zinc-900 text-zinc-600'
                          }`}
                        >
                          {c.status === 'connected' ? 'Connected' : 'Not configured'}
                        </span>
                      </div>
                      <p className="text-[11px] text-zinc-400 truncate mt-0.5">{c.description}</p>
                    </div>

                    <button
                      onClick={() => {
                        setConfiguringApp(c);
                        setKeyInput('');
                      }}
                      className="text-xs px-2.5 py-1 rounded-md bg-zinc-800 hover:bg-zinc-700 text-zinc-200 transition font-medium flex-shrink-0"
                    >
                      {c.status === 'connected' ? 'Configure' : 'Connect'}
                    </button>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* 密钥录入弹窗 */}
        {configuringApp && (
          <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-50 p-4">
            <div className="w-full max-w-md bg-[#161820] border border-zinc-800 rounded-2xl p-5 shadow-2xl space-y-4">
              <div className="flex items-center justify-between">
                <h4 className="text-sm font-medium text-white">Configure {configuringApp.name}</h4>
                <button
                  onClick={() => setConfiguringApp(null)}
                  className="text-zinc-400 hover:text-white"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>

              <p className="text-xs text-zinc-400">{configuringApp.description}</p>

              <div>
                <label className="text-[11px] font-mono text-zinc-400 block mb-1">
                  Environment variable: {configuringApp.envVar}
                </label>
                <input
                  type="password"
                  value={keyInput}
                  onChange={(e) => setKeyInput(e.target.value)}
                  placeholder="Enter API key..."
                  className="w-full bg-zinc-900 border border-zinc-700 rounded-lg px-3 py-2 text-xs text-white focus:outline-none focus:border-zinc-500"
                />
              </div>

              <div className="flex justify-end gap-2 pt-2">
                <button
                  onClick={() => setConfiguringApp(null)}
                  className="text-xs text-zinc-400 hover:text-white px-3 py-1.5 rounded-lg"
                >
                  Cancel
                </button>
                <button
                  disabled={!keyInput.trim() || isSavingKey}
                  onClick={handleSaveKey}
                  className="text-xs bg-white hover:bg-zinc-200 disabled:opacity-40 text-zinc-900 font-medium px-4 py-1.5 rounded-lg transition"
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
