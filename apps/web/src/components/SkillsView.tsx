'use client';

import React, { useCallback, useEffect, useState } from 'react';
import {
  Sparkles,
  Trash2,
  Search,
  X,
  RotateCw,
  Package,
  Store,
  Cpu,
  Download,
  Eye,
  AlertTriangle,
  ExternalLink,
  RefreshCw,
  CheckCircle2,
  FolderGit2,
  ChevronDown,
  ChevronUp,
} from 'lucide-react';

// ---- 类型(与 /api/skills* 响应同型) ----

interface SkillCardItem {
  id: string;
  trigger: string;
  steps: string;
  avoid?: string;
  check?: string;
  risk?: string;
  keywords: string[];
  hitCount: number;
  sourceMissionId?: string;
  createdAt: number;
  updatedAt: number;
}

interface InstalledPack {
  name: string;
  description: string;
  dirName: string;
  hasScripts: boolean;
  importedAt?: number;
  fileCount?: number;
  source?: { platform?: 'github' | 'modelscope'; repo: string; ref: string; sha: string; path: string };
  contentHash?: string;
}

interface BuiltinInventory {
  flows: Array<{ form: 'flow'; name: string; description: string }>;
  packs: Array<{ form: 'pack'; name: string; description: string; hasScripts: boolean }>;
}

interface MarketSkill {
  sourceId: string;
  sourceLabel: string;
  platform?: 'github' | 'modelscope';
  repo: string;
  path: string;
  name: string;
  category?: string;
  description?: string;
  displayName?: string;
  externalUrl?: string;
  downloads?: number;
}

interface MarketSource {
  id: string;
  label: string;
  repo: string;
  type?: 'github' | 'modelscope';
  error?: string;
  skills: MarketSkill[];
}

interface SkillDetail {
  name: string;
  description: string;
  content: string;
}

type Section = 'all' | 'cards' | 'installed' | 'market' | 'builtin';

interface SkillsViewProps {
  /** 数量上报(导航角标用;父层可选消费) */
  onCountsChange?: (counts: { cards: number; installed: number }) => void;
}

