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
  Feather,
  Tv,
  Github,
  BookMarked,
  KanbanSquare,
  TrendingUp,
  LineChart,
  Coins,
  CandlestickChart,
  BookOpenText,
  Languages,
  Newspaper,
  Twitter,
  QrCode,
  MonitorPlay,
  ShieldAlert,
  Copy,
  Package,
  Plane,
} from 'lucide-react';
import { ConnectorApp, McpConnectorInfo } from '../types/agent';
import { openAppScheme, isNativePlatform, copyToClipboard } from '../utils/nativeBridge';
import { XhsWebLoginModal } from './XhsWebLoginModal';
import { loginBadgeInfo } from '../lib/login-badge';
import type { XhsManagedRecord } from '../lib/user-store';

/**
 * 子 agent 可用性一行文案(2026-10-14 目录标记方案):
 * 数据来自 API 聚合的 McpConnectorInfo.subagent(目录 subagentOpen 标记 × 活连接只读注解)。
 * closed 用中性措辞(不向普通用户暴露内部红线条目);未连接时提示「连接后可用」。
 */
function subagentLine(app: McpConnectorInfo): { text: string; cls: string } | null {
  const sa = app.subagent;
  if (!sa) return null;
  if (sa.availability === 'closed') {
    return { text: '子 agent:不开放(该连接器含写操作或敏感数据,仅主对话可用)', cls: 'text-zinc-400' };
  }
  if (app.status !== 'connected') {
    return { text: '子 agent:已标记开放,连接后可用', cls: 'text-zinc-500' };
  }
  switch (sa.availability) {
    case 'escape':
      return {
        text: `子 agent:可用 —— 实测评审放行,全部 ${app.toolCount ?? 0} 个工具开放`,
        cls: 'text-emerald-600',
      };
    case 'ready': {
      const hc = sa.heuristicReadOnlyCount ?? 0;
      const base = `子 agent:可用 —— ${sa.readOnlyCount ?? 0}/${app.toolCount ?? 0} 个工具判定只读(双钥匙放行)`;
      return {
        text: hc > 0 ? `${base},其中 ${hc} 个由名称判定` : base,
        cls: 'text-emerald-600',
      };
    }
    case 'needs-measurement':
      return {
        text: `子 agent:已标记开放,但工具未能自动判定只读(注解缺失且名称含糊,共 ${app.toolCount ?? 0} 工具),待实测评审放行`,
        cls: 'text-amber-600',
      };
    default:
      return null;
  }
}

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
    case 'kuaidi100':
      return <Package className={`${className} text-amber-600`} />;
    case 'flyai':
      return <Plane className={`${className} text-orange-500`} />;
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
    case 'email':
    case 'email_smtp':
      return <Mail className={`${className} text-violet-600`} />;
    case 'email_imap':
      return <Inbox className={`${className} text-indigo-600`} />;
    case 'exa':
      return <Search className={`${className} text-indigo-600`} />;
    case 'tavily':
      return <Globe className={`${className} text-teal-600`} />;
    case 'firecrawl':
      return <Flame className={`${className} text-orange-600`} />;
    case 'xiaohongshu':
      return <Share2 className={`${className} text-rose-600`} />;
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
  { key: 'search', label: '搜索与数据', ids: ['exa', 'tavily', 'firecrawl', 'newsnow', 'twitterapi_io', 'deepwiki', 'openalex', 'qcc'] },
  { key: 'office', label: '办公协作', ids: ['notion_mcp', 'lark_suite', 'dingtalk_mcp', 'atlassian_mcp', 'yuque', 'dida365', 'tencent_docs', 'tencent_meeting', 'youdao_note', 'tencent_weiyun', 'tencent_lexiang', 'ardot'] },
  { key: 'invest', label: '投资理财', ids: ['tushare', 'alphavantage_mcp', 'coingecko_mcp', 'a_stock'] },
  { key: 'edu', label: '学习教研', ids: ['openalex', 'alphaxiv', 'huggingface_mcp', 'deepl_mcp', 'deepwiki'] },
  { key: 'travel', label: '地图出行', ids: ['amap', 'baidu_map', 'didi', 'flyai'] },
  { key: 'life', label: '生活服务', ids: ['kuaidi100'] },
  { key: 'publish', label: '通知与发布', ids: ['slack', 'feishu', 'dingtalk', 'wecom', 'email', 'wechat_mp', 'xiaohongshu', 'zhihu'] },
  { key: 'dev', label: '开发与云', ids: ['github', 'github_mcp', 'e2b', 'browser_auto'] },
];
const TABBED_IDS = new Set(CONNECTOR_TABS.flatMap((t) => t.ids));

interface ConnectorsViewProps {
  connectors: ConnectorApp[];
  onSaveKey: (
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
  ) => Promise<void>;
  onSetDefaultModel: (modelId: string) => Promise<void>;
  /** 任务中途授权跳转过来时自动打开对应连接器的配置弹窗 */
  autoConfigureId?: string | null;
  onAutoConfigureHandled?: () => void;
  /** 工坊依赖点跳转定位:连接器标识填入搜索框过滤到对应卡片(定位完由父层清空) */
  locateSearch?: string | null;
  onLocateHandled?: () => void;
}

