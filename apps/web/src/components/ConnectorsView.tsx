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
  ShieldAlert,
} from 'lucide-react';
import { ConnectorApp, McpConnectorInfo } from '../types/agent';
import { openAppScheme, isNativePlatform } from '../utils/nativeBridge';
import { XhsWebLoginModal } from './XhsWebLoginModal';
import { loginBadgeInfo } from '../lib/browser-login';
import type { XhsManagedRecord } from '../lib/user-store';

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
  { key: 'office', label: '办公协作', ids: ['notion_mcp', 'lark_suite', 'dingtalk_mcp', 'atlassian_mcp', 'yuque', 'dida365', 'tencent_docs', 'tencent_meeting', 'youdao_note', 'tencent_weiyun', 'tencent_lexiang', 'ardot'] },
  { key: 'invest', label: '投资理财', ids: ['tushare', 'alphavantage_mcp', 'coingecko_mcp', 'a_stock'] },
  { key: 'edu', label: '学习教研', ids: ['openalex', 'alphaxiv', 'huggingface_mcp', 'deepl_mcp', 'deepwiki'] },
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
  /** 任务中途授权跳转过来时自动打开对应连接器的配置弹窗 */
  autoConfigureId?: string | null;
  onAutoConfigureHandled?: () => void;
}

export function ConnectorsView({
  connectors,
  onSaveKey,
  onSetDefaultModel,
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

      {/* 小红书网页版扫码登录弹窗(scenario-loop P2 模块 1) */}
      {showXhsLogin && (
        <XhsWebLoginModal
          onClose={() => setShowXhsLogin(false)}
          onLoggedIn={() => void loadXhsStatus()}
        />
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
