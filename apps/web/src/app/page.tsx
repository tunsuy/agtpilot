'use client';

import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import dynamic from 'next/dynamic';
import { useSession, signOut } from 'next-auth/react';
import { Navbar } from '../components/Navbar';
import { HomeView } from '../components/HomeView';
import type { WorkshopRunPayload } from '../components/workshops/run';
import { useIsMobile } from '../components/mobile/useIsMobile';
import { findLiveStep } from '../lib/live-steps';
import { isZombieSse } from '../lib/sse-liveness';
import { MobileTabBar, MobileTab } from '../components/mobile/MobileTabBar';
import { MobileHomeView } from '../components/mobile/MobileHomeView';

// 非首屏视图全部懒加载：首页只下载 HomeView，其余视图/弹窗在用户切到时才按需拉取。
// 这是首屏瘦身的核心——此前后台代码与工坊提示词、qrcode、react-markdown 等
// 全部静态打进 / 的首屏 bundle。改 '#662' 时请保持 named export 的 .then 取法。
const CockpitView = dynamic(
  () => import('../components/CockpitView').then((m) => m.CockpitView),
  { ssr: false, loading: ViewLoading }
);
const ConnectorsView = dynamic(
  () => import('../components/ConnectorsView').then((m) => m.ConnectorsView),
  { ssr: false }
);
const WorkshopsView = dynamic(
  () => import('../components/workshops/WorkshopsView').then((m) => m.WorkshopsView),
  { ssr: false }
);
const DeliverablesView = dynamic(
  () => import('../components/DeliverablesView').then((m) => m.DeliverablesView),
  { ssr: false }
);
const MemoriesView = dynamic(
  () => import('../components/MemoriesView').then((m) => m.MemoriesView),
  { ssr: false }
);
const CronJobsView = dynamic(
  () => import('../components/CronJobsView').then((m) => m.CronJobsView),
  { ssr: false }
);
const SkillsView = dynamic(
  () => import('../components/SkillsView').then((m) => m.SkillsView),
  { ssr: false }
);
const GoalsView = dynamic(
  () => import('../components/GoalsView').then((m) => m.GoalsView),
  { ssr: false }
);
const DevicesView = dynamic(
  () => import('../components/DevicesView').then((m) => m.DevicesView),
  { ssr: false }
);
const AuthModal = dynamic(
  () => import('../components/AuthModal').then((m) => m.AuthModal),
  { ssr: false }
);
const DownloadAppModal = dynamic(
  () => import('../components/DownloadAppModal').then((m) => m.DownloadAppModal),
  { ssr: false }
);
const ChannelModal = dynamic(
  () => import('../components/ChannelModal').then((m) => m.ChannelModal),
  { ssr: false }
);
const MobileActivityView = dynamic(
  () => import('../components/mobile/MobileActivityView').then((m) => m.MobileActivityView),
  { ssr: false }
);
const MobileProfileView = dynamic(
  () => import('../components/mobile/MobileProfileView').then((m) => m.MobileProfileView),
  { ssr: false }
);
import {
  ChevronLeft,
} from 'lucide-react';
import {
  Mission,
  ViewportState,
  TerminalLog,
  ApprovalRequest,
  ConnectorSuggestion,
  PendingQuestion,
  ArtifactState,
  ConnectorApp,
  MemoryItem,
  CronJobItem,
  CronRunMeta,
  GoalItem,
  GoalMilestone,
} from '../types/agent';
import { isCronMission, toCronRunMeta, toWireMission } from '../lib/mission-wire';
import type { CronScenario } from '../lib/cron-scenario';

