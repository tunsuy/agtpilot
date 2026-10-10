'use client';

import { useState, useEffect, useRef } from 'react';
import { useSession, signOut } from 'next-auth/react';
import { CopilotKit } from '@copilotkit/react-core';
import { Navbar } from '../components/Navbar';
import { HomeView } from '../components/HomeView';
import { CockpitView } from '../components/CockpitView';
import { ConnectorsView } from '../components/ConnectorsView';
import { WorkshopsView } from '../components/workshops/WorkshopsView';
import { DeliverablesView } from '../components/DeliverablesView';
import { MemoriesView } from '../components/MemoriesView';
import { CronJobsView } from '../components/CronJobsView';
import { GoalsView } from '../components/GoalsView';
import { AuthModal } from '../components/AuthModal';
import { DownloadAppModal } from '../components/DownloadAppModal';
import { useIsMobile } from '../components/mobile/useIsMobile';
import { MobileTabBar, MobileTab } from '../components/mobile/MobileTabBar';
import { MobileHomeView } from '../components/mobile/MobileHomeView';
import { MobileActivityView } from '../components/mobile/MobileActivityView';
import { MobileProfileView } from '../components/mobile/MobileProfileView';
import {
  ChevronLeft,
} from 'lucide-react';
import {
  Mission,
  ViewportState,
  TerminalLog,
  ApprovalRequest,
  ConnectorSuggestion,
  ArtifactState,
  ConnectorApp,
  MemoryItem,
  CronJobItem,
  GoalItem,
  GoalMilestone,
} from '../types/agent';

