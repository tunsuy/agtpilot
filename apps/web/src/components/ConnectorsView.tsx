'use client';

import React, { useEffect, useState } from 'react';
import {
  Layers,
  Key,
  Check,
  Search,
  ExternalLink,
  ShieldCheck,
  RotateCw,
  X,
  Sparkles,
  Cpu,
  Bot,
  Terminal,
  GitBranch,
  FileText,
  MessageSquare,
  Bell,
  Globe,
  Flame,
  Zap,
  Share2,
  Smartphone,
  Laptop,
  MapPin,
  Map,
  Building2,
  Video,
  FileSpreadsheet,
  BookOpen,
  Plug,
  Unplug,
  Car,
  Cloud,
  Library,
  NotebookPen,
  Palette,
  MessagesSquare,
  Mail,
  Inbox,
  ClipboardList,
  Feather,
  Tv,
  Github,
  BookMarked,
  KanbanSquare,
  TrendingUp,
  LineChart,
  Coins,
  CandlestickChart,
  Activity,
  GraduationCap,
  BookOpenText,
  Languages,
  Newspaper,
  Twitter,
} from 'lucide-react';
import { ConnectorApp, McpConnectorInfo } from '../types/agent';
import { openAppScheme, isNativePlatform } from '../utils/nativeBridge';
import { buildXhsWorkshopPrompt, XHS_WORKSHOP_STYLES } from '../lib/xhs-workshop';
import {
  buildWeiboWorkshopPrompt,
  buildVideoScriptPrompt,
  WEIBO_WORKSHOP_STYLES,
  VIDEO_SCRIPT_DURATIONS,
} from '../lib/content-workshops';
import {
  buildEmailTriagePrompt,
  buildWeeklyReportPrompt,
  EMAIL_TRIAGE_SCOPES,
  WEEKLY_REPORT_PERIODS,
  WEEKLY_REPORT_AUDIENCES,
  WEEKLY_REPORT_DELIVERIES,
  type EmailTriageScope,
  type WeeklyReportPeriod,
  type WeeklyReportAudience,
  type WeeklyReportDelivery,
} from '../lib/office-workshops';
import {
  buildInvestPrompt,
  INVEST_MODES,
  REVIEW_MARKETS,
  RISK_PROFILES,
  INVEST_DELIVERIES,
  type InvestMode,
  type RiskProfile,
  type InvestDelivery,
} from '../lib/invest-workshops';
import {
  buildEduPrompt,
  EDU_MODES,
  FLASHCARD_TYPES,
  FLASHCARD_FORMATS,
  EDU_DELIVERIES,
  type EduMode,
  type FlashcardType,
  type FlashcardFormat,
  type EduDelivery,
} from '../lib/edu-workshops';

function renderMcpIcon(id: string, className = 'h-5 w-5') {
  switch (id) {
    case 'notion_mcp':
      return <FileText className={`${className} text-zinc-800`} />;
    case 'dida365':
      return <Check className={`${className} text-emerald-600`} />;
    case 'openalex':
      return <Search className={`${className} text-amber-600`} />;
    case 'qcc':
      return <Building2 className={`${className} text-blue-700`} />;
    case 'amap':
      return <MapPin className={`${className} text-sky-600`} />;
    case 'baidu_map':
      return <Map className={`${className} text-blue-600`} />;
    case 'tencent_docs':
      return <FileSpreadsheet className={`${className} text-blue-500`} />;
    case 'tencent_meeting':
      return <Video className={`${className} text-indigo-600`} />;
    case 'ardot':
      return <Palette className={`${className} text-violet-600`} />;
    case 'didi':
      return <Car className={`${className} text-orange-600`} />;
    case 'tencent_weiyun':
      return <Cloud className={`${className} text-sky-500`} />;
    case 'tencent_lexiang':
      return <Library className={`${className} text-cyan-600`} />;
    case 'youdao_note':
      return <NotebookPen className={`${className} text-emerald-600`} />;
    case 'zhihu':
      return <MessagesSquare className={`${className} text-blue-600`} />;
    case 'deepwiki':
      return <BookOpen className={`${className} text-zinc-700`} />;
    case 'lark_suite':
      return <Feather className={`${className} text-sky-500`} />;
    case 'dingtalk_mcp':
      return <Zap className={`${className} text-blue-600`} />;
    case 'atlassian_mcp':
      return <KanbanSquare className={`${className} text-blue-700`} />;
    case 'github_mcp':
      return <Github className={`${className} text-zinc-900`} />;
    case 'yuque':
      return <BookMarked className={`${className} text-emerald-600`} />;
    case 'tushare':
      return <TrendingUp className={`${className} text-blue-600`} />;
    case 'alphavantage_mcp':
      return <LineChart className={`${className} text-amber-600`} />;
    case 'coingecko_mcp':
      return <Coins className={`${className} text-emerald-600`} />;
    case 'a_stock':
      return <CandlestickChart className={`${className} text-red-600`} />;
    case 'alphaxiv':
      return <BookOpenText className={`${className} text-indigo-600`} />;
    case 'huggingface_mcp':
      return <Bot className={`${className} text-amber-500`} />;
    case 'deepl_mcp':
      return <Languages className={`${className} text-sky-700`} />;
    case 'newsnow':
      return <Newspaper className={`${className} text-orange-600`} />;
    case 'twitterapi_io':
      return <Twitter className={`${className} text-zinc-900`} />;
    case 'browser_auto':
      return <Globe className={`${className} text-emerald-600`} />;
    default:
      return <Plug className={`${className} text-zinc-600`} />;
  }
}

function renderConnectorIcon(id: string, className = 'h-5 w-5') {
  switch (id) {
    case 'deepseek':
      return <Cpu className={`${className} text-blue-600`} />;
    case 'openai':
      return <Bot className={`${className} text-emerald-600`} />;
    case 'e2b':
      return <Terminal className={`${className} text-amber-600`} />;
    case 'github':
      return <GitBranch className={`${className} text-zinc-900`} />;
    case 'notion':
      return <FileText className={`${className} text-zinc-800`} />;
    case 'slack':
      return <MessageSquare className={`${className} text-fuchsia-600`} />;
    case 'feishu':
      return <Bell className={`${className} text-sky-500`} />;
    case 'dingtalk':
      return <Zap className={`${className} text-blue-600`} />;
    case 'wecom':
      return <Bell className={`${className} text-blue-500`} />;
    case 'email_smtp':
      return <Mail className={`${className} text-violet-600`} />;
    case 'email_imap':
      return <Inbox className={`${className} text-indigo-600`} />;
    case 'weekly_report':
      return <ClipboardList className={`${className} text-sky-600`} />;
    case 'invest_workshop':
      return <Activity className={`${className} text-emerald-600`} />;
    case 'edu_workshop':
      return <GraduationCap className={`${className} text-indigo-600`} />;
    case 'exa':
      return <Search className={`${className} text-indigo-600`} />;
    case 'tavily':
      return <Globe className={`${className} text-teal-600`} />;
    case 'firecrawl':
      return <Flame className={`${className} text-orange-600`} />;
    case 'xiaohongshu':
      return <Share2 className={`${className} text-rose-600`} />;
    case 'weibo':
      return <MessagesSquare className={`${className} text-orange-500`} />;
    case 'douyin':
      return <Video className={`${className} text-zinc-900`} />;
    case 'bilibili':
      return <Tv className={`${className} text-sky-500`} />;
    case 'wechat_mp':
      return <Share2 className={`${className} text-emerald-600`} />;
    case 'twitter':
      return <Share2 className={`${className} text-zinc-900`} />;
    default:
      return <Zap className={`${className} text-zinc-600`} />;
  }
}

/**
 * 连接器页 Tab 分组(按用户意图人工策展,原生与 MCP 连接器混排)。
 * 不在任何分组里的新连接器自动落入「其他」兜底 Tab,不会静默消失。
 */
const CONNECTOR_TABS: Array<{ key: string; label: string; ids: string[] }> = [
  { key: 'models', label: '模型推理', ids: ['deepseek', 'openai', 'custom_llm'] },
  { key: 'search', label: '搜索与数据', ids: ['exa', 'tavily', 'firecrawl', 'zhihu', 'newsnow', 'twitterapi_io', 'deepwiki', 'openalex', 'qcc'] },
  { key: 'office', label: '办公协作', ids: ['notion_mcp', 'lark_suite', 'dingtalk_mcp', 'atlassian_mcp', 'yuque', 'weekly_report', 'dida365', 'tencent_docs', 'tencent_meeting', 'youdao_note', 'tencent_weiyun', 'tencent_lexiang', 'ardot'] },
  { key: 'invest', label: '投资理财', ids: ['tushare', 'alphavantage_mcp', 'coingecko_mcp', 'a_stock', 'invest_workshop'] },
  { key: 'edu', label: '学习教研', ids: ['openalex', 'alphaxiv', 'huggingface_mcp', 'deepl_mcp', 'deepwiki', 'edu_workshop'] },
  { key: 'travel', label: '地图出行', ids: ['amap', 'baidu_map', 'didi'] },
  { key: 'publish', label: '通知与发布', ids: ['slack', 'feishu', 'dingtalk', 'wecom', 'email_smtp', 'email_imap', 'wechat_mp', 'xiaohongshu', 'weibo', 'douyin', 'bilibili', 'twitter'] },
  { key: 'dev', label: '开发与云', ids: ['github', 'github_mcp', 'e2b', 'browser_auto'] },
];
const TABBED_IDS = new Set(CONNECTOR_TABS.flatMap((t) => t.ids));