export default function Workspace() {
  const [mounted, setMounted] = useState(false);
  const { isMobile, mounted: mobileReady } = useIsMobile();
  const [activeView, setActiveView] = useState<'home' | 'cockpit' | 'workshops' | 'goals' | 'connectors' | 'memories' | 'skills' | 'patrol' | 'deliverables' | 'devices'>('home');
  // 移动端专属状态：底部 tab + 全屏覆盖层（复用桌面视图做"更多"入口）
  const [mobileTab, setMobileTab] = useState<MobileTab>('home');
  const [mobileOverlay, setMobileOverlay] = useState<'goals' | 'connectors' | 'memories' | 'skills' | 'patrol' | 'workshops' | null>(null);
  const [rightTab, setRightTab] = useState<'browser' | 'terminal' | 'artifact' | 'activity'>('browser');
  const [authModalOpen, setAuthModalOpen] = useState(false);
  const [authModalTab, setAuthModalTab] = useState<'login' | 'register'>('login');
  const [downloadModalOpen, setDownloadModalOpen] = useState(false);
  const [channelModalOpen, setChannelModalOpen] = useState(false);

  // Agent 实时状态流
  const [missions, setMissions] = useState<Mission[]>([]);
  const [activeMissionId, setActiveMissionId] = useState<string | null>(null);
  // 推送深链指定的 mission（/?tab=activity&mission=<id>）：等 missions 列表加载到该 id 才选中，
  // 规避 loadAgentState / SSE init 稍后回写 activeMissionId 覆盖深链目标
  const [deepLinkMissionId, setDeepLinkMissionId] = useState<string | null>(null);
  // 会话 ↔ 设备任务互跳:驾驶舱会话卡 chip 跳设备页时要自动展开的 runner 任务
  const [runnerFocusTaskId, setRunnerFocusTaskId] = useState<string | null>(null);
  const [viewport, setViewport] = useState<ViewportState>({
    activeTab: 'browser',
    url: 'about:blank',
    title: 'Ready',
    status: 'idle',
  });
  const [terminalLogs, setTerminalLogs] = useState<TerminalLog[]>([]);
  const [approvalRequests, setApprovalRequests] = useState<ApprovalRequest[]>([]);
  const [connectorSuggestions, setConnectorSuggestions] = useState<ConnectorSuggestion[]>([]);
  // ask_user 问题卡(模糊需求先问后猜):点选项/输入回答后任务原地续跑
  const [pendingQuestions, setPendingQuestions] = useState<PendingQuestion[]>([]);
  // 中途授权（粘贴凭证类）：跳到连接器中心并自动打开对应配置弹窗
  const [mcpAutoConfigure, setMcpAutoConfigure] = useState<string | null>(null);
  // 工坊依赖点跳转:要定位的连接器标识(进连接器页后填入搜索框,随即清空)
  const [connectorLocate, setConnectorLocate] = useState<string | null>(null);
  const [artifact, setArtifact] = useState<ArtifactState | null>(null);

  // 连接器状态
  const [connectors, setConnectors] = useState<ConnectorApp[]>([]);
  // MCP 连接器就绪数（Navbar 徽标/首页统计并入用；ConnectorsView 页内另有全量列表）
  const [mcpConnectedCount, setMcpConnectedCount] = useState(0);
  const [isSubmitting, setIsSubmitting] = useState(false);
  // 乐观派发的占位会话 id：真实 mission_created 到达时摘除（见 handleRun / mission_created）
  const pendingLocalMissionIdRef = useRef<string | null>(null);
  // 当前查看的会话 id：SSE 闭包里拿不到最新 state，经 ref 读（artifact 归属判断用）
  const activeMissionIdRef = useRef<string | null>(activeMissionId);
  useEffect(() => {
    activeMissionIdRef.current = activeMissionId;
  }, [activeMissionId]);

  // 长效记忆状态
  const [memories, setMemories] = useState<MemoryItem[]>([]);
  // 技能中心角标(SkillsView 自取数后上报;导航徽标 = 技能卡 + 已引用生态技能包)
  const [skillCounts, setSkillCounts] = useState<{ cards: number; installed: number }>({ cards: 0, installed: 0 });

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
  // 巡航会话分流(docs/design/cruise-session-split.md):巡航会话不进工作台
  // missions 列表,执行历史行(cronRuns)给巡航中心任务卡,交付物摘要行
  // (cronDeliverables)并入交付库/工坊素材选择器的数据源
  const [cronRuns, setCronRuns] = useState<CronRunMeta[]>([]);
  const [cronDeliverables, setCronDeliverables] = useState<Mission[]>([]);

  const loadCronJobs = async () => {
    try {
      const res = await fetch('/api/cron/jobs');
      const data = await res.json();
      if (data.jobs) setCronJobs(data.jobs);
    } catch (e) {
      console.error(e);
    }
  };

  const handleCreateCronJob = async (job: {
    name: string;
    pattern: string;
    prompt: string;
    scenario?: CronScenario;
  }) => {
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
      // 不再跳工作台:巡航会话不进工作台列表(cruise-session-split),
      // 留在巡航页看「最近执行」实时冒出新行,想细看再点「查看会话」
    } catch (e) {
      console.error(e);
    }
  };

  /**
   * 会话详情懒回水分片(mission/[id]?parts=):终态会话右栏重字段
   * (artifact 全文 / terminalLogs / viewport 截图)不再随 core 一起拉,
   * 切到对应 tab / 打开交付物详情时按需取回,合并进 missions 与
   * cronDeliverables 里的会话行并置 parts 标记。in-flight 按 key 去重
   * (共享同一 promise);返回值 = 服务端 patch,供复制/下载这类等不及
   * state 回流的调用方现场取数。失败静默返回 null,再次触发即重试。
   */
  const partInflight = useRef<Map<string, Promise<any>>>(new Map());
  const loadMissionPart = useCallback(
    (missionId: string, part: 'artifact' | 'terminal' | 'viewport'): Promise<any> => {
      const key = `${missionId}:${part}`;
      const inflight = partInflight.current.get(key);
      if (inflight) return inflight;
      const p = (async () => {
        try {
          const res = await fetch(
            `/api/agent/mission/${encodeURIComponent(missionId)}?parts=${part}`
          );
          if (!res.ok) return null;
          const data = await res.json();
          const patch = data?.mission;
          if (!patch) return null;
          const merge = (m: Mission): Mission => {
            // 分片在飞期间 SSE mission_updated 已送达完整行(无 parts 标记
            // = 重字段全在):不合并,避免旧 patch 盖新数据/挂上半截标记
            if (!m.parts) return m;
            const { id: _id, parts, ...fields } = patch;
            return { ...m, ...fields, parts: { ...m.parts, ...parts } };
          };
          setMissions((prev) => prev.map((m) => (m.id === missionId ? merge(m) : m)));
          setCronDeliverables((prev) =>
            prev.map((m) => (m.id === missionId ? merge(m) : m))
          );
          return patch;
        } catch {
          return null;
        } finally {
          partInflight.current.delete(key);
        }
      })();
      partInflight.current.set(key, p);
      return p;
    },
    []
  );

  /**
   * 体验兜底:core 回水落地后空闲预取选中会话的 artifact 全文 ——
   * 用户点开历史会话大概率会看成果 tab,提前在空闲窗口把最常见的一片
   * 取回,tab 切换即显全文;terminal/viewport 更重且用得少,坚持按需。
   */
  const prefetchArtifactWhenIdle = useCallback(
    (missionId: string, parts?: { artifact?: boolean }) => {
      if (!parts || parts.artifact !== false) return;
      const run = () => {
        void loadMissionPart(missionId, 'artifact');
      };
      if (typeof window !== 'undefined' && 'requestIdleCallback' in window) {
        (window as any).requestIdleCallback(run, { timeout: 5000 });
      } else {
        setTimeout(run, 1500);
      }
    },
    [loadMissionPart]
  );

  /**
   * 从巡航中心打开某次执行的会话详情:巡航会话不随 state/init 下发。
   * 慢链路下「点击 → fetch 全量 → 才转场」会让用户长时间盯着巡航页无反馈,
   * 改为即时转场:先用执行行(cronRuns)/交付摘要(cronDeliverables)就地搭一个
   * hydrating 占位会话,立刻切到工作台(驾驶舱显示「正在加载会话…」),再后台经
   * /api/agent/mission/[id] 回水全量、整行替换 —— 感知延迟从一个 RTT+payload 降到 0。
   * 占位带 hydrating(非 stripped),故不触发「选中即回水」effect,避免同一会话双拉;
   * 已有全量行则直接选中不再回水。列表侧按 isCronMission 过滤,仅选中期间可见。
   */
  const openCronRun = async (missionId: string) => {
    const runMeta = cronRuns.find((r) => r.id === missionId);
    const deliverable = cronDeliverables.find((m) => m.id === missionId);
    const existing = missions.find((m) => m.id === missionId);
    const needHydrate = !existing; // 仅新占位自行回水;已有行(全量/摘要)交给既有逻辑

    if (needHydrate) {
      const placeholder: Mission = {
        ...(deliverable || {}),
        id: missionId,
        title: deliverable?.title || runMeta?.title || '巡航会话',
        status: deliverable?.status || runMeta?.status || 'DONE',
        progress: deliverable?.progress ?? (runMeta?.status === 'DONE' ? 100 : 0),
        startedAt: deliverable?.startedAt || runMeta?.startedAt || Date.now(),
        steps: deliverable?.steps || [],
        cronJobId: deliverable?.cronJobId || runMeta?.jobId,
        hasErrorStep: deliverable?.hasErrorStep ?? runMeta?.hasErrorStep,
        stripped: false,
        hydrating: true,
      };
      // 防重:并发点击/深链兜底同时触发时只注入一次
      setMissions((prev) => (prev.some((m) => m.id === missionId) ? prev : [placeholder, ...prev]));
    }
    setActiveMissionId(missionId);
    setActiveView('cockpit');
    setMobileTab('activity');
    setMobileOverlay(null);

    if (!needHydrate) return; // 已有行:转场即可,回水由既有 effect/无需处理

    try {
      const res = await fetch(`/api/agent/mission/${encodeURIComponent(missionId)}`);
      const data = await res.json();
      if (!data.success || !data.mission) throw new Error(data.error || '加载失败');
      const full: Mission = { ...data.mission, stripped: false, hydrating: false };
      setMissions((prev) =>
        prev.map((x) => {
          if (x.id !== full.id) return x;
          // 竞态防护:回水在飞期间 SSE mission_updated 已送达完整行(占位已被
          // 替换、无 hydrating 标记),不用 core 倒灌(那会丢 terminalLogs/viewport
          // 并把 artifact 全文倒退回摘录)
          if (!x.hydrating) return x;
          return full;
        })
      );
      prefetchArtifactWhenIdle(full.id, full.parts);
    } catch {
      // 回水失败:撤掉仍在飞的占位(避免永久「正在加载」);再次点击即重试
      setMissions((prev) => prev.filter((m) => !(m.id === missionId && m.hydrating)));
    }
  };

  // 交付库/工坊素材选择器数据源:手动会话 + 巡航交付物摘要行(按 id 去重,
  // 点开注入的巡航会话已在 missions 里,优先用其全量行)
  const deliverableMissions = useMemo(() => {
    const seen = new Set(missions.map((m) => m.id));
    return [...missions, ...cronDeliverables.filter((m) => !seen.has(m.id))];
  }, [missions, cronDeliverables]);

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

  // 首屏聚合拉取：一个请求拿齐首页/导航徽标所需的五类数据。
  // 失败静默（各视图仍可单独刷新），单项缺省不影响其余渲染。
  // 返回是否成功 —— 登录态对账 effect 据此决定推测拉取失败后要不要补拉。
  const bootstrapPromiseRef = useRef<Promise<boolean> | null>(null);
  const loadBootstrap = async (): Promise<boolean> => {
    try {
      const res = await fetch('/api/bootstrap');
      if (!res.ok) return false;
      const data = await res.json();
      if (data.connectors) setConnectors(data.connectors);
      if (typeof data.mcpConnectedCount === 'number') setMcpConnectedCount(data.mcpConnectedCount);
      if (data.memories) setMemories(data.memories);
      if (data.cronJobs) setCronJobs(data.cronJobs);
      if (data.goals) setGoals(data.goals);
      return true;
    } catch (e) {
      console.error(e);
      return false;
    }
  };

  // 仅供 SSE 首帧兜底使用（正常路径下 agent 状态由 SSE init 全量下发）。
  const loadAgentState = async () => {
    try {
      const res = await fetch('/api/agent/state');
      const data = await res.json();
      if (data.state) {
        if (data.state.missions) mergeWireMissions(data.state.missions);
        if (data.state.cronRuns) setCronRuns(data.state.cronRuns);
        if (data.state.cronDeliverables) setCronDeliverables(data.state.cronDeliverables);
        if (data.state.activeMissionId) setActiveMissionId(data.state.activeMissionId);
        if (data.state.viewport) setViewport(data.state.viewport);
        if (data.state.terminalLogs) setTerminalLogs(data.state.terminalLogs);
        if (data.state.approvalRequests) setApprovalRequests(data.state.approvalRequests);
        if (data.state.connectorSuggestions) setConnectorSuggestions(data.state.connectorSuggestions);
        if (data.state.pendingQuestions) setPendingQuestions(data.state.pendingQuestions);
        if (data.state.latestArtifact) setArtifact(data.state.latestArtifact);
      }
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

  const loadMcpConnectedCount = async () => {
    try {
      const res = await fetch('/api/connectors/mcp');
      const data = await res.json();
      if (data.success) setMcpConnectedCount(data.connectedCount || 0);
    } catch (e) {
      console.error(e);
    }
  };

  const handleSaveKey = async (
    envVar: string,
    value: string,
    extra?: {
      baseUrl?: string;
      baseUrlEnvVar?: string;
      modelName?: string;
      modelNameEnvVar?: string;
      /** 思考深度(low|medium|high);'' = 清除连接器级配置回落全局。value 留空时凭证不动 */
      reasoningEffort?: string;
      reasoningEffortEnvVar?: string;
    }
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
            reasoningEffort: extra.reasoningEffort,
            reasoningEffortEnvVar: extra.reasoningEffortEnvVar,
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

  const handleApproval = async (approvalId: string, approved: boolean, opts?: { includeClaim?: boolean }) => {
    // 乐观移除：卡片先消失再等 POST 返回。POST 若卡顿半秒，旧逻辑里卡片
    // 一直挂着，用户自然会再点一次（第二个 ApprovalRequest 由此而来）
    setApprovalRequests((prev) => prev.filter((r) => r.id !== approvalId));
    try {
      await fetch('/api/agent/approval', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // options:runner_publish 审批的「代发认领留言」勾选(决策项 6);其余审批忽略
        body: JSON.stringify({ approvalId, approved, options: opts }),
      });
    } catch (err) {
      // 网络失败时提示；后端广播 approval_resolved 会同步真实状态
      console.error(err);
    }
  };

  // ask_user 问题卡答题:乐观移除(卡片先消失再等 POST,与 handleApproval 同款
  // 防双击纪律),真实撤卡由 question_resolved SSE 收口。
  // answers 为逐问回答(index 对应卡内 questions 序),覆盖校验由后端桥做
  const handleAnswerQuestion = async (
    questionId: string,
    answers: Array<{ index: number; answer: string; via: 'option' | 'free_text' }>
  ) => {
    setPendingQuestions((prev) => prev.filter((q) => q.id !== questionId));
    try {
      await fetch('/api/agent/answer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ questionId, answers }),
      });
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
    // 乐观收尾:点击即本地置 DONE(镜像 stopMission 的口径:RUNNING/PENDING
    // → FAILED + abort 尾巴步)。SSE 万一静默死亡(连接被掐但 EventSource
    // 还没察觉),用户至少立刻看到执行态停止,权威 mission_updated 到达后
    // 整包覆盖 —— 修复生产实测「点停止没反应,刷新才见已停止」
    setMissions((prev) =>
      prev.map((m) => {
        if (m.id !== missionId || m.status === 'DONE') return m;
        const steps = m.steps.map((st) =>
          st.status === 'RUNNING' || st.status === 'PENDING' ? { ...st, status: 'FAILED' as const } : st
        );
        steps.push({
          id: `step_abort_fe_${Date.now()}`,
          title: '任务已被用户主动终止 (Aborted)',
          status: 'FAILED' as const,
          duration: '0ms',
        });
        return { ...m, status: 'DONE' as const, steps };
      })
    );
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

  /**
   * 删除历史会话:持久化库 + 内存态由后端一并清掉,前端同步摘除列表项。
   * 删掉的是当前选中会话时切到剩余列表头(没有剩余则回到空白就绪态);
   * ACTIVE/等待中的任务后端会拒绝(409),组件层已先行隐藏删除入口。
   */
  const handleDeleteMission = async (missionId: string) => {
    try {
      const res = await fetch('/api/agent/mission/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ missionId }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.success) {
        alert(data?.error || '删除失败,请稍后重试');
        return;
      }
      setMissions((prev) => {
        const next = prev.filter((m) => m.id !== missionId);
        if (activeMissionId === missionId) {
          setActiveMissionId(next[0]?.id ?? null);
        }
        return next;
      });
    } catch (err) {
      console.error(err);
      alert('删除失败,请稍后重试');
    }
  };

  const { data: session, status: sessionStatus } = useSession();

  const handleRun = async (
    text: string,
    title?: string,
    targetMissionId?: string | null,
    workshop?: WorkshopRunPayload,
    /** 显式引用的技能包名:undefined=继承任务记录,数组(含 [])=显式覆盖(空=清空) */
    skillPacks?: string[]
  ) => {
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

    // 乐观派发：不等后端 mission_created（冷启动 ensureRuntime / 网络往返可达数秒），
    // 先在前端立起会话 —— 用户气泡与「正在思考」占位即刻可见；后端事件到达后原位替换。
    // 新任务记入 pendingLocalMissionIdRef，mission_created 到达时摘除占位会话；
    // 续聊沿用真实 missionId，后端 mission_updated 会整包覆盖乐观步骤。
    const optimisticLiveStep = {
      id: `step_live_${missionId || 'local'}_fe_${Date.now()}`,
      role: 'assistant' as const,
      messageKind: 'progress' as const,
      title: '正在思考…',
      status: 'RUNNING' as const,
      answer: '',
      reasoning: '',
      startedAt: Date.now(),
    };
    const optimisticUserStep = {
      id: `step_user_fe_${Date.now()}`,
      role: 'user' as const,
      title: text.trim(),
      userPrompt: text.trim(),
      status: 'DONE' as const,
    };
    if (missionId && missions.some((m) => m.id === missionId)) {
      // 任务进行中的追问:后端只排队不打断(runInflight 在飞),前端同样
      // 只追加置灰的排队气泡 —— 不再立「正在思考」占位,避免双 live step
      // (这正是当初两轮交错把布局打乱的入口)。在飞判定:有 RUNNING live
      // step,或轮内工具执行期 live step 暂关但 mission 仍 ACTIVE。服务器
      // mission_updated 到达后按权威状态覆盖。
      const target = missions.find((m) => m.id === missionId)!;
      const inFlight = Boolean(findLiveStep(target)) || target.status === 'ACTIVE';
      if (inFlight) {
        setMissions((prev) =>
          prev.map((m) =>
            m.id === missionId
              ? { ...m, status: 'ACTIVE', steps: [...m.steps, { ...optimisticUserStep, queued: true }] }
              : m
          )
        );
        setActiveMissionId(missionId);
      } else {
        setMissions((prev) =>
          prev.map((m) =>
            m.id === missionId
              ? { ...m, status: 'ACTIVE', steps: [...m.steps, optimisticUserStep, optimisticLiveStep] }
              : m
          )
        );
        setActiveMissionId(missionId);
      }
    } else {
      const localMission: Mission = {
        id: `mission_local_${Date.now()}`,
        userId: session?.user?.id,
        title: title || text.trim(),
        status: 'ACTIVE',
        progress: 0,
        startedAt: Date.now(),
        steps: [optimisticUserStep, optimisticLiveStep],
        conversationMessages: [],
        // 乐观会话带上引用,驾驶舱 prefill 在 mission_created 替换前不闪空
        ...(skillPacks?.length ? { skillPacks } : {}),
      };
      pendingLocalMissionIdRef.current = localMission.id;
      setMissions((prev) => [localMission, ...prev]);
      setActiveMissionId(localMission.id);
    }

    try {
      await fetch('/api/agent/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // 带 workshop 载荷的工坊任务由服务端权威渲染(注册表+当前档案+覆盖目录),忽略客户端 prompt
        // skillPacks:undefined 不发键(继承语义),[] 要发(续聊清空语义)
        body: JSON.stringify({
          prompt: text.trim(),
          title,
          missionId,
          ...(workshop ? { workshop } : {}),
          ...(skillPacks !== undefined ? { skillPacks } : {}),
        }),
      });
    } catch (e) {
      console.error(e);
      // 派发失败：乐观会话立即标失败，不留永转的「正在思考」占位
      const failTitle = '任务派发失败';
      const failText = '无法连接服务器，请检查网络后重试。';
      if (pendingLocalMissionIdRef.current) {
        const localId = pendingLocalMissionIdRef.current;
        pendingLocalMissionIdRef.current = null;
        setMissions((prev) =>
          prev.map((m) =>
            m.id === localId
              ? {
                  ...m,
                  status: 'INTERRUPTED',
                  steps: [
                    ...m.steps.filter((s) => !s.id.startsWith('step_live_')),
                    { ...optimisticLiveStep, status: 'FAILED', title: failTitle, answer: failText },
                  ],
                }
              : m
          )
        );
      } else if (missionId) {
        setMissions((prev) =>
          prev.map((m) =>
            m.id === missionId
              ? {
                  ...m,
                  status: 'INTERRUPTED',
                  steps: m.steps.map((s) =>
                    s.id.startsWith('step_live_') && s.status === 'RUNNING'
                      ? { ...s, status: 'FAILED', title: failTitle, answer: failText }
                      : s
                  ),
                }
              : m
          )
        );
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  // 首屏启动:挂载即发推测性 /api/bootstrap —— 服务端鉴权只看 cookie,不必等
  // useSession 解析完再发(高延迟链路上串行等会话白付一整个往返)。未登录时
  // 该请求 401 静默;会话解析后由下方对账 effect 兜底补拉/清空。
  // 深链参数(OAuth 回调跳转、PWA 快捷方式/推送通知)也在挂载时一次性消费。
  useEffect(() => {
    setMounted(true);
    bootstrapPromiseRef.current = loadBootstrap();

    // 检查 URL 参数（如 OAuth 回调后跳转、PWA 快捷方式/推送通知深链）
    if (typeof window !== 'undefined') {
      const urlParams = new URLSearchParams(window.location.search);
      const tab = urlParams.get('tab');
      const mission = urlParams.get('mission');
      if (mission) {
        // 任务完成推送深链：直达该 mission（桌面 cockpit / 移动 activity 两种布局渲染不相交，双置安全）
        setDeepLinkMissionId(mission);
        setActiveMissionId(mission);
        setActiveView('cockpit');
        setMobileTab('activity');
      } else if (tab === 'connectors') {
        setActiveView('connectors');
      } else if (tab === 'workshops') {
        setActiveView('workshops');
      } else if (tab === 'home' || tab === 'deliverables' || tab === 'activity' || tab === 'profile') {
        setMobileTab(tab);
      }
      if (mission || tab) {
        // 深链参数消费后清掉,避免刷新/回退重复触发
        window.history.replaceState({}, '', window.location.pathname);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 登录态对账(bootstrap 侧):挂载时的推测拉取与 session 用同一份 cookie,
  // 首次解析时数据通常已就位 —— 不重拉(这正是省 RTT 的意义);仅推测拉取
  // 失败(弱网/5xx)而实际已登录时补一次。页面存活期间的登录/登出/换号
  // (uid 真实变化)才重拉或清空。
  const prevSessionUidRef = useRef<string | null | undefined>(undefined); // undefined = 尚未首次解析
  useEffect(() => {
    if (sessionStatus === 'loading') return;
    const uid = session?.user?.id ?? null;
    const prev = prevSessionUidRef.current;
    prevSessionUidRef.current = uid;
    if (prev === undefined) {
      // 首次解析:等推测拉取落地,失败且登录态未再变则补拉
      if (uid) {
        const inflight = bootstrapPromiseRef.current;
        if (inflight) {
          void inflight.then((ok) => {
            if (!ok && prevSessionUidRef.current === uid) {
              bootstrapPromiseRef.current = loadBootstrap();
            }
          });
        } else {
          bootstrapPromiseRef.current = loadBootstrap();
        }
      }
      return;
    }
    if (prev === uid) return;
    if (uid === null) {
      // 登出:推测拉取作废,清空所有用户态
      bootstrapPromiseRef.current = null;
      setConnectors([]);
      setMcpConnectedCount(0);
      setMemories([]);
      setCronJobs([]);
      setGoals([]);
      setMissions([]);
      setActiveMissionId(null);
      setTerminalLogs([]);
      setApprovalRequests([]);
      setConnectorSuggestions([]);
      setArtifact(null);
    } else {
      bootstrapPromiseRef.current = loadBootstrap();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.user?.id, sessionStatus]);

  // 空闲预热常用视图 chunk（仅桌面端已登录）：工作台(CockpitView)含
  // react-markdown 等重依赖，首次点进去要现场下载 + 解析，慢网下「几秒才
  // 展示」。登录后在浏览器空闲时静默预取工作台/连接器 chunk，首次切换即秒开。
  // 移动端不预取（省流量），失败静默。
  useEffect(() => {
    if (!session?.user?.id) return;
    if (typeof window === 'undefined') return;
    const prefetch = () => {
      if (isMobile) {
        void import('../components/mobile/MobileActivityView').catch(() => {});
      } else {
        void import('../components/CockpitView').catch(() => {});
        void import('../components/ConnectorsView').catch(() => {});
      }
    };
    const ric = (window as any).requestIdleCallback as
      | ((cb: () => void, opts?: { timeout?: number }) => number)
      | undefined;
    if (ric) {
      const id = ric(prefetch, { timeout: 4000 });
      return () => (window as any).cancelIdleCallback?.(id);
    }
    const t = setTimeout(prefetch, 1500);
    return () => clearTimeout(t);
  }, [session?.user?.id, isMobile]);

  // 深链目标 mission 已在列表中 → 正式选中并结束等待(SSE init/loadAgentState 的回写已被此 effect 纠正)
  useEffect(() => {
    if (!deepLinkMissionId) return;
    const exists = missions.some((m) => m.id === deepLinkMissionId);
    if (exists) {
      setActiveMissionId(deepLinkMissionId);
      setDeepLinkMissionId(null);
    }
  }, [deepLinkMissionId, missions]);

  // 深链目标不在下发列表 = 巡航会话(state/init 已分流,不再进工作台 missions,
  // docs/design/cruise-session-split.md):延时兜底现场懒回水注入后打开。
  // 手动会话由上方 exists effect 命中,不会走到这里;openCronRun 对手动会话
  // 同样幂等可用(慢网下 init 迟到时误触发也无害)
  useEffect(() => {
    if (!deepLinkMissionId) return;
    if (missions.some((m) => m.id === deepLinkMissionId)) return;
    const target = deepLinkMissionId;
    const t = setTimeout(() => {
      void openCronRun(target);
      setDeepLinkMissionId((cur) => (cur === target ? null : cur));
    }, 1500);
    return () => clearTimeout(t);
  }, [deepLinkMissionId, missions]);

  /**
   * 历史会话懒回水(首屏瘦身配套,lib/mission-wire.ts):state/init 对终态
   * 会话只带摘要(stripped,steps/terminalLogs/viewport 已剥),选中某条时经
   * /api/agent/mission/[id] 拉全量回填;选中会话的后台子任务一并回水
   * (子任务面板/失败 chip 要读 steps)。in-flight 集合防重(missions 在
   * 流式期间高频变化,effect 会反复触发);失败静默,重新选中即重试。
   */
  const hydrateInflight = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!activeMissionId) return;
    const pending = missions.filter(
      (m) =>
        m.stripped &&
        !hydrateInflight.current.has(m.id) &&
        (m.id === activeMissionId || m.parentMissionId === activeMissionId)
    );
    if (pending.length === 0) return;
    for (const m of pending) {
      hydrateInflight.current.add(m.id);
      (async () => {
        try {
          const res = await fetch(`/api/agent/mission/${encodeURIComponent(m.id)}`);
          const data = await res.json();
          if (data.success && data.mission) {
            const full: Mission = { ...data.mission, stripped: false };
            setMissions((prev) =>
              prev.map((x) => {
                if (x.id !== full.id) return x;
                // 竞态防护:回水在飞期间用户已对这条会话发起续聊(本地乐观
                // 置 ACTIVE/QUEUED),不用旧终态全量盖掉乐观气泡 —— 只清摘要
                // 标记,权威全量随服务端 mission_updated 很快到达
                if (x.status !== 'DONE' && x.status !== 'INTERRUPTED') {
                  return { ...x, stripped: false };
                }
                // 竞态防护:回水在飞期间 SSE mission_updated 已送达完整行
                // (无 parts 标记 = 重字段全在),不用 core 倒灌 —— 那会丢
                // terminalLogs/viewport 并把 artifact 全文倒退回摘录
                if (!x.stripped) return x;
                return full;
              })
            );
            // 选中会话:core 落地后空闲预取 artifact 全文(成果 tab 即点即显)
            if (m.id === activeMissionId) prefetchArtifactWhenIdle(full.id, full.parts);
          }
        } catch {
          // 静默:列表仍可浏览,再次选中该会话时重试回水
        } finally {
          hydrateInflight.current.delete(m.id);
        }
      })();
    }
    // prefetchArtifactWhenIdle 为 useCallback 稳定引用(依赖链均空)
  }, [activeMissionId, missions, prefetchArtifactWhenIdle]);

  useEffect(() => {
    if (session?.user?.id && mobileOverlay === 'connectors') {
      loadConnectors();
    }
  }, [mobileOverlay, session?.user?.id]);

  // ConnectorsView 内的 MCP 连接/断开只更新其内部状态、不回调父层；
  // 视图切换时重取一次 MCP 就绪数，让 Navbar 徽标/首页统计追平
  useEffect(() => {
    if (session?.user?.id && activeView !== 'connectors') {
      loadMcpConnectedCount();
    }
  }, [activeView, session?.user?.id]);

  /**
   * 线上 missions 合并回本地(首屏瘦身配套):state/init 对终态历史会话只带
   * 摘要(stripped),若本地已懒回水成全量且状态版本没变,保留本地全量 ——
   * 避免 SSE 重连 init 重同步把正打开的会话闪回空步骤。其余以线上为准。
   */
  const mergeWireMissions = (incoming: Mission[]) => {
    setMissions((prev) => {
      if (prev.length === 0) return incoming;
      const prevById = new Map(prev.map((m) => [m.id, m]));
      return incoming.map((m) => {
        const old = prevById.get(m.id);
        if (old && !old.stripped && m.stripped && old.status === m.status) return old;
        return m;
      });
    });
  };

  // SSE 登录态对账机制(挂载即连的配套纪律):连接不再等 useSession 解析 ——
  // cookie 浏览器自动带,服务端按登录态下发 init(未登录是空帧,零泄露)。
  // init 帧回显服务端实际认证到的 userId(state-scoping.ts),与客户端 session
  // 不一致(页面存活期间登录/登出/换号)才拆线重建。旧做法以 session?.user?.id
  // 为 effect 依赖:高延迟链路上白等一个串行 RTT 才开始连;若单纯改成挂载即连
  // 又会在 session 首次解析时因依赖变化必重连一次,全量 init 白下载两遍。
  // 对账式:首载恰好一条连接,登录态真变了才重建。
  const [sseEpoch, setSseEpoch] = useState(0);
  const sseUidRef = useRef<string | null | undefined>(undefined); // undefined = 当前连接 init 未到
  const sessionUidRef = useRef<string | null | undefined>(undefined); // undefined = session 尚未解析
  const sessionStatusRef = useRef(sessionStatus);
  sessionStatusRef.current = sessionStatus; // 渲染期刷新,effect/监听器闭包读到最新值

  const reconcileSse = useCallback(() => {
    if (sessionStatusRef.current === 'loading') return; // 登录态未解析,先不判
    if (sseUidRef.current === undefined) return; // init 未到,到了再对账
    if (sseUidRef.current === sessionUidRef.current) return; // 归属一致,连接健康
    // 不一致:拆旧线重建(下方连接 effect 随 sseEpoch 变化重跑),init 按新登录态重同步
    sseUidRef.current = undefined;
    setSseEpoch((e) => e + 1);
  }, []);

  // session 解析/变化:写入 ref 并触发对账
  useEffect(() => {
    sessionUidRef.current = session?.user?.id ?? null;
    reconcileSse();
  }, [session?.user?.id, sessionStatus, reconcileSse]);

  useEffect(() => {
    // SSE 假死自愈:TCP 连接可以「断了一半」——客户端侧仍 ESTABLISHED,
    // EventSource 不触发 onerror,自动重连永远不发生;期间服务端广播的
    // 工具卡/流式答复/完成态全部落空,页面冻在最后一帧,顶部的本地耗时
    // 计时却还在走(生产实测:续聊中段回复后连接假死,用户盯着「什么都没动」
    // 看了好几分钟,任务其实早已完成)。
    // 服务端每 25s 发一帧具名 ping 事件;客户端 60s 没收到任何心跳 →
    // 判定假死,主动 close 重建连接 —— 重连后 init 事件全量重同步,冻结的
    // 会话状态自动追平。
    let eventSource: EventSource | null = null;
    let lastAliveAt = Date.now();
    let gotInit = false;
    let initFallbackTimer: ReturnType<typeof setTimeout> | null = null;

    // 流式增量聚合：后端每个 token 一帧 assistant_delta，若每帧都 setMissions
    // 会让整棵视图随 token 频率重渲染（长回答/多步骤时明显掉帧）。这里把同一
    // 帧内到达的增量攒进 buffer，用 requestAnimationFrame 每帧最多刷新一次，
    // 渲染频率被钳到 ~60fps，观感不变但重渲染次数大幅下降。
    const pendingDeltas = new Map<string, { answer: string; reasoning: string }>();
    let deltaFrame: number | null = null;
    const flushDeltas = () => {
      deltaFrame = null;
      if (pendingDeltas.size === 0) return;
      const batch = new Map(pendingDeltas);
      pendingDeltas.clear();
      setMissions((prev) =>
        prev.map((m) => {
          const acc = batch.get(m.id);
          if (!acc) return m;
          const steps = [...m.steps];
          let applied = false;
          for (let i = steps.length - 1; i >= 0; i--) {
            const st = steps[i];
            if (st.id?.startsWith('step_live_') && st.status === 'RUNNING' && st.role === 'assistant') {
              const next = { ...st };
              if (acc.reasoning) next.reasoning = (next.reasoning || '') + acc.reasoning;
              if (acc.answer) {
                next.answer = (next.answer || '') + acc.answer;
                next.title = '正在处理…';
              }
              steps[i] = next;
              applied = true;
              break;
            }
          }
          if (!applied) {
            // 兜底：后端 live step 尚未随 mission_updated 到达（如 SSE 重连初期）
            steps.push({
              id: `step_live_${m.id}_fe_${Date.now()}`,
              role: 'assistant' as const,
              messageKind: 'progress' as const,
              title: '正在处理…',
              status: 'RUNNING' as const,
              answer: acc.answer || '',
              reasoning: acc.reasoning || '',
              startedAt: Date.now(),
            });
          }
          return { ...m, steps };
        })
      );
    };
    const scheduleDeltaFlush = () => {
      if (deltaFrame != null) return;
      if (typeof requestAnimationFrame !== 'undefined') {
        deltaFrame = requestAnimationFrame(flushDeltas);
      } else {
        deltaFrame = setTimeout(flushDeltas, 16) as unknown as number;
      }
    };
    const queueDelta = (taskId: string, segments: any[]) => {
      const cur = pendingDeltas.get(taskId) || { answer: '', reasoning: '' };
      for (const seg of segments) {
        if (seg.kind === 'reasoning') cur.reasoning += String(seg.delta || '');
        else cur.answer += String(seg.delta || '');
      }
      pendingDeltas.set(taskId, cur);
      scheduleDeltaFlush();
    };

    const connect = () => {
      lastAliveAt = Date.now();
      if (initFallbackTimer) clearTimeout(initFallbackTimer);
      eventSource = new EventSource('/api/agent/events');
      // 首帧兜底：SSE 若被反向代理缓冲/长期连不上，8s 内仍未收到 init 就回退
      // 拉一次 /api/agent/state —— 正常路径下 8s 前 init 已到，不会触发，也就
      // 不会产生此前「state + SSE init 各拉一遍」的重复全量同步。
      initFallbackTimer = setTimeout(() => {
        if (!gotInit) void loadAgentState();
      }, 8000);

      // 心跳(具名事件,注释行 EventSource 听不见):任何一帧都证明连接活着
      eventSource.addEventListener('ping', () => {
        lastAliveAt = Date.now();
      });

      eventSource.addEventListener('init', (e: MessageEvent) => {
        try {
          gotInit = true;
          if (initFallbackTimer) { clearTimeout(initFallbackTimer); initFallbackTimer = null; }
          pendingDeltas.clear();
          const state = JSON.parse(e.data);
          // 对账:init 回显服务端认证到的登录身份。与客户端 session 不一致
          // (页面存活期间登录/登出/换号)时 reconcileSse 拆线重建,本帧属于
          // 旧身份,整帧跳过不应用 —— 新连接的 init 随后到达
          sseUidRef.current = state.userId ?? null;
          const staleIdentity =
            sessionStatusRef.current !== 'loading' && sseUidRef.current !== sessionUidRef.current;
          reconcileSse();
          if (staleIdentity) return;
          if (state.missions) mergeWireMissions(state.missions);
          if (state.cronRuns) setCronRuns(state.cronRuns);
          if (state.cronDeliverables) setCronDeliverables(state.cronDeliverables);
          if (state.activeMissionId) setActiveMissionId(state.activeMissionId);
          if (state.viewport) setViewport(state.viewport);
          if (state.terminalLogs) setTerminalLogs(state.terminalLogs);
          if (state.approvalRequests) setApprovalRequests(state.approvalRequests);
          if (state.connectorSuggestions) setConnectorSuggestions(state.connectorSuggestions);
          if (state.pendingQuestions) setPendingQuestions(state.pendingQuestions);
          if (state.latestArtifact) setArtifact(state.latestArtifact);
        } catch (err) {
          console.error(err);
        }
      });

      eventSource.addEventListener('viewport_update', (e: MessageEvent) => {
        try {
          const vp = JSON.parse(e.data);
          setViewport((prev) => ({ ...prev, ...vp }));
          // 视口更新自动带看浏览器，但「执行动态」是粘性的：任务执行期间
          // 用户正盯着活动流时不被抢走焦点（想看浏览随时手点）
          setRightTab((prev) => (prev === 'activity' ? prev : 'browser'));
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
          // 巡航会话分流(docs/design/cruise-session-split.md):不进工作台
          // 列表、不抢焦点(旧行为:巡航触发会把用户当前会话硬切到巡航会话,
          // 日更任务每天打断一次)。执行历史行进 cronRuns,巡航中心实时可见
          if (isCronMission(mission)) {
            const row = toCronRunMeta(mission);
            setCronRuns((prev) => [row, ...prev.filter((r) => r.id !== row.id)]);
            return;
          }
          // 后台子 mission(带 parentMissionId):只并入列表(父会话行下挂 chip),
          // 【不抢焦点】—— 无条件切视图会把用户当前会话切走(子任务创建瞬间);
          // 也不动乐观占位(占位只属于用户亲手发起的会话,父 mission_created 必
          // 先于任何子任务到达,彼时占位已摘除)
          if (mission.parentMissionId) {
            setMissions((prev) => [mission, ...prev.filter((m) => m.id !== mission.id)]);
            return;
          }
          // 后端真实会话落地 → 摘除乐观占位会话（真实会话自带用户步骤与思考占位）
          const pendingLocalId = pendingLocalMissionIdRef.current;
          pendingLocalMissionIdRef.current = null;
          setMissions((prev) => [
            mission,
            ...prev.filter((m) => m.id !== mission.id && m.id !== pendingLocalId),
          ]);
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
          // 边界先于后续增量到达：丢弃该会话尚未 flush 的聚合增量（权威全量已覆盖）
          pendingDeltas.delete(updated.id);
          // missions 里只有手动会话 + 从巡航中心点开注入的巡航会话;
          // 未点开的巡航会话 map 是 no-op,不会混进工作台列表
          setMissions((prev) => prev.map((m) => (m.id === updated.id ? updated : m)));
          if (isCronMission(updated)) {
            // 巡航执行历史行实时刷新(状态翻转/失败尾步/交付物标记)
            const row = toCronRunMeta(updated);
            setCronRuns((prev) =>
              [row, ...prev.filter((r) => r.id !== row.id)].sort(
                (a, b) => (b.startedAt || 0) - (a.startedAt || 0)
              )
            );
            // 终态且带交付物 → 补入交付物索引(交付库/工坊素材选择器消费;
            // 与 state/init 的 cronDeliverables 同构:终态摘要投影,含 artifact)
            if (
              (updated.status === 'DONE' || updated.status === 'INTERRUPTED') &&
              updated.artifact?.content
            ) {
              setCronDeliverables((prev) => [
                toWireMission(updated) as Mission,
                ...prev.filter((x) => x.id !== updated.id),
              ]);
            }
          }
        } catch (err) {
          console.error(err);
        }
      });

      // token 用量实时更新（每步模型调用完成涨一次）：轻量事件只带
      // { taskId, usage }，只 patch 单字段，不重发全量 mission
      eventSource.addEventListener('mission_usage', (e: MessageEvent) => {
        try {
          const { taskId, usage } = JSON.parse(e.data);
          if (!taskId || !usage) return;
          setMissions((prev) => prev.map((m) => (m.id === taskId ? { ...m, usage } : m)));
        } catch (err) {
          console.error(err);
        }
      });

      // 流式增量（打字机）：按 taskId 定位 mission，从尾向前找 RUNNING 的
      // live step（step_live_ 前缀）按 kind 追加 answer / reasoning；边界
      // mission_updated 与 delta 在同一 SSE 连接上有序（后端先 flush 再广播
      // 边界），两种流不会交错错位。找不到 live step 时前端兜底创建。
      // 具体应用在 flushDeltas 里按帧批量完成，这里只做聚合成帧。
      eventSource.addEventListener('assistant_delta', (e: MessageEvent) => {
        try {
          const { taskId, segments } = JSON.parse(e.data);
          if (!taskId || !Array.isArray(segments) || segments.length === 0) return;
          queueDelta(taskId, segments);
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

      // ask_user 问题卡:弹卡等回答(切到驾驶舱/移动端「动态」让用户看见)
      eventSource.addEventListener('question_asked', (e: MessageEvent) => {
        try {
          const q: PendingQuestion = JSON.parse(e.data);
          setPendingQuestions((prev) => [...prev.filter((x) => x.id !== q.id), q]);
          setActiveView('cockpit');
          setMobileTab('activity');
        } catch (err) {
          console.error(err);
        }
      });

      eventSource.addEventListener('question_resolved', (e: MessageEvent) => {
        try {
          const { id } = JSON.parse(e.data);
          setPendingQuestions((prev) => prev.filter((x) => x.id !== id));
        } catch (err) {
          console.error(err);
        }
      });

      eventSource.addEventListener('artifact_updated', (e: MessageEvent) => {
        try {
          const art: ArtifactState = JSON.parse(e.data);
          setArtifact(art);
          // 归属到所属会话（后端 mission_updated 先行,这里兜底合并,
          // 防止某个会话的产物只在全局 latestArtifact 里"孤儿化"）
          if (art?.taskId) {
            setMissions((prev) =>
              prev.map((m) => (m.id === art.taskId && !m.artifact ? { ...m, artifact: art } : m))
            );
          }
          // 正在浏览别的历史会话时不要强切右栏 —— 产物属于谁就只在
          // 用户正看着它的会话时才把"成果"页签顶上来,避免串台抢焦点
          if (!art?.taskId || art.taskId === activeMissionIdRef.current) {
            setRightTab('artifact');
          }
        } catch (err) {
          console.error(err);
        }
      });

      // 记忆库更新（会话结束自动沉淀新记忆）：静默刷新记忆列表
      eventSource.addEventListener('memories_updated', (e: MessageEvent) => {
        try {
          const data = JSON.parse(e.data);
          // 连接归属以 init 回显的 userId 为准(服务端推送前已按归属过滤,
          // 这里双保险);effect 不再依赖 session,闭包里拿不到最新会话
          const owner = sseUidRef.current ?? sessionUidRef.current;
          if (owner && data?.userId === owner) {
            loadMemories();
          }
        } catch (err) {
          console.error(err);
        }
      });
    };

    // 假死连接换新:close 后重连,init 全量重同步把冻结的会话追平
    const healZombie = () => {
      console.warn('[sse] 心跳静默超时,重建连接自愈');
      eventSource?.close();
      connect();
    };

    connect();

    // 看门狗:只处理「OPEN 但静默」的假死态;CONNECTING 时 EventSource
    // 自带退避重试,不掺和
    const watchdogTimer = setInterval(() => {
      const es = eventSource;
      if (es && isZombieSse({ readyState: es.readyState, lastAliveAt })) {
        healZombie();
      }
    }, 15_000);

    // 切回标签页立即检查:后台标签页定时器被节流,看门狗可能迟钝
    const onVisible = () => {
      const es = eventSource;
      if (
        document.visibilityState === 'visible' &&
        es &&
        isZombieSse({ readyState: es.readyState, lastAliveAt })
      ) {
        healZombie();
      }
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      clearInterval(watchdogTimer);
      if (initFallbackTimer) clearTimeout(initFallbackTimer);
      if (deltaFrame != null && typeof cancelAnimationFrame !== 'undefined') cancelAnimationFrame(deltaFrame);
      document.removeEventListener('visibilitychange', onVisible);
      eventSource?.close();
    };
    // 依赖只有 sseEpoch(登录态对账不一致时 +1 触发重建)与稳定的 reconcileSse;
    // 不再依赖 session —— 挂载即连,首载恰好一条连接(见上方对账机制注释)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sseEpoch, reconcileSse]);

  const handleViewChange = (view: 'home' | 'cockpit' | 'workshops' | 'goals' | 'connectors' | 'memories' | 'skills' | 'patrol' | 'deliverables' | 'devices') => {
    // 首页允许所有人浏览概览，其余页面（工作台、工坊、连接器、记忆库、技能、巡航、交付库、长期目标）必须登录
    if (view !== 'home' && sessionStatus !== 'loading' && !session?.user) {
      setAuthModalTab('login');
      setAuthModalOpen(true);
      return;
    }
    setActiveView(view);
  };

  const currentMission = missions.find((m) => m.id === activeMissionId) || missions[0] || null;
  // 原生 + MCP 一并计入（与 ConnectorsView 页头「已就绪 N/M」口径一致）
  const connectedCount =
    connectors.filter((c) => c.status === 'connected').length + mcpConnectedCount;

  // 骨架屏：此前 return null 会白屏直到全部 JS 下载+水合+取状态完成，
  // 现在首帧直接给出与真实布局同构的浅色骨架，杜绝白屏。
  if (!mounted || !mobileReady) return <BootSkeleton />;

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
        skills: '技能中心',
        patrol: '定时巡航',
        workshops: '工坊',
      };
      return (
        <div className="fixed inset-0 z-[60] bg-[#fbfbfd] flex flex-col">
          <header
            className="shrink-0 relative flex items-center px-2 bg-white/92 backdrop-blur-lg border-b border-zinc-200/70"
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
          <div className="flex-1 overflow-y-auto overscroll-contain pb-[env(safe-area-inset-bottom,0px)]">
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
                locateSearch={connectorLocate}
                onLocateHandled={() => setConnectorLocate(null)}
              />
            )}
            {mobileOverlay === 'workshops' && (
              <WorkshopsView
                connectors={connectors}
                onRunPrompt={(prompt, title, workshop) => {
                  handleRun(prompt, title, null, workshop);
                  // 任务发起后回到活动页看执行流,关闭工坊覆盖层
                  setMobileOverlay(null);
                }}
                onOpenConnectors={(depId) => {
                  if (depId) setConnectorLocate(depId);
                  setMobileOverlay('connectors');
                }}
                missions={deliverableMissions}
              />
            )}
            {mobileOverlay === 'memories' && (
              <MemoriesView
                memories={memories}
                onAddMemory={handleAddMemory}
                onDeleteMemory={handleDeleteMemory}
              />
            )}
            {mobileOverlay === 'skills' && (
              <SkillsView onCountsChange={setSkillCounts} />
            )}
            {mobileOverlay === 'patrol' && (
              <CronJobsView
                jobs={cronJobs}
                onCreateJob={handleCreateCronJob}
                onUpdateJob={handleUpdateCronJob}
                onToggleJob={handleToggleCronJob}
                onDeleteJob={handleDeleteCronJob}
                onTriggerJob={handleTriggerCronJob}
                runs={cronRuns}
                onOpenRun={openCronRun}
              />
            )}
          </div>
        </div>
      );
    };

    return (
      <div className="min-h-[100dvh] w-full bg-[#fbfbfd] text-zinc-900 font-sans antialiased selection:bg-zinc-200">
          {authModalOpen && (
            <AuthModal isOpen onClose={() => setAuthModalOpen(false)} initialTab={authModalTab} />
          )}
          {downloadModalOpen && (
            <DownloadAppModal isOpen onClose={() => setDownloadModalOpen(false)} />
          )}

          {!mobileOverlay && (
            <>
              {mobileTab === 'home' && (
                <MobileHomeView
                  missions={missions}
                  isSubmitting={isSubmitting}
                  userName={userName}
                  isLoggedIn={isLoggedIn}
                  approvalCount={approvalRequests.length + pendingQuestions.length}
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
                <DeliverablesView
                  artifact={artifact}
                  missions={deliverableMissions}
                  variant="mobile"
                  onOpenCockpit={() => setMobileTab('activity')}
                  onRunMission={handleRun}
                  onLoadMissionPart={loadMissionPart}
                />
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
                  pendingQuestions={pendingQuestions}
                  onAnswerQuestion={handleAnswerQuestion}
                  terminalLogs={terminalLogs}
                  onOpenDeliverable={() => setMobileTab('deliverables')}
                  onRunMission={handleRun}
                  onRunNovelChain={(workshop, display) => handleRun(display.prompt, display.title, null, workshop)}
                  isSubmitting={isSubmitting}
                  onStopMission={handleStopMission}
                  onLoadMissionPart={loadMissionPart}
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
                approvalCount={approvalRequests.length + pendingQuestions.length}
                hasActiveMission={hasActiveMission}
              />
            </>
          )}

          {renderOverlay()}
        </div>
    );
  }

  return (
      <div className="min-h-screen w-full bg-[#fbfbfd] text-zinc-900 font-sans antialiased selection:bg-zinc-200">
        {/* Global Minimalist Topbar */}
        <Navbar
          activeView={activeView}
          onViewChange={handleViewChange}
          currentMission={currentMission}
          connectedCount={connectedCount}
          memoryCount={memories.length}
          skillCount={skillCounts.cards + skillCounts.installed}
          patrolCount={cronJobs.filter((j) => j.status === 'active').length}
          goalCount={goals.length}
          approvalRequests={approvalRequests}
          pendingQuestionCount={pendingQuestions.length}
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
          onOpenChannel={() => setChannelModalOpen(true)}
        />

        {/* NextAuth Authentication Modal */}
        {authModalOpen && (
          <AuthModal isOpen onClose={() => setAuthModalOpen(false)} initialTab={authModalTab} />
        )}

        {/* Mobile Download Modal */}
        {downloadModalOpen && (
          <DownloadAppModal isOpen onClose={() => setDownloadModalOpen(false)} />
        )}

        {/* IM 通道弹窗(右上角「IM 通道」唤起,与下载移动版一致形态) */}
        {channelModalOpen && (
          <ChannelModal isOpen onClose={() => setChannelModalOpen(false)} />
        )}

        {/* Main Content Area */}
        <div className="pt-14 h-full">
          {activeView === 'home' && (
            <main className="min-h-[calc(100vh-3.5rem)] overflow-y-auto">
              <HomeView
                onRunMission={handleRun}
                missions={missions}
                connectors={connectors}
                mcpConnectedCount={mcpConnectedCount}
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
              pendingQuestions={pendingQuestions}
              onAnswerQuestion={handleAnswerQuestion}
              artifact={artifact}
              rightTab={rightTab}
              onRightTabChange={setRightTab}
              onLoadMissionPart={loadMissionPart}
              onRunMission={handleRun}
              onRunNovelChain={(workshop, display) => handleRun(display.prompt, display.title, null, workshop)}
              onStopMission={handleStopMission}
              onDeleteMission={handleDeleteMission}
              onNewSession={() => setActiveMissionId(null)}
              isSubmitting={isSubmitting}
              connectors={connectors}
              onSelectModel={handleSetDefaultModel}
              onOpenRunnerTask={(taskId) => {
                setRunnerFocusTaskId(taskId);
                handleViewChange('devices');
              }}
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
                onRunPrompt={(prompt, title, workshop) => handleRun(prompt, title, null, workshop)}
                onOpenConnectors={(depId) => {
                  if (depId) setConnectorLocate(depId);
                  handleViewChange('connectors');
                }}
                missions={deliverableMissions}
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
                locateSearch={connectorLocate}
                onLocateHandled={() => setConnectorLocate(null)}
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

          {activeView === 'skills' && (
            <main className="min-h-[calc(100vh-3.5rem)] overflow-y-auto pb-16 md:pb-0">
              <SkillsView onCountsChange={setSkillCounts} />
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
                runs={cronRuns}
                onOpenRun={openCronRun}
              />
            </main>
          )}

          {activeView === 'deliverables' && (
            <main className="min-h-[calc(100vh-3.5rem)] overflow-y-auto pb-16 md:pb-0">
              <DeliverablesView
                artifact={artifact}
                missions={deliverableMissions}
                onOpenCockpit={() => setActiveView('cockpit')}
                onRunMission={handleRun}
                onLoadMissionPart={loadMissionPart}
              />
            </main>
          )}

          {activeView === 'devices' && (
            <main className="min-h-[calc(100vh-3.5rem)] overflow-y-auto pb-16 md:pb-0">
              <DevicesView
                missions={missions}
                onOpenMission={(missionId) => {
                  setActiveMissionId(missionId);
                  handleViewChange('cockpit');
                }}
                focusTaskId={runnerFocusTaskId}
                onFocusHandled={() => setRunnerFocusTaskId(null)}
              />
            </main>
          )}
        </div>
      </div>
  );
}

/** 懒加载视图的加载态：切到尚未下载完的视图时给轻量占位，避免闪白。 */
function ViewLoading() {
  return (
    <div className="flex min-h-[40vh] items-center justify-center">
      <div className="h-6 w-6 animate-spin rounded-full border-2 border-zinc-300 border-t-zinc-700" />
    </div>
  );
}

/** 首帧骨架：与真实布局同构的浅色占位，避免 JS 未就绪前的白屏。 */
function BootSkeleton() {
  return (
    <div className="min-h-screen w-full bg-[#fbfbfd]">
      <div className="fixed inset-x-0 top-0 z-40 h-14 border-b border-zinc-200/70 bg-white/80 backdrop-blur">
        <div className="flex h-full items-center gap-3 px-4">
          <div className="h-6 w-6 rounded-md bg-zinc-200/80 animate-pulse" />
          <div className="h-4 w-24 rounded bg-zinc-200/80 animate-pulse" />
          <div className="ml-auto flex gap-2">
            <div className="h-7 w-16 rounded-full bg-zinc-200/60 animate-pulse" />
            <div className="h-7 w-16 rounded-full bg-zinc-200/60 animate-pulse" />
          </div>
        </div>
      </div>
      <div className="mx-auto flex max-w-3xl flex-col items-center gap-5 px-6 pt-40">
        <div className="h-9 w-9 animate-spin rounded-full border-2 border-zinc-300 border-t-zinc-700" />
        <div className="h-5 w-40 rounded bg-zinc-200/70 animate-pulse" />
        <div className="h-12 w-full max-w-xl rounded-2xl bg-white shadow-sm ring-1 ring-zinc-200/70" />
      </div>
    </div>
  );
}
