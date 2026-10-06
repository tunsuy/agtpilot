'use client';

import { useState, useEffect } from 'react';
import { useSession } from 'next-auth/react';
import { CopilotKit } from '@copilotkit/react-core';
import { Navbar } from '../components/Navbar';
import { HomeView } from '../components/HomeView';
import { CockpitView } from '../components/CockpitView';
import { ConnectorsView } from '../components/ConnectorsView';
import { DeliverablesView } from '../components/DeliverablesView';
import { MemoriesView } from '../components/MemoriesView';
import { CronJobsView } from '../components/CronJobsView';
import { AuthModal } from '../components/AuthModal';
import {
  Mission,
  ViewportState,
  TerminalLog,
  ApprovalRequest,
  ArtifactState,
  ConnectorApp,
  MemoryItem,
  CronJobItem,
} from '../types/agent';

export default function Workspace() {
  const [mounted, setMounted] = useState(false);
  const [activeView, setActiveView] = useState<'home' | 'cockpit' | 'connectors' | 'memories' | 'patrol' | 'deliverables'>('home');
  const [rightTab, setRightTab] = useState<'browser' | 'terminal' | 'artifact'>('browser');
  const [authModalOpen, setAuthModalOpen] = useState(false);
  const [authModalTab, setAuthModalTab] = useState<'login' | 'register'>('login');

  // Agent 实时状态流
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

  // 连接器状态
  const [connectors, setConnectors] = useState<ConnectorApp[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // 长效记忆状态
  const [memories, setMemories] = useState<MemoryItem[]>([]);

  const loadMemories = async () => {
    try {
      const res = await fetch('/api/memories');
      const data = await res.json();
      if (data.memories) setMemories(data.memories);
    } catch (e) {
      console.error(e);
    }
  };

  const handleAddMemory = async (memory: { title: string; content: string; category: MemoryItem['category'] }) => {
    try {
      const res = await fetch('/api/memories', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'add', memory }),
      });
      const data = await res.json();
      if (data.memories) setMemories(data.memories);
    } catch (e) {
      console.error(e);
    }
  };

  const handleDeleteMemory = async (id: string) => {
    try {
      const res = await fetch('/api/memories', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'delete', id }),
      });
      const data = await res.json();
      if (data.memories) setMemories(data.memories);
    } catch (e) {
      console.error(e);
    }
  };

  // 主动巡航 Cron Jobs 状态
  const [cronJobs, setCronJobs] = useState<CronJobItem[]>([]);

  const loadCronJobs = async () => {
    try {
      const res = await fetch('/api/cron/jobs');
      const data = await res.json();
      if (data.jobs) setCronJobs(data.jobs);
    } catch (e) {
      console.error(e);
    }
  };

  const handleCreateCronJob = async (job: { name: string; pattern: string; prompt: string }) => {
    try {
      const res = await fetch('/api/cron/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'create', ...job }),
      });
      const data = await res.json();
      if (data.jobs) setCronJobs(data.jobs);
    } catch (e) {
      console.error(e);
    }
  };

  const handleToggleCronJob = async (id: string) => {
    try {
      const res = await fetch('/api/cron/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'toggle', id }),
      });
      const data = await res.json();
      if (data.jobs) setCronJobs(data.jobs);
    } catch (e) {
      console.error(e);
    }
  };

  const handleDeleteCronJob = async (id: string) => {
    try {
      const res = await fetch('/api/cron/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'cancel', id }),
      });
      const data = await res.json();
      if (data.jobs) setCronJobs(data.jobs);
    } catch (e) {
      console.error(e);
    }
  };

  const loadConnectors = async () => {
    try {
      const res = await fetch('/api/connectors');
      const data = await res.json();
      if (data.connectors) setConnectors(data.connectors);
    } catch (e) {
      console.error(e);
    }
  };

  const handleSaveKey = async (
    envVar: string,
    value: string,
    extra?: { baseUrl?: string; baseUrlEnvVar?: string; modelName?: string; modelNameEnvVar?: string }
  ) => {
    try {
      const payload: any = extra
        ? {
            action: 'saveConnectorConfig',
            envVar,
            value,
            baseUrl: extra.baseUrl,
            baseUrlEnvVar: extra.baseUrlEnvVar,
            modelName: extra.modelName,
            modelNameEnvVar: extra.modelNameEnvVar,
          }
        : { envVar, value };

      const res = await fetch('/api/connectors', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (data.connectors) setConnectors(data.connectors);
    } catch (e) {
      console.error(e);
    }
  };

  const handleSetDefaultModel = async (modelId: string) => {
    try {
      const res = await fetch('/api/connectors', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'setDefaultModel', modelId }),
      });
      const data = await res.json();
      if (data.connectors) setConnectors(data.connectors);
    } catch (e) {
      console.error(e);
    }
  };

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

  const handleStopMission = async (missionId: string) => {
    try {
      await fetch('/api/agent/stop', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ missionId }),
      });
    } catch (err) {
      console.error(err);
    }
  };

  const { data: session, status: sessionStatus } = useSession();

  const handleRun = async (text: string, title?: string, targetMissionId?: string) => {
    if (!text.trim() || isSubmitting) return;

    // 检查登录状态：未登录用户直接拦截并弹出登录弹窗
    if (sessionStatus !== 'loading' && !session?.user) {
      setAuthModalTab('login');
      setAuthModalOpen(true);
      return;
    }

    setIsSubmitting(true);
    setActiveView('cockpit');

    // 如果指定了 targetMissionId，或者当前正处于某会话且不是全新发起的，则沿用该会话
    const missionId = targetMissionId !== undefined ? targetMissionId : activeMissionId || undefined;

    try {
      await fetch('/api/agent/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: text.trim(), title, missionId }),
      });
    } catch (e) {
      console.error(e);
    } finally {
      setIsSubmitting(false);
    }
  };

  useEffect(() => {
    setMounted(true);

    if (session?.user?.id) {
      loadConnectors();
      loadMemories();
      loadCronJobs();
    } else {
      setConnectors([]);
      setMemories([]);
      setCronJobs([]);
      setMissions([]);
      setActiveMissionId(null);
      setTerminalLogs([]);
      setApprovalRequests([]);
      setArtifact(null);
    }

    // 检查 URL 参数（如 OAuth 回调后跳转）
    if (typeof window !== 'undefined') {
      const urlParams = new URLSearchParams(window.location.search);
      if (urlParams.get('tab') === 'connectors') {
        setActiveView('connectors');
      }
    }
  }, [session?.user?.id]);

  useEffect(() => {
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
        setActiveView('cockpit');
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
        setActiveView('cockpit');
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
  }, [session?.user?.id]);

  const handleViewChange = (view: 'home' | 'cockpit' | 'connectors' | 'memories' | 'patrol' | 'deliverables') => {
    // 首页允许所有人浏览概览，其余页面（工作台、连接器、记忆库、巡航、交付库）必须登录
    if (view !== 'home' && sessionStatus !== 'loading' && !session?.user) {
      setAuthModalTab('login');
      setAuthModalOpen(true);
      return;
    }
    setActiveView(view);
  };

  const currentMission = missions.find((m) => m.id === activeMissionId) || missions[0] || null;
  const connectedCount = connectors.filter((c) => c.status === 'connected').length;

  if (!mounted) return null;

  return (
    <CopilotKit runtimeUrl="/api/copilotkit" showDevConsole={false}>
      <div className="min-h-screen w-screen bg-[#fbfbfd] text-zinc-900 font-sans antialiased selection:bg-zinc-200">
        {/* Global Minimalist Topbar */}
        <Navbar
          activeView={activeView}
          onViewChange={handleViewChange}
          currentMission={currentMission}
          connectedCount={connectedCount}
          memoryCount={memories.length}
          patrolCount={cronJobs.filter((j) => j.status === 'active').length}
          approvalRequests={approvalRequests}
          hasArtifact={Boolean(artifact)}
          onNewMission={() => {
            if (sessionStatus !== 'loading' && !session?.user) {
              setAuthModalTab('login');
              setAuthModalOpen(true);
              return;
            }
            setActiveView('home');
          }}
          onOpenAuth={(tab) => {
            setAuthModalTab(tab);
            setAuthModalOpen(true);
          }}
        />

        {/* NextAuth Authentication Modal */}
        <AuthModal
          isOpen={authModalOpen}
          onClose={() => setAuthModalOpen(false)}
          initialTab={authModalTab}
        />

        {/* Main Content Area */}
        <div className="pt-14 h-full">
          {activeView === 'home' && (
            <main className="min-h-[calc(100vh-3.5rem)] overflow-y-auto">
              <HomeView
                onRunMission={handleRun}
                missions={missions}
                connectors={connectors}
                onSelectModel={handleSetDefaultModel}
                onOpenCockpit={(missionId) => {
                  if (missionId) setActiveMissionId(missionId);
                  handleViewChange('cockpit');
                }}
                onOpenConnectors={() => handleViewChange('connectors')}
              />
            </main>
          )}

          {activeView === 'cockpit' && (
            <CockpitView
              missions={missions}
              activeMissionId={activeMissionId}
              onSelectMission={(id) => setActiveMissionId(id)}
              viewport={viewport}
              terminalLogs={terminalLogs}
              approvalRequests={approvalRequests}
              onApproval={handleApproval}
              artifact={artifact}
              rightTab={rightTab}
              onRightTabChange={setRightTab}
              onRunMission={handleRun}
              onStopMission={handleStopMission}
              onNewSession={() => setActiveMissionId(null)}
              isSubmitting={isSubmitting}
              connectors={connectors}
              onSelectModel={handleSetDefaultModel}
            />
          )}

          {activeView === 'connectors' && (
            <main className="min-h-[calc(100vh-3.5rem)] overflow-y-auto">
              <ConnectorsView
                connectors={connectors}
                onSaveKey={handleSaveKey}
                onSetDefaultModel={handleSetDefaultModel}
              />
            </main>
          )}

          {activeView === 'memories' && (
            <main className="min-h-[calc(100vh-3.5rem)] overflow-y-auto">
              <MemoriesView
                memories={memories}
                onAddMemory={handleAddMemory}
                onDeleteMemory={handleDeleteMemory}
              />
            </main>
          )}

          {activeView === 'patrol' && (
            <main className="min-h-[calc(100vh-3.5rem)] overflow-y-auto">
              <CronJobsView
                jobs={cronJobs}
                onCreateJob={handleCreateCronJob}
                onToggleJob={handleToggleCronJob}
                onDeleteJob={handleDeleteCronJob}
              />
            </main>
          )}

          {activeView === 'deliverables' && (
            <main className="min-h-[calc(100vh-3.5rem)] overflow-y-auto">
              <DeliverablesView
                artifact={artifact}
                missions={missions}
                onOpenCockpit={() => setActiveView('cockpit')}
                onRunMission={handleRun}
              />
            </main>
          )}
        </div>
      </div>
    </CopilotKit>
  );
}
