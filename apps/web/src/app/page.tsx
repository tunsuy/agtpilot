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
import { GoalsView } from '../components/GoalsView';
import { AuthModal } from '../components/AuthModal';
import { DownloadAppModal } from '../components/DownloadAppModal';
import {
  Compass,
  Cpu,
  Target,
  Clock,
  FileText,
  Brain,
  Layers,
} from 'lucide-react';
import {
  Mission,
  ViewportState,
  TerminalLog,
  ApprovalRequest,
  ArtifactState,
  ConnectorApp,
  MemoryItem,
  CronJobItem,
  GoalItem,
  GoalMilestone,
} from '../types/agent';

export default function Workspace() {
  const [mounted, setMounted] = useState(false);
  const [activeView, setActiveView] = useState<'home' | 'cockpit' | 'goals' | 'connectors' | 'memories' | 'patrol' | 'deliverables'>('home');
  const [rightTab, setRightTab] = useState<'browser' | 'terminal' | 'artifact'>('browser');
  const [authModalOpen, setAuthModalOpen] = useState(false);
  const [authModalTab, setAuthModalTab] = useState<'login' | 'register'>('login');
  const [downloadModalOpen, setDownloadModalOpen] = useState(false);

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

  const handleUpdateCronJob = async (job: { id: string; name: string; pattern: string; prompt: string }) => {
    try {
      const res = await fetch('/api/cron/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'update', ...job }),
      });
      const data = await res.json();
      if (data.jobs) setCronJobs(data.jobs);
    } catch (e) {
      console.error(e);
    }
  };

  const handleTriggerCronJob = async (id: string) => {
    try {
      const res = await fetch('/api/cron/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'trigger', id }),
      });
      const data = await res.json();
      if (data.jobs) setCronJobs(data.jobs);
      setActiveView('cockpit');
    } catch (e) {
      console.error(e);
    }
  };

  // 长期目标与里程碑状态
  const [goals, setGoals] = useState<GoalItem[]>([]);

  const loadGoals = async () => {
    try {
      const res = await fetch('/api/goals');
      const data = await res.json();
      if (data.goals) setGoals(data.goals);
    } catch (e) {
      console.error(e);
    }
  };

  const handleCreateGoal = async (goal: {
    title: string;
    description: string;
    category?: GoalItem['category'];
    targetDate?: string;
    milestones: Array<{ title: string; description?: string; status?: GoalMilestone['status'] }>;
  }) => {
    try {
      const res = await fetch('/api/goals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'create', ...goal }),
      });
      const data = await res.json();
      if (data.goals) setGoals(data.goals);
    } catch (e) {
      console.error(e);
    }
  };

  const handleUpdateGoal = async (goal: {
    id: string;
    title?: string;
    description?: string;
    category?: GoalItem['category'];
    targetDate?: string;
    status?: GoalItem['status'];
    milestones?: GoalMilestone[];
  }) => {
    try {
      const res = await fetch('/api/goals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'update', ...goal }),
      });
      const data = await res.json();
      if (data.goals) setGoals(data.goals);
    } catch (e) {
      console.error(e);
    }
  };

  const handleDeleteGoal = async (id: string) => {
    try {
      const res = await fetch('/api/goals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'delete', id }),
      });
      const data = await res.json();
      if (data.goals) setGoals(data.goals);
    } catch (e) {
      console.error(e);
    }
  };

  const handleToggleMilestone = async (goalId: string, milestoneId: string, status?: GoalMilestone['status']) => {
    try {
      const res = await fetch('/api/goals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'toggle_milestone', goalId, milestoneId, status }),
      });
      const data = await res.json();
      if (data.goals) setGoals(data.goals);
    } catch (e) {
      console.error(e);
    }
  };

  const handleAdvanceMilestone = (goal: GoalItem, milestone: GoalMilestone) => {
    const prompt = `【推进长期目标里程碑】\n目标名称：${goal.title}\n所属领域：${goal.category || '综合'}\n当前阶段：${milestone.title}\n阶段要求与成果：${milestone.description || '按阶段规划推进'}\n\n请作为我的个人超级智能体，围绕此阶段目标为我制定落地行动方案并执行攻坚，产出结构化阶段交付成果。`;
    handleRun(prompt);
    setActiveView('cockpit');
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
      loadGoals();
      loadAgentState();
    } else if (sessionStatus !== 'loading') {
      setConnectors([]);
      setMemories([]);
      setCronJobs([]);
      setGoals([]);
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
  }, [session?.user?.id, sessionStatus]);

  const loadAgentState = async () => {
    try {
      const res = await fetch('/api/agent/state');
      const data = await res.json();
      if (data.state) {
        if (data.state.missions) setMissions(data.state.missions);
        if (data.state.activeMissionId) setActiveMissionId(data.state.activeMissionId);
        if (data.state.viewport) setViewport(data.state.viewport);
        if (data.state.terminalLogs) setTerminalLogs(data.state.terminalLogs);
        if (data.state.approvalRequests) setApprovalRequests(data.state.approvalRequests);
        if (data.state.latestArtifact) setArtifact(data.state.latestArtifact);
      }
    } catch (e) {
      console.error(e);
    }
  };

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

  const handleViewChange = (view: 'home' | 'cockpit' | 'goals' | 'connectors' | 'memories' | 'patrol' | 'deliverables') => {
    // 首页允许所有人浏览概览，其余页面（工作台、连接器、记忆库、巡航、交付库、长期目标）必须登录
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
      <div className="min-h-screen w-full bg-[#fbfbfd] text-zinc-900 font-sans antialiased selection:bg-zinc-200">
        {/* Global Minimalist Topbar */}
        <Navbar
          activeView={activeView}
          onViewChange={handleViewChange}
          currentMission={currentMission}
          connectedCount={connectedCount}
          memoryCount={memories.length}
          patrolCount={cronJobs.filter((j) => j.status === 'active').length}
          goalCount={goals.length}
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
          onOpenDownloadApp={() => setDownloadModalOpen(true)}
        />

        {/* NextAuth Authentication Modal */}
        <AuthModal
          isOpen={authModalOpen}
          onClose={() => setAuthModalOpen(false)}
          initialTab={authModalTab}
        />

        {/* Mobile Download Modal */}
        <DownloadAppModal
          isOpen={downloadModalOpen}
          onClose={() => setDownloadModalOpen(false)}
        />

        {/* Main Content Area */}
        <div className="pt-14 h-full">
          {activeView === 'home' && (
            <main className="min-h-[calc(100vh-3.5rem)] overflow-y-auto">
              <HomeView
                onRunMission={handleRun}
                missions={missions}
                connectors={connectors}
                goals={goals}
                memories={memories}
                cronJobs={cronJobs}
                onSelectModel={handleSetDefaultModel}
                onOpenCockpit={(missionId) => {
                  if (missionId) setActiveMissionId(missionId);
                  handleViewChange('cockpit');
                }}
                onOpenConnectors={() => handleViewChange('connectors')}
                onOpenGoals={() => handleViewChange('goals')}
                onOpenMemories={() => handleViewChange('memories')}
                onOpenPatrol={() => handleViewChange('patrol')}
                onOpenDownloadApp={() => setDownloadModalOpen(true)}
                onOpenAuth={(tab) => {
                  setAuthModalTab(tab);
                  setAuthModalOpen(true);
                }}
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

          {activeView === 'goals' && (
            <main className="min-h-[calc(100vh-3.5rem)] overflow-y-auto pb-16 md:pb-0">
              <GoalsView
                goals={goals}
                onCreateGoal={handleCreateGoal}
                onUpdateGoal={handleUpdateGoal}
                onDeleteGoal={handleDeleteGoal}
                onToggleMilestone={handleToggleMilestone}
                onAdvanceMilestone={handleAdvanceMilestone}
              />
            </main>
          )}

          {activeView === 'connectors' && (
            <main className="min-h-[calc(100vh-3.5rem)] overflow-y-auto pb-16 md:pb-0">
              <ConnectorsView
                connectors={connectors}
                onSaveKey={handleSaveKey}
                onSetDefaultModel={handleSetDefaultModel}
              />
            </main>
          )}

          {activeView === 'memories' && (
            <main className="min-h-[calc(100vh-3.5rem)] overflow-y-auto pb-16 md:pb-0">
              <MemoriesView
                memories={memories}
                onAddMemory={handleAddMemory}
                onDeleteMemory={handleDeleteMemory}
              />
            </main>
          )}

          {activeView === 'patrol' && (
            <main className="min-h-[calc(100vh-3.5rem)] overflow-y-auto pb-16 md:pb-0">
              <CronJobsView
                jobs={cronJobs}
                onCreateJob={handleCreateCronJob}
                onUpdateJob={handleUpdateCronJob}
                onToggleJob={handleToggleCronJob}
                onDeleteJob={handleDeleteCronJob}
                onTriggerJob={handleTriggerCronJob}
              />
            </main>
          )}

          {activeView === 'deliverables' && (
            <main className="min-h-[calc(100vh-3.5rem)] overflow-y-auto pb-16 md:pb-0">
              <DeliverablesView
                artifact={artifact}
                missions={missions}
                onOpenCockpit={() => setActiveView('cockpit')}
                onRunMission={handleRun}
              />
            </main>
          )}
        </div>

        {/* 移动端沉浸式原生底部导航栏 (Mobile App Tab Bar, 仅在 md 以下小屏幕常驻) */}
        <div className="md:hidden fixed bottom-0 inset-x-0 h-14 bg-white/95 backdrop-blur-md border-t border-zinc-200/80 z-40 flex items-center justify-around px-2 select-none shadow-[0_-4px_20px_rgba(0,0,0,0.04)]">
          <button
            onClick={() => handleViewChange('home')}
            className={`flex flex-col items-center justify-center flex-1 py-1 transition ${
              activeView === 'home' ? 'text-zinc-900 font-bold' : 'text-zinc-400 hover:text-zinc-600'
            }`}
          >
            <Compass className="h-4 w-4" />
            <span className="text-[10px] mt-0.5">首页</span>
          </button>

          <button
            onClick={() => handleViewChange('cockpit')}
            className={`relative flex flex-col items-center justify-center flex-1 py-1 transition ${
              activeView === 'cockpit' ? 'text-zinc-900 font-bold' : 'text-zinc-400 hover:text-zinc-600'
            }`}
          >
            <Cpu className="h-4 w-4" />
            <span className="text-[10px] mt-0.5">工作台</span>
            {missions.some((m) => m.status === 'ACTIVE') && (
              <span className="absolute top-1 right-1/4 h-1.5 w-1.5 rounded-full bg-blue-600 animate-ping" />
            )}
          </button>

          <button
            onClick={() => handleViewChange('goals')}
            className={`flex flex-col items-center justify-center flex-1 py-1 transition ${
              activeView === 'goals' ? 'text-zinc-900 font-bold' : 'text-zinc-400 hover:text-zinc-600'
            }`}
          >
            <Target className="h-4 w-4" />
            <span className="text-[10px] mt-0.5">目标</span>
          </button>

          <button
            onClick={() => handleViewChange('deliverables')}
            className={`flex flex-col items-center justify-center flex-1 py-1 transition ${
              activeView === 'deliverables' ? 'text-zinc-900 font-bold' : 'text-zinc-400 hover:text-zinc-600'
            }`}
          >
            <FileText className="h-4 w-4" />
            <span className="text-[10px] mt-0.5">交付库</span>
          </button>

          <button
            onClick={() => handleViewChange('connectors')}
            className={`flex flex-col items-center justify-center flex-1 py-1 transition ${
              activeView === 'connectors' ? 'text-zinc-900 font-bold' : 'text-zinc-400 hover:text-zinc-600'
            }`}
          >
            <Layers className="h-4 w-4" />
            <span className="text-[10px] mt-0.5">连接器</span>
          </button>
        </div>
      </div>
    </CopilotKit>
  );
}