export default function Workspace() {
  const [mounted, setMounted] = useState(false);
  const { isMobile, mounted: mobileReady } = useIsMobile();
  const [activeView, setActiveView] = useState<'home' | 'cockpit' | 'workshops' | 'goals' | 'connectors' | 'memories' | 'patrol' | 'deliverables'>('home');
  // 移动端专属状态：底部 tab + 全屏覆盖层（复用桌面视图做"更多"入口）
  const [mobileTab, setMobileTab] = useState<MobileTab>('home');
  const [mobileOverlay, setMobileOverlay] = useState<'goals' | 'connectors' | 'memories' | 'patrol' | 'workshops' | null>(null);
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
  const [connectorSuggestions, setConnectorSuggestions] = useState<ConnectorSuggestion[]>([]);
  // 中途授权（粘贴凭证类）：跳到连接器中心并自动打开对应配置弹窗
  const [mcpAutoConfigure, setMcpAutoConfigure] = useState<string | null>(null);
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

  // 任务中途授权卡片：oauth → 直接跳一键授权；token → 连接器中心自动打开配置弹窗
  const handleConnectorAuthorize = (s: ConnectorSuggestion) => {
    if (s.authType === 'oauth' && s.authorizeUrl) {
      window.location.href = s.authorizeUrl;
      return;
    }
    setMcpAutoConfigure(s.connectorId);
    setActiveView('connectors');
    setMobileOverlay('connectors');
  };

  const handleSkipConnectorSuggestion = async (s: ConnectorSuggestion) => {
    setConnectorSuggestions((prev) => prev.filter((x) => x.id !== s.id));
    try {
      await fetch('/api/connectors/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'skipSuggestion', connectorId: s.connectorId }),
      });
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

  const handleRun = async (text: string, title?: string, targetMissionId?: string | null) => {
    if (!text.trim() || isSubmitting) return;

    // 检查登录状态：未登录用户直接拦截并弹出登录弹窗
    if (sessionStatus !== 'loading' && !session?.user) {
      setAuthModalTab('login');
      setAuthModalOpen(true);
      return;
    }

    setIsSubmitting(true);
    setActiveView('cockpit');
    setMobileTab('activity');

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
      setConnectorSuggestions([]);
      setArtifact(null);
    }
    // 检查 URL 参数（如 OAuth 回调后跳转、PWA 快捷方式/推送通知深链）
    if (typeof window !== 'undefined') {
      const urlParams = new URLSearchParams(window.location.search);
      const tab = urlParams.get('tab');
      if (tab === 'connectors') {
        setActiveView('connectors');
      } else if (tab === 'workshops') {
        setActiveView('workshops');
      } else if (tab === 'home' || tab === 'deliverables' || tab === 'activity' || tab === 'profile') {
        setMobileTab(tab);
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
        if (data.state.connectorSuggestions) setConnectorSuggestions(data.state.connectorSuggestions);
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
        if (state.connectorSuggestions) setConnectorSuggestions(state.connectorSuggestions);
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
        setMobileTab('activity');
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

    // 流式增量（打字机）：按 taskId 定位 mission，从尾向前找 RUNNING 的
    // live step（step_live_ 前缀）按 kind 追加 answer / reasoning；边界
    // mission_updated 与 delta 在同一 SSE 连接上有序（后端先 flush 再广播
    // 边界），两种流不会交错错位。找不到 live step 时前端兜底创建。
    eventSource.addEventListener('assistant_delta', (e: MessageEvent) => {
      try {
        const { taskId, segments } = JSON.parse(e.data);
        if (!taskId || !Array.isArray(segments) || segments.length === 0) return;
        setMissions((prev) =>
          prev.map((m) => {
            if (m.id !== taskId) return m;
            const steps = [...m.steps];
            let applied = false;
            for (let i = steps.length - 1; i >= 0; i--) {
              const st = steps[i];
              if (st.id?.startsWith('step_live_') && st.status === 'RUNNING' && st.role === 'assistant') {
                const next = { ...st };
                for (const seg of segments) {
                  if (seg.kind === 'reasoning') {
                    next.reasoning = (next.reasoning || '') + String(seg.delta || '');
                  } else {
                    next.answer = (next.answer || '') + String(seg.delta || '');
                    next.title = '正在处理…';
                  }
                }
                steps[i] = next;
                applied = true;
                break;
              }
            }
            if (!applied) {
              // 兜底：后端 live step 尚未随 mission_updated 到达（如 SSE 重连初期）
              const fallback = {
                id: `step_live_${taskId}_fe_${Date.now()}`,
                role: 'assistant' as const,
                messageKind: 'progress' as const,
                title: '正在处理…',
                status: 'RUNNING' as const,
                answer: '',
                reasoning: '',
                startedAt: Date.now(),
              };
              for (const seg of segments) {
                if (seg.kind === 'reasoning') {
                  fallback.reasoning = (fallback.reasoning || '') + String(seg.delta || '');
                } else {
                  fallback.answer = (fallback.answer || '') + String(seg.delta || '');
                }
              }
              steps.push(fallback);
            }
            return { ...m, steps };
          })
        );
      } catch (err) {
        console.error(err);
      }
    });

    eventSource.addEventListener('approval_requested', (e: MessageEvent) => {
      try {
        const req: ApprovalRequest = JSON.parse(e.data);
        setApprovalRequests((prev) => [...prev.filter((r) => r.id !== req.id), req]);
        setActiveView('cockpit');
        setMobileTab('activity');
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

    // 任务中途连接器授权建议：弹卡片等用户一键授权/跳过
    eventSource.addEventListener('connector_suggested', (e: MessageEvent) => {
      try {
        const s: ConnectorSuggestion = JSON.parse(e.data);
        setConnectorSuggestions((prev) => [...prev.filter((x) => x.id !== s.id), s]);
        setActiveView('cockpit');
        setMobileTab('activity');
      } catch (err) {
        console.error(err);
      }
    });

    eventSource.addEventListener('connector_suggestion_resolved', (e: MessageEvent) => {
      try {
        const { id } = JSON.parse(e.data);
        setConnectorSuggestions((prev) => prev.filter((x) => x.id !== id));
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

    // 记忆库更新（会话结束自动沉淀新记忆）：静默刷新记忆列表
    eventSource.addEventListener('memories_updated', (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data);
        if (session?.user?.id && data?.userId === session.user.id) {
          loadMemories();
        }
      } catch (err) {
        console.error(err);
      }
    });

    return () => {
      eventSource.close();
    };
  }, [session?.user?.id]);

  const handleViewChange = (view: 'home' | 'cockpit' | 'workshops' | 'goals' | 'connectors' | 'memories' | 'patrol' | 'deliverables') => {
    // 首页允许所有人浏览概览，其余页面（工作台、工坊、连接器、记忆库、巡航、交付库、长期目标）必须登录
    if (view !== 'home' && sessionStatus !== 'loading' && !session?.user) {
      setAuthModalTab('login');
      setAuthModalOpen(true);
      return;
    }
    setActiveView(view);
  };

  const currentMission = missions.find((m) => m.id === activeMissionId) || missions[0] || null;
  const connectedCount = connectors.filter((c) => c.status === 'connected').length;

  if (!mounted || !mobileReady) return null;

  const isLoggedIn = Boolean(session?.user);
  const userName = (session?.user?.name as string) || null;
  const userEmail = (session?.user?.email as string) || null;
  const userAvatar = ((session?.user as any)?.image as string) || null;
  const hasActiveMission = missions.some((m) => m.status === 'ACTIVE');

  // ============ 移动端专属布局：遥控器 + 收件箱 ============
  if (isMobile) {
    const openAuth = (tab: 'login' | 'register') => {
      setAuthModalTab(tab);
      setAuthModalOpen(true);
    };

    // 全屏覆盖层里复用的桌面视图（做"更多"入口），带返回条
    const renderOverlay = () => {
      if (!mobileOverlay) return null;
      const titles: Record<string, string> = {
        goals: '长期目标',
        connectors: '连接器',
        memories: '记忆库',
        patrol: '定时巡航',
        workshops: '工坊',
      };
      return (
        <div className="fixed inset-0 z-40 bg-[#fbfbfd] flex flex-col">
          <header
            className="h-13 shrink-0 relative flex items-center px-2 bg-white/92 backdrop-blur-lg border-b border-zinc-200/70"
            style={{ paddingTop: 'env(safe-area-inset-top, 0px)', height: 'calc(3.25rem + env(safe-area-inset-top, 0px))' }}
          >
            <button
              type="button"
              onClick={() => setMobileOverlay(null)}
              className="h-9 px-2 -ml-1 flex items-center gap-0.5 text-sm text-zinc-600 active:text-zinc-900 transition z-10"
            >
              <ChevronLeft className="h-5 w-5" /> 返回
            </button>
            <span className="absolute left-1/2 -translate-x-1/2 text-sm font-semibold text-zinc-900 truncate px-12">
              {titles[mobileOverlay]}
            </span>
          </header>
          <div className="flex-1 overflow-y-auto">
            {mobileOverlay === 'goals' && (
              <GoalsView
                goals={goals}
                onCreateGoal={handleCreateGoal}
                onUpdateGoal={handleUpdateGoal}
                onDeleteGoal={handleDeleteGoal}
                onToggleMilestone={handleToggleMilestone}
                onAdvanceMilestone={handleAdvanceMilestone}
              />
            )}
            {mobileOverlay === 'connectors' && (
              <ConnectorsView
                connectors={connectors}
                onSaveKey={handleSaveKey}
                onSetDefaultModel={handleSetDefaultModel}
                autoConfigureId={mcpAutoConfigure}
                onAutoConfigureHandled={() => setMcpAutoConfigure(null)}
              />
            )}
            {mobileOverlay === 'workshops' && (
              <WorkshopsView
                connectors={connectors}
                onRunPrompt={(prompt, title) => {
                  handleRun(prompt, title, null);
                  // 任务发起后回到活动页看执行流,关闭工坊覆盖层
                  setMobileOverlay(null);
                }}
                onOpenConnectors={() => setMobileOverlay('connectors')}
              />
            )}
            {mobileOverlay === 'memories' && (
              <MemoriesView
                memories={memories}
                onAddMemory={handleAddMemory}
                onDeleteMemory={handleDeleteMemory}
              />
            )}
            {mobileOverlay === 'patrol' && (
              <CronJobsView
                jobs={cronJobs}
                onCreateJob={handleCreateCronJob}
                onUpdateJob={handleUpdateCronJob}
                onToggleJob={handleToggleCronJob}
                onDeleteJob={handleDeleteCronJob}
                onTriggerJob={handleTriggerCronJob}
              />
            )}
          </div>
        </div>
      );
    };

    return (
      <CopilotKit runtimeUrl="/api/copilotkit" showDevConsole={false}>
        <div className="min-h-[100dvh] w-full bg-[#fbfbfd] text-zinc-900 font-sans antialiased selection:bg-zinc-200">
          <AuthModal isOpen={authModalOpen} onClose={() => setAuthModalOpen(false)} initialTab={authModalTab} />
          <DownloadAppModal isOpen={downloadModalOpen} onClose={() => setDownloadModalOpen(false)} />

          {!mobileOverlay && (
            <>
              {mobileTab === 'home' && (
                <MobileHomeView
                  missions={missions}
                  isSubmitting={isSubmitting}
                  userName={userName}
                  isLoggedIn={isLoggedIn}
                  approvalCount={approvalRequests.length}
                  onRunMission={handleRun}
                  onStopMission={handleStopMission}
                  onOpenMission={(id) => {
                    setActiveMissionId(id);
                    setMobileTab('activity');
                  }}
                  onOpenApprovals={() => setMobileTab('activity')}
                  onRequireLogin={() => openAuth('login')}
                />
              )}

              {mobileTab === 'deliverables' && (
                <div className="pb-16">
                  <DeliverablesView
                    artifact={artifact}
                    missions={missions}
                    variant="mobile"
                    onOpenCockpit={() => setMobileTab('activity')}
                    onRunMission={handleRun}
                  />
                </div>
              )}

              {mobileTab === 'activity' && (
                <MobileActivityView
                  missions={missions}
                  activeMissionId={activeMissionId}
                  onSelectMission={setActiveMissionId}
                  approvalRequests={approvalRequests}
                  onApproval={handleApproval}
                  connectorSuggestions={connectorSuggestions}
                  onConnectorAuthorize={handleConnectorAuthorize}
                  onSkipConnectorSuggestion={handleSkipConnectorSuggestion}
                  terminalLogs={terminalLogs}
                />
              )}

              {mobileTab === 'profile' && (
                <MobileProfileView
                  userName={userName}
                  userEmail={userEmail}
                  userAvatar={userAvatar}
                  isLoggedIn={isLoggedIn}
                  goals={goals}
                  cronJobs={cronJobs}
                  connectors={connectors}
                  memoryCount={memories.length}
                  onToggleCronJob={handleToggleCronJob}
                  onTriggerCronJob={handleTriggerCronJob}
                  onOpenFullView={(v) => {
                    if (!isLoggedIn) {
                      openAuth('login');
                      return;
                    }
                    setMobileOverlay(v);
                  }}
                  onOpenAuth={openAuth}
                  onLogout={() => signOut()}
                />
              )}

              <MobileTabBar
                activeTab={mobileTab}
                onChange={setMobileTab}
                approvalCount={approvalRequests.length}
                hasActiveMission={hasActiveMission}
              />
            </>
          )}

          {renderOverlay()}
        </div>
      </CopilotKit>
    );
  }

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
              connectorSuggestions={connectorSuggestions}
              onConnectorAuthorize={handleConnectorAuthorize}
              onSkipConnectorSuggestion={handleSkipConnectorSuggestion}
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

          {activeView === 'workshops' && (
            <main className="min-h-[calc(100vh-3.5rem)] overflow-y-auto pb-16 md:pb-0">
              <WorkshopsView
                connectors={connectors}
                onRunPrompt={(prompt, title) => handleRun(prompt, title, null)}
                onOpenConnectors={() => handleViewChange('connectors')}
              />
            </main>
          )}

          {activeView === 'connectors' && (
            <main className="min-h-[calc(100vh-3.5rem)] overflow-y-auto pb-16 md:pb-0">
              <ConnectorsView
                connectors={connectors}
                onSaveKey={handleSaveKey}
                onSetDefaultModel={handleSetDefaultModel}
                autoConfigureId={mcpAutoConfigure}
                onAutoConfigureHandled={() => setMcpAutoConfigure(null)}
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
      </div>
    </CopilotKit>
  );
}