export function SkillsView({ onCountsChange }: SkillsViewProps) {
  // 默认落「技能市场」且只看魔搭:魔搭是主力浏览路径(8万+条目、服务端搜索、国内快),
  // GitHub 源小且网络不稳;「全部」分区仍保留(四块堆叠),只是不再作为落地态
  const [section, setSection] = useState<Section>('market');
  const [searchQuery, setSearchQuery] = useState('');

  const [cards, setCards] = useState<SkillCardItem[]>([]);
  const [installed, setInstalled] = useState<InstalledPack[]>([]);
  const [builtin, setBuiltin] = useState<BuiltinInventory>({ flows: [], packs: [] });
  const [marketEnabled, setMarketEnabled] = useState(true);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [market, setMarket] = useState<MarketSource[] | null>(null);
  const [marketLoading, setMarketLoading] = useState(false);
  const [marketError, setMarketError] = useState<string | null>(null);
  // 已发给服务端的搜索词(魔搭 8 万+ 条目必须走服务端搜索;防抖 600ms)
  const [marketSearch, setMarketSearch] = useState('');

  // 弹窗状态
  const [deleteCardTarget, setDeleteCardTarget] = useState<SkillCardItem | null>(null);
  const [uninstallTarget, setUninstallTarget] = useState<InstalledPack | null>(null);
  const [importTarget, setImportTarget] = useState<MarketSkill | null>(null);
  const [detail, setDetail] = useState<{ skill: MarketSkill; data: SkillDetail } | null>(null);
  const [detailLoading, setDetailLoading] = useState<MarketSkill | null>(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  const showToast = (kind: 'ok' | 'err', text: string) => {
    setToast({ kind, text });
    window.setTimeout(() => setToast(null), 4000);
  };

  const loadSkills = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await fetch('/api/skills');
      const data = await res.json();
      if (!data.success) throw new Error(data.error || '加载失败');
      setCards(data.cards || []);
      setInstalled(data.installed || []);
      setBuiltin(data.builtin || { flows: [], packs: [] });
      setMarketEnabled(data.marketEnabled !== false);
      onCountsChange?.({ cards: (data.cards || []).length, installed: (data.installed || []).length });
    } catch (e: any) {
      setLoadError(String(e?.message || e));
    } finally {
      setLoading(false);
    }
  }, [onCountsChange]);

  useEffect(() => {
    loadSkills();
  }, [loadSkills]);

  const loadMarket = useCallback(async (refresh = false, search?: string) => {
    setMarketLoading(true);
    setMarketError(null);
    try {
      const qs = new URLSearchParams();
      if (refresh) qs.set('refresh', '1');
      if (search && search.trim()) qs.set('search', search.trim());
      const suffix = qs.toString();
      const res = await fetch(`/api/skills/market${suffix ? `?${suffix}` : ''}`);
      const data = await res.json();
      if (!data.success) throw new Error(data.error || '市场索引加载失败');
      setMarket(data.sources || []);
    } catch (e: any) {
      setMarketError(String(e?.message || e));
    } finally {
      setMarketLoading(false);
    }
  }, []);

  // 切到市场分区时懒加载索引
  useEffect(() => {
    if ((section === 'market' || section === 'all') && marketEnabled && market === null && !marketLoading) {
      loadMarket();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [section, marketEnabled]);

  // 市场搜索防抖:输入停顿 500ms 后带 search 重新拉取(魔搭走服务端搜索)
  useEffect(() => {
    if (section !== 'market' && section !== 'all') return;
    if (!marketEnabled || market === null) return;
    const trimmed = searchQuery.trim();
    if (trimmed === marketSearch) return;
    const t = window.setTimeout(() => {
      setMarketSearch(trimmed);
      loadMarket(false, trimmed || undefined);
    }, 500);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchQuery, section, marketEnabled, market]);

  const handleDeleteCard = async () => {
    if (!deleteCardTarget || busy) return;
    setBusy(true);
    try {
      const res = await fetch('/api/skills', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'delete-card', id: deleteCardTarget.id }),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error || '删除失败');
      showToast('ok', '技能卡已删除(台账留痕)');
      setDeleteCardTarget(null);
      await loadSkills();
    } catch (e: any) {
      showToast('err', String(e?.message || e));
    } finally {
      setBusy(false);
    }
  };

  const handleUninstall = async () => {
    if (!uninstallTarget || busy) return;
    setBusy(true);
    try {
      const res = await fetch('/api/skills', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'uninstall-pack', name: uninstallTarget.dirName }),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error || '解除引用失败');
      showToast('ok', `已解除引用「${uninstallTarget.name}」`);
      setUninstallTarget(null);
      await loadSkills();
    } catch (e: any) {
      showToast('err', String(e?.message || e));
    } finally {
      setBusy(false);
    }
  };

  const handleImport = async () => {
    if (!importTarget || busy) return;
    setBusy(true);
    try {
      const res = await fetch('/api/skills/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          repo: importTarget.repo,
          path: importTarget.path,
          ...(importTarget.platform === 'modelscope' ? { platform: 'modelscope' } : {}),
          riskAck: true,
        }),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error || '引用失败');
      showToast('ok', data.message || '已引用');
      setImportTarget(null);
      await loadSkills();
    } catch (e: any) {
      showToast('err', String(e?.message || e));
    } finally {
      setBusy(false);
    }
  };

  const openDetail = async (skill: MarketSkill) => {
    setDetailLoading(skill);
    try {
      const qs = new URLSearchParams({ repo: skill.repo, path: skill.path });
      if (skill.platform === 'modelscope') qs.set('platform', 'modelscope');
      const res = await fetch(`/api/skills/market?${qs.toString()}`);
      const data = await res.json();
      if (!data.success) throw new Error(data.error || '详情加载失败');
      setDetail({ skill, data: data.detail });
    } catch (e: any) {
      showToast('err', String(e?.message || e));
    } finally {
      setDetailLoading(null);
    }
  };

  const q = searchQuery.trim().toLowerCase();
  const matchQ = (...fields: Array<string | undefined>) =>
    !q || fields.some((f) => (f || '').toLowerCase().includes(q));

  const filteredCards = cards.filter((c) => matchQ(c.trigger, c.steps, c.avoid, ...(c.keywords || [])));
  const filteredInstalled = installed.filter((p) => matchQ(p.name, p.description, p.source?.repo));
  // 魔搭条目不做本地过滤:服务端搜索是唯一权威(匹配字段更全,本地 matchQ 反而误杀)。
  // 此前输入期间(防抖未触发、marketSearch 还是旧值)每个键击都本地重滤一遍前 50 条,
  // 三列网格随键伸缩、页面跳动;现在防抖等待期保持上一批服务端结果稳定展示,
  // 新结果到达一次性替换(每次搜索至多一次重排)。github 条目(env 配源才会出现)
  // 仍本地过滤作输入中的即时反馈。
  const filteredMarket: MarketSource[] = (market || [])
    .map((s) => ({
      ...s,
      skills: s.skills.filter(
        (k) =>
          k.platform === 'modelscope' ||
          matchQ(k.name, k.displayName, k.description, k.path, k.category, k.repo)
      ),
    }))
    .filter((s) => s.error || s.skills.length > 0);
  const filteredBuiltinFlows = builtin.flows.filter((f) => matchQ(f.name, f.description));
  const filteredBuiltinPacks = builtin.packs.filter((p) => matchQ(p.name, p.description));

  const sections: Array<{ id: Section; label: string; count?: number }> = [
    { id: 'all', label: '全部' },
    { id: 'cards', label: '我的技能卡', count: cards.length },
    { id: 'installed', label: '已引用生态技能', count: installed.length },
    { id: 'market', label: '技能市场', count: market ? market.reduce((n, s) => n + s.skills.length, 0) : undefined },
    { id: 'builtin', label: '内置技能', count: builtin.flows.length + builtin.packs.length },
  ];

  const show = (id: Section) => section === 'all' || section === id;

  // 渐进披露(纯客户端切片,零后台请求 —— 列表数据已全量在内存):
  // 技能卡/已引用首屏 LIST_PAGE 张,市场按源分桶每源 MARKET_PAGE 张。
  // 卡片/已引用随搜索词或分区切换复位;市场只认防抖落定的 marketSearch 与
  // 数据重载,不随键击复位 —— 否则与「防抖等待期稳定展示」的防跳动语义打架
  const cardsPaging = useShowMore(filteredCards.length, LIST_PAGE, `${section}|${q}`);
  const installedPaging = useShowMore(filteredInstalled.length, LIST_PAGE, `${section}|${q}`);
  const [marketVisible, setMarketVisible] = useState<Record<string, number>>({});
  useEffect(() => {
    setMarketVisible({});
  }, [marketSearch, section, market]);

  return (
    <div className="w-full max-w-5xl mx-auto px-4 py-8 md:py-12 space-y-8 animate-fadeIn">
      {/* 头部 */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2.5">
            <div className="p-1.5 rounded-xl bg-amber-50 text-amber-600 border border-amber-200/60 shadow-2xs">
              <Sparkles className="h-5 w-5" />
            </div>
            <h1 className="text-2xl font-semibold tracking-tight text-zinc-900">技能中心</h1>
            {cards.length + installed.length > 0 && (
              <span className="text-xs font-mono font-medium px-2 py-0.5 rounded-full bg-zinc-100 border border-zinc-200/80 text-zinc-600">
                {cards.length} 卡 · {installed.length} 包
              </span>
            )}
          </div>
          <p className="text-xs text-zinc-500 mt-1 max-w-xl leading-relaxed">
            任务跑完自动蒸馏的操作程序沉淀为技能卡(可随时删除);生态技能包可一键引用到本机(第三方代码,安装前请确认风险)。安装后不自动载入任何会话 —— 只有在会话输入区、巡航任务或长期目标里显式勾选引用,其指令才会注入对应任务;不再需要时解除引用即彻底移除。
          </p>
        </div>
        <button
          onClick={loadSkills}
          className="flex items-center gap-1.5 px-4 py-2 rounded-xl bg-zinc-100 hover:bg-zinc-200/70 text-zinc-700 text-xs font-medium transition flex-shrink-0"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
          <span>刷新</span>
        </button>
      </div>

      {/* 分区 + 搜索 */}
      <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3">
        <div className="flex items-center gap-1.5 overflow-x-auto pb-1 sm:pb-0">
          {sections.map((s) => (
            <button
              key={s.id}
              onClick={() => setSection(s.id)}
              className={`px-3 py-1.5 rounded-xl text-xs font-medium whitespace-nowrap transition flex items-center gap-1.5 ${
                section === s.id
                  ? 'bg-zinc-900 text-white shadow-xs'
                  : 'bg-zinc-100 hover:bg-zinc-200/70 text-zinc-600'
              }`}
            >
              <span>{s.label}</span>
              {s.count !== undefined && (
                <span
                  className={`text-[10px] px-1 rounded-full ${
                    section === s.id ? 'bg-zinc-700 text-zinc-200' : 'bg-zinc-200 text-zinc-500'
                  }`}
                >
                  {s.count}
                </span>
              )}
            </button>
          ))}
        </div>
        <div className="relative w-full sm:w-64">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-zinc-400" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="搜索技能..."
            className="w-full pl-9 pr-4 py-1.5 rounded-xl border border-zinc-200 bg-white text-xs text-zinc-900 placeholder-zinc-400 focus:outline-none focus:border-zinc-400 transition"
          />
        </div>
      </div>

      {loadError && (
        <div className="px-4 py-3 rounded-xl bg-red-50 border border-red-200 text-xs text-red-700">
          加载失败: {loadError}
        </div>
      )}

      {/* 我的技能卡 */}
      {show('cards') && (
        <section className="space-y-3">
          <h2 className="text-sm font-semibold text-zinc-800 flex items-center gap-1.5">
            <Sparkles className="h-4 w-4 text-amber-500" />
            我的技能卡
            <span className="text-[10px] font-normal text-zinc-400">任务轨迹自动蒸馏 · 执行任务时按相关性自动注入</span>
          </h2>
          {filteredCards.length === 0 ? (
            <EmptyHint text="还没有沉淀技能卡 —— 完成几个任务(尤其工坊类重复任务)后会自动蒸馏出来" />
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {filteredCards.slice(0, cardsPaging.shown).map((c) => (
                <div
                  key={c.id}
                  className="p-5 rounded-2xl border border-zinc-200 bg-white hover:border-zinc-300 hover:shadow-xs transition flex flex-col justify-between group"
                >
                  <div className="space-y-2">
                    <div className="flex items-start justify-between gap-2">
                      <h3 className="text-xs font-semibold text-zinc-900 leading-snug">{c.trigger}</h3>
                      <span className="text-[10px] px-2 py-0.5 rounded-full font-medium bg-amber-50 text-amber-700 border border-amber-200 flex-shrink-0">
                        自动蒸馏
                      </span>
                    </div>
                    <FieldRow label="Do" text={c.steps} />
                    {c.avoid && <FieldRow label="Avoid" text={c.avoid} tone="red" />}
                    {c.check && <FieldRow label="Check" text={c.check} tone="blue" />}
                    {c.risk && <FieldRow label="Risk" text={c.risk} tone="amber" />}
                    {c.keywords?.length > 0 && (
                      <div className="flex flex-wrap gap-1 pt-1">
                        {c.keywords.slice(0, 6).map((k) => (
                          <span key={k} className="text-[10px] px-1.5 py-0.5 rounded bg-zinc-100 text-zinc-500 font-mono">
                            {k}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                  <div className="pt-3 mt-3 border-t border-zinc-100 flex items-center justify-between text-[10px] text-zinc-400">
                    <span className="font-mono">
                      {new Date(c.updatedAt).toLocaleDateString()} · 命中 {c.hitCount} 次
                    </span>
                    <button
                      onClick={() => setDeleteCardTarget(c)}
                      className="opacity-0 group-hover:opacity-100 transition p-1 text-zinc-400 hover:text-red-600 hover:bg-red-50 rounded-md"
                      title="删除该技能卡"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
          <ShowMoreBar
            remaining={cardsPaging.remaining}
            expanded={cardsPaging.expanded}
            onMore={cardsPaging.more}
            onCollapse={cardsPaging.collapse}
          />
        </section>
      )}

      {/* 已引用生态技能 */}
      {show('installed') && (
        <section className="space-y-3">
          <h2 className="text-sm font-semibold text-zinc-800 flex items-center gap-1.5">
            <Package className="h-4 w-4 text-emerald-500" />
            已引用生态技能
            <span className="text-[10px] font-normal text-zinc-400">安装在本机你的专属目录 · 任务显式引用才注入 · 不自动更新</span>
          </h2>
          {filteredInstalled.length === 0 ? (
            <EmptyHint text="还没有引用生态技能 —— 去「技能市场」挑一个,或让 Agent 在任务里建议" />
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {filteredInstalled.slice(0, installedPaging.shown).map((p) => (
                <div
                  key={p.dirName}
                  className="p-5 rounded-2xl border border-zinc-200 bg-white hover:border-zinc-300 hover:shadow-xs transition flex flex-col justify-between group"
                >
                  <div>
                    <div className="flex items-start justify-between gap-2 mb-1.5">
                      <h3 className="text-xs font-semibold text-zinc-900">{p.name}</h3>
                      <div className="flex items-center gap-1 flex-shrink-0">
                        {p.hasScripts && (
                          <span className="text-[10px] px-2 py-0.5 rounded-full font-medium bg-zinc-100 text-zinc-600 border border-zinc-200">
                            含脚本
                          </span>
                        )}
                        <span className="text-[10px] px-2 py-0.5 rounded-full font-medium bg-emerald-50 text-emerald-700 border border-emerald-200">
                          已引用
                        </span>
                      </div>
                    </div>
                    {p.description && (
                      <p className="text-xs text-zinc-600 leading-relaxed line-clamp-3">{p.description}</p>
                    )}
                    {p.source && (
                      <p className="text-[10px] text-zinc-400 font-mono mt-2 break-all">
                        <FolderGit2 className="inline h-3 w-3 mr-1" />
                        {p.source.platform === 'modelscope' ? (
                          <>魔搭 · {p.source.repo}</>
                        ) : (
                          <>
                            {p.source.repo}@{p.source.sha.slice(0, 8)} · {p.source.path}
                          </>
                        )}
                      </p>
                    )}
                  </div>
                  <div className="pt-3 mt-3 border-t border-zinc-100 flex items-center justify-between text-[10px] text-zinc-400">
                    <span className="font-mono">
                      {p.importedAt ? new Date(p.importedAt).toLocaleDateString() : '—'}
                      {p.fileCount !== undefined && ` · ${p.fileCount} 文件`}
                    </span>
                    <button
                      onClick={() => setUninstallTarget(p)}
                      className="opacity-0 group-hover:opacity-100 transition flex items-center gap-1 px-2 py-1 text-zinc-500 hover:text-red-600 hover:bg-red-50 rounded-md"
                      title="解除引用(删除本机安装)"
                    >
                      <X className="h-3 w-3" />
                      <span>解除引用</span>
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
          <ShowMoreBar
            remaining={installedPaging.remaining}
            expanded={installedPaging.expanded}
            onMore={installedPaging.more}
            onCollapse={installedPaging.collapse}
          />
        </section>
      )}

      {/* 技能市场 */}
      {show('market') && (
        <section className="space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-zinc-800 flex items-center gap-1.5">
              <Store className="h-4 w-4 text-blue-500" />
              技能市场
              <span className="text-[10px] font-normal text-zinc-400">Agent Skills 开放标准生态 · 服务端索引</span>
            </h2>
            {market !== null && (
              <button
                onClick={() => loadMarket(true, marketSearch || undefined)}
                className="flex items-center gap-1 text-[10px] text-zinc-500 hover:text-zinc-800 transition"
              >
                <RefreshCw className={`h-3 w-3 ${marketLoading ? 'animate-spin' : ''}`} />
                重新拉取
              </button>
            )}
          </div>
          {!marketEnabled ? (
            <EmptyHint text="技能市场已关闭(AGTPILOT_SKILL_MARKET=0)" />
          ) : marketLoading && market === null ? (
            <EmptyHint text="正在拉取市场索引..." />
          ) : marketError ? (
            <div className="px-4 py-3 rounded-xl bg-red-50 border border-red-200 text-xs text-red-700">
              市场索引失败: {marketError}
            </div>
          ) : (
            <>
              {filteredMarket.map((src) => {
              // 每源独立的渐进披露:marketVisible 记录该源已展开到的张数(缺省 = 首屏)
              const shown = Math.min(marketVisible[src.id] ?? MARKET_PAGE, src.skills.length);
              const remaining = src.skills.length - shown;
              return (
              <div key={src.id} className="space-y-2">
                <div className="flex items-center gap-2 text-[11px] text-zinc-500">
                  <span className="font-semibold text-zinc-700">{src.label}</span>
                  {src.type === 'modelscope' ? (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-50 text-blue-600 border border-blue-200">
                      国内
                    </span>
                  ) : (
                    <span className="font-mono">{src.repo}</span>
                  )}
                  <a
                    href={src.type === 'modelscope' ? 'https://modelscope.cn/skills' : `https://github.com/${src.repo}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-zinc-400 hover:text-zinc-700 transition"
                    title={src.type === 'modelscope' ? '在魔搭打开(新标签)' : '在 GitHub 打开(新标签)'}
                  >
                    <ExternalLink className="h-3 w-3" />
                  </a>
                  {src.type === 'modelscope' && marketSearch && (
                    <span className="text-zinc-400">搜索「{marketSearch}」的服务端结果</span>
                  )}
                </div>
                {src.error && (
                  <div className="px-3 py-2 rounded-lg bg-amber-50 border border-amber-200 text-[11px] text-amber-700">
                    该源拉取失败: {src.error}
                  </div>
                )}
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                  {src.skills.slice(0, shown).map((s) => {
                    const isInstalled = installed.some(
                      (p) =>
                        (p.source?.platform || 'github') === (s.platform || 'github') &&
                        p.source?.repo === s.repo &&
                        p.source?.path === s.path
                    );
                    const isMs = s.platform === 'modelscope';
                    return (
                      <div
                        key={`${s.sourceId}:${s.repo}:${s.path}`}
                        className="p-4 rounded-2xl border border-zinc-200 bg-white hover:border-zinc-300 hover:shadow-xs transition"
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0">
                            <h3 className="text-xs font-semibold text-zinc-900 truncate flex items-center gap-1.5">
                              <span className="truncate">{s.displayName || s.name}</span>
                              {isMs && (
                                <span className="text-[9px] px-1 py-px rounded bg-blue-50 text-blue-600 border border-blue-200 flex-shrink-0">
                                  魔搭
                                </span>
                              )}
                            </h3>
                            <p className="text-[10px] text-zinc-400 font-mono truncate mt-0.5">
                              {isMs ? s.repo : `${s.category ? `${s.category}/` : ''}${s.name}`}
                            </p>
                          </div>
                          {isInstalled && (
                            <span className="text-[10px] px-2 py-0.5 rounded-full font-medium bg-emerald-50 text-emerald-700 border border-emerald-200 flex items-center gap-0.5 flex-shrink-0">
                              <CheckCircle2 className="h-2.5 w-2.5" />
                              已引用
                            </span>
                          )}
                        </div>
                        {s.description && (
                          <p className="text-[11px] text-zinc-600 leading-relaxed mt-1.5 line-clamp-2">
                            {s.description}
                          </p>
                        )}
                        <div className="flex items-center gap-2 mt-3">
                          <button
                            onClick={() => openDetail(s)}
                            disabled={detailLoading?.repo === s.repo && detailLoading?.path === s.path}
                            className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-zinc-100 hover:bg-zinc-200/70 text-zinc-700 text-[11px] font-medium transition disabled:opacity-50"
                          >
                            {detailLoading?.repo === s.repo && detailLoading?.path === s.path ? (
                              <RotateCw className="h-3 w-3 animate-spin" />
                            ) : (
                              <Eye className="h-3 w-3" />
                            )}
                            详情
                          </button>
                          <button
                            onClick={() => setImportTarget(s)}
                            disabled={isInstalled}
                            className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-zinc-900 hover:bg-zinc-800 disabled:opacity-40 text-white text-[11px] font-medium transition shadow-xs"
                          >
                            <Download className="h-3 w-3" />
                            {isInstalled ? '已引用' : '引用'}
                          </button>
                          <span className="flex-1" />
                          {typeof s.downloads === 'number' && s.downloads > 0 && (
                            <span className="text-[10px] text-zinc-400 flex items-center gap-0.5" title="魔搭下载量">
                              <Download className="h-2.5 w-2.5" />
                              {s.downloads >= 10000 ? `${(s.downloads / 10000).toFixed(1)}万` : s.downloads}
                            </span>
                          )}
                          {s.externalUrl && (
                            <a
                              href={s.externalUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-zinc-400 hover:text-zinc-700 transition"
                              title="在魔搭打开(新标签)"
                            >
                              <ExternalLink className="h-3 w-3" />
                            </a>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
                <ShowMoreBar
                  remaining={remaining}
                  expanded={shown > MARKET_PAGE}
                  onMore={() => setMarketVisible((v) => ({ ...v, [src.id]: shown + MARKET_PAGE }))}
                  onCollapse={() => setMarketVisible((v) => ({ ...v, [src.id]: MARKET_PAGE }))}
                />
              </div>
              );
            })}
              {filteredMarket.length === 0 && (
                <EmptyHint text="没有匹配的技能 —— 换个搜索词试试(魔搭 8 万+ 条目走服务端搜索)" />
              )}
            </>
          )}
        </section>
      )}

      {/* 内置技能 */}
      {show('builtin') && (
        <section className="space-y-3">
          <h2 className="text-sm font-semibold text-zinc-800 flex items-center gap-1.5">
            <Cpu className="h-4 w-4 text-zinc-500" />
            内置技能
            <span className="text-[10px] font-normal text-zinc-400">出厂自带 · 只读(托管开关在各工坊页)</span>
          </h2>
          {filteredBuiltinFlows.length + filteredBuiltinPacks.length === 0 ? (
            <EmptyHint text="当前部署没有内置技能" />
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {filteredBuiltinFlows.map((f) => (
                <BuiltinRow key={`flow:${f.name}`} name={f.name} description={f.description} tag="浏览器流程" />
              ))}
              {filteredBuiltinPacks.map((p) => (
                <BuiltinRow
                  key={`pack:${p.name}`}
                  name={p.name}
                  description={p.description}
                  tag={p.hasScripts ? '沙箱技能包 · 含脚本' : '沙箱技能包'}
                />
              ))}
            </div>
          )}
        </section>
      )}

      {/* 删除技能卡确认 */}
      {deleteCardTarget && (
        <ConfirmModal
          title="删除技能卡"
          icon={<Trash2 className="h-4 w-4 text-red-500" />}
          body={
            <>
              将删除这张自动蒸馏的技能卡(删除进台账留痕,不可恢复;同类任务再次跑完会重新蒸馏):
              <p className="mt-2 px-3 py-2 rounded-lg bg-zinc-50 border border-zinc-200 text-xs text-zinc-700 leading-relaxed">
                {deleteCardTarget.trigger}
              </p>
            </>
          }
          confirmLabel="删除"
          danger
          busy={busy}
          onConfirm={handleDeleteCard}
          onCancel={() => setDeleteCardTarget(null)}
        />
      )}

      {/* 解除引用确认 */}
      {uninstallTarget && (
        <ConfirmModal
          title="解除引用生态技能"
          icon={<X className="h-4 w-4 text-red-500" />}
          body={
            <>
              将从本机彻底删除技能包「{uninstallTarget.name}」(删除进台账留痕;之后可随时重新引用):
              {uninstallTarget.source && (
                <p className="mt-2 px-3 py-2 rounded-lg bg-zinc-50 border border-zinc-200 text-[10px] text-zinc-500 font-mono break-all">
                  {uninstallTarget.source.platform === 'modelscope'
                    ? `魔搭 · ${uninstallTarget.source.repo}`
                    : `${uninstallTarget.source.repo}@${uninstallTarget.source.sha.slice(0, 8)} · ${uninstallTarget.source.path}`}
                </p>
              )}
            </>
          }
          confirmLabel="解除引用"
          danger
          busy={busy}
          onConfirm={handleUninstall}
          onCancel={() => setUninstallTarget(null)}
        />
      )}

      {/* 引用风险确认 */}
      {importTarget && (
        <ConfirmModal
          title="引用生态技能包"
          icon={<AlertTriangle className="h-4 w-4 text-amber-500" />}
          body={
            <>
              即将从 <span className="font-mono text-zinc-700">{importTarget.repo}</span>
              {importTarget.platform === 'modelscope' ? '(魔搭)' : ''} 安装
              {importTarget.path ? (
                <>
                  {' '}
                  <span className="font-mono text-zinc-700">{importTarget.path}</span>
                </>
              ) : null}{' '}
              到你的专属技能目录。请知悉:
              <ul className="mt-2 space-y-1 text-[11px] text-zinc-600 list-disc pl-4">
                <li>这是<b>第三方内容</b>:安装后不自动载入,只有你在任务里<b>显式引用</b>时其 SKILL.md 指令才会注入 Agent 上下文,请确认来源可信(建议先看详情)</li>
                <li>包内脚本只可经沙箱工具执行,敏感操作仍走审批门</li>
                <li>安装后<b>不自动更新</b>(防供应链投毒);升级 = 解除引用后重装</li>
                <li>来源版本(repo/commit/文件哈希)会记录在案,可随时解除引用</li>
              </ul>
            </>
          }
          confirmLabel="已知悉风险,引用"
          danger={false}
          busy={busy}
          onConfirm={handleImport}
          onCancel={() => setImportTarget(null)}
        />
      )}

      {/* SKILL.md 详情 */}
      {detail && (
        <div className="fixed top-14 inset-x-0 bottom-0 bg-black/30 backdrop-blur-xs z-40 flex items-center justify-center p-4 animate-fadeIn">
          <div className="w-full max-w-2xl max-h-[80vh] rounded-2xl bg-white border border-zinc-200 shadow-xl flex flex-col">
            <div className="flex items-start justify-between p-5 border-b border-zinc-100">
              <div className="min-w-0">
                <h3 className="text-sm font-semibold text-zinc-900 truncate">{detail.data.name}</h3>
                <p className="text-[10px] text-zinc-400 font-mono mt-0.5 truncate">
                  {detail.skill.platform === 'modelscope' ? '魔搭 · ' : ''}
                  {detail.skill.repo}
                  {detail.skill.path ? ` · ${detail.skill.path}` : ''}
                </p>
                {detail.data.description && (
                  <p className="text-xs text-zinc-600 mt-1.5 leading-relaxed">{detail.data.description}</p>
                )}
              </div>
              <button onClick={() => setDetail(null)} className="text-zinc-400 hover:text-zinc-700 p-1 flex-shrink-0">
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="p-5 overflow-y-auto flex-1">
              <pre className="text-[11px] text-zinc-700 leading-relaxed whitespace-pre-wrap font-mono bg-zinc-50 rounded-xl border border-zinc-200 p-4">
                {detail.data.content}
              </pre>
            </div>
            <div className="flex items-center justify-end gap-2 p-4 border-t border-zinc-100">
              <button
                onClick={() => setDetail(null)}
                className="px-3 py-1.5 rounded-lg text-xs font-medium text-zinc-600 hover:bg-zinc-100 transition"
              >
                关闭
              </button>
              <button
                onClick={() => {
                  const s = detail.skill;
                  setDetail(null);
                  setImportTarget(s);
                }}
                className="flex items-center gap-1.5 px-4 py-1.5 rounded-lg bg-zinc-900 hover:bg-zinc-800 text-white text-xs font-medium transition shadow-xs"
              >
                <Download className="h-3.5 w-3.5" />
                引用该技能
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 轻提示 */}
      {toast && (
        <div
          className={`fixed bottom-6 left-1/2 -translate-x-1/2 z-50 px-4 py-2 rounded-xl text-xs font-medium shadow-lg border ${
            toast.kind === 'ok'
              ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
              : 'bg-red-50 text-red-700 border-red-200'
          }`}
        >
          {toast.text}
        </div>
      )}
    </div>
  );
}

// ---- 局部小组件 ----

function FieldRow({ label, text, tone }: { label: string; text: string; tone?: 'red' | 'blue' | 'amber' }) {
  const toneCls =
    tone === 'red'
      ? 'text-red-600 bg-red-50 border-red-100'
      : tone === 'blue'
        ? 'text-blue-600 bg-blue-50 border-blue-100'
        : tone === 'amber'
          ? 'text-amber-600 bg-amber-50 border-amber-100'
          : 'text-zinc-500 bg-zinc-50 border-zinc-100';
  return (
    <div className="flex items-start gap-2 text-[11px] leading-relaxed">
      <span className={`px-1.5 py-0.5 rounded border font-mono text-[10px] flex-shrink-0 ${toneCls}`}>{label}</span>
      <span className="text-zinc-600 whitespace-pre-wrap line-clamp-4">{text}</span>
    </div>
  );
}

function EmptyHint({ text }: { text: string }) {
  return (
    <div className="py-10 text-center rounded-2xl border border-dashed border-zinc-200 bg-zinc-50/50">
      <p className="text-[11px] text-zinc-400 max-w-sm mx-auto">{text}</p>
    </div>
  );
}

// ---- 渐进披露(加载更多) ----

/** 首屏张数:市场每源(桌面 3 列 = 4 行)/ 技能卡与已引用(2 列 = 4 行) */
const MARKET_PAGE = 12;
const LIST_PAGE = 8;

/**
 * 纯客户端渐进披露:首屏只展示 initial 张,「加载更多」按 initial 增量展开,
 * 展开过可「收起」。resetKey 变化(搜索落定/切分区/数据重载)时复位首屏。
 * 列表数据已全量在内存,零后台请求。
 */
function useShowMore(total: number, initial: number, resetKey: unknown) {
  const [visible, setVisible] = useState(initial);
  useEffect(() => {
    setVisible(initial);
  }, [resetKey, initial]);
  const shown = Math.min(visible, total);
  return {
    shown,
    remaining: total - shown,
    expanded: shown > initial,
    more: () => setVisible((v) => v + initial),
    collapse: () => setVisible(initial),
  };
}

/** 网格底部「加载更多 / 收起」条(技能卡/已引用/市场源块共用;不足一屏不渲染) */
function ShowMoreBar({
  remaining,
  expanded,
  onMore,
  onCollapse,
}: {
  remaining: number;
  expanded: boolean;
  onMore: () => void;
  onCollapse: () => void;
}) {
  if (remaining <= 0 && !expanded) return null;
  return (
    <div className="flex items-center justify-center gap-2.5 pt-0.5">
      {remaining > 0 && (
        <button
          onClick={onMore}
          className="flex items-center gap-1.5 px-4 py-1.5 rounded-xl border border-zinc-200 bg-white hover:bg-zinc-50 hover:border-zinc-300 text-xs font-medium text-zinc-600 transition shadow-2xs"
        >
          加载更多(还有 {remaining} 个)
          <ChevronDown className="h-3.5 w-3.5" />
        </button>
      )}
      {expanded && (
        <button
          onClick={onCollapse}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs text-zinc-400 hover:text-zinc-700 hover:bg-zinc-100 transition"
        >
          收起
          <ChevronUp className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}

function BuiltinRow({ name, description, tag }: { name: string; description: string; tag: string }) {
  return (
    <div className="p-4 rounded-2xl border border-zinc-200 bg-white flex items-start justify-between gap-2">
      <div className="min-w-0">
        <h3 className="text-xs font-semibold text-zinc-900 truncate">{name}</h3>
        {description && <p className="text-[11px] text-zinc-500 leading-relaxed mt-1 line-clamp-2">{description}</p>}
      </div>
      <span className="text-[10px] px-2 py-0.5 rounded-full font-medium bg-zinc-100 text-zinc-600 border border-zinc-200 flex-shrink-0">
        {tag}
      </span>
    </div>
  );
}

function ConfirmModal({
  title,
  icon,
  body,
  confirmLabel,
  danger,
  busy,
  onConfirm,
  onCancel,
}: {
  title: string;
  icon: React.ReactNode;
  body: React.ReactNode;
  confirmLabel: string;
  danger: boolean;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="fixed top-14 inset-x-0 bottom-0 bg-black/30 backdrop-blur-xs z-40 flex items-center justify-center p-4 animate-fadeIn">
      <div className="w-full max-w-md rounded-2xl bg-white border border-zinc-200 p-6 shadow-xl space-y-4">
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-2">
            {icon}
            <h3 className="text-sm font-semibold text-zinc-900">{title}</h3>
          </div>
          <button onClick={onCancel} className="text-zinc-400 hover:text-zinc-700 p-1">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="text-xs text-zinc-600 leading-relaxed">{body}</div>
        <div className="flex items-center justify-end gap-2 pt-2 border-t border-zinc-100">
          <button
            onClick={onCancel}
            className="px-3 py-1.5 rounded-lg text-xs font-medium text-zinc-600 hover:bg-zinc-100 transition"
          >
            取消
          </button>
          <button
            onClick={onConfirm}
            disabled={busy}
            className={`flex items-center gap-1.5 px-4 py-1.5 rounded-lg disabled:opacity-40 text-white text-xs font-medium transition shadow-xs ${
              danger ? 'bg-red-600 hover:bg-red-500' : 'bg-zinc-900 hover:bg-zinc-800'
            }`}
          >
            {busy && <RotateCw className="h-3.5 w-3.5 animate-spin" />}
            <span>{confirmLabel}</span>
          </button>
        </div>
      </div>
    </div>
  );
}
