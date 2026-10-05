'use client';

import { useState, useEffect } from 'react';
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
} from 'lucide-react';

interface ConnectorApp {
  id: string;
  name: string;
  category: string;
  iconName: string;
  status: 'connected' | 'available';
  description: string;
  actionCount: number;
}

interface MissionGoal {
  id: string;
  title: string;
  category: string;
  status: 'running' | 'completed' | 'waiting_approval' | 'scheduled';
  progress: number;
  currentAction: string;
  lineage: Array<{
    step: string;
    status: 'done' | 'active' | 'pending';
    detail: string;
    timestamp: string;
  }>;
  signoffRequest?: {
    action: string;
    target: string;
    consequence: string;
    risk: 'high' | 'medium';
  };
}

export default function MetaMuseWorkspace() {
  const [mounted, setMounted] = useState(false);

  // 导航模式：活动监控视口、任务血缘流、应用连接器、主动监控看板、委托灵感库
  const [activeView, setActiveView] = useState<'live_browser' | 'lineage' | 'connectors' | 'missions' | 'ideas'>('live_browser');

  // 连接器生态列表 (对标 Meta Muse 40+ Connectors)
  const [connectors, setConnectors] = useState<ConnectorApp[]>([
    { id: 'google', name: 'Google Workspace', category: '日程/邮件/文档', iconName: 'mail', status: 'connected', description: 'Gmail 邮件检索与日历会议自动编排', actionCount: 18 },
    { id: 'notion', name: 'Notion 个人知识库', category: '笔记/文档', iconName: 'file', status: 'connected', description: '自动结构化记录调研结果与周报', actionCount: 34 },
    { id: 'github', name: 'GitHub 软件仓库', category: '代码/工程', iconName: 'github', status: 'connected', description: 'Issue 监控、PR 审查与代码库补丁提交', actionCount: 52 },
    { id: 'feishu', name: '飞书 / 企微通知中枢', category: '即时通讯', iconName: 'bell', status: 'connected', description: '移动端主动推送富文本卡片与关键决策审批', actionCount: 29 },
    { id: 'e2b', name: 'E2B 云端安全微容器', category: '执行沙箱', iconName: 'database', status: 'connected', description: 'Firecracker 硬件隔离 MicroVM，支持全套科学计算', actionCount: 41 },
    { id: 'mcp', name: 'Anthropic MCP 开放网关', category: '工具标准协议', iconName: 'layers', status: 'connected', description: '标准化连接 Slack、Postgres 与自定义 MCP 服务', actionCount: 16 },
  ]);

  // 当前主线长任务 (Mission)
  const [activeMission, setActiveMission] = useState<MissionGoal>({
    id: 'mission-01',
    title: '全网深度竞品调研与技术选型决策报告',
    category: '自主研究与决策',
    status: 'waiting_approval',
    progress: 75,
    currentAction: '等待人类对关键邮件通知进行安全签批 (Human-in-the-Loop Sign-off)',
    lineage: [
      {
        step: '1. 复杂目标规划与意图锚定',
        status: 'done',
        detail: '自动分解为 4 个执行子目标，预加载 Exa 与 Firecrawl 凭证',
        timestamp: '14:20:05',
      },
      {
        step: '2. 实时全网神经检索与高价值源提取',
        status: 'done',
        detail: '调度 Exa 语义检索获得 12 篇核心技术白皮书与开源架构评测',
        timestamp: '14:21:18',
      },
      {
        step: '3. 持久化浏览器导航与深层内容蒸馏',
        status: 'done',
        detail: '使用 Firecrawl 穿透反爬机制并提取清洗后的 Markdown 正文',
        timestamp: '14:22:40',
      },
      {
        step: '4. 向飞书项目群外发调研简报并同步 Notion',
        status: 'active',
        detail: '触发高危操作安全网关，等待主人点击 Sign-off 签批授权',
        timestamp: '14:23:15',
      },
    ],
    signoffRequest: {
      action: '向核心团队飞书项目群外发技术调研结论简报',
      target: '飞书群聊: #AI-Architecture-Core (共 8 人)',
      consequence: '此操作将直接向外部通讯工具发送包含选型决策的公开卡片',
      risk: 'high',
    },
  });

  // 主动定时任务 (Active Background Missions)
  const [scheduledMissions] = useState([
    {
      id: 'sch-1',
      title: '每日早上 9 点 GitHub AI 趋势雷达巡检',
      cadence: '每天 09:00:00 (Cron: 0 9 * * *)',
      status: 'active',
      nextRun: '明天 09:00:00',
      autoSyncApp: 'Notion + 飞书群',
    },
    {
      id: 'sch-2',
      title: '云端基础设施与 API 成本预算实时熔断守护',
      cadence: '每 30 分钟轮询',
      status: 'active',
      nextRun: '18 分钟后',
      autoSyncApp: '桌面原生弹窗',
    },
  ]);

  // 委托灵感库 (Ideas & Delegation Library)
  const ideas = [
    {
      title: '出差全流程行程编排与日程同步',
      prompt: '帮我规划下周去旧金山的参会行程，检索航班与酒店，并在 Google Calendar 中创建日程块，生成预算表。',
      tags: ['出行', '日历', '预算'],
    },
    {
      title: '行业前沿论文深度研读与知识沉淀',
      prompt: '检索今天 arXiv 上关于 Multi-Agent 和 Self-Correction 的最新论文，提炼核心创新点，并同步保存到我的 Notion 研报库中。',
      tags: ['科研', 'Notion', '自动摘要'],
    },
    {
      title: '代码库安全审计与自动化补丁提交',
      prompt: '在受控沙箱中对当前项目运行安全测试，找出潜在死循环风险，使用 Git 补丁引擎修复并向我展示 Visual Diff。',
      tags: ['工程', '沙箱', 'Git 审查'],
    },
    {
      title: '竞品价格变动自动化监控与告警',
      prompt: '使用智能浏览器打开目标竞品官网定价页，对比上周快照，如有变动立即通过飞书机器人向我发送富文本卡片。',
      tags: ['智能浏览器', '飞书', '持续守护'],
    },
  ];

  // 签批状态
  const [signedOff, setSignedOff] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  return (
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
            <p className="text-[11px] text-slate-400">你的全自主个人数字主理人</p>
          </div>
        </div>

        {/* 核心自主能力导航 */}
        <div className="p-3 space-y-1 text-xs">
          <button
            onClick={() => setActiveView('live_browser')}
            className={`w-full flex items-center justify-between px-3 py-2.5 rounded-xl font-medium transition-all ${
              activeView === 'live_browser'
                ? 'bg-indigo-600 text-white shadow-md shadow-indigo-600/30'
                : 'text-slate-400 hover:bg-slate-800/60 hover:text-slate-200'
            }`}
          >
            <div className="flex items-center gap-2.5">
              <Monitor className="h-4 w-4" />
              <span>实时可视浏览器视口</span>
            </div>
            <span className="h-2 w-2 rounded-full bg-emerald-400 animate-pulse" />
          </button>

          <button
            onClick={() => setActiveView('lineage')}
            className={`w-full flex items-center justify-between px-3 py-2.5 rounded-xl font-medium transition-all ${
              activeView === 'lineage'
                ? 'bg-indigo-600 text-white shadow-md shadow-indigo-600/30'
                : 'text-slate-400 hover:bg-slate-800/60 hover:text-slate-200'
            }`}
          >
            <div className="flex items-center gap-2.5">
              <Activity className="h-4 w-4" />
              <span>任务执行血缘流</span>
            </div>
            {activeMission.signoffRequest && !signedOff && (
              <span className="rounded-full bg-amber-500/20 px-1.5 py-0.2 text-[10px] text-amber-300 font-bold border border-amber-500/30 animate-pulse">
                待签批
              </span>
            )}
          </button>

          <button
            onClick={() => setActiveView('connectors')}
            className={`w-full flex items-center justify-between px-3 py-2.5 rounded-xl font-medium transition-all ${
              activeView === 'connectors'
                ? 'bg-indigo-600 text-white shadow-md shadow-indigo-600/30'
                : 'text-slate-400 hover:bg-slate-800/60 hover:text-slate-200'
            }`}
          >
            <div className="flex items-center gap-2.5">
              <Layers className="h-4 w-4" />
              <span>应用连接器 (Connectors)</span>
            </div>
            <span className="text-[10px] text-slate-500 font-mono">6 已连</span>
          </button>

          <button
            onClick={() => setActiveView('missions')}
            className={`w-full flex items-center justify-between px-3 py-2.5 rounded-xl font-medium transition-all ${
              activeView === 'missions'
                ? 'bg-indigo-600 text-white shadow-md shadow-indigo-600/30'
                : 'text-slate-400 hover:bg-slate-800/60 hover:text-slate-200'
            }`}
          >
            <div className="flex items-center gap-2.5">
              <Calendar className="h-4 w-4" />
              <span>主动巡航任务看板</span>
            </div>
            <span className="text-[10px] text-emerald-400 bg-emerald-500/10 px-1.5 py-0.2 rounded border border-emerald-500/20">
              2 运行
            </span>
          </button>

          <button
            onClick={() => setActiveView('ideas')}
            className={`w-full flex items-center justify-between px-3 py-2.5 rounded-xl font-medium transition-all ${
              activeView === 'ideas'
                ? 'bg-indigo-600 text-white shadow-md shadow-indigo-600/30'
                : 'text-slate-400 hover:bg-slate-800/60 hover:text-slate-200'
            }`}
          >
            <div className="flex items-center gap-2.5">
              <Sparkles className="h-4 w-4" />
              <span>委托灵感库 (Ideas)</span>
            </div>
            <span className="text-[10px] text-purple-400">推荐</span>
          </button>
        </div>

        {/* 底部隔离安全状态条 (Sentinel Security) */}
        <div className="mt-auto p-4 border-t border-slate-800/80 bg-slate-950/40">
          <div className="flex items-center justify-between text-xs text-slate-400 mb-2">
            <span className="flex items-center gap-1.5 text-slate-300 font-medium">
              <Shield className="h-3.5 w-3.5 text-emerald-400" /> Sentinel 哨兵守护
            </span>
            <span className="text-[10px] text-emerald-400 font-mono">100% 隔离安全</span>
          </div>
          <p className="text-[11px] text-slate-500 leading-relaxed">
            运行于隔离云端微虚拟机中。高危外发与支付均强制等待主人签批确认。
          </p>
        </div>
      </aside>

      {/* 2. 中央大舞台工作区 (Executive Hub Stage) */}
      <main className="flex-1 flex flex-col min-w-0 bg-slate-950 overflow-hidden">
        {/* 顶部状态条 */}
        <header className="h-16 border-b border-slate-800/80 bg-slate-900/40 px-6 flex items-center justify-between backdrop-blur">
          <div className="flex items-center gap-3">
            <span className="text-xs text-slate-400">当前任务目标:</span>
            <span className="text-sm font-bold text-white flex items-center gap-2">
              {activeMission.title}
              <span className="rounded-full bg-indigo-500/10 px-2 py-0.5 text-[10px] font-semibold text-indigo-400 border border-indigo-500/20">
                {activeMission.category}
              </span>
            </span>
          </div>

          <div className="flex items-center gap-3 text-xs">
            <span className="text-slate-400">推进进度:</span>
            <div className="w-32 bg-slate-800 h-2 rounded-full overflow-hidden">
              <div
                className="bg-gradient-to-r from-indigo-500 to-purple-500 h-full transition-all duration-500"
                style={{ width: `${activeMission.progress}%` }}
              />
            </div>
            <span className="font-mono text-emerald-400 font-semibold">{activeMission.progress}%</span>
          </div>
        </header>

        {/* 主舞台视口内容切换 */}
        <div className="flex-1 overflow-y-auto p-6">
          {/* A. 实时可视浏览器视口 (Live Browser View - 对标 Meta Muse 核心体验) */}
          {activeView === 'live_browser' && (
            <div className="space-y-4 max-w-5xl mx-auto h-full flex flex-col">
              <div className="flex items-center justify-between">
                <div>
                  <h2 className="text-base font-bold text-white flex items-center gap-2">
                    <Globe className="h-4 w-4 text-cyan-400" />
                    智能体实时可视浏览器视口 (Live Agent Browser)
                  </h2>
                  <p className="text-xs text-slate-400 mt-1">
                    实时透视智能体正在浏览、点击、抽取信息的网页视口。你可随时点击右上角介入接管。
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <span className="flex items-center gap-1 text-[11px] text-emerald-400 font-mono bg-emerald-500/10 px-2.5 py-1 rounded-lg border border-emerald-500/20">
                    <span className="h-2 w-2 rounded-full bg-emerald-400 animate-pulse" />
                    Stagehand AI 驱动中
                  </span>
                  <button className="flex items-center gap-1.5 text-xs bg-slate-800 hover:bg-slate-700 text-slate-200 px-3 py-1.5 rounded-lg border border-slate-700 transition-all">
                    <Pause className="h-3 w-3" /> 人工暂停/介入
                  </button>
                </div>
              </div>

              {/* 模拟浏览器窗口视口 */}
              <div className="flex-1 rounded-2xl border border-slate-800 bg-slate-900/60 overflow-hidden shadow-2xl flex flex-col min-h-[520px]">
                {/* 浏览器地址控制栏 */}
                <div className="h-10 bg-slate-900 border-b border-slate-800 px-4 flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className="flex gap-1.5">
                      <div className="h-2.5 w-2.5 rounded-full bg-rose-500/60" />
                      <div className="h-2.5 w-2.5 rounded-full bg-amber-500/60" />
                      <div className="h-2.5 w-2.5 rounded-full bg-emerald-500/60" />
                    </div>
                    <div className="rounded-md bg-slate-950 border border-slate-800 px-3 py-1 text-[11px] text-slate-300 font-mono flex items-center gap-2">
                      <Lock className="h-3 w-3 text-emerald-400" />
                      <span>https://huggingface.co/papers/autonomous-agents</span>
                    </div>
                  </div>
                  <div className="text-[11px] text-indigo-400 font-mono">
                    蒸馏提取率: 98.4%
                  </div>
                </div>

                {/* 模拟真实智能体视口渲染 */}
                <div className="flex-1 bg-slate-950 p-6 overflow-y-auto">
                  <div className="max-w-3xl mx-auto space-y-6">
                    <div className="p-4 rounded-xl bg-slate-900 border border-slate-800 relative overflow-hidden">
                      <div className="absolute top-2 right-2 bg-indigo-500/20 text-indigo-300 border border-indigo-500/30 text-[10px] px-2 py-0.5 rounded font-mono">
                        智能体当前聚焦目标
                      </div>
                      <h3 className="text-lg font-bold text-white mb-2">
                        State-of-the-Art Autonomous Agents with Environmental Feedback
                      </h3>
                      <p className="text-xs text-slate-400 leading-relaxed">
                        本论文详细评测了具备工具调用、自我反思与多应用连接能力的全新自主智能体范式。智能体正在自动提炼论文第二章节架构图...
                      </p>
                    </div>

                    <div className="grid grid-cols-3 gap-4 text-xs font-mono">
                      <div className="p-3 bg-slate-900/60 rounded-xl border border-slate-800/80">
                        <span className="text-slate-500 block mb-1">页面加载耗时</span>
                        <span className="text-white font-bold">420 ms</span>
                      </div>
                      <div className="p-3 bg-slate-900/60 rounded-xl border border-slate-800/80">
                        <span className="text-slate-500 block mb-1">已捕获关键实体</span>
                        <span className="text-cyan-400 font-bold">14 项指标</span>
                      </div>
                      <div className="p-3 bg-slate-900/60 rounded-xl border border-slate-800/80">
                        <span className="text-slate-500 block mb-1">下步动作</span>
                        <span className="text-emerald-400 font-bold">生成 Notion 报告</span>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* B. 任务执行血缘流与签批卡片 (Task Lineage & Sign-off) */}
          {activeView === 'lineage' && (
            <div className="space-y-6 max-w-4xl mx-auto">
              <div>
                <h2 className="text-base font-bold text-white flex items-center gap-2">
                  <Activity className="h-4 w-4 text-purple-400" />
                  任务目标分解与执行血缘树 (Task Lineage)
                </h2>
                <p className="text-xs text-slate-400 mt-1">
                  对标 Meta Muse 核心特性：多步骤复杂任务完全透明化，高危外发动作必须获得主人授权签署。
                </p>
              </div>

              {/* 关键签批卡片 (Human-in-the-Loop Sign-off Card) */}
              {activeMission.signoffRequest && (
                <div
                  className={`rounded-2xl border p-5 transition-all ${
                    signedOff
                      ? 'border-emerald-500/40 bg-emerald-950/20'
                      : 'border-amber-500/50 bg-amber-950/20 shadow-xl shadow-amber-500/10'
                  }`}
                >
                  <div className="flex items-start justify-between">
                    <div className="flex items-start gap-3">
                      <div className="mt-1">
                        {signedOff ? (
                          <CheckCircle2 className="h-5 w-5 text-emerald-400" />
                        ) : (
                          <ShieldAlert className="h-5 w-5 text-amber-400 animate-pulse" />
                        )}
                      </div>
                      <div>
                        <div className="flex items-center gap-2">
                          <span
                            className={`text-xs font-bold font-mono px-2 py-0.5 rounded ${
                              signedOff
                                ? 'bg-emerald-500/20 text-emerald-300'
                                : 'bg-amber-500/20 text-amber-300'
                            }`}
                          >
                            {signedOff ? '已授权签署 (SIGNED-OFF)' : '需要主人授权签署 (SIGN-OFF REQUIRED)'}
                          </span>
                        </div>
                        <h3 className="text-sm font-semibold text-white mt-1.5">
                          {activeMission.signoffRequest.action}
                        </h3>
                        <p className="text-xs text-slate-400 mt-1">
                          目标对象: <strong className="text-slate-200">{activeMission.signoffRequest.target}</strong>
                        </p>
                        <p className="text-[11px] text-slate-500 mt-0.5">
                          后果提示: {activeMission.signoffRequest.consequence}
                        </p>
                      </div>
                    </div>

                    {!signedOff ? (
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => alert('已取消该敏感动作')}
                          className="px-3 py-1.5 rounded-xl border border-slate-700 bg-slate-800 text-xs text-slate-300 hover:bg-slate-700"
                        >
                          驳回
                        </button>
                        <button
                          onClick={() => setSignedOff(true)}
                          className="flex items-center gap-1.5 px-4 py-1.5 rounded-xl bg-amber-500 hover:bg-amber-400 text-slate-950 font-bold text-xs transition-all shadow-md shadow-amber-500/20"
                        >
                          <Check className="h-3.5 w-3.5 stroke-[3]" />
                          确认签署 (Sign-off)
                        </button>
                      </div>
                    ) : (
                      <span className="text-xs font-mono text-emerald-400 flex items-center gap-1">
                        <Check className="h-3 w-3" /> 操作已合规放行
                      </span>
                    )}
                  </div>
                </div>
              )}

              {/* 血缘树列表 */}
              <div className="space-y-3">
                {activeMission.lineage.map((item, idx) => (
                  <div
                    key={idx}
                    className="p-4 rounded-xl border border-slate-800 bg-slate-900/40 flex items-start justify-between"
                  >
                    <div className="flex items-start gap-3">
                      <div className="mt-0.5">
                        {item.status === 'done' ? (
                          <CheckCircle2 className="h-4 w-4 text-emerald-400" />
                        ) : item.status === 'active' ? (
                          <div className="h-4 w-4 rounded-full border-2 border-indigo-400 border-t-transparent animate-spin" />
                        ) : (
                          <Clock className="h-4 w-4 text-slate-600" />
                        )}
                      </div>
                      <div>
                        <h4 className="text-xs font-semibold text-white">{item.step}</h4>
                        <p className="text-[11px] text-slate-400 mt-0.5 leading-relaxed">{item.detail}</p>
                      </div>
                    </div>
                    <span className="text-[10px] font-mono text-slate-500">{item.timestamp}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* C. 应用生态连接器 (App Connectors Hub - 对标 Meta Muse 40+ Connectors) */}
          {activeView === 'connectors' && (
            <div className="space-y-6 max-w-5xl mx-auto">
              <div>
                <h2 className="text-base font-bold text-white flex items-center gap-2">
                  <Layers className="h-4 w-4 text-indigo-400" />
                  个人生活与工作生态连接器 (Connectors Hub)
                </h2>
                <p className="text-xs text-slate-400 mt-1">
                  让智能体跨越单一应用壁垒，串联 Google Workspace、Notion、GitHub、飞书与自定义 MCP 服务。
                </p>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {connectors.map((c) => (
                  <div
                    key={c.id}
                    className="rounded-2xl border border-slate-800 bg-slate-900/50 p-5 backdrop-blur hover:border-indigo-500/40 transition-all flex flex-col justify-between"
                  >
                    <div>
                      <div className="flex items-center justify-between mb-3">
                        <span className="text-[10px] uppercase font-bold text-indigo-400 bg-indigo-500/10 px-2 py-0.5 rounded border border-indigo-500/20">
                          {c.category}
                        </span>
                        <span className="flex items-center gap-1 text-[10px] text-emerald-400 font-mono bg-emerald-500/10 px-2 py-0.5 rounded-full border border-emerald-500/20">
                          <Check className="h-3 w-3" /> 已授权连接
                        </span>
                      </div>
                      <h3 className="text-sm font-bold text-white mb-1">{c.name}</h3>
                      <p className="text-xs text-slate-400 leading-relaxed mb-4">{c.description}</p>
                    </div>

                    <div className="flex items-center justify-between pt-3 border-t border-slate-800/80 text-[11px] text-slate-500">
                      <span>已累计调度: <strong className="text-slate-300 font-mono">{c.actionCount} 次</strong></span>
                      <button className="text-indigo-400 hover:text-indigo-300 font-medium">配置权限 →</button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* D. 主动定时巡航看板 (Scheduled Missions & Dashboards) */}
          {activeView === 'missions' && (
            <div className="space-y-6 max-w-4xl mx-auto">
              <div>
                <h2 className="text-base font-bold text-white flex items-center gap-2">
                  <Calendar className="h-4 w-4 text-amber-400" />
                  主动巡航任务与定期自动看板 (Active Background Missions)
                </h2>
                <p className="text-xs text-slate-400 mt-1">
                  即使你关闭网页或处于离线状态，智能体仍在后台无人值守自动运行，并将最终结论汇入你的应用中。
                </p>
              </div>

              <div className="space-y-4">
                {scheduledMissions.map((mission) => (
                  <div
                    key={mission.id}
                    className="p-5 rounded-2xl border border-slate-800 bg-slate-900/50 backdrop-blur flex items-center justify-between"
                  >
                    <div>
                      <div className="flex items-center gap-2">
                        <h3 className="text-sm font-bold text-white">{mission.title}</h3>
                        <span className="rounded bg-slate-800 px-2 py-0.5 text-xs font-mono text-amber-400 border border-slate-700">
                          {mission.cadence}
                        </span>
                      </div>
                      <div className="flex items-center gap-4 text-xs text-slate-400 mt-2">
                        <span>下次触发: <strong className="text-slate-200">{mission.nextRun}</strong></span>
                        <span>结果同步至: <strong className="text-indigo-300">{mission.autoSyncApp}</strong></span>
                      </div>
                    </div>

                    <span className="rounded-full bg-emerald-500/10 px-3 py-1 text-xs font-semibold text-emerald-400 border border-emerald-500/20 font-mono">
                      后台巡航中
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* E. 委托灵感库 (Ideas & Delegation Library) */}
          {activeView === 'ideas' && (
            <div className="space-y-6 max-w-4xl mx-auto">
              <div>
                <h2 className="text-base font-bold text-white flex items-center gap-2">
                  <Sparkles className="h-4 w-4 text-purple-400" />
                  智能体委托灵感库 (Delegation Ideas)
                </h2>
                <p className="text-xs text-slate-400 mt-1">
                  不知道该把哪些繁琐任务交给智能体？点击下方卡片，一键下发端到端复杂委托。
                </p>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {ideas.map((idea, idx) => (
                  <div
                    key={idx}
                    className="p-5 rounded-2xl border border-slate-800 bg-slate-900/50 hover:border-purple-500/40 transition-all flex flex-col justify-between"
                  >
                    <div>
                      <h3 className="text-sm font-bold text-white mb-2">{idea.title}</h3>
                      <p className="text-xs text-slate-400 leading-relaxed mb-4">{idea.prompt}</p>
                      <div className="flex gap-1.5 mb-4">
                        {idea.tags.map((t, i) => (
                          <span
                            key={i}
                            className="rounded bg-slate-800/80 px-2 py-0.5 text-[10px] text-slate-400 border border-slate-700"
                          >
                            #{t}
                          </span>
                        ))}
                      </div>
                    </div>

                    <button
                      onClick={() => alert(`已将委托加入对话: "${idea.prompt}"`)}
                      className="w-full flex items-center justify-center gap-1.5 py-2 rounded-xl bg-indigo-600/20 hover:bg-indigo-600 text-indigo-300 hover:text-white border border-indigo-500/30 text-xs font-semibold transition-all"
                    >
                      <Send className="h-3.5 w-3.5" /> 一键下发此委托
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </main>

      {/* 3. 右侧对话交互驾驶舱 (Copilot Assistant) */}
      {mounted && (
        <CopilotKit runtimeUrl="/api/copilotkit">
          <CopilotSidebar
            instructions="你是由 DeepSeek Harness 官方 Cordis 插件微内核驱动的个人全自主主理人助手 (agtpilot - 对标 Meta Muse)。你可以自主规划跨应用复杂长任务，调用实时浏览器、连接 Google Workspace、Notion、GitHub 与飞书。遇到发送外部邮件或高危指令时，生成规范的 Human-in-the-Loop 签批授权。"
            labels={{
              title: 'agtpilot 主理人',
              initial: '你好！我是你的个人全自主智能体。我已经打通实时网页视口、任务血缘流、Google Workspace / Notion / 飞书连接器以及安全签批机制。请告诉我你想交托给我的目标（例如：“分析今天 GitHub AI 趋势并生成周报同步到 Notion”）。',
            }}
            defaultOpen={true}
            clickOutsideToClose={false}
          />
        </CopilotKit>
      )}
    </div>
  );
}