interface ConnectorsViewProps {
  connectors: ConnectorApp[];
  onSaveKey: (
    envVar: string,
    value: string,
    extra?: { baseUrl?: string; baseUrlEnvVar?: string; modelName?: string; modelNameEnvVar?: string }
  ) => Promise<void>;
  onSetDefaultModel: (modelId: string) => Promise<void>;
  /** 内容工坊:把结构化 Prompt 作为新任务交给 Agent 执行并跳转任务页 */
  onRunPrompt?: (prompt: string, title?: string) => void | Promise<void>;
  /** 任务中途授权跳转过来时自动打开对应连接器的配置弹窗 */
  autoConfigureId?: string | null;
  onAutoConfigureHandled?: () => void;
}

export function ConnectorsView({
  connectors,
  onSaveKey,
  onSetDefaultModel,
  onRunPrompt,
  autoConfigureId,
  onAutoConfigureHandled,
}: ConnectorsViewProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [tab, setTab] = useState('all');
  const [configuringApp, setConfiguringApp] = useState<ConnectorApp | null>(null);
  const [keyInput, setKeyInput] = useState('');
  const [baseUrlInput, setBaseUrlInput] = useState('');
  const [modelNameInput, setModelNameInput] = useState('');
  const [isSaving, setIsSaving] = useState(false);

  // ---- 真机唤起可用性:Capacitor 原生壳或手机浏览器 UA;桌面端隐藏按钮(scheme 打不开是死按钮) ----
  const [mobileCtx, setMobileCtx] = useState(false);
  useEffect(() => {
    let native = false;
    try {
      native = isNativePlatform();
    } catch {
      // Capacitor 桥未就绪时按 UA 兜底
    }
    const uaMobile =
      typeof navigator !== 'undefined' && /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
    setMobileCtx(native || uaMobile);
  }, []);

  // ---- MCP 连接器（官方托管直连，自取数据，独立于外部 props）----
  const [mcpConnectors, setMcpConnectors] = useState<McpConnectorInfo[]>([]);
  const [mcpConfiguring, setMcpConfiguring] = useState<McpConnectorInfo | null>(null);
  const [mcpTokenInput, setMcpTokenInput] = useState('');
  const [mcpSaving, setMcpSaving] = useState(false);
  const [mcpNotice, setMcpNotice] = useState('');

  // ---- 内容/脚本工坊（半自动运营：Agent 选题+创作，发布仍由用户在 App 人工确认）----
  // 小红书/微博 = 图文内容工坊；抖音/B站 = 短视频脚本工坊；同一弹窗按 wsKind 复用
  const [workshopApp, setWorkshopApp] = useState<ConnectorApp | null>(null);
  const [wsTopic, setWsTopic] = useState('');
  const [wsStyle, setWsStyle] = useState<string>(XHS_WORKSHOP_STYLES[0]);
  const [wsCount, setWsCount] = useState(1);
  const [wsDuration, setWsDuration] = useState<string>(VIDEO_SCRIPT_DURATIONS[1]);

  // ---- 办公工坊：邮件分诊 / 周报生成（office-workshops.ts）----
  const [etScope, setEtScope] = useState<EmailTriageScope>('unread');
  const [etFocus, setEtFocus] = useState('');
  const [etDraft, setEtDraft] = useState(true);
  const [wrPeriod, setWrPeriod] = useState<WeeklyReportPeriod>('this_week');
  const [wrAudience, setWrAudience] = useState<WeeklyReportAudience>('leader');
  const [wrDelivery, setWrDelivery] = useState<WeeklyReportDelivery>('chat');
  const [wrExtras, setWrExtras] = useState('');

  // ---- 投研工坊：个股/基金体检 / 组合体检 / 盘后复盘（invest-workshops.ts）----
  const [ivMode, setIvMode] = useState<InvestMode>('stock_check');
  const [ivSymbols, setIvSymbols] = useState('');
  const [ivFocus, setIvFocus] = useState('');
  const [ivHoldings, setIvHoldings] = useState('');
  const [ivRisk, setIvRisk] = useState<RiskProfile>('balanced');
  const [ivMarkets, setIvMarkets] = useState<string[]>(['a_share']);
  const [ivDelivery, setIvDelivery] = useState<InvestDelivery>('chat');

  const toggleIvMarket = (id: string) =>
    setIvMarkets((prev) => (prev.includes(id) ? prev.filter((m) => m !== id) : [...prev, id]));

  // ---- 教研工坊：文献综述 / 论文精读 / 智能备课 / 学习卡片（edu-workshops.ts）----
  const [ewMode, setEwMode] = useState<EduMode>('literature_review');
  const [ewTopic, setEwTopic] = useState('');
  const [ewFocus, setEwFocus] = useState('');
  const [ewPaper, setEwPaper] = useState('');
  const [ewSubject, setEwSubject] = useState('');
  const [ewGrade, setEwGrade] = useState('');
  const [ewDuration, setEwDuration] = useState('');
  const [ewExtras, setEwExtras] = useState('');
  const [ewMaterial, setEwMaterial] = useState('');
  const [ewCardType, setEwCardType] = useState<FlashcardType>('mixed');
  const [ewCardFormat, setEwCardFormat] = useState<FlashcardFormat>('anki_csv');
  const [ewDelivery, setEwDelivery] = useState<EduDelivery>('chat');

  const wsKind: 'xhs' | 'weibo' | 'video' | 'email_triage' | 'weekly' | 'invest' | 'edu' | null = workshopApp
    ? workshopApp.id === 'weibo'
      ? 'weibo'
      : workshopApp.id === 'douyin' || workshopApp.id === 'bilibili'
      ? 'video'
      : workshopApp.id === 'email_imap'
      ? 'email_triage'
      : workshopApp.id === 'weekly_report'
      ? 'weekly'
      : workshopApp.id === 'invest_workshop'
      ? 'invest'
      : workshopApp.id === 'edu_workshop'
      ? 'edu'
      : 'xhs'
    : null;

  const openWorkshop = (app: ConnectorApp) => {
    setWorkshopApp(app);
    setWsTopic('');
    setWsCount(1);
    setWsStyle(app.id === 'weibo' ? WEIBO_WORKSHOP_STYLES[0] : XHS_WORKSHOP_STYLES[0]);
    setWsDuration(VIDEO_SCRIPT_DURATIONS[1]);
    // 办公工坊默认值
    setEtScope('unread');
    setEtFocus('');
    setEtDraft(true);
    setWrPeriod('this_week');
    setWrAudience('leader');
    setWrDelivery('chat');
    setWrExtras('');
    // 投研工坊默认值
    setIvMode('stock_check');
    setIvSymbols('');
    setIvFocus('');
    setIvHoldings('');
    setIvRisk('balanced');
    setIvMarkets(['a_share']);
    setIvDelivery('chat');
    // 教研工坊默认值
    setEwMode('literature_review');
    setEwTopic('');
    setEwFocus('');
    setEwPaper('');
    setEwSubject('');
    setEwGrade('');
    setEwDuration('');
    setEwExtras('');
    setEwMaterial('');
    setEwCardType('mixed');
    setEwCardFormat('anki_csv');
    setEwDelivery('chat');
  };

  const handleWorkshopRun = () => {
    if (!workshopApp || !onRunPrompt || !wsKind) return;
    if (wsKind === 'email_triage') {
      const prompt = buildEmailTriagePrompt({ scope: etScope, focus: etFocus, draftReplies: etDraft });
      const scopeName = EMAIL_TRIAGE_SCOPES.find((s) => s.id === etScope)?.name || '邮件';
      onRunPrompt(prompt, `邮件分诊 · ${scopeName}`);
    } else if (wsKind === 'weekly') {
      const prompt = buildWeeklyReportPrompt({
        period: wrPeriod,
        audience: wrAudience,
        delivery: wrDelivery,
        extras: wrExtras,
      });
      const periodName = WEEKLY_REPORT_PERIODS.find((p) => p.id === wrPeriod)?.name || '周报';
      onRunPrompt(prompt, `周报生成 · ${periodName}`);
    } else if (wsKind === 'invest') {
      const prompt = buildInvestPrompt({
        mode: ivMode,
        symbols: ivSymbols,
        focus: ivFocus,
        holdings: ivHoldings,
        riskProfile: ivRisk,
        markets: ivMarkets,
        delivery: ivDelivery,
      });
      const modeName = INVEST_MODES.find((m) => m.id === ivMode)?.name || '投研';
      onRunPrompt(prompt, `投研 · ${modeName}`);
    } else if (wsKind === 'edu') {
      const prompt = buildEduPrompt({
        mode: ewMode,
        topic: ewTopic,
        focus: ewFocus,
        paper: ewPaper,
        subject: ewSubject,
        grade: ewGrade,
        duration: ewDuration,
        extras: ewExtras,
        material: ewMaterial,
        cardType: ewCardType,
        cardFormat: ewCardFormat,
        delivery: ewDelivery,
      });
      const modeName = EDU_MODES.find((m) => m.id === ewMode)?.name || '教研';
      onRunPrompt(prompt, `教研 · ${modeName}`);
    } else if (wsKind === 'video') {
      const isBili = workshopApp.id === 'bilibili';
      const prompt = buildVideoScriptPrompt({
        topic: wsTopic,
        platform: isBili ? 'bilibili' : 'douyin',
        duration: wsDuration,
        count: wsCount,
      });
      onRunPrompt(prompt, `${isBili ? 'B站' : '抖音'}短视频脚本工坊 · ${wsDuration}`);
    } else if (wsKind === 'weibo') {
      const prompt = buildWeiboWorkshopPrompt({ topic: wsTopic, style: wsStyle, count: wsCount });
      onRunPrompt(prompt, `微博内容工坊 · ${wsStyle}`);
    } else {
      const prompt = buildXhsWorkshopPrompt({ topic: wsTopic, style: wsStyle, count: wsCount });
      onRunPrompt(prompt, `小红书内容工坊 · ${wsStyle}`);
    }
    setWorkshopApp(null);
    setWsTopic('');
    setWsStyle(XHS_WORKSHOP_STYLES[0]);
    setWsCount(1);
  };

  const loadMcpConnectors = async () => {
    try {
      const res = await fetch('/api/connectors/mcp');
      const data = await res.json();
      if (data.success) setMcpConnectors(data.connectors || []);
    } catch {
      // 未登录/后端未就绪时静默
    }
  };
  useEffect(() => {
    loadMcpConnectors();
  }, []);

  // OAuth 回跳结果提示（/?tab=connectors&authorized=xxx / &error=xxx）
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    const authorized = params.get('authorized');
    const error = params.get('error');
    if (authorized) {
      setMcpNotice(`✅ 「${authorized}」授权成功，工具已挂载，任务可继续使用。`);
    } else if (error) {
      setMcpNotice(`⚠️ ${error}`);
    }
  }, []);

  // 任务中途授权（粘贴凭证类）：自动打开对应连接器的配置弹窗
  useEffect(() => {
    if (!autoConfigureId) return;
    const target = mcpConnectors.find((c) => c.id === autoConfigureId);
    if (target) {
      setMcpConfiguring(target);
      setMcpTokenInput('');
      setMcpNotice('');
      onAutoConfigureHandled?.();
    }
  }, [autoConfigureId, mcpConnectors]);

  const mcpPost = async (body: any): Promise<boolean> => {
    setMcpSaving(true);
    setMcpNotice('');
    try {
      const res = await fetch('/api/connectors/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (data.success) {
        setMcpConnectors(data.connectors || []);
        return true;
      }
      setMcpNotice(data.error || '操作失败');
      return false;
    } catch (e: any) {
      setMcpNotice(e?.message || '网络错误');
      return false;
    } finally {
      setMcpSaving(false);
    }
  };

  const handleSaveMcpToken = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!mcpConfiguring || !mcpTokenInput.trim()) return;
    const ok = await mcpPost({
      action: 'saveToken',
      connectorId: mcpConfiguring.id,
      token: mcpTokenInput.trim(),
    });
    if (ok) {
      setMcpConfiguring(null);
      setMcpTokenInput('');
    }
  };

  // ---- Tab 归属:all=全部;other=未策展兜底;其余按 CONNECTOR_TABS 的 ids ----
  const tabIds = tab === 'all' ? null : CONNECTOR_TABS.find((t) => t.key === tab)?.ids ?? null;
  const inTab = (id: string) =>
    tab === 'all' || (tab === 'other' ? !TABBED_IDS.has(id) : Boolean(tabIds?.includes(id)));
  const matchSearch = (name: string, description: string, category: string) =>
    !searchQuery ||
    name.toLowerCase().includes(searchQuery.toLowerCase()) ||
    description.toLowerCase().includes(searchQuery.toLowerCase()) ||
    category.toLowerCase().includes(searchQuery.toLowerCase());

  const filteredMcp = mcpConnectors.filter((c) => inTab(c.id) && matchSearch(c.name, c.description, c.category));

  const filtered = connectors.filter((c) => inTab(c.id) && matchSearch(c.name, c.description, c.category));

  const tabCount = (key: string) => {
    const ids = key === 'all' ? null : CONNECTOR_TABS.find((t) => t.key === key)?.ids ?? null;
    const hit = (id: string) =>
      key === 'all' || (key === 'other' ? !TABBED_IDS.has(id) : Boolean(ids?.includes(id)));
    return connectors.filter((c) => hit(c.id)).length + mcpConnectors.filter((c) => hit(c.id)).length;
  };
  const hasOther =
    connectors.some((c) => !TABBED_IDS.has(c.id)) || mcpConnectors.some((c) => !TABBED_IDS.has(c.id));

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!configuringApp || !configuringApp.envVar || !keyInput.trim()) return;
    setIsSaving(true);
    try {
      await onSaveKey(configuringApp.envVar, keyInput.trim(), {
        baseUrl: baseUrlInput.trim() || undefined,
        baseUrlEnvVar: configuringApp.baseUrlEnvVar,
        modelName: modelNameInput.trim() || undefined,
        modelNameEnvVar: configuringApp.modelNameEnvVar,
      });
      setConfiguringApp(null);
      setKeyInput('');
      setBaseUrlInput('');
      setModelNameInput('');
    } catch (err) {
      console.error(err);
    } finally {
      setIsSaving(false);
    }
  };

  const connectedCount = connectors.filter((c) => c.status === 'connected').length;

  return (
    <div className="w-full max-w-5xl mx-auto px-4 py-8 md:py-12 space-y-8 animate-fadeIn">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2.5">
            <div className="p-1.5 rounded-xl bg-blue-50 text-blue-600 border border-blue-200/60 shadow-2xs">
              <Layers className="h-5 w-5" />
            </div>
            <h1 className="text-2xl font-semibold tracking-tight text-zinc-900">
              连接器与原子能力中心
            </h1>
            <span className="text-xs font-mono font-medium px-2 py-0.5 rounded-full bg-zinc-100 border border-zinc-200/80 text-zinc-600">
              已就绪 {connectedCount}/{connectors.length}
            </span>
          </div>
          <p className="text-xs text-zinc-500 mt-1 max-w-xl leading-relaxed">
            为 AgtPilot 授权外部 SaaS、网络搜索和模型凭据，拓展自主行动边界。
          </p>
        </div>
      </div>

      {/* Category Tabs & Search Bar */}
      <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3">
        <div className="flex items-center gap-1.5 overflow-x-auto pb-1 sm:pb-0 scrollbar-none">
          {[
            { key: 'all', label: '全部' },
            ...CONNECTOR_TABS.map((t) => ({ key: t.key, label: t.label })),
            ...(hasOther ? [{ key: 'other', label: '其他' }] : []),
          ].map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`px-3 py-1.5 rounded-xl text-xs font-medium whitespace-nowrap transition flex items-center gap-1.5 ${
                tab === t.key
                  ? 'bg-zinc-900 text-white shadow-xs'
                  : 'bg-zinc-100 hover:bg-zinc-200/70 text-zinc-600'
              }`}
            >
              <span>{t.label}</span>
              <span className="opacity-75 font-mono text-[11px]">({tabCount(t.key)})</span>
            </button>
          ))}
        </div>

        <div className="relative w-full sm:w-64 flex-shrink-0">
          <Search className="absolute left-3 top-2.5 h-3.5 w-3.5 text-zinc-400" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="搜索连接器..."
            className="w-full pl-9 pr-3 py-1.5 rounded-xl border border-zinc-200 bg-white text-xs text-zinc-900 placeholder-zinc-400 focus:outline-none focus:ring-2 focus:ring-zinc-900/10 focus:border-zinc-400 transition"
          />
        </div>
      </div>

      {/* Connectors Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {filtered.map((app) => (
          <div
            key={app.id}
            className="p-5 rounded-2xl border border-zinc-200 bg-white hover:border-zinc-300 hover:shadow-xs transition flex flex-col justify-between"
          >
            <div>
              <div className="flex items-start justify-between mb-3">
                <div className="flex items-center gap-3">
                  <div className="h-10 w-10 rounded-xl bg-zinc-50 border border-zinc-200/80 flex items-center justify-center shadow-2xs">
                    {renderConnectorIcon(app.id, 'h-5 w-5')}
                  </div>
                  <div>
                    <h3 className="text-xs font-semibold text-zinc-900">{app.name}</h3>
                    <div className="flex items-center gap-1.5 mt-0.5">
                      <span className="text-[10px] text-zinc-400 uppercase font-mono">
                        {app.category}
                      </span>
                      {app.comingSoon ? (
                        <span className="text-[9px] px-1.5 py-0.2 rounded font-medium bg-amber-50 text-amber-600 border border-amber-200 flex items-center gap-0.5 whitespace-nowrap">
                          <Laptop className="h-2.5 w-2.5" />
                          <span>接入开发中</span>
                        </span>
                      ) : app.platformType === 'mobile' || app.mobileAction ? (
                        <span className="text-[9px] px-1.5 py-0.2 rounded font-medium bg-rose-50 text-rose-600 border border-rose-200 flex items-center gap-0.5 whitespace-nowrap">
                          <Smartphone className="h-2.5 w-2.5" />
                          <span>支持真机免密</span>
                        </span>
                      ) : (
                        <span className="text-[9px] px-1.5 py-0.2 rounded font-medium bg-zinc-100 text-zinc-500 flex items-center gap-0.5 whitespace-nowrap">
                          <Laptop className="h-2.5 w-2.5" />
                          <span>Web 凭证</span>
                        </span>
                      )}
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-1.5 flex-shrink-0">
                  {app.isModel && app.isDefaultModel && (
                    <span className="text-[10px] px-2 py-0.5 rounded-full font-medium bg-blue-50 text-blue-700 border border-blue-200 whitespace-nowrap">
                      当前激活
                    </span>
                  )}
                  {app.comingSoon ? (
                    <span className="text-[10px] px-2 py-0.5 rounded-full font-medium whitespace-nowrap bg-amber-50 text-amber-700 border border-amber-200">
                      即将支持
                    </span>
                  ) : app.noCredential ? (
                    <span className="text-[10px] px-2 py-0.5 rounded-full font-medium whitespace-nowrap bg-emerald-50 text-emerald-700 border border-emerald-200">
                      免凭证
                    </span>
                  ) : (
                    <span
                      className={`text-[10px] px-2 py-0.5 rounded-full font-medium whitespace-nowrap ${
                        app.status === 'connected'
                          ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                          : 'bg-zinc-100 text-zinc-500'
                      }`}
                    >
                      {app.status === 'connected' ? '已连接' : '未配置'}
                    </span>
                  )}
                </div>
              </div>

              <p className="text-xs text-zinc-500 leading-relaxed mb-4">
                {app.description}
              </p>
            </div>

            <div className="pt-3 border-t border-zinc-100 flex flex-wrap items-center justify-between gap-y-2">
              <span className="text-[10px] font-mono text-zinc-400 truncate max-w-[130px]">
                {app.envVar || ''}
              </span>

              <div className="flex flex-wrap items-center justify-end gap-1.5">
                {app.isModel && app.status === 'connected' && !app.isDefaultModel && (
                  <button
                    onClick={() => onSetDefaultModel(app.id)}
                    className="shrink-0 whitespace-nowrap px-2.5 py-1 rounded-lg text-xs font-medium text-blue-600 hover:text-blue-700 hover:bg-blue-50 transition"
                  >
                    设为默认
                  </button>
                )}

                {/* 内容/脚本工坊：Agent 选题+创作，发布仍由用户在 App 人工确认（合规半自动） */}
                {(app.id === 'xiaohongshu' || app.id === 'weibo' || app.id === 'douyin' || app.id === 'bilibili') && onRunPrompt && (
                  <button
                    onClick={() => openWorkshop(app)}
                    className="flex shrink-0 items-center gap-1 whitespace-nowrap px-2.5 py-1 rounded-lg text-xs font-medium bg-violet-50 hover:bg-violet-100 text-violet-700 border border-violet-200 transition shadow-2xs"
                    title="让 Agent 帮你选题、写文案/脚本、配标签，你只需在 App 人工确认发布"
                  >
                    <Sparkles className="h-3 w-3" />
                    <span>{app.id === 'douyin' || app.id === 'bilibili' ? '脚本工坊' : '内容工坊'}</span>
                  </button>
                )}

                {/* 办公工坊：邮件分诊 / 周报生成 */}
                {(app.id === 'email_imap' || app.id === 'weekly_report') && onRunPrompt && (
                  <button
                    onClick={() => openWorkshop(app)}
                    className="flex shrink-0 items-center gap-1 whitespace-nowrap px-2.5 py-1 rounded-lg text-xs font-medium bg-sky-50 hover:bg-sky-100 text-sky-700 border border-sky-200 transition shadow-2xs"
                    title={
                      app.id === 'email_imap'
                        ? 'Agent 拉取收件箱，自动分诊为四级优先级并起草回复（发送前逐封经你确认）'
                        : 'Agent 从你已连接的平台自动取材，汇总成结构化周报（投递前经你确认）'
                    }
                  >
                    <Sparkles className="h-3 w-3" />
                    <span>{app.id === 'email_imap' ? '邮件分诊' : '生成周报'}</span>
                  </button>
                )}

                {/* 投研工坊：个股/基金体检、组合体检、盘后复盘（只读投研，不构成投资建议） */}
                {app.id === 'invest_workshop' && onRunPrompt && (
                  <button
                    onClick={() => openWorkshop(app)}
                    className="flex shrink-0 items-center gap-1 whitespace-nowrap px-2.5 py-1 rounded-lg text-xs font-medium bg-emerald-50 hover:bg-emerald-100 text-emerald-700 border border-emerald-200 transition shadow-2xs"
                    title="个股/基金体检、持仓组合体检、每日盘后复盘——只读投研，数据标注来源与时间戳"
                  >
                    <Sparkles className="h-3 w-3" />
                    <span>投研工坊</span>
                  </button>
                )}

                {/* 教研工坊：文献综述、论文精读、智能备课、学习卡片（只读检索，学术诚信） */}
                {app.id === 'edu_workshop' && onRunPrompt && (
                  <button
                    onClick={() => openWorkshop(app)}
                    className="flex shrink-0 items-center gap-1 whitespace-nowrap px-2.5 py-1 rounded-lg text-xs font-medium bg-indigo-50 hover:bg-indigo-100 text-indigo-700 border border-indigo-200 transition shadow-2xs"
                    title="文献综述、论文精读、智能备课、学习卡片——只读检索，参考文献附 DOI/arXiv ID，严禁编造引用"
                  >
                    <Sparkles className="h-3 w-3" />
                    <span>教研工坊</span>
                  </button>
                )}

                {/* 移动端专属一键唤起真机 App 按钮（桌面端 scheme 无法打开，隐藏避免死按钮） */}
                {app.mobileAction && mobileCtx && (
                  <button
                    onClick={async () => {
                      if (app.mobileAction?.scheme) {
                        await openAppScheme(
                          app.mobileAction.scheme,
                          app.websiteUrl
                        );
                      }
                    }}
                    className="flex shrink-0 items-center gap-1 whitespace-nowrap px-2.5 py-1 rounded-lg text-xs font-medium bg-rose-50 hover:bg-rose-100 text-rose-700 border border-rose-200 transition shadow-2xs"
                    title="在手机端可直接唤起已登录的原生 App"
                  >
                    <Smartphone className="h-3 w-3" />
                    <span>真机唤起</span>
                  </button>
                )}

                {/* 桌面端提示:唤起能力仅在手机端存在 */}
                {app.mobileAction && !mobileCtx && (
                  <span
                    className="flex shrink-0 items-center gap-1 whitespace-nowrap px-2.5 py-1 rounded-lg text-[11px] text-zinc-400 bg-zinc-50 border border-zinc-200"
                    title="真机唤起仅在手机浏览器或 Capacitor App 内可用"
                  >
                    <Smartphone className="h-3 w-3" />
                    <span>手机端可用</span>
                  </span>
                )}

                {/* 凭证配置入口：comingSoon（未接入）与 noCredential（免凭证）不提供任何输入 */}
                {!app.comingSoon && !app.noCredential && (
                  <button
                    onClick={() => {
                      setConfiguringApp(app);
                      setKeyInput('');
                      setBaseUrlInput(app.baseUrl || '');
                      setModelNameInput(app.customModelName || '');
                    }}
                    className="shrink-0 whitespace-nowrap px-2.5 py-1 rounded-lg text-xs font-medium text-zinc-600 hover:text-zinc-900 hover:bg-zinc-100 transition"
                    title="手动输入或修改 API Key / Token"
                  >
                    {app.status === 'connected' ? '重新配置' : '配置密钥'}
                  </button>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* 空分组/无搜索结果占位 */}
      {filtered.length === 0 && filteredMcp.length === 0 && (
        <div className="text-center py-10 text-xs text-zinc-400">
          该分组下没有匹配的连接器{searchQuery ? `(搜索「${searchQuery}」无结果)` : ''}
        </div>
      )}

      {/* MCP 连接器区（官方托管直连：一键授权 / 粘贴凭证 / 免凭证） */}
      {filteredMcp.length > 0 && (
        <div className="space-y-4">
          <div className="flex items-center gap-2.5">
            <div className="p-1.5 rounded-xl bg-violet-50 text-violet-600 border border-violet-200/60 shadow-2xs">
              <Plug className="h-4 w-4" />
            </div>
            <div>
              <h2 className="text-sm font-semibold text-zinc-900">MCP 连接器 · 官方托管直连</h2>
              <p className="text-[11px] text-zinc-500">
                免安装、免命令行：能一键授权的绝不让填 Key，授权后工具自动挂载进任务。
              </p>
            </div>
          </div>

          {mcpNotice && (
            <div className="px-3 py-2 rounded-xl bg-red-50 border border-red-200 text-xs text-red-700">
              {mcpNotice}
            </div>
          )}

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {filteredMcp.map((app) => (
              <div
                key={app.id}
                className="p-5 rounded-2xl border border-zinc-200 bg-white hover:border-zinc-300 hover:shadow-xs transition flex flex-col justify-between"
              >
                <div>
                  <div className="flex items-start justify-between mb-3">
                    <div className="flex items-center gap-3">
                      <div className="h-10 w-10 rounded-xl bg-zinc-50 border border-zinc-200/80 flex items-center justify-center shadow-2xs">
                        {renderMcpIcon(app.id, 'h-5 w-5')}
                      </div>
                      <div>
                        <h3 className="text-xs font-semibold text-zinc-900">{app.name}</h3>
                        <div className="flex items-center gap-1.5 mt-0.5">
                          <span className="text-[10px] text-zinc-400 uppercase font-mono">
                            {app.category}
                          </span>
                          <span
                            className={`text-[9px] px-1.5 py-0.2 rounded font-medium flex items-center gap-0.5 whitespace-nowrap ${
                              app.authType === 'oauth'
                                ? 'bg-violet-50 text-violet-600 border border-violet-200'
                                : app.authType === 'none'
                                ? 'bg-sky-50 text-sky-600 border border-sky-200'
                                : 'bg-amber-50 text-amber-600 border border-amber-200'
                            }`}
                          >
                            {app.authType === 'oauth' ? '一键授权' : app.optIn ? '手动启用' : app.authType === 'none' ? '免凭证直连' : '粘贴凭证'}
                          </span>
                        </div>
                      </div>
                    </div>

                    <span
                      className={`text-[10px] px-2 py-0.5 rounded-full font-medium whitespace-nowrap ${
                        app.status === 'connected'
                          ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                          : 'bg-zinc-100 text-zinc-500'
                      }`}
                    >
                      {app.status === 'connected'
                        ? app.toolCount
                          ? `已挂载 ${app.toolCount} 工具`
                          : app.optIn
                          ? '已启用'
                          : '已连接'
                        : app.optIn
                        ? '未启用'
                        : '未配置'}
                    </span>
                  </div>

                  <p className="text-xs text-zinc-500 leading-relaxed mb-2">{app.description}</p>
                  {app.lastError && (
                    <p className="text-[10px] text-red-500 leading-relaxed mb-2 break-all">
                      连接异常: {app.lastError}
                    </p>
                  )}
                </div>

                <div className="pt-3 border-t border-zinc-100 flex flex-wrap items-center justify-between gap-y-2">
                  <span className="text-[10px] font-mono text-zinc-400 truncate max-w-[130px]">
                    {app.authType === 'oauth' ? 'OAuth 2.1 + PKCE' : app.optIn ? '本地 stdio 子进程' : app.authType === 'none' ? 'MCP Streamable HTTP' : app.keyMasked || 'MCP Streamable HTTP'}
                  </span>

                  <div className="flex flex-wrap items-center justify-end gap-1.5">
                    {app.authType === 'oauth' && (
                      <a
                        href={`/api/connectors/mcp/start?connector=${app.id}`}
                        className={`flex shrink-0 items-center gap-1 whitespace-nowrap px-3 py-1 rounded-lg text-xs font-medium transition shadow-2xs ${
                          app.status === 'connected'
                            ? 'bg-zinc-100 hover:bg-zinc-200 text-zinc-700'
                            : 'bg-zinc-900 hover:bg-zinc-800 text-white'
                        }`}
                      >
                        <ExternalLink className="h-3 w-3" />
                        <span>{app.status === 'connected' ? '重新授权' : '一键授权'}</span>
                      </a>
                    )}

                    {app.authType === 'token' && (
                      <button
                        onClick={() => {
                          setMcpConfiguring(app);
                          setMcpTokenInput('');
                          setMcpNotice('');
                        }}
                        className="shrink-0 whitespace-nowrap px-3 py-1 rounded-lg text-xs font-medium bg-zinc-900 hover:bg-zinc-800 text-white transition shadow-2xs"
                      >
                        {app.status === 'connected' ? '更新凭证' : '打开授权页'}
                      </button>
                    )}

                    {app.authType === 'none' && !app.optIn && (
                      <button
                        onClick={() => mcpPost({ action: 'connect', connectorId: app.id })}
                        disabled={mcpSaving}
                        className="flex shrink-0 items-center gap-1 whitespace-nowrap px-2.5 py-1 rounded-lg text-xs font-medium text-zinc-600 hover:text-zinc-900 hover:bg-zinc-100 transition"
                        title="立即重连并刷新工具列表"
                      >
                        <RotateCw className={`h-3 w-3 ${mcpSaving ? 'animate-spin' : ''}`} />
                        <span>重连</span>
                      </button>
                    )}

                    {app.optIn && app.status !== 'connected' && (
                      <button
                        onClick={() => mcpPost({ action: 'saveToken', connectorId: app.id, token: '1' })}
                        disabled={mcpSaving}
                        className="flex shrink-0 items-center gap-1 whitespace-nowrap px-3 py-1 rounded-lg text-xs font-medium bg-zinc-900 hover:bg-zinc-800 text-white transition shadow-2xs"
                        title="启用后为你的任务挂载本地浏览器子进程(需服务器已装 Chrome/Chromium)"
                      >
                        {mcpSaving ? <RotateCw className="h-3 w-3 animate-spin" /> : <Zap className="h-3 w-3" />}
                        <span>启用</span>
                      </button>
                    )}

                    {app.optIn && app.status === 'connected' && (
                      <button
                        onClick={() => mcpPost({ action: 'disconnect', connectorId: app.id })}
                        disabled={mcpSaving}
                        className="flex shrink-0 items-center gap-1 whitespace-nowrap px-2.5 py-1 rounded-lg text-xs font-medium text-zinc-600 hover:text-red-600 hover:bg-red-50 transition"
                        title="停用并断开本地子进程"
                      >
                        <Unplug className="h-3 w-3" />
                        <span>停用</span>
                      </button>
                    )}

                    {app.status === 'connected' && app.authType !== 'none' && (
                      <button
                        onClick={() => mcpPost({ action: 'disconnect', connectorId: app.id })}
                        disabled={mcpSaving}
                        className="flex shrink-0 items-center gap-1 whitespace-nowrap px-2 py-1 rounded-lg text-[11px] font-medium text-zinc-400 hover:text-red-600 hover:bg-red-50 transition"
                        title="清除凭证并断开连接"
                      >
                        <Unplug className="h-3 w-3" />
                        <span>断开</span>
                      </button>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* MCP Token Config Modal */}
      {mcpConfiguring && (
        <div className="fixed inset-0 bg-black/30 backdrop-blur-xs z-50 flex items-center justify-center p-4">
          <div className="w-full max-w-md rounded-2xl bg-white border border-zinc-200 p-6 shadow-xl animate-fadeIn space-y-4">
            <div className="flex items-start justify-between">
              <div className="flex items-center gap-3">
                <div className="h-9 w-9 rounded-xl bg-zinc-100 flex items-center justify-center shadow-2xs">
                  {renderMcpIcon(mcpConfiguring.id, 'h-4 w-4')}
                </div>
                <div>
                  <h3 className="text-sm font-semibold text-zinc-900">
                    连接 {mcpConfiguring.name}
                  </h3>
                  <p className="text-xs text-zinc-500 mt-0.5">粘贴凭证，即刻挂载官方 MCP 工具</p>
                </div>
              </div>
              <button
                onClick={() => setMcpConfiguring(null)}
                className="text-zinc-400 hover:text-zinc-700 p-1 rounded-md"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            {mcpConfiguring.authHint && (
              <div className="px-3 py-2.5 rounded-xl bg-amber-50 border border-amber-200/70 text-xs text-amber-800 leading-relaxed">
                {mcpConfiguring.authHint}
                {mcpConfiguring.quickAuthUrl && (
                  <a
                    href={mcpConfiguring.quickAuthUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="mt-1.5 flex items-center gap-1 font-medium text-amber-900 underline underline-offset-2"
                  >
                    <ExternalLink className="h-3 w-3" />
                    打开官方授权页获取凭证
                  </a>
                )}
              </div>
            )}

            <form onSubmit={handleSaveMcpToken} className="space-y-4">
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-zinc-700 block">
                  Token / Key <span className="text-red-500">*</span>
                </label>
                <input
                  type="password"
                  value={mcpTokenInput}
                  onChange={(e) => setMcpTokenInput(e.target.value)}
                  placeholder={mcpConfiguring.keyMasked || '粘贴从授权页复制的凭证'}
                  autoFocus
                  className="w-full px-3 py-2 rounded-xl border border-zinc-300 bg-white text-xs text-zinc-900 placeholder-zinc-400 focus:outline-none focus:border-zinc-500"
                />
                <p className="text-[10px] text-zinc-400 flex items-center gap-1">
                  <ShieldCheck className="h-3 w-3" />
                  凭证经 AES-256-GCM 加密后仅存储在你的个人空间，任务执行时才解密使用
                </p>
              </div>

              <div className="flex items-center justify-end gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => setMcpConfiguring(null)}
                  className="px-3 py-1.5 rounded-lg text-xs font-medium text-zinc-600 hover:bg-zinc-100 transition"
                >
                  取消
                </button>
                <button
                  type="submit"
                  disabled={!mcpTokenInput.trim() || mcpSaving}
                  className="flex items-center gap-1.5 px-4 py-1.5 rounded-lg bg-zinc-900 hover:bg-zinc-800 disabled:opacity-40 text-white text-xs font-medium transition shadow-xs"
                >
                  {mcpSaving && <RotateCw className="h-3.5 w-3.5 animate-spin" />}
                  <span>保存并连接</span>
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Key Config Modal */}
      {configuringApp && (
        <div className="fixed inset-0 bg-black/30 backdrop-blur-xs z-50 flex items-center justify-center p-4">
          <div className="w-full max-w-md rounded-2xl bg-white border border-zinc-200 p-6 shadow-xl animate-fadeIn space-y-4">
            <div className="flex items-start justify-between">
              <div className="flex items-center gap-3">
                <div className="h-9 w-9 rounded-xl bg-zinc-100 flex items-center justify-center shadow-2xs">
                  {renderConnectorIcon(configuringApp.id, 'h-4 w-4')}
                </div>
                <div>
                  <h3 className="text-sm font-semibold text-zinc-900">
                    配置 {configuringApp.name}
                  </h3>
                  {configuringApp.envVar && (
                    <p className="text-xs text-zinc-500 font-mono mt-0.5">
                      环境变量: {configuringApp.envVar}
                    </p>
                  )}
                </div>
              </div>
              <button
                onClick={() => setConfiguringApp(null)}
                className="text-zinc-400 hover:text-zinc-700 p-1 rounded-md"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <form onSubmit={handleSave} className="space-y-4">
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-zinc-700 block">
                  API Key / Token <span className="text-red-500">*</span>
                </label>
                <input
                  type="password"
                  value={keyInput}
                  onChange={(e) => setKeyInput(e.target.value)}
                  placeholder={configuringApp.keyMasked || '输入凭证密钥 (sk-...)'}
                  autoFocus
                  className="w-full px-3 py-2 rounded-xl border border-zinc-300 bg-white text-xs text-zinc-900 placeholder-zinc-400 focus:outline-none focus:border-zinc-500"
                />
                {configuringApp.configHint && (
                  <p className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-2.5 py-2 leading-relaxed">
                    {configuringApp.configHint}
                  </p>
                )}
              </div>

              {/* 仅在模型类连接器上展示 Base URL 与模型名称 */}
              {configuringApp.isModel && (
                <>
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between">
                      <label className="text-xs font-medium text-zinc-700 block">
                        API Base URL (自定义中转 / 代理地址)
                      </label>
                      <span className="text-[10px] text-zinc-400">可选</span>
                    </div>
                    <input
                      type="text"
                      value={baseUrlInput}
                      onChange={(e) => setBaseUrlInput(e.target.value)}
                      placeholder={
                        configuringApp.id === 'deepseek'
                          ? '默认: https://api.deepseek.com/v1'
                          : configuringApp.id === 'openai'
                          ? '默认: https://api.openai.com/v1'
                          : '例如: https://api.openai.com/v1 或 http://localhost:11434/v1'
                      }
                      className="w-full px-3 py-2 rounded-xl border border-zinc-300 bg-white text-xs text-zinc-900 placeholder-zinc-400 focus:outline-none focus:border-zinc-500 font-mono"
                    />
                  </div>

                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between">
                      <label className="text-xs font-medium text-zinc-700 block">
                        模型标识 (Model Identifier)
                      </label>
                      <span className="text-[10px] text-zinc-400">可选</span>
                    </div>
                    <input
                      type="text"
                      value={modelNameInput}
                      onChange={(e) => setModelNameInput(e.target.value)}
                      placeholder={
                        configuringApp.id === 'deepseek'
                          ? '默认: deepseek-chat (或 deepseek-reasoner)'
                          : configuringApp.id === 'openai'
                          ? '默认: gpt-4o (或 gpt-4o-mini)'
                          : '例如: qwen2.5:72b, claude-3-5-sonnet, deepseek-r1'
                      }
                      className="w-full px-3 py-2 rounded-xl border border-zinc-300 bg-white text-xs text-zinc-900 placeholder-zinc-400 focus:outline-none focus:border-zinc-500 font-mono"
                    />
                  </div>
                </>
              )}

              <div className="flex items-center justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setConfiguringApp(null)}
                  className="px-3 py-1.5 rounded-lg text-xs font-medium text-zinc-600 hover:bg-zinc-100 transition"
                >
                  取消
                </button>
                <button
                  type="submit"
                  disabled={!keyInput.trim() || isSaving}
                  className="flex items-center gap-1.5 px-4 py-1.5 rounded-lg bg-zinc-900 hover:bg-zinc-800 disabled:opacity-40 text-white text-xs font-medium transition shadow-xs"
                >
                  {isSaving && <RotateCw className="h-3.5 w-3.5 animate-spin" />}
                  <span>保存连接</span>
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* 内容/脚本工坊 Modal（半自动运营：Agent 选题+创作，发布由用户在 App 人工确认） */}
      {workshopApp && (
        <div className="fixed inset-0 bg-black/30 backdrop-blur-xs z-50 flex items-center justify-center p-4">
          <div className="w-full max-w-md rounded-2xl bg-white border border-zinc-200 p-6 shadow-xl animate-fadeIn space-y-4">
            <div className="flex items-start justify-between">
              <div className="flex items-center gap-3">
                <div className={`h-9 w-9 rounded-xl flex items-center justify-center shadow-2xs ${
                  wsKind === 'invest'
                    ? 'bg-emerald-100 text-emerald-600'
                    : wsKind === 'edu'
                    ? 'bg-indigo-100 text-indigo-600'
                    : 'bg-violet-100 text-violet-600'
                }`}>
                  <Sparkles className="h-4 w-4" />
                </div>
                <div>
                  <h3 className="text-sm font-semibold text-zinc-900">
                    {wsKind === 'video'
                      ? `${workshopApp.id === 'bilibili' ? 'B站' : '抖音'}短视频脚本工坊`
                      : wsKind === 'weibo'
                      ? '微博内容工坊'
                      : wsKind === 'email_triage'
                      ? '邮件分诊工坊'
                      : wsKind === 'weekly'
                      ? '周报生成工坊'
                      : wsKind === 'invest'
                      ? '投研工坊'
                      : wsKind === 'edu'
                      ? '教研工坊'
                      : '小红书内容工坊'}
                  </h3>
                  <p className="text-xs text-zinc-500 mt-0.5">
                    {wsKind === 'email_triage'
                      ? 'Agent 拉取收件箱自动分级分诊，回复草稿经你逐封确认才发送'
                      : wsKind === 'weekly'
                      ? 'Agent 从已连接平台自动取材汇总周报，投递前经你确认'
                      : wsKind === 'invest'
                      ? '行情数据来自已连接的行情连接器，输出仅供参考、不构成投资建议'
                      : wsKind === 'edu'
                      ? '文献来自 OpenAlex/alphaXiv 真实检索，引用附 DOI/arXiv ID、严禁编造'
                      : 'Agent 选题+创作，你在 App 人工确认发布（合规半自动）'}
                  </p>
                </div>
              </div>
              <button
                onClick={() => setWorkshopApp(null)}
                className="text-zinc-400 hover:text-zinc-700 p-1 rounded-md"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="space-y-4">
              {/* 主题（内容/脚本工坊才有） */}
              {(wsKind === 'xhs' || wsKind === 'weibo' || wsKind === 'video') && (
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-zinc-700 block">主题（可选）</label>
                  <input
                    type="text"
                    value={wsTopic}
                    onChange={(e) => setWsTopic(e.target.value)}
                    placeholder={
                      wsKind === 'video'
                        ? '留空则由 Agent 抓知乎热榜/搜索热点自动选题，如：AI 工具月度盘点'
                        : '留空则由 Agent 抓知乎热榜/搜索热点自动选题，如：秋冬通勤穿搭'
                    }
                    className="w-full px-3 py-2 rounded-xl border border-zinc-300 bg-white text-xs text-zinc-900 placeholder-zinc-400 focus:outline-none focus:border-zinc-500"
                  />
                </div>
              )}

              {/* 内容类型（图文工坊才有；脚本工坊选时长） */}
              {(wsKind === 'xhs' || wsKind === 'weibo') && (
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-zinc-700 block">
                    {wsKind === 'weibo' ? '微博类型' : '笔记类型'}
                  </label>
                  <div className="flex flex-wrap gap-1.5">
                    {(wsKind === 'weibo' ? WEIBO_WORKSHOP_STYLES : XHS_WORKSHOP_STYLES).map((s) => (
                      <button
                        key={s}
                        type="button"
                        onClick={() => setWsStyle(s)}
                        className={`px-2.5 py-1 rounded-lg text-xs font-medium border transition ${
                          wsStyle === s
                            ? 'bg-violet-600 text-white border-violet-600'
                            : 'bg-white text-zinc-600 border-zinc-200 hover:border-zinc-300'
                        }`}
                      >
                        {s}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* 视频时长（脚本工坊才有） */}
              {wsKind === 'video' && (
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-zinc-700 block">视频时长</label>
                  <div className="flex gap-1.5">
                    {VIDEO_SCRIPT_DURATIONS.map((d) => (
                      <button
                        key={d}
                        type="button"
                        onClick={() => setWsDuration(d)}
                        className={`px-3 py-1 rounded-lg text-xs font-medium border transition ${
                          wsDuration === d
                            ? 'bg-violet-600 text-white border-violet-600'
                            : 'bg-white text-zinc-600 border-zinc-200 hover:border-zinc-300'
                        }`}
                      >
                        {d}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* 篇数（内容/脚本工坊才有） */}
              {(wsKind === 'xhs' || wsKind === 'weibo' || wsKind === 'video') && (
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-zinc-700 block">
                    {wsKind === 'video' ? '产出脚本数' : '产出篇数'}
                  </label>
                  <div className="flex gap-1.5">
                    {[1, 2, 3].map((n) => (
                      <button
                        key={n}
                        type="button"
                        onClick={() => setWsCount(n)}
                        className={`w-10 py-1 rounded-lg text-xs font-medium border transition ${
                          wsCount === n
                            ? 'bg-violet-600 text-white border-violet-600'
                            : 'bg-white text-zinc-600 border-zinc-200 hover:border-zinc-300'
                        }`}
                      >
                        {n}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* 邮件分诊：范围 / 关注点 / 是否起草回复 */}
              {wsKind === 'email_triage' && (
                <>
                  <div className="space-y-1.5">
                    <label className="text-xs font-medium text-zinc-700 block">分诊范围</label>
                    <div className="flex flex-wrap gap-1.5">
                      {EMAIL_TRIAGE_SCOPES.map((s) => (
                        <button
                          key={s.id}
                          type="button"
                          onClick={() => setEtScope(s.id)}
                          className={`px-2.5 py-1 rounded-lg text-xs font-medium border transition ${
                            etScope === s.id
                              ? 'bg-sky-600 text-white border-sky-600'
                              : 'bg-white text-zinc-600 border-zinc-200 hover:border-zinc-300'
                          }`}
                        >
                          {s.name}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-xs font-medium text-zinc-700 block">特别关注（可选）</label>
                    <input
                      type="text"
                      value={etFocus}
                      onChange={(e) => setEtFocus(e.target.value)}
                      placeholder="如：老板的邮件、合同相关、面试候选人——命中的自动上调优先级"
                      className="w-full px-3 py-2 rounded-xl border border-zinc-300 bg-white text-xs text-zinc-900 placeholder-zinc-400 focus:outline-none focus:border-zinc-500"
                    />
                  </div>
                  <label className="flex items-center gap-2 cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={etDraft}
                      onChange={(e) => setEtDraft(e.target.checked)}
                      className="h-3.5 w-3.5 rounded border-zinc-300 accent-sky-600"
                    />
                    <span className="text-xs text-zinc-600">为高优邮件起草回复（发送前逐封经我确认）</span>
                  </label>
                </>
              )}

              {/* 周报生成：周期 / 读者 / 投递 / 补充要点 */}
              {wsKind === 'weekly' && (
                <>
                  <div className="space-y-1.5">
                    <label className="text-xs font-medium text-zinc-700 block">周报周期</label>
                    <div className="flex gap-1.5">
                      {WEEKLY_REPORT_PERIODS.map((p) => (
                        <button
                          key={p.id}
                          type="button"
                          onClick={() => setWrPeriod(p.id)}
                          className={`px-3 py-1 rounded-lg text-xs font-medium border transition ${
                            wrPeriod === p.id
                              ? 'bg-sky-600 text-white border-sky-600'
                              : 'bg-white text-zinc-600 border-zinc-200 hover:border-zinc-300'
                          }`}
                        >
                          {p.name}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-xs font-medium text-zinc-700 block">写给谁看</label>
                    <div className="flex gap-1.5">
                      {WEEKLY_REPORT_AUDIENCES.map((a) => (
                        <button
                          key={a.id}
                          type="button"
                          onClick={() => setWrAudience(a.id)}
                          className={`px-3 py-1 rounded-lg text-xs font-medium border transition ${
                            wrAudience === a.id
                              ? 'bg-sky-600 text-white border-sky-600'
                              : 'bg-white text-zinc-600 border-zinc-200 hover:border-zinc-300'
                          }`}
                        >
                          {a.name}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-xs font-medium text-zinc-700 block">投递方式</label>
                    <div className="flex flex-wrap gap-1.5">
                      {WEEKLY_REPORT_DELIVERIES.map((d) => (
                        <button
                          key={d.id}
                          type="button"
                          onClick={() => setWrDelivery(d.id)}
                          className={`px-2.5 py-1 rounded-lg text-xs font-medium border transition ${
                            wrDelivery === d.id
                              ? 'bg-sky-600 text-white border-sky-600'
                              : 'bg-white text-zinc-600 border-zinc-200 hover:border-zinc-300'
                          }`}
                        >
                          {d.name}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-xs font-medium text-zinc-700 block">补充要点（可选）</label>
                    <textarea
                      value={wrExtras}
                      onChange={(e) => setWrExtras(e.target.value)}
                      rows={2}
                      placeholder="口述数据源里没有的工作，直接纳入周报，如：本周主导了 X 项目上线、协调了 Y 部门…"
                      className="w-full px-3 py-2 rounded-xl border border-zinc-300 bg-white text-xs text-zinc-900 placeholder-zinc-400 focus:outline-none focus:border-zinc-500 resize-none"
                    />
                  </div>
                </>
              )}

              {/* 投研工坊：模式 / 标的 / 持仓 / 市场 / 投递 */}
              {wsKind === 'invest' && (
                <>
                  <div className="space-y-1.5">
                    <label className="text-xs font-medium text-zinc-700 block">投研模式</label>
                    <div className="flex flex-wrap gap-1.5">
                      {INVEST_MODES.map((m) => (
                        <button
                          key={m.id}
                          type="button"
                          onClick={() => setIvMode(m.id)}
                          className={`px-2.5 py-1 rounded-lg text-xs font-medium border transition ${
                            ivMode === m.id
                              ? 'bg-emerald-600 text-white border-emerald-600'
                              : 'bg-white text-zinc-600 border-zinc-200 hover:border-zinc-300'
                          }`}
                        >
                          {m.name}
                        </button>
                      ))}
                    </div>
                  </div>

                  {ivMode === 'stock_check' && (
                    <>
                      <div className="space-y-1.5">
                        <label className="text-xs font-medium text-zinc-700 block">体检标的</label>
                        <input
                          type="text"
                          value={ivSymbols}
                          onChange={(e) => setIvSymbols(e.target.value)}
                          placeholder="逗号分隔，如：600519, 00700, AAPL, 110022, BTC（留空则任务里先问你）"
                          className="w-full px-3 py-2 rounded-xl border border-zinc-300 bg-white text-xs text-zinc-900 placeholder-zinc-400 focus:outline-none focus:border-zinc-500"
                        />
                      </div>
                      <div className="space-y-1.5">
                        <label className="text-xs font-medium text-zinc-700 block">额外关注点（可选）</label>
                        <input
                          type="text"
                          value={ivFocus}
                          onChange={(e) => setIvFocus(e.target.value)}
                          placeholder="如：重点看分红稳定性、对比同行业估值、关注解禁压力"
                          className="w-full px-3 py-2 rounded-xl border border-zinc-300 bg-white text-xs text-zinc-900 placeholder-zinc-400 focus:outline-none focus:border-zinc-500"
                        />
                      </div>
                    </>
                  )}

                  {ivMode === 'portfolio_check' && (
                    <>
                      <div className="space-y-1.5">
                        <label className="text-xs font-medium text-zinc-700 block">我的持仓</label>
                        <textarea
                          value={ivHoldings}
                          onChange={(e) => setIvHoldings(e.target.value)}
                          rows={3}
                          placeholder={'自由格式，如：\n600519 100股 成本1680\nAAPL 50股\n110022 占比20%\nBTC 0.5个（留空则任务里先问你）'}
                          className="w-full px-3 py-2 rounded-xl border border-zinc-300 bg-white text-xs text-zinc-900 placeholder-zinc-400 focus:outline-none focus:border-zinc-500 resize-none"
                        />
                      </div>
                      <div className="space-y-1.5">
                        <label className="text-xs font-medium text-zinc-700 block">风险偏好</label>
                        <div className="flex gap-1.5">
                          {RISK_PROFILES.map((r) => (
                            <button
                              key={r.id}
                              type="button"
                              onClick={() => setIvRisk(r.id)}
                              className={`px-2.5 py-1 rounded-lg text-xs font-medium border transition ${
                                ivRisk === r.id
                                  ? 'bg-emerald-600 text-white border-emerald-600'
                                  : 'bg-white text-zinc-600 border-zinc-200 hover:border-zinc-300'
                              }`}
                            >
                              {r.name}
                            </button>
                          ))}
                        </div>
                      </div>
                    </>
                  )}

                  {ivMode === 'daily_review' && (
                    <div className="space-y-1.5">
                      <label className="text-xs font-medium text-zinc-700 block">覆盖市场（可多选）</label>
                      <div className="flex flex-wrap gap-1.5">
                        {REVIEW_MARKETS.map((m) => (
                          <button
                            key={m.id}
                            type="button"
                            onClick={() => toggleIvMarket(m.id)}
                            className={`px-2.5 py-1 rounded-lg text-xs font-medium border transition ${
                              ivMarkets.includes(m.id)
                                ? 'bg-emerald-600 text-white border-emerald-600'
                                : 'bg-white text-zinc-600 border-zinc-200 hover:border-zinc-300'
                            }`}
                          >
                            {m.name}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}

                  <div className="space-y-1.5">
                    <label className="text-xs font-medium text-zinc-700 block">报告投递</label>
                    <div className="flex flex-wrap gap-1.5">
                      {INVEST_DELIVERIES.map((d) => (
                        <button
                          key={d.id}
                          type="button"
                          onClick={() => setIvDelivery(d.id)}
                          className={`px-2.5 py-1 rounded-lg text-xs font-medium border transition ${
                            ivDelivery === d.id
                              ? 'bg-emerald-600 text-white border-emerald-600'
                              : 'bg-white text-zinc-600 border-zinc-200 hover:border-zinc-300'
                          }`}
                        >
                          {d.name}
                        </button>
                      ))}
                    </div>
                  </div>
                </>
              )}

              {wsKind === 'edu' && (
                <>
                  <div className="space-y-1.5">
                    <label className="text-xs font-medium text-zinc-700 block">教研模式</label>
                    <div className="flex flex-wrap gap-1.5">
                      {EDU_MODES.map((m) => (
                        <button
                          key={m.id}
                          type="button"
                          onClick={() => setEwMode(m.id)}
                          className={`px-2.5 py-1 rounded-lg text-xs font-medium border transition ${
                            ewMode === m.id
                              ? 'bg-indigo-600 text-white border-indigo-600'
                              : 'bg-white text-zinc-600 border-zinc-200 hover:border-zinc-300'
                          }`}
                        >
                          {m.name}
                        </button>
                      ))}
                    </div>
                  </div>

                  {ewMode === 'literature_review' && (
                    <>
                      <div className="space-y-1.5">
                        <label className="text-xs font-medium text-zinc-700 block">综述课题 / 关键词</label>
                        <input
                          type="text"
                          value={ewTopic}
                          onChange={(e) => setEwTopic(e.target.value)}
                          placeholder="如：扩散模型在医学图像分割中的应用（留空则任务里先问你）"
                          className="w-full px-3 py-2 rounded-xl border border-zinc-300 bg-white text-xs text-zinc-900 placeholder-zinc-400 focus:outline-none focus:border-zinc-500"
                        />
                      </div>
                      <div className="space-y-1.5">
                        <label className="text-xs font-medium text-zinc-700 block">额外要求（可选）</label>
                        <input
                          type="text"
                          value={ewFocus}
                          onChange={(e) => setEwFocus(e.target.value)}
                          placeholder="如：只要近 3 年、侧重方法论、以中文文献为主、需要 15 篇以上"
                          className="w-full px-3 py-2 rounded-xl border border-zinc-300 bg-white text-xs text-zinc-900 placeholder-zinc-400 focus:outline-none focus:border-zinc-500"
                        />
                      </div>
                    </>
                  )}

                  {ewMode === 'paper_read' && (
                    <>
                      <div className="space-y-1.5">
                        <label className="text-xs font-medium text-zinc-700 block">论文标识</label>
                        <input
                          type="text"
                          value={ewPaper}
                          onChange={(e) => setEwPaper(e.target.value)}
                          placeholder="标题 / arXiv ID（如 2506.13538）/ DOI / 链接（留空则任务里先问你）"
                          className="w-full px-3 py-2 rounded-xl border border-zinc-300 bg-white text-xs text-zinc-900 placeholder-zinc-400 focus:outline-none focus:border-zinc-500"
                        />
                      </div>
                      <div className="space-y-1.5">
                        <label className="text-xs font-medium text-zinc-700 block">额外关注点（可选）</label>
                        <input
                          type="text"
                          value={ewFocus}
                          onChange={(e) => setEwFocus(e.target.value)}
                          placeholder="如：重点讲清方法、和我的课题的关系、实验复现难度"
                          className="w-full px-3 py-2 rounded-xl border border-zinc-300 bg-white text-xs text-zinc-900 placeholder-zinc-400 focus:outline-none focus:border-zinc-500"
                        />
                      </div>
                    </>
                  )}

                  {ewMode === 'lesson_plan' && (
                    <>
                      <div className="grid grid-cols-2 gap-2">
                        <div className="space-y-1.5">
                          <label className="text-xs font-medium text-zinc-700 block">学科</label>
                          <input
                            type="text"
                            value={ewSubject}
                            onChange={(e) => setEwSubject(e.target.value)}
                            placeholder="如：初中数学"
                            className="w-full px-3 py-2 rounded-xl border border-zinc-300 bg-white text-xs text-zinc-900 placeholder-zinc-400 focus:outline-none focus:border-zinc-500"
                          />
                        </div>
                        <div className="space-y-1.5">
                          <label className="text-xs font-medium text-zinc-700 block">学段年级</label>
                          <input
                            type="text"
                            value={ewGrade}
                            onChange={(e) => setEwGrade(e.target.value)}
                            placeholder="如：八年级 / 大一下学期"
                            className="w-full px-3 py-2 rounded-xl border border-zinc-300 bg-white text-xs text-zinc-900 placeholder-zinc-400 focus:outline-none focus:border-zinc-500"
                          />
                        </div>
                      </div>
                      <div className="grid grid-cols-3 gap-2">
                        <div className="col-span-2 space-y-1.5">
                          <label className="text-xs font-medium text-zinc-700 block">课题</label>
                          <input
                            type="text"
                            value={ewTopic}
                            onChange={(e) => setEwTopic(e.target.value)}
                            placeholder="如：勾股定理 / 光合作用"
                            className="w-full px-3 py-2 rounded-xl border border-zinc-300 bg-white text-xs text-zinc-900 placeholder-zinc-400 focus:outline-none focus:border-zinc-500"
                          />
                        </div>
                        <div className="space-y-1.5">
                          <label className="text-xs font-medium text-zinc-700 block">课时</label>
                          <input
                            type="text"
                            value={ewDuration}
                            onChange={(e) => setEwDuration(e.target.value)}
                            placeholder="1 课时"
                            className="w-full px-3 py-2 rounded-xl border border-zinc-300 bg-white text-xs text-zinc-900 placeholder-zinc-400 focus:outline-none focus:border-zinc-500"
                          />
                        </div>
                      </div>
                      <div className="space-y-1.5">
                        <label className="text-xs font-medium text-zinc-700 block">补充要求（可选）</label>
                        <input
                          type="text"
                          value={ewExtras}
                          onChange={(e) => setEwExtras(e.target.value)}
                          placeholder="教材版本 / 学情 / 特殊安排，如：人教版、班级基础偏弱、需含分组实验"
                          className="w-full px-3 py-2 rounded-xl border border-zinc-300 bg-white text-xs text-zinc-900 placeholder-zinc-400 focus:outline-none focus:border-zinc-500"
                        />
                      </div>
                    </>
                  )}

                  {ewMode === 'flashcards' && (
                    <>
                      <div className="space-y-1.5">
                        <label className="text-xs font-medium text-zinc-700 block">卡片主题（可选）</label>
                        <input
                          type="text"
                          value={ewTopic}
                          onChange={(e) => setEwTopic(e.target.value)}
                          placeholder="如：高一化学必修一 · 离子反应（用于聚焦与命名）"
                          className="w-full px-3 py-2 rounded-xl border border-zinc-300 bg-white text-xs text-zinc-900 placeholder-zinc-400 focus:outline-none focus:border-zinc-500"
                        />
                      </div>
                      <div className="space-y-1.5">
                        <label className="text-xs font-medium text-zinc-700 block">学习材料</label>
                        <textarea
                          value={ewMaterial}
                          onChange={(e) => setEwMaterial(e.target.value)}
                          rows={5}
                          placeholder={'把要做成卡片的学习材料/笔记/教材段落粘贴到这里（留空则任务里先问你）。\n材料越具体，卡片越贴合考点。'}
                          className="w-full px-3 py-2 rounded-xl border border-zinc-300 bg-white text-xs text-zinc-900 placeholder-zinc-400 focus:outline-none focus:border-zinc-500 resize-none"
                        />
                      </div>
                      <div className="space-y-1.5">
                        <label className="text-xs font-medium text-zinc-700 block">卡片类型</label>
                        <div className="flex flex-wrap gap-1.5">
                          {FLASHCARD_TYPES.map((t) => (
                            <button
                              key={t.id}
                              type="button"
                              onClick={() => setEwCardType(t.id)}
                              className={`px-2.5 py-1 rounded-lg text-xs font-medium border transition ${
                                ewCardType === t.id
                                  ? 'bg-indigo-600 text-white border-indigo-600'
                                  : 'bg-white text-zinc-600 border-zinc-200 hover:border-zinc-300'
                              }`}
                            >
                              {t.name}
                            </button>
                          ))}
                        </div>
                      </div>
                      <div className="space-y-1.5">
                        <label className="text-xs font-medium text-zinc-700 block">输出格式</label>
                        <div className="flex flex-wrap gap-1.5">
                          {FLASHCARD_FORMATS.map((f) => (
                            <button
                              key={f.id}
                              type="button"
                              onClick={() => setEwCardFormat(f.id)}
                              className={`px-2.5 py-1 rounded-lg text-xs font-medium border transition ${
                                ewCardFormat === f.id
                                  ? 'bg-indigo-600 text-white border-indigo-600'
                                  : 'bg-white text-zinc-600 border-zinc-200 hover:border-zinc-300'
                              }`}
                            >
                              {f.name}
                            </button>
                          ))}
                        </div>
                      </div>
                    </>
                  )}

                  {ewMode !== 'flashcards' && (
                    <div className="space-y-1.5">
                      <label className="text-xs font-medium text-zinc-700 block">成果投递</label>
                      <div className="flex flex-wrap gap-1.5">
                        {EDU_DELIVERIES.map((d) => (
                          <button
                            key={d.id}
                            type="button"
                            onClick={() => setEwDelivery(d.id)}
                            className={`px-2.5 py-1 rounded-lg text-xs font-medium border transition ${
                              ewDelivery === d.id
                                ? 'bg-indigo-600 text-white border-indigo-600'
                                : 'bg-white text-zinc-600 border-zinc-200 hover:border-zinc-300'
                            }`}
                          >
                            {d.name}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </>
              )}

              <p className="text-[11px] text-zinc-400 leading-relaxed flex items-start gap-1.5">
                <ShieldCheck className="h-3.5 w-3.5 mt-px flex-shrink-0" />
                {wsKind === 'email_triage'
                  ? '生成后跳转任务页，Agent 用 email_list/email_read 读取收件箱，输出总览 + 四级分诊清单（🔴立即/🟠今日/🟡稍后/⚪可忽略）与回复草稿。发送任何回复、改动邮件状态都需你逐封确认。需先在「电子邮件收件 (IMAP)」配置凭证（或已配 SMTP 会自动复用）。'
                  : wsKind === 'weekly'
                  ? '生成后跳转任务页，Agent 从你已连接的 Jira/GitHub/飞书/钉钉/腾讯会议/邮箱自动取材，输出结构化周报（概览/重点工作/数据看板/风险/下周计划）。先展示全文，投递（邮件/群机器人）需你确认；数据源都不可用时按补充要点整理。'
                  : wsKind === 'invest'
                  ? '生成后跳转任务页，Agent 通过你已连接的 Tushare / Alpha Vantage / CoinGecko / A股行情连接器拉取实时行情、估值与新闻，输出带来源与时间戳的结构化投研报告。全程只读：不执行任何交易、不动资金；报告经邮件/群机器人发送前需你确认。输出仅供参考，不构成投资建议。'
                  : wsKind === 'edu'
                  ? '生成后跳转任务页，Agent 通过你已连接的 OpenAlex / alphaXiv / Hugging Face / DeepL 连接器检索真实文献（缺失时降级为网络搜索并明示），按模式产出文献综述 / 论文精读卡 / 教案 / 学习卡片。每条引用附 DOI 或 arXiv ID、严禁编造参考文献；全程只读、不改你的文献库；成果经邮件/群机器人投递前需你确认。'
                  : wsKind === 'video'
                  ? `生成后跳转任务页，Agent 产出标题/分镜脚本/口播稿/标签分区/封面文案。你拍摄剪辑后 → 「真机唤起」${workshopApp.id === 'bilibili' ? 'B站' : '抖音'} App → 人工核对后发布。已连接知乎 MCP 时选题走实时热榜。`
                  : `生成后跳转任务页，Agent 产出标题/正文/标签/配图建议。复制满意的一篇 → 「真机唤起」${workshopApp.id === 'weibo' ? '微博' : '小红书'} App → 人工核对后发布。已连接知乎 MCP 时选题走实时热榜。`}
              </p>

              <div className="flex items-center justify-end gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => setWorkshopApp(null)}
                  className="px-3 py-1.5 rounded-lg text-xs font-medium text-zinc-600 hover:bg-zinc-100 transition"
                >
                  取消
                </button>
                <button
                  type="button"
                  onClick={handleWorkshopRun}
                  className={`flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-white text-xs font-medium transition shadow-xs ${
                    wsKind === 'invest'
                      ? 'bg-emerald-600 hover:bg-emerald-700'
                      : wsKind === 'edu'
                      ? 'bg-indigo-600 hover:bg-indigo-700'
                      : wsKind === 'email_triage' || wsKind === 'weekly'
                      ? 'bg-sky-600 hover:bg-sky-700'
                      : 'bg-violet-600 hover:bg-violet-700'
                  }`}
                >
                  <Sparkles className="h-3.5 w-3.5" />
                  <span>
                    {wsKind === 'email_triage'
                      ? '开始分诊'
                      : wsKind === 'weekly'
                      ? '生成周报'
                      : wsKind === 'invest'
                      ? '开始分析'
                      : wsKind === 'edu'
                      ? '开始生成'
                      : '开始创作'}
                  </span>
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