export function ConnectorsView({
  connectors,
  onSaveKey,
  onSetDefaultModel,
  autoConfigureId,
  onAutoConfigureHandled,
  locateSearch,
  onLocateHandled,
}: ConnectorsViewProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [tab, setTab] = useState('all');
  const [configuringApp, setConfiguringApp] = useState<ConnectorApp | null>(null);
  const [keyInput, setKeyInput] = useState('');
  // 合并卡片「电子邮件」专用:发信必填、收信可选(留空复用发信凭证)
  const [smtpKeyInput, setSmtpKeyInput] = useState('');
  const [imapKeyInput, setImapKeyInput] = useState('');
  const [baseUrlInput, setBaseUrlInput] = useState('');
  const [modelNameInput, setModelNameInput] = useState('');
  // 思考深度('' = 默认:不存连接器级配置,回落全局 env / 厂商缺省)
  const [reasoningInput, setReasoningInput] = useState('');
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

  // 设备码授权弹窗（OAuth 2.0 Device Grant）：展示 user_code,后端按 interval 轮询换 token。
  // tick 自增驱动轮询 effect 重新排定下一次 setTimeout;phase 离开 polling 即停。
  const [deviceAuth, setDeviceAuth] = useState<{
    connectorId: string;
    connectorName: string;
    userCode: string;
    verificationUri: string;
    interval: number;
    expiresAt: number;
    tick: number;
    phase: 'polling' | 'success' | 'expired' | 'denied' | 'error';
    error?: string;
  } | null>(null);
  // 用户码「已复制」反馈（2s 自动复位）
  const [copiedUserCode, setCopiedUserCode] = useState(false);

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

  // 工坊依赖点跳转定位:连接器标识直接进搜索框(id 精确匹配过滤到对应卡片)
  useEffect(() => {
    if (locateSearch) {
      setSearchQuery(locateSearch);
      onLocateHandled?.();
    }
  }, [locateSearch]);

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

  // ---- 设备码授权（OAuth Device Grant,gh CLI 同款;无回调、不要求 https 部署）----
  const startDeviceAuth = async (connectorId: string, connectorName: string) => {
    setMcpSaving(true);
    setMcpNotice('');
    try {
      const res = await fetch('/api/connectors/mcp/device', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'start', connectorId }),
      });
      const data = await res.json();
      if (!data.success || !data.device) {
        setMcpNotice(data.error || '发起设备码授权失败');
        return;
      }
      setDeviceAuth({
        connectorId,
        connectorName,
        userCode: data.device.userCode,
        verificationUri: data.device.verificationUri,
        interval: Math.max(3, Number(data.device.interval) || 5),
        expiresAt: Date.now() + (Number(data.device.expiresIn) || 900) * 1000,
        tick: 0,
        phase: 'polling',
      });
    } catch (e: any) {
      setMcpNotice(e?.message || '网络错误');
    } finally {
      setMcpSaving(false);
    }
  };

  // 轮询:phase=polling 时按 interval 排下一次;pending/slow_down 用 tick 自增重新进入本 effect
  useEffect(() => {
    if (!deviceAuth || deviceAuth.phase !== 'polling') return;
    if (Date.now() > deviceAuth.expiresAt) {
      setDeviceAuth((d) => (d ? { ...d, phase: 'expired' } : d));
      return;
    }
    let cancelled = false;
    const timer = setTimeout(async () => {
      if (cancelled) return;
      try {
        const res = await fetch('/api/connectors/mcp/device', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'poll', connectorId: deviceAuth.connectorId }),
        });
        const data = await res.json();
        if (cancelled) return;
        if (!data.success) {
          setDeviceAuth((d) => (d ? { ...d, phase: 'error', error: data.error || '轮询失败' } : d));
          return;
        }
        if (data.status === 'success') {
          setDeviceAuth((d) => (d ? { ...d, phase: 'success' } : d));
          setMcpNotice(`✅ 「${deviceAuth.connectorName}」设备码授权成功，工具已挂载（OAuth token，无到期换 key 烦恼）。`);
          loadMcpConnectors();
        } else if (data.status === 'pending' || data.status === 'slow_down') {
          setDeviceAuth((d) =>
            d ? { ...d, interval: data.interval ? Math.max(3, Number(data.interval)) : d.interval, tick: d.tick + 1 } : d
          );
        } else if (data.status === 'expired') {
          setDeviceAuth((d) => (d ? { ...d, phase: 'expired' } : d));
        } else if (data.status === 'denied') {
          setDeviceAuth((d) => (d ? { ...d, phase: 'denied' } : d));
        } else {
          setDeviceAuth((d) => (d ? { ...d, phase: 'error', error: data.error || '授权失败' } : d));
        }
      } catch {
        // 网络抖动:算一次 tick 继续轮询（设备码过期时间是天然兜底）
        if (!cancelled) setDeviceAuth((d) => (d ? { ...d, tick: d.tick + 1 } : d));
      }
    }, deviceAuth.interval * 1000);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [deviceAuth]);

  const closeDeviceAuth = () => {
    if (deviceAuth?.phase === 'polling') {
      // 通知后端清中间态（fire-and-forget,失败无害:设备码 15 分钟自然过期）
      fetch('/api/connectors/mcp/device', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'cancel', connectorId: deviceAuth.connectorId }),
      }).catch(() => {});
    }
    setDeviceAuth(null);
  };

  // ---- 小红书网页版登录 + 托管模式(scenario-loop P2 模块 1/2) ----
  const [xhsStatus, setXhsStatus] = useState<{
    record: XhsManagedRecord | null;
    dailyLimit: number;
    todayCount: number;
  } | null>(null);
  const [showXhsLogin, setShowXhsLogin] = useState(false);
  const [showXhsRisk, setShowXhsRisk] = useState(false);
  const [riskAck, setRiskAck] = useState(false);
  const [xhsBusy, setXhsBusy] = useState(false);
  const [xhsNotice, setXhsNotice] = useState('');

  const loadXhsStatus = async () => {
    try {
      const res = await fetch('/api/xhs-managed');
      if (res.status === 401) return; // 未登录静默
      const data = await res.json();
      if (data.success) {
        setXhsStatus({ record: data.record, dailyLimit: data.dailyLimit, todayCount: data.todayCount });
      }
    } catch {
      // 后端未就绪时静默
    }
  };
  useEffect(() => {
    loadXhsStatus();
  }, []);

  const xhsPost = async (body: Record<string, unknown>): Promise<boolean> => {
    setXhsBusy(true);
    setXhsNotice('');
    try {
      const res = await fetch('/api/xhs-managed', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (data.success) {
        setXhsStatus((prev) => (prev ? { ...prev, record: data.record } : prev));
        return true;
      }
      setXhsNotice(data.error || '操作失败');
      return false;
    } catch (e: any) {
      setXhsNotice(e?.message || '网络错误');
      return false;
    } finally {
      setXhsBusy(false);
    }
  };

  const daysAgoText = (ts: number): string => {
    const days = Math.floor((Date.now() - ts) / 86400_000);
    if (days <= 0) return '今天';
    if (days === 1) return '昨天';
    if (days < 30) return `${days} 天前`;
    return `${Math.floor(days / 30)} 个月前`;
  };

  // ---- 知乎网页版登录 + 托管模式(与小红书同构;zhihu-managed) ----
  const [zhihuStatus, setZhihuStatus] = useState<{
    record: XhsManagedRecord | null;
    dailyLimit: number;
    todayCount: number;
  } | null>(null);
  const [showZhihuLogin, setShowZhihuLogin] = useState(false);
  const [showZhihuRisk, setShowZhihuRisk] = useState(false);
  const [zhihuRiskAck, setZhihuRiskAck] = useState(false);
  const [zhihuBusy, setZhihuBusy] = useState(false);
  const [zhihuNotice, setZhihuNotice] = useState('');

  const loadZhihuStatus = async () => {
    try {
      const res = await fetch('/api/zhihu-managed');
      if (res.status === 401) return; // 未登录静默
      const data = await res.json();
      if (data.success) {
        setZhihuStatus({ record: data.record, dailyLimit: data.dailyLimit, todayCount: data.todayCount });
      }
    } catch {
      // 后端未就绪时静默
    }
  };
  useEffect(() => {
    loadZhihuStatus();
  }, []);

  const zhihuPost = async (body: Record<string, unknown>): Promise<boolean> => {
    setZhihuBusy(true);
    setZhihuNotice('');
    try {
      const res = await fetch('/api/zhihu-managed', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (data.success) {
        setZhihuStatus((prev) => (prev ? { ...prev, record: data.record } : prev));
        return true;
      }
      setZhihuNotice(data.error || '操作失败');
      return false;
    } catch (e: any) {
      setZhihuNotice(e?.message || '网络错误');
      return false;
    } finally {
      setZhihuBusy(false);
    }
  };

  // ---- 番茄网页版登录 + 托管模式(与知乎同构;fanqie-managed;按用户拍板:一次性确认即全授权,存草稿不逐次审批) ----
  const [fanqieStatus, setFanqieStatus] = useState<{
    record: XhsManagedRecord | null;
    dailyLimit: number;
    todayCount: number;
  } | null>(null);
  const [showFanqieLogin, setShowFanqieLogin] = useState(false);
  const [showFanqieRisk, setShowFanqieRisk] = useState(false);
  const [fanqieRiskAck, setFanqieRiskAck] = useState(false);
  const [fanqieBusy, setFanqieBusy] = useState(false);
  const [fanqieNotice, setFanqieNotice] = useState('');

  const loadFanqieStatus = async () => {
    try {
      const res = await fetch('/api/fanqie-managed');
      if (res.status === 401) return; // 未登录静默
      const data = await res.json();
      if (data.success) {
        setFanqieStatus({ record: data.record, dailyLimit: data.dailyLimit, todayCount: data.todayCount });
      }
    } catch {
      // 后端未就绪时静默
    }
  };
  useEffect(() => {
    loadFanqieStatus();
  }, []);

  const fanqiePost = async (body: Record<string, unknown>): Promise<boolean> => {
    setFanqieBusy(true);
    setFanqieNotice('');
    try {
      const res = await fetch('/api/fanqie-managed', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (data.success) {
        setFanqieStatus((prev) => (prev ? { ...prev, record: data.record } : prev));
        return true;
      }
      setFanqieNotice(data.error || '操作失败');
      return false;
    } catch (e: any) {
      setFanqieNotice(e?.message || '网络错误');
      return false;
    } finally {
      setFanqieBusy(false);
    }
  };

  // ---- Tab 归属:all=全部;other=未策展兜底;其余按 CONNECTOR_TABS 的 ids ----
  const tabIds = tab === 'all' ? null : CONNECTOR_TABS.find((t) => t.key === tab)?.ids ?? null;
  const inTab = (id: string) =>
    tab === 'all' || (tab === 'other' ? !TABBED_IDS.has(id) : Boolean(tabIds?.includes(id)));
  const matchSearch = (id: string, name: string, description: string, category: string) =>
    !searchQuery ||
    id.toLowerCase() === searchQuery.toLowerCase() ||
    name.toLowerCase().includes(searchQuery.toLowerCase()) ||
    description.toLowerCase().includes(searchQuery.toLowerCase()) ||
    category.toLowerCase().includes(searchQuery.toLowerCase());

  const filteredMcp = mcpConnectors.filter((c) => inTab(c.id) && matchSearch(c.id, c.name, c.description, c.category));

  // 平台账号型 MCP 卡片上提:知乎(网页版扫码登录 + 托管存草稿)与番茄(网页版扫码登录 +
  // 托管存章节草稿)同属浏览器托管通道,渲染进上方原生连接器区;其余 MCP 连接器留在下方「官方托管直连」区
  const promotedMcp = filteredMcp.filter((c) => c.id === 'zhihu' || c.id === 'tomato_writer');
  const regularMcp = filteredMcp.filter((c) => c.id !== 'zhihu' && c.id !== 'tomato_writer');

  const filtered = connectors.filter((c) => inTab(c.id) && matchSearch(c.id, c.name, c.description, c.category));

  // ---- 电子邮件合并展示:后端保持 SMTP/IMAP 双凭证键(收发权限边界),
  // 前端合并为一张「电子邮件」卡片,弹窗内分「发信/收信」两节 ----
  const emailSmtp = connectors.find((c) => c.id === 'email_smtp');
  const emailImap = connectors.find((c) => c.id === 'email_imap');
  const emailMerged: ConnectorApp | null =
    emailSmtp || emailImap
      ? {
          ...(emailSmtp ?? emailImap!),
          id: 'email',
          name: '电子邮件',
          description:
            'Agent 用你的邮箱发信与读信：email_send 发任务报告与内容投递，email_list / email_read 读收件箱（默认不改已读）。只配发信则仅能往外发，收信留空自动复用发信凭证。',
        }
      : null;
  // 原始双卡片从列表剔除,由合并卡片替代;搜索命中任一原始 id/名称也定位到合并卡片
  const displayFiltered = filtered
    .filter((c) => c.id !== 'email_smtp' && c.id !== 'email_imap')
    .concat(
      emailMerged && inTab('email') &&
        (matchSearch(emailMerged.id, emailMerged.name, emailMerged.description, emailMerged.category) ||
          ['email_smtp', 'email_imap', 'smtp', 'imap', '发信', '收信'].some((k) =>
            searchQuery.toLowerCase().includes(k.toLowerCase())
          ))
        ? [emailMerged]
        : []
    );

  // 原生双键合并为单卡片计数:email_smtp/email_imap 不单独计数,由合并卡片计 1
  const displayHit = (id: string) => id !== 'email_smtp' && id !== 'email_imap';
  const tabCount = (key: string) => {
    const ids = key === 'all' ? null : CONNECTOR_TABS.find((t) => t.key === key)?.ids ?? null;
    const hit = (id: string) =>
      key === 'all' || (key === 'other' ? !TABBED_IDS.has(id) : Boolean(ids?.includes(id)));
    const nativeCount =
      connectors.filter((c) => displayHit(c.id) && hit(c.id)).length +
      (emailMerged && hit('email') ? 1 : 0);
    return nativeCount + mcpConnectors.filter((c) => hit(c.id)).length;
  };
  const hasOther =
    connectors.some((c) => displayHit(c.id) && !TABBED_IDS.has(c.id)) || mcpConnectors.some((c) => !TABBED_IDS.has(c.id));

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!configuringApp || !configuringApp.envVar) return;
    // 已连接的模型连接器允许 Key 留空 = 只改 Base URL/模型标识/思考深度(后端对空 Key 不动凭证)
    const keylessModelSave =
      configuringApp.isModel && configuringApp.status === 'connected' && !keyInput.trim();
    if (!keyInput.trim() && !keylessModelSave) return;
    setIsSaving(true);
    try {
      await onSaveKey(configuringApp.envVar, keyInput.trim(), {
        baseUrl: baseUrlInput.trim() || undefined,
        baseUrlEnvVar: configuringApp.baseUrlEnvVar,
        modelName: modelNameInput.trim() || undefined,
        modelNameEnvVar: configuringApp.modelNameEnvVar,
        reasoningEffort: configuringApp.isModel ? reasoningInput : undefined,
        reasoningEffortEnvVar: configuringApp.reasoningEffortEnvVar,
      });
      setConfiguringApp(null);
      setKeyInput('');
      setBaseUrlInput('');
      setModelNameInput('');
      setReasoningInput('');
    } catch (err) {
      console.error(err);
    } finally {
      setIsSaving(false);
    }
  };

  // 合并卡片「电子邮件」保存:发信必填单独存 SMTP 键;收信非空才存 IMAP 键(留空=复用发信,后端已兜底)
  const handleSaveEmail = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!smtpKeyInput.trim() && emailSmtp?.status !== 'connected') return;
    setIsSaving(true);
    try {
      if (smtpKeyInput.trim()) {
        await onSaveKey('EMAIL_SMTP_CREDENTIAL', smtpKeyInput.trim());
      }
      if (imapKeyInput.trim()) {
        await onSaveKey('EMAIL_IMAP_CREDENTIAL', imapKeyInput.trim());
      }
      setConfiguringApp(null);
      setSmtpKeyInput('');
      setImapKeyInput('');
      setKeyInput('');
    } catch (err) {
      console.error(err);
    } finally {
      setIsSaving(false);
    }
  };

  // 已就绪统计:原生连接器与 MCP 连接器合并计数(两者同页混排,漏算 MCP 会虚低;
  // mcpConnectors 异步加载完成后自动刷新)
  const connectedCount =
    connectors.filter((c) => (c.id === 'email_smtp' || c.id === 'email_imap' ? false : c.status === 'connected')).length +
    (emailSmtp?.status === 'connected' || emailImap?.status === 'connected' ? 1 : 0) +
    mcpConnectors.filter((c) => c.status === 'connected').length;
  const totalConnectors = connectors.length - (emailSmtp && emailImap ? 1 : 0) + mcpConnectors.length;

  // 番茄卡片右上角徽标数据源:扫码登录态(托管记录 lastLoginAt),不是 MCP 连接态。
  // 本地 MCP 已撤、servers 为空,MCP 侧永远是「未配置」——已扫码的用户看到灰徽标
  // 是误导(实测反馈:扫码登录后右上角仍显示未配置)
  const fanqieLogin = loginBadgeInfo(fanqieStatus?.record || undefined);

  // MCP 卡片渲染函数:知乎(平台账号型:网页版扫码登录 + 托管存草稿)上提到原生连接器区
  // 与微信/小红书同网格,其余 MCP 连接器仍在下方「官方托管直连」区 —— 同一份卡片 JSX 两处复用
  const renderMcpCard = (app: McpConnectorInfo) => (
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
                            : app.authType === 'none' || app.id === 'tomato_writer'
                            ? 'bg-sky-50 text-sky-600 border border-sky-200'
                            : 'bg-amber-50 text-amber-600 border border-amber-200'
                        }`}
                      >
                        {app.id === 'tomato_writer'
                          ? '扫码登录'
                          : app.authType === 'oauth'
                          ? '一键授权'
                          : app.optIn || app.publicTrial
                          ? '手动启用'
                          : app.authType === 'none'
                          ? '免凭证直连'
                          : app.deviceFlow?.available
                          ? '设备码授权'
                          : '粘贴凭证'}
                      </span>
                    </div>
                  </div>
                </div>

                {/* 番茄:徽标按扫码登录态显示;其余 MCP 连接器仍按 MCP 连接态 */}
                <span
                  className={`text-[10px] px-2 py-0.5 rounded-full font-medium whitespace-nowrap ${
                    app.id === 'tomato_writer'
                      ? fanqieLogin.loggedIn
                        ? fanqieLogin.maybeStale
                          ? 'bg-amber-50 text-amber-700 border border-amber-200'
                          : 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                        : 'bg-zinc-100 text-zinc-500'
                      : app.status === 'connected'
                      ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                      : 'bg-zinc-100 text-zinc-500'
                  }`}
                >
                  {app.id === 'tomato_writer'
                    ? fanqieLogin.loggedIn
                      ? fanqieLogin.maybeStale
                        ? '登录可能过期'
                        : '已登录'
                      : '未登录'
                    : app.status === 'connected'
                    ? app.toolCount
                      ? `已挂载 ${app.toolCount} 工具`
                      : app.optIn || app.publicTrial
                      ? '已启用'
                      : '已连接'
                    : app.optIn || app.publicTrial
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
              {(() => {
                const line = subagentLine(app);
                return line ? (
                  <p className={`text-[10px] leading-relaxed mb-2 ${line.cls}`}>{line.text}</p>
                ) : null;
              })()}

              {/* 知乎专属:网页版登录徽标 + 托管模式状态(浏览器托管存草稿,与 MCP 凭证互不依赖) */}
              {app.id === 'zhihu' && (
                <div className="space-y-1.5 mb-2">
                  {(() => {
                    const badge = loginBadgeInfo(zhihuStatus?.record || undefined);
                    return badge.loggedIn ? (
                      <p className={`text-[10px] leading-relaxed ${badge.maybeStale ? 'text-amber-600' : 'text-emerald-600'}`}>
                        {badge.maybeStale
                          ? `网页版登录可能已过期(${daysAgoText(badge.lastLoginAt!)}登录),建议重新扫码`
                          : `网页版已登录 · ${daysAgoText(badge.lastLoginAt!)}`}
                      </p>
                    ) : (
                      <p className="text-[10px] text-zinc-400 leading-relaxed">
                        网页版未登录 —— 扫码后 Agent 可把专栏文章存进知乎草稿箱(跨端可见)
                      </p>
                    );
                  })()}
                  {zhihuStatus?.record?.enabled && (
                    <p className="text-[10px] text-zinc-500 leading-relaxed">
                      托管模式已开启:存草稿每日上限 {zhihuStatus.dailyLimit} 次,今日已用 {zhihuStatus.todayCount} 次,全部操作落审计
                    </p>
                  )}
                  {zhihuNotice && <p className="text-[10px] text-red-500 leading-relaxed">{zhihuNotice}</p>}
                </div>
              )}

              {/* 番茄专属:网页版登录徽标 + 托管模式状态(浏览器托管存章节草稿;已拍板不逐次审批,一次性确认即全授权) */}
              {app.id === 'tomato_writer' && (
                <div className="space-y-1.5 mb-2">
                  {(() => {
                    const badge = loginBadgeInfo(fanqieStatus?.record || undefined);
                    return badge.loggedIn ? (
                      <p className={`text-[10px] leading-relaxed ${badge.maybeStale ? 'text-amber-600' : 'text-emerald-600'}`}>
                        {badge.maybeStale
                          ? `网页版登录可能已过期(${daysAgoText(badge.lastLoginAt!)}登录),建议重新扫码`
                          : `网页版已登录 · ${daysAgoText(badge.lastLoginAt!)}`}
                      </p>
                    ) : (
                      <p className="text-[10px] text-zinc-400 leading-relaxed">
                        网页版未登录 —— 扫码后 Agent 可把章节存进番茄草稿箱(网页版与 App 跨端可见)
                      </p>
                    );
                  })()}
                  {fanqieStatus?.record?.enabled && (
                    <p className="text-[10px] text-zinc-500 leading-relaxed">
                      托管模式已开启:存草稿每日上限 {fanqieStatus.dailyLimit} 次,今日已用 {fanqieStatus.todayCount} 次,全部操作落审计(存草稿免逐次审批)
                    </p>
                  )}
                  {fanqieNotice && <p className="text-[10px] text-red-500 leading-relaxed">{fanqieNotice}</p>}
                </div>
              )}
            </div>

            <div className="pt-3 border-t border-zinc-100 flex flex-wrap items-center justify-between gap-y-2">
              <span className="text-[10px] font-mono text-zinc-400 truncate max-w-[130px]">
                {app.id === 'tomato_writer'
                  ? '浏览器托管'
                  : app.authType === 'oauth'
                  ? 'OAuth 2.1 + PKCE'
                  : app.optIn
                  ? '本地 stdio 子进程'
                  : app.authType === 'none'
                  ? 'MCP Streamable HTTP'
                  : app.keyMasked || 'MCP Streamable HTTP'}
              </span>

              <div className="flex flex-wrap items-center justify-end gap-1.5">
                {/* 知乎专属:网页版扫码登录 + 托管模式开关(浏览器托管,与 MCP token 互不依赖) */}
                {app.id === 'zhihu' && (
                  <>
                    <button
                      onClick={() => setShowZhihuLogin(true)}
                      className="flex shrink-0 items-center gap-1 whitespace-nowrap px-2.5 py-1 rounded-lg text-xs font-medium bg-blue-50 hover:bg-blue-100 text-blue-700 border border-blue-200 transition shadow-2xs"
                      title="打开服务器浏览器的知乎登录页,用手机 App 扫码;登录态只落本服务"
                    >
                      <QrCode className="h-3 w-3" />
                      <span>网页版扫码登录</span>
                    </button>
                    {/* 接管浏览器:投射服务器的已登录浏览器,用户亲自核对/点发布 ——
                        知乎草稿存服务端跨端可见,发布权归人是唯一闭环 */}
                    <button
                      onClick={() =>
                        window.open(
                          '/takeover?url=https%3A%2F%2Fwww.zhihu.com%2Fcreator',
                          '_blank',
                          'noopener,width=1180,height=860'
                        )
                      }
                      className="flex shrink-0 items-center gap-1 whitespace-nowrap px-2.5 py-1 rounded-lg text-xs font-medium bg-amber-50 hover:bg-amber-100 text-amber-700 border border-amber-200 transition shadow-2xs"
                      title="接管服务器上已登录的浏览器:直达知乎创作中心草稿箱,画面实时投射,鼠标键盘由你操控(适合人工点发布)"
                    >
                      <MonitorPlay className="h-3 w-3" />
                      <span>接管浏览器</span>
                    </button>
                    {zhihuStatus?.record?.enabled ? (
                      <button
                        onClick={() => void zhihuPost({ action: 'disable' })}
                        disabled={zhihuBusy}
                        className="shrink-0 whitespace-nowrap px-2.5 py-1 rounded-lg text-xs font-medium text-zinc-500 hover:text-zinc-800 hover:bg-zinc-100 transition disabled:opacity-50"
                        title="关闭托管:Agent 不再执行存草稿(登录态保留)"
                      >
                        关闭托管
                      </button>
                    ) : (
                      <button
                        onClick={() => {
                          setZhihuRiskAck(false);
                          setZhihuNotice('');
                          setShowZhihuRisk(true);
                        }}
                        disabled={zhihuBusy || !zhihuStatus?.record?.lastLoginAt}
                        className="shrink-0 whitespace-nowrap px-2.5 py-1 rounded-lg text-xs font-medium text-zinc-500 hover:text-zinc-800 hover:bg-zinc-100 transition disabled:opacity-40"
                        title={
                          zhihuStatus?.record?.lastLoginAt
                            ? '开启后 Agent 可把文章填进知乎专栏编辑器并停在草稿箱(需审批,有限频,落审计)'
                            : '先完成网页版扫码登录,才能开启托管模式'
                        }
                      >
                        托管模式·存草稿
                      </button>
                    )}
                  </>
                )}

                {/* 番茄专属:网页版扫码登录 + 托管模式开关(浏览器托管,免逐次审批) */}
                {app.id === 'tomato_writer' && (
                  <>
                    <button
                      onClick={() => setShowFanqieLogin(true)}
                      className="flex shrink-0 items-center gap-1 whitespace-nowrap px-2.5 py-1 rounded-lg text-xs font-medium bg-orange-50 hover:bg-orange-100 text-orange-700 border border-orange-200 transition shadow-2xs"
                      title="打开服务器浏览器的番茄作家后台,用手机扫码;登录态只落本服务"
                    >
                      <QrCode className="h-3 w-3" />
                      <span>网页版扫码登录</span>
                    </button>
                    {/* 接管浏览器:投射服务器的已登录浏览器,用户亲自核对/点发布 */}
                    <button
                      onClick={() =>
                        window.open(
                          '/takeover?url=https%3A%2F%2Ffanqienovel.com%2Fmain%2Fwriter%2Fhome',
                          '_blank',
                          'noopener,width=1180,height=860'
                        )
                      }
                      className="flex shrink-0 items-center gap-1 whitespace-nowrap px-2.5 py-1 rounded-lg text-xs font-medium bg-amber-50 hover:bg-amber-100 text-amber-700 border border-amber-200 transition shadow-2xs"
                      title="接管服务器上已登录的浏览器:直达番茄作家后台,画面实时投射,鼠标键盘由你操控(适合人工核对草稿/点发布)"
                    >
                      <MonitorPlay className="h-3 w-3" />
                      <span>接管浏览器</span>
                    </button>
                    {fanqieStatus?.record?.enabled ? (
                      <button
                        onClick={() => void fanqiePost({ action: 'disable' })}
                        disabled={fanqieBusy}
                        className="shrink-0 whitespace-nowrap px-2.5 py-1 rounded-lg text-xs font-medium text-zinc-500 hover:text-zinc-800 hover:bg-zinc-100 transition disabled:opacity-50"
                        title="关闭托管:Agent 不再执行存章节草稿(登录态保留)"
                      >
                        关闭托管
                      </button>
                    ) : (
                      <button
                        onClick={() => {
                          setFanqieRiskAck(false);
                          setFanqieNotice('');
                          setShowFanqieRisk(true);
                        }}
                        disabled={fanqieBusy || !fanqieStatus?.record?.lastLoginAt}
                        className="shrink-0 whitespace-nowrap px-2.5 py-1 rounded-lg text-xs font-medium text-zinc-500 hover:text-zinc-800 hover:bg-zinc-100 transition disabled:opacity-40"
                        title={
                          fanqieStatus?.record?.lastLoginAt
                            ? '开启后 Agent 可把章节填进番茄编辑器并存草稿,直接执行、无需逐次审批(有限频,落审计)'
                            : '先完成网页版扫码登录,才能开启托管模式'
                        }
                      >
                        托管模式·存草稿
                      </button>
                    )}
                  </>
                )}

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

                {app.authType === 'token' && app.deviceFlow?.available && (
                  <button
                    onClick={() => startDeviceAuth(app.id, app.name)}
                    disabled={mcpSaving}
                    className={`flex shrink-0 items-center gap-1 whitespace-nowrap px-3 py-1 rounded-lg text-xs font-medium transition shadow-2xs ${
                      app.status === 'connected'
                        ? 'bg-zinc-100 hover:bg-zinc-200 text-zinc-700'
                        : 'bg-zinc-900 hover:bg-zinc-800 text-white'
                    }`}
                    title="在服务方页面输一次码即完成授权,token 自动续期(推荐)"
                  >
                    <Smartphone className="h-3 w-3" />
                    <span>{app.status === 'connected' ? '重新设备码授权' : '设备码授权'}</span>
                  </button>
                )}

                {/* 一键公共试用(如飞猪):手动启用,存哨兵 '1';未连接时显示主按钮 */}
                {app.authType === 'token' && app.publicTrial && app.status !== 'connected' && (
                  <button
                    onClick={() => mcpPost({ action: 'saveToken', connectorId: app.id, token: '1' })}
                    disabled={mcpSaving}
                    className="flex shrink-0 items-center gap-1 whitespace-nowrap px-3 py-1 rounded-lg text-xs font-medium bg-zinc-900 hover:bg-zinc-800 text-white transition shadow-2xs"
                    title="手动启用内置公共试用通道(共享额度,人多可能被限流);也可改用粘贴自有 Key"
                  >
                    {mcpSaving ? <RotateCw className="h-3 w-3 animate-spin" /> : <Zap className="h-3 w-3" />}
                    <span>启用公共试用</span>
                  </button>
                )}

                {app.authType === 'token' && app.id !== 'tomato_writer' && (
                  <button
                    onClick={() => {
                      setMcpConfiguring(app);
                      setMcpTokenInput('');
                      setMcpNotice('');
                    }}
                    className={`shrink-0 whitespace-nowrap px-3 py-1 rounded-lg text-xs font-medium transition ${
                      app.deviceFlow?.available || app.publicTrial
                        ? 'text-zinc-600 hover:text-zinc-900 hover:bg-zinc-100'
                        : 'bg-zinc-900 hover:bg-zinc-800 text-white shadow-2xs'
                    }`}
                  >
                    {app.status === 'connected'
                      ? app.publicTrial
                        ? '改用自有 Key'
                        : '更新凭证'
                      : app.deviceFlow?.available
                      ? '改用粘贴凭证'
                      : app.publicTrial
                      ? '粘贴自有 Key'
                      : '打开授权页'}
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
  );

  return (
    <div className="w-full max-w-5xl mx-auto px-4 py-6 md:py-12 pb-24 md:pb-8 space-y-8 animate-fadeIn">
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
              已就绪 {connectedCount}/{totalConnectors}
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
        {displayFiltered.map((app) => (
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
                  ) : app.id === 'email' ? (
                    <span className="flex items-center gap-1 flex-shrink-0">
                      <span
                        className={`text-[10px] px-2 py-0.5 rounded-full font-medium whitespace-nowrap ${
                          emailSmtp?.status === 'connected'
                            ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                            : 'bg-zinc-100 text-zinc-500'
                        }`}
                      >
                        {emailSmtp?.status === 'connected' ? '发信已配' : '发信未配'}
                      </span>
                      <span
                        className={`text-[10px] px-2 py-0.5 rounded-full font-medium whitespace-nowrap ${
                          emailImap?.status === 'connected' || emailSmtp?.status === 'connected'
                            ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                            : 'bg-zinc-100 text-zinc-500'
                        }`}
                        title={emailImap?.status === 'connected' ? '已单独配置收信凭证' : emailSmtp?.status === 'connected' ? '复用发信凭证读信' : '未配置'}
                      >
                        {emailImap?.status === 'connected' ? '收信已配' : emailSmtp?.status === 'connected' ? '收信复用' : '收信未配'}
                      </span>
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

              {/* 小红书专属:网页版登录徽标 + 托管模式状态(scenario-loop P2) */}
              {app.id === 'xiaohongshu' && (
                <div className="space-y-1.5 mb-4">
                  {(() => {
                    const badge = loginBadgeInfo(xhsStatus?.record || undefined);
                    return badge.loggedIn ? (
                      <p className={`text-[10px] leading-relaxed ${badge.maybeStale ? 'text-amber-600' : 'text-emerald-600'}`}>
                        {badge.maybeStale
                          ? `网页版登录可能已过期(${daysAgoText(badge.lastLoginAt!)}登录),建议重新扫码`
                          : `网页版已登录 · ${daysAgoText(badge.lastLoginAt!)}`}
                      </p>
                    ) : (
                      <p className="text-[10px] text-zinc-400 leading-relaxed">
                        网页版未登录 —— 扫码后 Agent 可读创作数据、存草稿
                      </p>
                    );
                  })()}
                  {xhsStatus?.record?.enabled && (
                    <p className="text-[10px] text-zinc-500 leading-relaxed">
                      托管模式已开启:存草稿每日上限 {xhsStatus.dailyLimit} 次,今日已用 {xhsStatus.todayCount} 次,全部操作落审计
                    </p>
                  )}
                  {xhsNotice && <p className="text-[10px] text-red-500 leading-relaxed">{xhsNotice}</p>}
                </div>
              )}
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

                {/* 桌面端提示:唤起能力仅在手机端存在(纯图标+悬浮提示,窄卡片下
                    不与 envVar/配置按钮抢宽度——此前文字版会把底部行挤断行) */}
                {app.mobileAction && !mobileCtx && (
                  <span
                    className="flex shrink-0 items-center px-2 py-1 rounded-lg text-[11px] text-zinc-400 bg-zinc-50 border border-zinc-200"
                    title="真机唤起仅在手机浏览器或 Capacitor App 内可用"
                    aria-label="真机唤起仅手机端可用"
                  >
                    <Smartphone className="h-3 w-3" />
                  </span>
                )}

                {/* 小红书专属:网页版扫码登录 + 托管模式开关(scenario-loop P2) */}
                {app.id === 'xiaohongshu' && (
                  <>
                    <button
                      onClick={() => setShowXhsLogin(true)}
                      className="flex shrink-0 items-center gap-1 whitespace-nowrap px-2.5 py-1 rounded-lg text-xs font-medium bg-rose-50 hover:bg-rose-100 text-rose-700 border border-rose-200 transition shadow-2xs"
                      title="打开服务器浏览器的小红书登录页,用手机 App 扫码;登录态只落本服务"
                    >
                      <QrCode className="h-3 w-3" />
                      <span>网页版扫码登录</span>
                    </button>
                    {/* 接管浏览器(scenario-loop §6):投射服务器的已登录浏览器,
                        用户亲自核对页面/点发布 —— 小红书网页草稿只存浏览器本地,
                        跨端不可见,发布权归人是唯一闭环 */}
                    <button
                      onClick={() =>
                        window.open(
                          '/takeover',
                          '_blank',
                          'noopener,width=1180,height=860'
                        )
                      }
                      className="flex shrink-0 items-center gap-1 whitespace-nowrap px-2.5 py-1 rounded-lg text-xs font-medium bg-amber-50 hover:bg-amber-100 text-amber-700 border border-amber-200 transition shadow-2xs"
                      title="接管服务器上已登录的浏览器:画面实时投射到这里,鼠标键盘由你操控(适合人工点发布)"
                    >
                      <MonitorPlay className="h-3 w-3" />
                      <span>接管浏览器</span>
                    </button>
                    {xhsStatus?.record?.enabled ? (
                      <button
                        onClick={() => void xhsPost({ action: 'disable' })}
                        disabled={xhsBusy}
                        className="shrink-0 whitespace-nowrap px-2.5 py-1 rounded-lg text-xs font-medium text-zinc-500 hover:text-zinc-800 hover:bg-zinc-100 transition disabled:opacity-50"
                        title="关闭托管:Agent 不再执行存草稿(登录态保留)"
                      >
                        关闭托管
                      </button>
                    ) : (
                      <button
                        onClick={() => {
                          setRiskAck(false);
                          setXhsNotice('');
                          setShowXhsRisk(true);
                        }}
                        disabled={xhsBusy || !xhsStatus?.record?.lastLoginAt}
                        className="shrink-0 whitespace-nowrap px-2.5 py-1 rounded-lg text-xs font-medium text-zinc-500 hover:text-zinc-800 hover:bg-zinc-100 transition disabled:opacity-40"
                        title={
                          xhsStatus?.record?.lastLoginAt
                            ? '开启后 Agent 可把笔记存进网页版草稿箱(需审批,有限频,落审计)'
                            : '先完成网页版扫码登录,才能开启托管模式'
                        }
                      >
                        托管模式·存草稿
                      </button>
                    )}
                  </>
                )}

                {/* 凭证配置入口：comingSoon（未接入）与 noCredential（免凭证）不提供任何输入 */}
                {!app.comingSoon && !app.noCredential && (
                  <button
                    onClick={() => {
                      setConfiguringApp(app);
                      setKeyInput('');
                      // 合并卡片:预填收信凭证掩码提示,发信走通用输入
                      setSmtpKeyInput('');
                      setImapKeyInput('');
                      setBaseUrlInput(app.baseUrl || '');
                      setModelNameInput(app.customModelName || '');
                      setReasoningInput(app.reasoningEffort || '');
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
        {/* 知乎:平台账号型 MCP 卡片上提,与微信/小红书同区渲染(卡片 JSX 复用 MCP 渲染函数) */}
        {promotedMcp.map(renderMcpCard)}
      </div>

      {/* 空分组/无搜索结果占位 */}
      {displayFiltered.length === 0 && filteredMcp.length === 0 && (
        <div className="text-center py-10 text-xs text-zinc-400">
          该分组下没有匹配的连接器{searchQuery ? `(搜索「${searchQuery}」无结果)` : ''}
        </div>
      )}

      {/* MCP 连接器区（官方托管直连：一键授权 / 粘贴凭证 / 免凭证） */}
      {regularMcp.length > 0 && (
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
            {regularMcp.map(renderMcpCard)}
          </div>
        </div>
      )}

      {/* MCP Token Config Modal */}
      {mcpConfiguring && (
        <div className="fixed inset-0 z-[80] bg-black/30 backdrop-blur-xs flex items-end sm:items-center justify-center p-0 sm:p-4 overflow-y-auto">
          <div className="w-full sm:max-w-md rounded-t-2xl sm:rounded-2xl bg-white border border-zinc-200 p-5 sm:p-6 shadow-xl animate-fadeIn space-y-4 max-h-[92dvh] overflow-y-auto mb-[env(safe-area-inset-bottom,0px)]">
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

      {/* 设备码授权弹窗（OAuth 2.0 Device Grant）：输一次码即授权,token 自动续期 */}
      {deviceAuth && (
        <div className="fixed inset-0 z-[80] bg-black/30 backdrop-blur-xs flex items-end sm:items-center justify-center p-0 sm:p-4 overflow-y-auto">
          <div className="w-full sm:max-w-md rounded-t-2xl sm:rounded-2xl bg-white border border-zinc-200 p-5 sm:p-6 shadow-xl animate-fadeIn space-y-4 max-h-[92dvh] overflow-y-auto mb-[env(safe-area-inset-bottom,0px)]">
            <div className="flex items-start justify-between">
              <div className="flex items-center gap-3">
                <div className="h-9 w-9 rounded-xl bg-zinc-100 flex items-center justify-center shadow-2xs">
                  {renderMcpIcon(deviceAuth.connectorId, 'h-4 w-4')}
                </div>
                <div>
                  <h3 className="text-sm font-semibold text-zinc-900">授权 {deviceAuth.connectorName}</h3>
                  <p className="text-xs text-zinc-500 mt-0.5">设备码授权：token 自动续期，免换 key</p>
                </div>
              </div>
              <button onClick={closeDeviceAuth} className="text-zinc-400 hover:text-zinc-700 p-1 rounded-md">
                <X className="h-4 w-4" />
              </button>
            </div>

            {deviceAuth.phase === 'polling' && (
              <div className="space-y-3.5">
                <div className="px-3 py-2.5 rounded-xl bg-zinc-50 border border-zinc-200 text-xs text-zinc-600 leading-relaxed space-y-2">
                  <p className="flex items-start gap-2">
                    <span className="shrink-0 h-4 w-4 rounded-full bg-zinc-900 text-white text-[10px] flex items-center justify-center font-semibold mt-px">1</span>
                    <span>
                      打开{' '}
                      <a
                        href={deviceAuth.verificationUri}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="font-medium text-zinc-900 underline underline-offset-2"
                      >
                        {deviceAuth.verificationUri.replace(/^https?:\/\//, '')}
                      </a>
                      （手机或电脑浏览器均可）
                    </span>
                  </p>
                  <p className="flex items-start gap-2">
                    <span className="shrink-0 h-4 w-4 rounded-full bg-zinc-900 text-white text-[10px] flex items-center justify-center font-semibold mt-px">2</span>
                    <span>输入下方用户码并确认授权</span>
                  </p>
                </div>

                <button
                  type="button"
                  onClick={async () => {
                    if (await copyToClipboard(deviceAuth.userCode)) {
                      setCopiedUserCode(true);
                      setTimeout(() => setCopiedUserCode(false), 2000);
                    }
                  }}
                  className="w-full flex items-center justify-center gap-2.5 px-4 py-3.5 rounded-xl border-2 border-dashed border-zinc-300 bg-white hover:border-zinc-400 transition group"
                  title="点击复制用户码"
                >
                  <span className="text-2xl font-mono font-bold tracking-[0.3em] text-zinc-900">
                    {deviceAuth.userCode}
                  </span>
                  {copiedUserCode ? (
                    <Check className="h-4 w-4 text-emerald-600" />
                  ) : (
                    <Copy className="h-4 w-4 text-zinc-300 group-hover:text-zinc-500" />
                  )}
                </button>

                <div className="flex items-center justify-center gap-2 text-xs text-zinc-500">
                  <RotateCw className="h-3.5 w-3.5 animate-spin" />
                  <span>
                    等待页面确认…（每 {deviceAuth.interval}s 自动查询，剩余{' '}
                    {Math.max(0, Math.round((deviceAuth.expiresAt - Date.now()) / 60))} 分钟）
                  </span>
                </div>
                <p className="text-[10px] text-zinc-400 flex items-center justify-center gap-1">
                  <ShieldCheck className="h-3 w-3" />
                  授权范围与权限以你在 GitHub 确认页看到的为准；token 加密存于你的个人空间
                </p>
              </div>
            )}

            {deviceAuth.phase === 'success' && (
              <div className="py-4 text-center space-y-3">
                <div className="mx-auto h-11 w-11 rounded-full bg-emerald-50 border border-emerald-200 flex items-center justify-center">
                  <Check className="h-5 w-5 text-emerald-600" />
                </div>
                <div>
                  <p className="text-sm font-semibold text-zinc-900">授权成功，工具已挂载</p>
                  <p className="text-xs text-zinc-500 mt-1">OAuth token 自动续期，无需再换 key</p>
                </div>
                <button
                  onClick={closeDeviceAuth}
                  className="px-4 py-1.5 rounded-lg bg-zinc-900 hover:bg-zinc-800 text-white text-xs font-medium transition"
                >
                  完成
                </button>
              </div>
            )}

            {(deviceAuth.phase === 'expired' || deviceAuth.phase === 'denied' || deviceAuth.phase === 'error') && (
              <div className="py-3 text-center space-y-3">
                <p className="text-sm font-medium text-zinc-900">
                  {deviceAuth.phase === 'expired'
                    ? '设备码已过期'
                    : deviceAuth.phase === 'denied'
                    ? '授权已在页面上被拒绝'
                    : '授权失败'}
                </p>
                {deviceAuth.error && <p className="text-xs text-red-600 break-all">{deviceAuth.error}</p>}
                <div className="flex items-center justify-center gap-2">
                  <button
                    onClick={closeDeviceAuth}
                    className="px-3 py-1.5 rounded-lg text-xs font-medium text-zinc-600 hover:bg-zinc-100 transition"
                  >
                    关闭
                  </button>
                  <button
                    onClick={() => startDeviceAuth(deviceAuth.connectorId, deviceAuth.connectorName)}
                    className="px-4 py-1.5 rounded-lg bg-zinc-900 hover:bg-zinc-800 text-white text-xs font-medium transition"
                  >
                    重新发起
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Key Config Modal */}
      {configuringApp && (
        <div className="fixed inset-0 z-[80] bg-black/30 backdrop-blur-xs flex items-end sm:items-center justify-center p-0 sm:p-4 overflow-y-auto">
          <div className="w-full sm:max-w-md rounded-t-2xl sm:rounded-2xl bg-white border border-zinc-200 p-5 sm:p-6 shadow-xl animate-fadeIn space-y-4 max-h-[92dvh] overflow-y-auto mb-[env(safe-area-inset-bottom,0px)]">
            <div className="flex items-start justify-between">
              <div className="flex items-center gap-3">
                <div className="h-9 w-9 rounded-xl bg-zinc-100 flex items-center justify-center shadow-2xs">
                  {renderConnectorIcon(configuringApp.id, 'h-4 w-4')}
                </div>
                <div>
                  <h3 className="text-sm font-semibold text-zinc-900">
                    配置 {configuringApp.name}
                  </h3>
                  {configuringApp.id === 'email' ? (
                    <p className="text-xs text-zinc-500 font-mono mt-0.5">
                      EMAIL_SMTP_CREDENTIAL / EMAIL_IMAP_CREDENTIAL
                    </p>
                  ) : (
                    configuringApp.envVar && (
                      <p className="text-xs text-zinc-500 font-mono mt-0.5">
                        环境变量: {configuringApp.envVar}
                      </p>
                    )
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

            {configuringApp.id === 'email' ? (
              <form onSubmit={handleSaveEmail} className="space-y-4">
                <div className="px-3 py-2.5 rounded-xl bg-amber-50 border border-amber-200/70 text-[11px] text-amber-800 leading-relaxed">
                  按 账号:授权码 格式填写（QQ/163/Gmail/Outlook 自动识别服务器）。QQ：邮箱设置→账户→开启 SMTP 并生成授权码；163：设置→POP3/SMTP→开启并获取授权码；Gmail：开启两步验证后生成应用专用密码——均不是登录密码。
                </div>
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-zinc-700 block">
                    发信凭证（SMTP） <span className="text-red-500">*</span>
                    {emailSmtp?.status === 'connected' && (
                      <span className="ml-1 text-[10px] font-normal text-emerald-600">已配置，不填则保留</span>
                    )}
                  </label>
                  <input
                    type="password"
                    value={smtpKeyInput}
                    onChange={(e) => setSmtpKeyInput(e.target.value)}
                    placeholder={emailSmtp?.keyMasked || '账号:授权码，如 user@qq.com:abcd1234'}
                    className="w-full px-3 py-2 rounded-xl border border-zinc-300 bg-white text-xs text-zinc-900 placeholder-zinc-400 focus:outline-none focus:border-zinc-500"
                  />
                  <p className="text-[10px] text-zinc-400">开通 email_send：发任务报告、内容投递、通知提醒</p>
                </div>
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-zinc-700 block">
                    收信凭证（IMAP） <span className="text-zinc-400 font-normal">可选</span>
                    {emailImap?.status === 'connected' && (
                      <span className="ml-1 text-[10px] font-normal text-emerald-600">已配置，不填则保留</span>
                    )}
                  </label>
                  <input
                    type="password"
                    value={imapKeyInput}
                    onChange={(e) => setImapKeyInput(e.target.value)}
                    placeholder={emailImap?.keyMasked || '留空则复用发信凭证'}
                    className="w-full px-3 py-2 rounded-xl border border-zinc-300 bg-white text-xs text-zinc-900 placeholder-zinc-400 focus:outline-none focus:border-zinc-500"
                  />
                  <p className="text-[10px] text-zinc-400">开通 email_list / email_read：读收件箱（默认不改已读）。QQ/163/Gmail 的授权码收发通用，留空即可；仅自建邮箱收发服务器不同时才需单独填。</p>
                </div>
                <div className="flex items-center justify-end gap-2 pt-1">
                  <button
                    type="button"
                    onClick={() => setConfiguringApp(null)}
                    className="px-3 py-1.5 rounded-lg text-xs font-medium text-zinc-600 hover:bg-zinc-100 transition"
                  >
                    取消
                  </button>
                  <button
                    type="submit"
                    disabled={(!smtpKeyInput.trim() && emailSmtp?.status !== 'connected') || isSaving}
                    className="flex items-center gap-1.5 px-4 py-1.5 rounded-lg bg-zinc-900 hover:bg-zinc-800 disabled:opacity-40 text-white text-xs font-medium transition shadow-xs"
                  >
                    {isSaving && <RotateCw className="h-3.5 w-3.5 animate-spin" />}
                    <span>保存连接</span>
                  </button>
                </div>
              </form>
            ) : (
            <form onSubmit={handleSave} className="space-y-4">
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-zinc-700 block">
                  API Key / Token{' '}
                  {configuringApp.isModel && configuringApp.status === 'connected' ? (
                    <span className="text-[10px] font-normal text-emerald-600">已配置,不填则保留(可只改下方设置)</span>
                  ) : (
                    <span className="text-red-500">*</span>
                  )}
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
                    {configuringApp.websiteUrl && (
                      <a
                        href={configuringApp.websiteUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="mt-1.5 flex items-center gap-1 font-medium text-amber-900 underline underline-offset-2"
                      >
                        <ExternalLink className="h-3 w-3" />
                        打开官网获取 Key
                      </a>
                    )}
                  </p>
                )}
                {!configuringApp.configHint && configuringApp.websiteUrl && (
                  <a
                    href={configuringApp.websiteUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-1 text-[11px] font-medium text-zinc-600 underline underline-offset-2 hover:text-zinc-900"
                  >
                    <ExternalLink className="h-3 w-3" />
                    打开官网获取 Key
                  </a>
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

                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between">
                      <label className="text-xs font-medium text-zinc-700 block">
                        思考深度 (Reasoning Effort)
                      </label>
                      <span className="text-[10px] text-zinc-400">可选</span>
                    </div>
                    <select
                      value={reasoningInput}
                      onChange={(e) => setReasoningInput(e.target.value)}
                      className="w-full px-3 py-2 rounded-xl border border-zinc-300 bg-white text-xs text-zinc-900 focus:outline-none focus:border-zinc-500"
                    >
                      <option value="">默认(跟随全局配置或厂商缺省)</option>
                      <option value="low">低 — 反应快、省 token,适合简单任务</option>
                      <option value="medium">中 — 均衡</option>
                      <option value="high">高 — 深度推理,更慢更贵</option>
                    </select>
                    <p className="text-[10px] text-zinc-400">
                      仅对推理型模型有意义(如 deepseek-reasoner、o 系列、QwQ);非推理模型会忽略该参数,严格中转站可能拒绝未知参数——拿不准就留默认。
                    </p>
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
                  disabled={
                    (!keyInput.trim() &&
                      !(configuringApp.isModel && configuringApp.status === 'connected')) ||
                    isSaving
                  }
                  className="flex items-center gap-1.5 px-4 py-1.5 rounded-lg bg-zinc-900 hover:bg-zinc-800 disabled:opacity-40 text-white text-xs font-medium transition shadow-xs"
                >
                  {isSaving && <RotateCw className="h-3.5 w-3.5 animate-spin" />}
                  <span>保存连接</span>
                </button>
              </div>
            </form>
            )}
          </div>
        </div>
      )}

      {/* 小红书网页版扫码登录弹窗(scenario-loop P2 模块 1) */}
      {showXhsLogin && (
        <XhsWebLoginModal
          onClose={() => setShowXhsLogin(false)}
          onLoggedIn={() => void loadXhsStatus()}
        />
      )}

      {/* 知乎网页版扫码登录弹窗(同一状态机,platform=zhihu) */}
      {showZhihuLogin && (
        <XhsWebLoginModal
          platform="zhihu"
          onClose={() => setShowZhihuLogin(false)}
          onLoggedIn={() => void loadZhihuStatus()}
        />
      )}

      {/* 知乎托管模式风险明示弹窗(与小红书同款:开启前的强制确认) */}
      {showZhihuRisk && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-xs z-50 flex items-center justify-center p-4 animate-fadeIn">
          <div className="w-full max-w-md rounded-2xl bg-white border border-zinc-200 p-6 shadow-xl space-y-4">
            <h3 className="text-sm font-semibold text-zinc-900 flex items-center gap-2">
              <ShieldAlert className="h-4 w-4 text-amber-500" />
              开启「托管模式 · 存草稿」
            </h3>
            <div className="space-y-2 text-[11px] text-zinc-600 leading-relaxed">
              <p>开启后,Agent 可以替你把文章填进知乎专栏编辑器,停在平台的服务端自动保存 —— 终点是知乎草稿箱(跨端可见)。请知悉:</p>
              <ul className="list-disc pl-4 space-y-1">
                <li><b>风控灰色地带</b>:平台对自动化操作的态度随时可能变化,存在账号被限流/风控的风险,由你自行承担;</li>
                <li><b>每日上限</b>:存草稿每天至多 {zhihuStatus?.dailyLimit ?? 3} 次(超出直接拒绝);</li>
                <li><b>操作落审计</b>:每次存草稿(含成败)都会记录在本服务的审计日志;</li>
                <li><b>发布永远归你</b>:发布按钮被代码级围栏永久拦截,Agent 只能存草稿,发布由你本人在知乎草稿箱内完成。</li>
              </ul>
            </div>
            <label className="flex items-start gap-2 text-xs text-zinc-700 cursor-pointer">
              <input
                type="checkbox"
                checked={zhihuRiskAck}
                onChange={(e) => setZhihuRiskAck(e.target.checked)}
                className="mt-0.5"
              />
              <span>我已了解上述风险,愿意开启托管模式</span>
            </label>
            <div className="flex items-center justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={() => setShowZhihuRisk(false)}
                className="px-3 py-1.5 rounded-lg text-xs font-medium text-zinc-600 hover:bg-zinc-100 transition"
              >
                取消
              </button>
              <button
                type="button"
                disabled={!zhihuRiskAck || zhihuBusy}
                onClick={async () => {
                  const ok = await zhihuPost({ action: 'enable', riskAcknowledged: true });
                  if (ok) setShowZhihuRisk(false);
                }}
                className="px-4 py-1.5 rounded-lg bg-zinc-900 hover:bg-zinc-800 disabled:opacity-40 text-white text-xs font-medium transition shadow-xs"
              >
                {zhihuBusy ? '开启中…' : '开启托管模式'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 番茄网页版扫码登录弹窗(同一状态机,platform=fanqie) */}
      {showFanqieLogin && (
        <XhsWebLoginModal
          platform="fanqie"
          onClose={() => setShowFanqieLogin(false)}
          onLoggedIn={() => void loadFanqieStatus()}
        />
      )}

      {/* 番茄托管模式风险明示弹窗(与知乎同款;差异:一次性确认即全授权,存草稿不逐次审批) */}
      {showFanqieRisk && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-xs z-50 flex items-center justify-center p-4 animate-fadeIn">
          <div className="w-full max-w-md rounded-2xl bg-white border border-zinc-200 p-6 shadow-xl space-y-4">
            <h3 className="text-sm font-semibold text-zinc-900 flex items-center gap-2">
              <ShieldAlert className="h-4 w-4 text-amber-500" />
              开启「托管模式 · 存草稿」
            </h3>
            <div className="space-y-2 text-[11px] text-zinc-600 leading-relaxed">
              <p>开启后,Agent 可以替你把章节填进番茄作家后台的章节编辑器,停在平台的草稿箱(网页版与番茄作家助手 App 跨端可见)。请知悉:</p>
              <ul className="list-disc pl-4 space-y-1">
                <li><b>无需逐次审批</b>:本次确认即对之后的每次存草稿生效,Agent 直接执行,不再逐次询问你;</li>
                <li><b>风控灰色地带</b>:平台对自动化操作的态度随时可能变化,存在账号被限流/风控的风险,由你自行承担;</li>
                <li><b>每日上限</b>:存草稿每天至多 {fanqieStatus?.dailyLimit ?? 3} 次(超出直接拒绝);</li>
                <li><b>操作落审计</b>:每次存草稿(含成败)都会记录在本服务的审计日志;</li>
                <li><b>发布永远归你</b>:发布/定时发布按钮被代码级围栏永久拦截,Agent 只能存草稿,发布由你本人在番茄后台完成。</li>
              </ul>
            </div>
            <label className="flex items-start gap-2 text-xs text-zinc-700 cursor-pointer">
              <input
                type="checkbox"
                checked={fanqieRiskAck}
                onChange={(e) => setFanqieRiskAck(e.target.checked)}
                className="mt-0.5"
              />
              <span>我已了解上述风险,愿意开启托管模式(之后存草稿直接执行)</span>
            </label>
            <div className="flex items-center justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={() => setShowFanqieRisk(false)}
                className="px-3 py-1.5 rounded-lg text-xs font-medium text-zinc-600 hover:bg-zinc-100 transition"
              >
                取消
              </button>
              <button
                type="button"
                disabled={!fanqieRiskAck || fanqieBusy}
                onClick={async () => {
                  const ok = await fanqiePost({ action: 'enable', riskAcknowledged: true });
                  if (ok) setShowFanqieRisk(false);
                }}
                className="px-4 py-1.5 rounded-lg bg-zinc-900 hover:bg-zinc-800 disabled:opacity-40 text-white text-xs font-medium transition shadow-xs"
              >
                {fanqieBusy ? '开启中…' : '开启托管模式'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 托管模式风险明示弹窗(scenario-loop P2 模块 2:开启前的强制确认) */}
      {showXhsRisk && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-xs z-50 flex items-center justify-center p-4 animate-fadeIn">
          <div className="w-full max-w-md rounded-2xl bg-white border border-zinc-200 p-6 shadow-xl space-y-4">
            <h3 className="text-sm font-semibold text-zinc-900 flex items-center gap-2">
              <ShieldAlert className="h-4 w-4 text-amber-500" />
              开启「托管模式 · 存草稿」
            </h3>
            <div className="space-y-2 text-[11px] text-zinc-600 leading-relaxed">
              <p>开启后,Agent 可以替你把笔记填进小红书网页版发布页,停在平台的自动保存 —— 终点是草稿箱。请知悉:</p>
              <ul className="list-disc pl-4 space-y-1">
                <li><b>风控灰色地带</b>:平台对自动化操作的态度随时可能变化,存在账号被限流/风控的风险,由你自行承担;</li>
                <li><b>每日上限</b>:存草稿每天至多 {xhsStatus?.dailyLimit ?? 3} 次(超出直接拒绝);</li>
                <li><b>操作落审计</b>:每次存草稿(含成败)都会记录在本服务的审计日志;</li>
                <li><b>发布永远归你</b>:发布按钮被代码级围栏永久拦截,Agent 只能存草稿,发布由你本人在 App 内完成。</li>
              </ul>
            </div>
            <label className="flex items-start gap-2 text-xs text-zinc-700 cursor-pointer">
              <input
                type="checkbox"
                checked={riskAck}
                onChange={(e) => setRiskAck(e.target.checked)}
                className="mt-0.5"
              />
              <span>我已了解上述风险,愿意开启托管模式</span>
            </label>
            <div className="flex items-center justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={() => setShowXhsRisk(false)}
                className="px-3 py-1.5 rounded-lg text-xs font-medium text-zinc-600 hover:bg-zinc-100 transition"
              >
                取消
              </button>
              <button
                type="button"
                disabled={!riskAck || xhsBusy}
                onClick={async () => {
                  const ok = await xhsPost({ action: 'enable', riskAcknowledged: true });
                  if (ok) setShowXhsRisk(false);
                }}
                className="px-4 py-1.5 rounded-lg bg-zinc-900 hover:bg-zinc-800 disabled:opacity-40 text-white text-xs font-medium transition shadow-xs"
              >
                {xhsBusy ? '开启中…' : '开启托管模式'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
