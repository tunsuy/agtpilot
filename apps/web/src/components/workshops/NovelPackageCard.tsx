'use client';

/**
 * 网文小说包卡片(novel 工坊交付物 · docs/design/novel-workshop.md §6-§7)
 *
 * 五种包五种卡(开书三段化后):
 * - 设定包(第一步):书名/卖点/设定集/人物卡 + 「存入书库」建书(action=create,
 *   不带章正文)+ 「继续:生成大纲」串第二步(genesis_outline 工坊任务);
 * - 大纲包(第二步):粗纲/细纲/伏笔/时间线 + 「存入书库」合并进书(action=
 *   mergeOutline,书号经用户书库校验)+ 「继续:写开篇第 1 章」走续写管线
 *   + 入库后「订阅日更」快捷块(开书途中一键开通,免回表单切续写模式);
 * - 续写包:章节 + 反思五连预览 + 「存入书库」(action=append,写回状态库);
 * - 文风锚包(P2 文风学习):文风锚全文 + 绑书时「写回本书」(action=updateStyle),
 *   未绑书时可复制留作开书文风锚;
 * - 旧开书包(单次全量):历史任务重渲染兼容,照旧走 create。
 *
 * 书号校验(归属闭环):续写包/大纲包回显的【书号】入库前先按当前用户书库核对——
 * 命中直接入;未命中(书被删/串书)绝不猜,给书目下拉由用户指认后再入。
 * 入库成功前按钮始终可用,失败明示原因,不静默假成功。
 *
 * 已在书库派生(P2):saved 态不再只活在组件内存 —— 挂载时拉书库列表,按
 * novel-card-state 的派生规则(书名精确匹配/书号+大纲/书号+章数)回填 saved 态。
 * 重开历史卡片:徽标直接显示「已在书库」、链式按钮与日更订阅入口保持可用,
 * 配合服务端 create 幂等(同名返回 existed),重复建书彻底死透。
 *
 * 预览排版(P2):Section 的字符串内容走 ReactMarkdown(gfm+breaks)渲染,
 * 不再是 md 原文直出;预拼接文本(细纲/反思等)统一 `- ` 列表行使 GFM 出真列表。
 *
 * 番茄同步行(P2):已入库卡片底部 FanqieSyncRow 展示服务端自动同步账本
 * (开书状态机/章节 synced·pending·failed 计数),提供书级开关、失败重试与
 * 手动绑定逃生门;同步执行全在服务端 fanqie-sync 运行器,本行只读+触发。
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import {
  BookOpen,
  CalendarClock,
  Check,
  ChevronDown,
  Copy,
  Library,
  Link2,
  Loader2,
  Map,
  PenLine,
  RefreshCw,
  Sparkles,
  TriangleAlert,
} from 'lucide-react';
import type { CronJobItem } from '../../types/agent';
import type {
  NovelPackage,
  NovelGenesisPackage,
  NovelGenesisBiblePackage,
  NovelGenesisOutlinePackage,
  NovelContinuePackage,
  NovelStylePackage,
} from '../../workshops/novel/novel-package';
import type { NovelBookSummary, NovelFanqieState } from '../../lib/novel-context';
import { REVIEW_EVERY_N } from '../../lib/novel-context';
import {
  deriveBibleSaved,
  deriveOutlineSaved,
  deriveContinueSaved,
} from '../../lib/novel-card-state';
import type { WorkshopRunPayload } from './run';
import type { DeliveryProgressView } from '../../lib/workshop-delivery-view';

const countWords = (s: string) => String(s || '').replace(/\s/g, '').length;

/** 拉书库列表(摘要口径);失败按空列表处理(与卡内既有兜底一致) */
async function fetchBookSummaries(): Promise<NovelBookSummary[]> {
  try {
    const res = await fetch('/api/novels');
    const data = await res.json();
    return data.success && Array.isArray(data.books) ? data.books : [];
  } catch {
    return [];
  }
}

/**
 * markdown 正文渲染(修「预览是 md 原文」):与驾驶舱产物同一渲染通道。
 * remarkBreaks 保留单换行(与原 whitespace-pre-wrap 观感一致,小说行文不并段);
 * 类名把标题/列表压到卡片密度(11px 语境,不用 prose-sm 的 14px 大字号)。
 */
function Md({ children }: { children: string }) {
  return (
    <div className="space-y-1.5 [&_h1]:text-xs [&_h1]:font-semibold [&_h1]:text-zinc-700 [&_h1]:mt-2 [&_h2]:text-xs [&_h2]:font-semibold [&_h2]:text-zinc-700 [&_h2]:mt-2 [&_h3]:text-[11px] [&_h3]:font-semibold [&_h3]:text-zinc-700 [&_h3]:mt-1.5 [&_h4]:text-[11px] [&_h4]:font-semibold [&_h4]:text-zinc-700 [&_ul]:list-disc [&_ul]:pl-4 [&_ol]:list-decimal [&_ol]:pl-4 [&_li]:my-0.5 [&_strong]:font-semibold [&_strong]:text-zinc-700 [&_hr]:my-2 [&_blockquote]:border-l-2 [&_blockquote]:border-zinc-200 [&_blockquote]:pl-2 [&_blockquote]:text-zinc-500 [&_table]:text-[10px] [&_th]:border [&_th]:border-zinc-200 [&_th]:px-1 [&_td]:border [&_td]:border-zinc-200 [&_td]:px-1 [&_a]:text-violet-600 [&_code]:text-[10px] [&_code]:bg-zinc-100 [&_code]:px-0.5 [&_code]:rounded">
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]}>{children}</ReactMarkdown>
    </div>
  );
}

/** 可折叠小节(六件套各段共用);字符串内容走 Md 排版,JSX 内容原样渲染 */
function Section({ label, count, children }: { label: string; count?: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-lg border border-zinc-200 overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between px-3 py-1.5 text-[11px] font-medium text-zinc-600 hover:bg-zinc-50 transition"
      >
        <span>
          {label}
          {count && <span className="ml-1.5 text-[10px] text-zinc-400 font-normal">{count}</span>}
        </span>
        <ChevronDown className={`h-3.5 w-3.5 text-zinc-400 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div className="px-3 pb-2.5 text-[11px] text-zinc-600 leading-relaxed break-words max-h-56 overflow-y-auto border-t border-zinc-100 pt-2">
          {typeof children === 'string' ? <Md>{children}</Md> : children}
        </div>
      )}
    </div>
  );
}

/**
 * 逐字段交付进度条(novel 设定包/大纲包):按契约字段序展示每字段三态——
 * ✓ 已交付 / ⏳ 交付中 / ! 被打回重试 / ○ 待交付(骨架)。头部角标 N/M。
 * 仅在 progress 存在(交付路径)时渲染;文本解析路径 progress=undefined 不出现,
 * 卡片行为与从前逐字节一致。
 */
function FieldProgressStrip({ progress }: { progress: DeliveryProgressView }) {
  const icon = (state: string) => {
    if (state === 'delivered') return <Check className="h-3 w-3 text-emerald-600" />;
    if (state === 'delivering') return <Loader2 className="h-3 w-3 text-blue-500 animate-spin" />;
    if (state === 'rejected') return <TriangleAlert className="h-3 w-3 text-amber-500" />;
    return <span className="h-1.5 w-1.5 rounded-full bg-zinc-300" />;
  };
  const tone = (state: string) =>
    state === 'delivered'
      ? 'text-zinc-700'
      : state === 'delivering'
        ? 'text-blue-600'
        : state === 'rejected'
          ? 'text-amber-600'
          : 'text-zinc-400';
  return (
    <div className="px-4 py-2 border-b border-zinc-100 bg-white">
      <div className="flex items-center gap-1.5 mb-1.5">
        <span className="text-[10px] font-medium text-zinc-500">逐字段交付</span>
        <span className="text-[10px] font-mono text-zinc-400">
          {progress.deliveredCount}/{progress.totalCount}
        </span>
        {progress.complete && <span className="text-[10px] text-emerald-600 font-medium">· 已全部交付</span>}
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-1">
        {progress.fields.map((f) => (
          <span key={f.key} className={`flex items-center gap-1 text-[10px] ${tone(f.state)}`}>
            {icon(f.state)}
            {f.label}
            {f.required && f.state !== 'delivered' && <span className="text-zinc-300">*</span>}
          </span>
        ))}
      </div>
    </div>
  );
}

type SaveState =
  | { phase: 'idle' }
  | { phase: 'saving' }
  | {
      phase: 'saved';
      bookId: string;
      chapterCount: number;
      wordCount: number;
      nextChapter: number;
      reviewDue?: boolean;
      /** 派生回填(挂载时从书库列表认出「已在库」),非本次点击入库 */
      derived?: boolean;
    }
  | { phase: 'error'; message: string };

/**
 * 卡片「下一步」出口(开书三段化串联):工坊载荷走服务端权威渲染
 * (书状态/档案现读注入),prompt 只是乐观气泡的展示文本,服务端忽略。
 */
export type NovelChainHandler = (
  workshop: WorkshopRunPayload,
  display: { prompt: string; title?: string }
) => void;

function SaveButton({
  onSave,
  state,
  disabled,
  label,
  savedLabel,
}: {
  onSave: () => void | Promise<void>;
  state: SaveState;
  disabled?: boolean;
  label: string;
  /** 已入库徽标文案(设定包建书 0 章/大纲包合并,与续写包语义不同) */
  savedLabel?: string;
}) {
  if (state.phase === 'saved') {
    return (
      <span className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-50 border border-emerald-200 text-emerald-700 text-[11px] font-medium">
        <Check className="h-3.5 w-3.5" />
        {savedLabel ||
          (state.derived ? '已在书库' : '已入库') +
            ` · 共${state.chapterCount}章 ${state.wordCount}字 · 书号 ${state.bookId}`}
      </span>
    );
  }
  return (
    <button
      type="button"
      onClick={onSave}
      disabled={disabled || state.phase === 'saving'}
      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-violet-600 hover:bg-violet-700 text-white text-[11px] font-medium transition shadow-xs disabled:opacity-50"
    >
      {state.phase === 'saving' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Library className="h-3.5 w-3.5" />}
      {state.phase === 'saving' ? '入库中…' : label}
    </button>
  );
}

/** 「下一步」链式按钮:入库成功后出现,一键派发下一段工坊任务 */
function ChainButton({ onClick, icon: Icon, label }: { onClick: () => void; icon: typeof Map; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-violet-200 bg-violet-50/70 text-violet-700 hover:bg-violet-100 transition text-[11px] font-medium"
    >
      <Icon className="h-3.5 w-3.5" />
      {label}
    </button>
  );
}

// ---- 开书包卡 ----

function GenesisCard({ pkg }: { pkg: NovelGenesisPackage }) {
  const [save, setSave] = useState<SaveState>({ phase: 'idle' });
  // 已在书库派生:重开历史卡片时按书名精确匹配回填 saved 态(修「成功后按钮仍可点」)
  const [books, setBooks] = useState<NovelBookSummary[] | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      const list = await fetchBookSummaries();
      if (alive) setBooks(list);
    })();
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (!books) return;
    const derived = deriveBibleSaved(pkg, books);
    if (!derived) return;
    setSave((cur) => (cur.phase === 'idle' ? { phase: 'saved', derived: true, ...derived } : cur));
  }, [books]);

  const handleSave = async () => {
    setSave({ phase: 'saving' });
    const { kind: _kind, ...input } = pkg; // kind 是解析器判别字段,不入库
    try {
      const res = await fetch('/api/novels', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'create', ...input }),
      });
      const data = await res.json();
      if (data.success && data.bookId && data.progress) {
        setSave({ phase: 'saved', bookId: data.bookId, ...data.progress });
      } else {
        setSave({ phase: 'error', message: data.error || '入库失败' });
      }
    } catch (err: any) {
      setSave({ phase: 'error', message: err?.message || '网络异常' });
    }
  };

  return (
    <div className="rounded-xl border border-zinc-200 bg-white overflow-hidden">
      <div className="flex items-center justify-between gap-2 px-4 py-2.5 bg-zinc-50/70 border-b border-zinc-100">
        <span className="flex items-center gap-1.5 text-[11px] font-semibold text-zinc-700 min-w-0">
          <BookOpen className="h-3.5 w-3.5 text-violet-500 shrink-0" />
          <span className="truncate">开书包 ·《{pkg.title}》</span>
          <span className="shrink-0 px-1.5 py-0.5 rounded-md bg-violet-50 text-violet-700 text-[10px] font-medium border border-violet-100">
            {pkg.chapters.length}章开篇 · {pkg.characters.length}张人物卡 · 细纲{pkg.detailed.length}条
          </span>
        </span>
      </div>

      <div className="p-4 space-y-2.5">
        {pkg.premise && <p className="text-xs text-zinc-700 leading-relaxed break-words">卖点:{pkg.premise}</p>}

        <Section label="设定集" count={`${countWords(pkg.bible)}字`}>{pkg.bible}</Section>
        <Section label="人物卡" count={`${pkg.characters.length}张`}>
          {pkg.characters
            .map((c) =>
              [
                `## ${c.name}${c.role ? `(${c.role})` : ''}`,
                c.personality ? `- 性格:${c.personality}` : '',
                c.motivation ? `- 动机:${c.motivation}` : '',
                c.relations ? `- 关系:${c.relations}` : '',
                c.currentState ? `- 当前状态:${c.currentState}` : '',
              ]
                .filter(Boolean)
                .join('\n')
            )
            .join('\n\n')}
        </Section>
        {pkg.synopsis && <Section label="作品简介" count={`${countWords(pkg.synopsis)}字`}>{pkg.synopsis}</Section>}
        <Section label="粗纲/卷纲" count={`${countWords(pkg.outline)}字`}>{pkg.outline}</Section>
        {pkg.detailed.length > 0 && (
          <Section label="细纲池" count={`${pkg.detailed.length}条`}>
            {pkg.detailed
              .map((d) => `- 第${d.index}章${d.title ? ` ${d.title}` : ''}:${d.events}`)
              .join('\n')}
          </Section>
        )}
        {pkg.ledgerSeeds.length > 0 && (
          <Section label="伏笔台账(埋设)" count={`${pkg.ledgerSeeds.length}条`}>
            {pkg.ledgerSeeds.map((f) => `- (第${f.plantedChapter}章埋) ${f.content}`).join('\n')}
          </Section>
        )}
        {pkg.timelineSeeds.length > 0 && (
          <Section label="时间线" count={`${pkg.timelineSeeds.length}条`}>
            {pkg.timelineSeeds.map((t) => `- ${t}`).join('\n')}
          </Section>
        )}

        <div className="space-y-1.5 pt-1">
          <span className="text-[10px] font-medium text-zinc-400 uppercase tracking-wide">开篇章节</span>
          {pkg.chapters.map((ch, i) => (
            <Section key={i} label={`第${i + 1}章${ch.title ? ` ${ch.title}` : ''}`} count={`${countWords(ch.content)}字`}>
              <>
                <Md>{ch.content}</Md>
                {ch.summary && (
                  <p className="mt-2 pt-2 border-t border-zinc-100 text-zinc-500">摘要:{ch.summary}</p>
                )}
              </>
            </Section>
          ))}
        </div>

        <div className="flex items-center justify-between gap-2 pt-2.5 border-t border-zinc-100">
          <span className="text-[10px] text-zinc-400 leading-relaxed min-w-0">
            入库后可随时「续写下一章」与「全书体检」;入库前请先审阅,不满意可重跑。
          </span>
          <SaveButton onSave={handleSave} state={save} label="存入书库" />
        </div>
        {save.phase === 'error' && (
          <p className="text-[11px] text-red-600 flex items-start gap-1">
            <TriangleAlert className="h-3.5 w-3.5 mt-px shrink-0" />
            {save.message}
          </p>
        )}
        {save.phase === 'saved' && <FanqieSyncRow bookId={save.bookId} />}
      </div>
    </div>
  );
}

// ---- 设定包卡(开书三段化 · 第一步) ----

function GenesisBibleCard({
  pkg,
  onChain,
  progress,
}: {
  pkg: NovelGenesisBiblePackage;
  onChain?: NovelChainHandler;
  progress?: DeliveryProgressView;
}) {
  const [save, setSave] = useState<SaveState>({ phase: 'idle' });
  // 已在书库派生:同名书已建(含服务端 existed 幂等命中过的)→ 直接呈现已入库,
  // 「继续:生成大纲」用派生书号激活,历史卡片可续操作
  const [books, setBooks] = useState<NovelBookSummary[] | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      const list = await fetchBookSummaries();
      if (alive) setBooks(list);
    })();
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (!books) return;
    const derived = deriveBibleSaved(pkg, books);
    if (!derived) return;
    setSave((cur) => (cur.phase === 'idle' ? { phase: 'saved', derived: true, ...derived } : cur));
  }, [books]);

  const handleSave = async () => {
    setSave({ phase: 'saving' });
    // kind 是解析器判别字段不入库;chapterWords 是回显的表单值(串下一步用),不进建书载荷
    const { kind: _kind, chapterWords: _words, ...input } = pkg;
    try {
      const res = await fetch('/api/novels', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'create', ...input }),
      });
      const data = await res.json();
      if (data.success && data.bookId && data.progress) {
        setSave({ phase: 'saved', bookId: data.bookId, ...data.progress });
      } else {
        setSave({ phase: 'error', message: data.error || '建书失败' });
      }
    } catch (err: any) {
      setSave({ phase: 'error', message: err?.message || '网络异常' });
    }
  };

  const chainOutline = () => {
    if (save.phase !== 'saved' || !onChain) return;
    onChain(
      {
        id: 'novel',
        params: {
          mode: 'genesis_outline',
          bookId: save.bookId,
          ...(pkg.chapterWords ? { chapterWords: pkg.chapterWords } : {}),
        },
      },
      { prompt: `继续《${pkg.title}》:生成全书大纲——粗纲/细纲/伏笔/时间线(开书第二步)`, title: `《${pkg.title}》大纲规划` }
    );
  };

  return (
    <div className="rounded-xl border border-zinc-200 bg-white overflow-hidden">
      <div className="flex items-center justify-between gap-2 px-4 py-2.5 bg-zinc-50/70 border-b border-zinc-100">
        <span className="flex items-center gap-1.5 text-[11px] font-semibold text-zinc-700 min-w-0">
          <BookOpen className="h-3.5 w-3.5 text-violet-500 shrink-0" />
          <span className="truncate">设定包 ·《{pkg.title}》</span>
          <span className="shrink-0 px-1.5 py-0.5 rounded-md bg-violet-50 text-violet-700 text-[10px] font-medium border border-violet-100">
            开书第一步 · {pkg.characters.length}张人物卡
          </span>
        </span>
      </div>

      {progress && <FieldProgressStrip progress={progress} />}

      <div className="p-4 space-y-2.5">
        {pkg.genre && (
          <p className="text-xs text-zinc-700 leading-relaxed break-words">
            题材:{pkg.genre}
            {pkg.premise ? ` · 卖点:${pkg.premise}` : ''}
          </p>
        )}
        {!pkg.genre && pkg.premise && <p className="text-xs text-zinc-700 leading-relaxed break-words">卖点:{pkg.premise}</p>}

        <Section label="设定集" count={`${countWords(pkg.bible)}字`}>{pkg.bible}</Section>
        <Section label="人物卡" count={`${pkg.characters.length}张`}>
          {pkg.characters
            .map((c) =>
              [
                `## ${c.name}${c.role ? `(${c.role})` : ''}`,
                c.personality ? `- 性格:${c.personality}` : '',
                c.motivation ? `- 动机:${c.motivation}` : '',
                c.speech ? `- 口癖:${c.speech}` : '',
                c.relations ? `- 关系:${c.relations}` : '',
                c.arc ? `- 弧光:${c.arc}` : '',
              ]
                .filter(Boolean)
                .join('\n')
            )
            .join('\n\n')}
        </Section>
        {pkg.synopsis && <Section label="作品简介" count={`${countWords(pkg.synopsis)}字`}>{pkg.synopsis}</Section>}
        {pkg.style && <Section label="文风锚(回显)" count={`${countWords(pkg.style)}字`}>{pkg.style}</Section>}

        <div className="flex items-center justify-between gap-2 pt-2.5 border-t border-zinc-100">
          <span className="text-[10px] text-zinc-400 leading-relaxed min-w-0">
            建书不带正文:大纲在第二步生成,正文逐章续写。入库前请先审阅,不满意可重跑。
          </span>
          <SaveButton
            onSave={handleSave}
            state={save}
            disabled={progress ? !progress.requiredDone : undefined}
            label="存入书库"
            savedLabel={
              save.phase === 'saved'
                ? `${save.derived ? '已在书库' : '已建书'} · 书号 ${save.bookId}`
                : ''
            }
          />
        </div>
        {save.phase === 'error' && (
          <p className="text-[11px] text-red-600 flex items-start gap-1">
            <TriangleAlert className="h-3.5 w-3.5 mt-px shrink-0" />
            {save.message}
          </p>
        )}
        {/* 三段化串联:入库成功才给下一步(没书号没法注入设定地基);派生 saved 同样激活 */}
        {save.phase === 'saved' && onChain && (
          <div className="flex items-center justify-end">
            <ChainButton onClick={chainOutline} icon={Map} label="继续:生成大纲" />
          </div>
        )}
        {save.phase === 'saved' && <FanqieSyncRow bookId={save.bookId} />}
      </div>
    </div>
  );
}

// ---- 大纲包卡(开书三段化 · 第二步) ----

/** 日更时刻 chip(与表单 SUB_HOURS 同源整点:`0 H * * *`) */
const DAILY_HOURS = [6, 9, 12, 18, 21];
/** 日更章字数 chip(与表单 CHAPTER_WORDS 同源,钳制区间 1000-6000) */
const DAILY_WORDS = [1000, 2000, 3000, 5000];

function GenesisOutlineCard({
  pkg,
  onChain,
  progress,
}: {
  pkg: NovelGenesisOutlinePackage;
  onChain?: NovelChainHandler;
  progress?: DeliveryProgressView;
}) {
  const [save, setSave] = useState<SaveState>({ phase: 'idle' });
  // 书号校验同续写包:回显书号按用户书库核对,未命中(书被删/串书/漏回显)给下拉指认
  const [books, setBooks] = useState<NovelBookSummary[] | null>(null);
  const [chosenBookId, setChosenBookId] = useState<string | null>(null);

  // ---- 日更快捷订阅(开书途中一键开通,免回表单切续写模式) ----
  const [dailyJob, setDailyJob] = useState<CronJobItem | null>(null);
  const [dailyHour, setDailyHour] = useState<number>(9);
  const [dailyWords, setDailyWords] = useState<number>(3000);
  const [dailyBusy, setDailyBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      const list = await fetchBookSummaries();
      if (alive) setBooks(list);
    })();
    return () => {
      alive = false;
    };
  }, []);

  const claimedValid = useMemo(
    () => (books ? books.some((b) => b.bookId === pkg.bookId) : null),
    [books, pkg.bookId]
  );
  const targetBookId = claimedValid ? pkg.bookId : chosenBookId;
  const targetBook = books?.find((b) => b.bookId === targetBookId) || null;

  // 「已在书库」派生:书号命中且大纲已合并 → 历史卡片重挂载直接回填 saved 态
  const derived = useMemo(() => deriveOutlineSaved(pkg, books), [books, pkg.bookId]);
  useEffect(() => {
    if (!derived) return;
    setSave((cur) => (cur.phase === 'idle' ? { phase: 'saved', derived: true, ...derived } : cur));
  }, [derived]);
  // 有效书号 = 本次入库 或 派生命中:订阅日更/链式按钮/番茄同步行共用门槛
  const effectiveBookId = save.phase === 'saved' ? save.bookId : derived?.bookId || null;
  const effectiveBook = books?.find((b) => b.bookId === effectiveBookId) || null;
  const chainNextChapter = save.phase === 'saved' ? save.nextChapter : derived?.nextChapter;

  const handleSave = async () => {
    if (!targetBookId) return;
    setSave({ phase: 'saving' });
    // kind/bookId 是判别与回显字段,载荷书号以用户校验/指认结果为准
    const { kind: _kind, bookId: _claimed, ...input } = pkg;
    try {
      const res = await fetch('/api/novels', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'mergeOutline', bookId: targetBookId, ...input }),
      });
      const data = await res.json();
      if (data.success && data.progress) {
        setSave({ phase: 'saved', bookId: targetBookId, ...data.progress });
      } else {
        setSave({ phase: 'error', message: data.error || '合并失败' });
      }
    } catch (err: any) {
      setSave({ phase: 'error', message: err?.message || '网络异常' });
    }
  };

  const chainOpening = () => {
    if (!effectiveBookId || !chainNextChapter || !onChain) return;
    const bookTitle = effectiveBook?.title || targetBook?.title || '本书';
    const nextIndex = chainNextChapter;
    onChain(
      { id: 'novel', params: { mode: 'continue', bookId: effectiveBookId } },
      { prompt: `继续《${bookTitle}》:按刚合并的细纲写第 ${nextIndex} 章(开书第三步,此后逐章续写)`, title: `《${bookTitle}》第${nextIndex}章` }
    );
  };

  // 有效书号存在即查本书已有日更(同书全局至多一条活跃,与表单续写模式同一判定);
  // 派生书号同样驱动 —— 重开历史大纲卡也能看到订阅态并直接改订/退订(修「日更入口消失」)
  useEffect(() => {
    if (!effectiveBookId) {
      setDailyJob(null);
      return;
    }
    let alive = true;
    (async () => {
      try {
        const res = await fetch('/api/cron/jobs');
        const data = await res.json();
        if (!alive || !data.success) return;
        const job = (data.jobs || []).find(
          (j: CronJobItem) =>
            j.scenario?.key === 'novel_daily_chapter' &&
            j.scenario?.bookId === effectiveBookId &&
            j.status !== 'cancelled'
        );
        if (!alive || !job) return;
        setDailyJob(job);
        // 回填现有任务的时刻/字数,改订阅时不从默认值跳
        const hour = Number((job.pattern || '').split(' ')[1]);
        if (DAILY_HOURS.includes(hour)) setDailyHour(hour);
        if (job.scenario?.count && DAILY_WORDS.includes(job.scenario.count)) setDailyWords(job.scenario.count);
      } catch {
        // 未登录/后端未就绪时静默:显示未订阅,可重试
      }
    })();
    return () => {
      alive = false;
    };
  }, [effectiveBookId]);

  const postCron = (body: Record<string, unknown>) =>
    fetch('/api/cron/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then((r) => r.json());

  /** 开通/修改日更:同书先取消旧任务再建新任务(与表单续写订阅同一保证) */
  const handleDailySubscribe = async () => {
    if (!effectiveBookId) return;
    setDailyBusy(true);
    try {
      if (dailyJob) await postCron({ action: 'cancel', id: dailyJob.id });
      const bookTitle = effectiveBook?.title || targetBook?.title || '本书';
      // 存档的 prompt 仅作展示快照;触发时服务端现读书库+档案重建(requiresServerState)
      const data = await postCron({
        action: 'create',
        name: `《${bookTitle}》日更`,
        pattern: `0 ${dailyHour} * * *`,
        prompt: `(场景订阅:小说日更,触发时服务端现读《${bookTitle}》续写下一章)`,
        scenario: { key: 'novel_daily_chapter', count: dailyWords, bookId: effectiveBookId },
      });
      if (data.success) setDailyJob(data.newJob || null);
    } catch {
      // 网络异常静默,按钮恢复可点即可重试
    } finally {
      setDailyBusy(false);
    }
  };

  const handleDailyUnsubscribe = async () => {
    if (!dailyJob) return;
    setDailyBusy(true);
    try {
      await postCron({ action: 'cancel', id: dailyJob.id });
      setDailyJob(null);
    } catch {
      // 网络异常静默,按钮恢复可点即可重试
    } finally {
      setDailyBusy(false);
    }
  };

  return (
    <div className="rounded-xl border border-zinc-200 bg-white overflow-hidden">
      <div className="flex items-center justify-between gap-2 px-4 py-2.5 bg-zinc-50/70 border-b border-zinc-100">
        <span className="flex items-center gap-1.5 text-[11px] font-semibold text-zinc-700 min-w-0">
          <Map className="h-3.5 w-3.5 text-violet-500 shrink-0" />
          <span className="truncate">大纲包{targetBook ? ` ·《${targetBook.title}》` : ''}</span>
          <span className="shrink-0 px-1.5 py-0.5 rounded-md bg-violet-50 text-violet-700 text-[10px] font-medium border border-violet-100">
            开书第二步 · 细纲{pkg.detailed.length}条 · 伏笔{pkg.ledgerSeeds.length}
          </span>
        </span>
      </div>

      {progress && <FieldProgressStrip progress={progress} />}

      <div className="p-4 space-y-2.5">
        <Section label="粗纲/卷纲" count={`${countWords(pkg.outline)}字`}>{pkg.outline}</Section>
        {pkg.detailed.length > 0 && (
          <Section label="细纲池" count={`${pkg.detailed.length}条`}>
            {pkg.detailed
              .map((d) => `- 第${d.index}章${d.title ? ` ${d.title}` : ''}:${d.events}`)
              .join('\n')}
          </Section>
        )}
        {pkg.ledgerSeeds.length > 0 && (
          <Section label="伏笔台账(埋设)" count={`${pkg.ledgerSeeds.length}条`}>
            {pkg.ledgerSeeds.map((f) => `- (第${f.plantedChapter}章埋) ${f.content}`).join('\n')}
          </Section>
        )}
        {pkg.timelineSeeds.length > 0 && (
          <Section label="时间线" count={`${pkg.timelineSeeds.length}条`}>
            {pkg.timelineSeeds.map((t) => `- ${t}`).join('\n')}
          </Section>
        )}

        {/* 书号校验:回显书号未命中/漏回显时,给下拉指认(书被删/串书绝不猜归属) */}
        {books !== null && claimedValid === false && (
          <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 space-y-1.5">
            <p className="text-[11px] text-amber-700 flex items-start gap-1 leading-relaxed">
              <TriangleAlert className="h-3.5 w-3.5 mt-px shrink-0" />
              {pkg.bookId
                ? `回显书号 ${pkg.bookId} 不在你的书库中(书可能被删除,或 Agent 串了书号)。`
                : '大纲包没有回显书号。'}
              请指认这份大纲并入哪本书:
            </p>
            {books.length > 0 ? (
              <select
                value={chosenBookId || ''}
                onChange={(e) => setChosenBookId(e.target.value || null)}
                className="w-full px-2.5 py-1.5 rounded-lg border border-amber-300 bg-white text-xs text-zinc-900 focus:outline-none focus:border-amber-500"
              >
                <option value="">— 请选择书目 —</option>
                {books.map((b) => (
                  <option key={b.bookId} value={b.bookId}>
                    《{b.title}》 已写{b.progress.chapterCount}章 · 下一章为第{b.progress.nextChapter}章
                  </option>
                ))}
              </select>
            ) : (
              <p className="text-[11px] text-amber-700">书库为空:请先用「开新书」完成第一步并入库,这份大纲无法合并。</p>
            )}
          </div>
        )}

        <div className="flex items-center justify-between gap-2 pt-2.5 border-t border-zinc-100">
          <span className="text-[10px] text-zinc-400 leading-relaxed min-w-0">
            合并只写规划层(粗纲/细纲池/伏笔/时间线),不动正文与人物卡;入库前请先审阅。
          </span>
          <SaveButton
            onSave={handleSave}
            state={save}
            disabled={!targetBookId || (progress ? !progress.requiredDone : false)}
            label="存入书库"
            savedLabel={
              save.phase === 'saved'
                ? `${save.derived ? '已在书库 · 大纲已合并' : '已合并'} · 书号 ${save.bookId}`
                : ''
            }
          />
        </div>
        {save.phase === 'error' && (
          <p className="text-[11px] text-red-600 flex items-start gap-1">
            <TriangleAlert className="h-3.5 w-3.5 mt-px shrink-0" />
            {save.message}
          </p>
        )}
        {effectiveBookId && chainNextChapter && onChain && (
          <div className="flex items-center justify-end">
            <ChainButton onClick={chainOpening} icon={PenLine} label={`继续:写第 ${chainNextChapter} 章`} />
          </div>
        )}

        {/* 日更快捷订阅:开书途中(书号+细纲就绪的最早时刻)一键开通,免回表单切续写模式;
            门槛 = 有效书号(本次入库或派生命中)→ 重开历史大纲卡也显示订阅态 */}
        {effectiveBookId && (
          <div className="rounded-xl border border-zinc-200 bg-zinc-50/60 p-3 space-y-2.5">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-zinc-700 flex items-center gap-1.5">
                <CalendarClock className="h-3.5 w-3.5 text-violet-500" />
                订阅 · 每天自动续写
              </span>
              {dailyJob && (
                <button
                  type="button"
                  onClick={handleDailyUnsubscribe}
                  disabled={dailyBusy}
                  className="text-[11px] text-zinc-400 hover:text-red-500 transition disabled:opacity-50"
                >
                  取消日更
                </button>
              )}
            </div>

            {dailyJob ? (
              <p className="text-[11px] text-zinc-500 leading-relaxed">
                已订阅 · 每天 {dailyHour}:00 自动续写本章约 {dailyWords} 字。触发时 Agent
                按书库最新进度写下一章(手动续写/日更同源,不会写重章),产出落书库待审。
              </p>
            ) : (
              <>
                <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                  <span className="flex flex-wrap items-center gap-1.5">
                    <span className="text-[10px] text-zinc-400">时刻</span>
                    {DAILY_HOURS.map((h) => (
                      <button
                        key={h}
                        type="button"
                        onClick={() => setDailyHour(h)}
                        className={`px-2 py-0.5 rounded-md border text-[10px] transition ${
                          h === dailyHour
                            ? 'bg-violet-600 text-white border-violet-600'
                            : 'bg-white text-zinc-600 border-zinc-200 hover:border-zinc-300'
                        }`}
                      >
                        {h}点
                      </button>
                    ))}
                  </span>
                  <span className="flex flex-wrap items-center gap-1.5">
                    <span className="text-[10px] text-zinc-400">每章</span>
                    {DAILY_WORDS.map((w) => (
                      <button
                        key={w}
                        type="button"
                        onClick={() => setDailyWords(w)}
                        className={`px-2 py-0.5 rounded-md border text-[10px] transition ${
                          w === dailyWords
                            ? 'bg-violet-600 text-white border-violet-600'
                            : 'bg-white text-zinc-600 border-zinc-200 hover:border-zinc-300'
                        }`}
                      >
                        {w}字
                      </button>
                    ))}
                  </span>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[10px] text-zinc-400 leading-relaxed">
                    日更任务只写书库:Agent 每天按最新状态续写下一章,发布永远由你确认。
                  </span>
                  <button
                    type="button"
                    onClick={handleDailySubscribe}
                    disabled={dailyBusy}
                    className="shrink-0 px-3 py-1 rounded-lg text-[11px] font-medium transition shadow-xs disabled:opacity-50 bg-violet-600 hover:bg-violet-700 text-white"
                  >
                    {dailyBusy ? '保存中…' : '开通日更'}
                  </button>
                </div>
              </>
            )}
          </div>
        )}

        {effectiveBookId && <FanqieSyncRow bookId={effectiveBookId} />}
      </div>
    </div>
  );
}

// ---- 续写包卡 ----

function ContinueCard({ pkg }: { pkg: NovelContinuePackage }) {
  const [save, setSave] = useState<SaveState>({ phase: 'idle' });
  // 书号校验:拉用户书库,回显书号命中 → 直接入;未命中 → 下拉指认(绝不猜)
  const [books, setBooks] = useState<NovelBookSummary[] | null>(null);
  const [chosenBookId, setChosenBookId] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      const list = await fetchBookSummaries();
      if (alive) setBooks(list);
    })();
    return () => {
      alive = false;
    };
  }, []);

  const claimedValid = useMemo(
    () => (books ? books.some((b) => b.bookId === pkg.bookId) : null),
    [books, pkg.bookId]
  );
  const targetBookId = claimedValid ? pkg.bookId : chosenBookId;
  const targetBook = books?.find((b) => b.bookId === targetBookId) || null;

  // 「已在书库」派生:书号命中且章数已覆盖自称章号 → 历史卡片重挂载回填 saved 态
  // (接受「后章抬高计数」的显示级口径,见 novel-card-state.ts 注释;数据面由服务端
  // append 恒按 nextChapter 落章兜底,不存在写重风险)
  useEffect(() => {
    if (!books) return;
    const derived = deriveContinueSaved(pkg, books);
    if (!derived) return;
    setSave((cur) => (cur.phase === 'idle' ? { phase: 'saved', derived: true, ...derived } : cur));
  }, [books]);

  const handleSave = async () => {
    if (!targetBookId) return;
    setSave({ phase: 'saving' });
    // kind 是解析器判别字段不入库;bookId 以用户指认/校验结果为准,不用包里自称的
    const { kind: _kind, bookId: _claimed, ...input } = pkg;
    try {
      const res = await fetch('/api/novels', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'append', bookId: targetBookId, ...input }),
      });
      const data = await res.json();
      if (data.success && data.progress) {
        setSave({ phase: 'saved', bookId: targetBookId, ...data.progress, reviewDue: Boolean(data.reviewDue) });
      } else {
        setSave({ phase: 'error', message: data.error || '入库失败' });
      }
    } catch (err: any) {
      setSave({ phase: 'error', message: err?.message || '网络异常' });
    }
  };

  return (
    <div className="rounded-xl border border-zinc-200 bg-white overflow-hidden">
      <div className="flex items-center justify-between gap-2 px-4 py-2.5 bg-zinc-50/70 border-b border-zinc-100">
        <span className="flex items-center gap-1.5 text-[11px] font-semibold text-zinc-700 min-w-0">
          <PenLine className="h-3.5 w-3.5 text-violet-500 shrink-0" />
          <span className="truncate">
            续写包 · 第{pkg.claimedIndex ?? '?'}章{pkg.title ? ` ${pkg.title}` : ''}
          </span>
          <span className="shrink-0 px-1.5 py-0.5 rounded-md bg-violet-50 text-violet-700 text-[10px] font-medium border border-violet-100">
            {countWords(pkg.content)}字
          </span>
        </span>
      </div>

      <div className="p-4 space-y-2.5">
        <Section label="正文">{pkg.content}</Section>
        <Section label="本章摘要">{pkg.summary}</Section>
        {(pkg.characterUpdates.length > 0 || pkg.ledgerActions.length > 0 || pkg.timelineAppend.length > 0) && (
          <Section
            label="反思写回"
            count={`人物${pkg.characterUpdates.length} · 伏笔${pkg.ledgerActions.length} · 时间线${pkg.timelineAppend.length}`}
          >
            {[
              ...pkg.characterUpdates.map((u) => `- ${u.name}:→ ${u.currentState}`),
              ...pkg.ledgerActions.map((a) =>
                a.action === 'plant' ? `- [埋设] ${a.content}` : `- [回收] ${a.keyword}${a.payMethod ? `(方式:${a.payMethod})` : ''}`
              ),
              ...pkg.timelineAppend.map((t) => `- ${t}`),
            ].join('\n')}
          </Section>
        )}
        {pkg.detailedAppend.length > 0 && (
          <Section label="细纲池补充" count={`${pkg.detailedAppend.length}条`}>
            {pkg.detailedAppend.map((d) => `- 第${d.index}章${d.title ? ` ${d.title}` : ''}:${d.events}`).join('\n')}
          </Section>
        )}
        {pkg.volumeSummary && <Section label="总纲更新">{pkg.volumeSummary}</Section>}

        {/* 书号校验:回显书号未命中书库时,给下拉指认(书被删/串书绝不猜归属) */}
        {books !== null && claimedValid === false && (
          <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 space-y-1.5">
            <p className="text-[11px] text-amber-700 flex items-start gap-1 leading-relaxed">
              <TriangleAlert className="h-3.5 w-3.5 mt-px shrink-0" />
              回显书号 <span className="font-mono">{pkg.bookId}</span> 不在你的书库中(书可能被删除,或 Agent 串了书号)。请指认这一章入哪本书:
            </p>
            {books.length > 0 ? (
              <select
                value={chosenBookId || ''}
                onChange={(e) => setChosenBookId(e.target.value || null)}
                className="w-full px-2.5 py-1.5 rounded-lg border border-amber-300 bg-white text-xs text-zinc-900 focus:outline-none focus:border-amber-500"
              >
                <option value="">— 请选择书目 —</option>
                {books.map((b) => (
                  <option key={b.bookId} value={b.bookId}>
                    《{b.title}》 已写{b.progress.chapterCount}章 · 下一章为第{b.progress.nextChapter}章
                  </option>
                ))}
              </select>
            ) : (
              <p className="text-[11px] text-amber-700">书库为空:请先用「开新书」建书,这一章无法入库。</p>
            )}
          </div>
        )}

        <div className="flex items-center justify-between gap-2 pt-2.5 border-t border-zinc-100">
          <span className="text-[10px] text-zinc-400 leading-relaxed min-w-0">
            {targetBook
              ? `将写入《${targetBook.title}》第${targetBook.progress.nextChapter}章(序号以书库为准),并自动写回反思状态。`
              : '入库 = 正文落章文件 + 摘要/人物状态/伏笔/时间线写回状态库。'}
          </span>
          <SaveButton onSave={handleSave} state={save} disabled={!targetBookId} label="存入书库" />
        </div>
        {save.phase === 'error' && (
          <p className="text-[11px] text-red-600 flex items-start gap-1">
            <TriangleAlert className="h-3.5 w-3.5 mt-px shrink-0" />
            {save.message}
          </p>
        )}
        {/* 体检提醒(P1):入库后到体检节点就提示,不静默积累矛盾 */}
        {save.phase === 'saved' && save.reviewDue && (
          <p className="text-[11px] text-amber-600 flex items-start gap-1 leading-relaxed">
            <TriangleAlert className="h-3.5 w-3.5 mt-px shrink-0" />
            这一章入库后,距上次全书体检已新写满 {REVIEW_EVERY_N} 章:建议去工坊跑一次「全书体检」,核对伏笔/时间线/人物状态。
          </p>
        )}
        {save.phase === 'saved' && <FanqieSyncRow bookId={save.bookId} />}
      </div>
    </div>
  );
}

// ---- 文风锚包卡(P2 文风学习) ----

type StylePhase = 'idle' | 'saving' | 'saved' | 'copied' | 'error';

function StyleAnchorCard({ pkg }: { pkg: NovelStylePackage }) {
  const [phase, setPhase] = useState<StylePhase>('idle');
  const [message, setMessage] = useState('');

  const handleSave = async () => {
    if (!pkg.bookId) return;
    setPhase('saving');
    setMessage('');
    try {
      const res = await fetch('/api/novels', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'updateStyle', bookId: pkg.bookId, style: pkg.style }),
      });
      const data = await res.json();
      if (data.success) {
        setPhase('saved');
      } else {
        setPhase('error');
        setMessage(data.error || '写回失败');
      }
    } catch (err: any) {
      setPhase('error');
      setMessage(err?.message || '网络异常');
    }
  };

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(pkg.style);
      setPhase('copied');
      setMessage('');
    } catch {
      setPhase('error');
      setMessage('复制失败:请手动选中「文风锚」文本复制');
    }
  };

  return (
    <div className="rounded-xl border border-zinc-200 bg-white overflow-hidden">
      <div className="flex items-center justify-between gap-2 px-4 py-2.5 bg-zinc-50/70 border-b border-zinc-100">
        <span className="flex items-center gap-1.5 text-[11px] font-semibold text-zinc-700 min-w-0">
          <Sparkles className="h-3.5 w-3.5 text-violet-500 shrink-0" />
          <span className="truncate">文风锚包{pkg.bookId ? ` · 书号 ${pkg.bookId}` : ' · 未绑定书目'}</span>
          <span className="shrink-0 px-1.5 py-0.5 rounded-md bg-violet-50 text-violet-700 text-[10px] font-medium border border-violet-100">
            {countWords(pkg.style)}字
          </span>
        </span>
      </div>

      <div className="p-4 space-y-2.5">
        <div className="rounded-lg border border-zinc-200 px-3 py-2.5 text-[11px] text-zinc-600 leading-relaxed break-words max-h-64 overflow-y-auto">
          <Md>{pkg.style}</Md>
        </div>

        <div className="flex items-center justify-between gap-2 pt-2.5 border-t border-zinc-100">
          <span className="text-[10px] text-zinc-400 leading-relaxed min-w-0">
            {pkg.bookId
              ? '写回后,这本书之后的每次续写都会注入这份文风锚(覆盖旧锚)。'
              : '未绑定书目:复制后在「开新书」的自定义文风锚里粘贴,或之后绑书重跑文风学习。'}
          </span>
          <span className="flex items-center gap-1.5 shrink-0">
            <button
              type="button"
              onClick={handleCopy}
              className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-zinc-200 bg-white text-zinc-600 text-[11px] font-medium hover:border-zinc-300 transition"
            >
              {phase === 'copied' ? <Check className="h-3.5 w-3.5 text-emerald-600" /> : <Copy className="h-3.5 w-3.5" />}
              {phase === 'copied' ? '已复制' : '复制'}
            </button>
            {pkg.bookId &&
              (phase === 'saved' ? (
                <span className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-50 border border-emerald-200 text-emerald-700 text-[11px] font-medium">
                  <Check className="h-3.5 w-3.5" />
                  已写回本书
                </span>
              ) : (
                <button
                  type="button"
                  onClick={handleSave}
                  disabled={phase === 'saving'}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-violet-600 hover:bg-violet-700 text-white text-[11px] font-medium transition shadow-xs disabled:opacity-50"
                >
                  {phase === 'saving' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
                  {phase === 'saving' ? '写回中…' : '写回本书'}
                </button>
              ))}
          </span>
        </div>
        {phase === 'error' && (
          <p className="text-[11px] text-red-600 flex items-start gap-1">
            <TriangleAlert className="h-3.5 w-3.5 mt-px shrink-0" />
            {message}
          </p>
        )}
      </div>
    </div>
  );
}

// ---- 番茄自动同步行(P2) ----

/**
 * 书级番茄同步账本展示(数据源 book.json.fanqie,经 GET /api/novels?bookId=):
 * - 未开启番茄托管 → 整行不渲染(没开托管的用户不见同步 UI);
 * - 开书状态机:pending/creating 转圈并 10s 轮询至静默;failed → 原因 + 重试 +
 *   手动绑定(逃生门:建书成功但没拿到书号时绝不自动重试,人工核对后绑定);
 *   无记录(同步上线前入库的旧书)→「排队开书」一键补意图;
 * - 章节 synced/pending/failed 计数 + 失败章节逐章重试。
 * 写操作全走 /api/novels(setFanqieSync/retryFanqieSync/bindFanqieBook),执行后
 * 重读账本。发布永远人工:本行不会出现、也永远不应出现任何发布入口。
 */
function FanqieSyncRow({ bookId }: { bookId: string }) {
  const [managed, setManaged] = useState<boolean | null>(null); // null=未知,不渲染
  const [fanqie, setFanqie] = useState<NovelFanqieState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [bindOpen, setBindOpen] = useState(false);
  const [bindValue, setBindValue] = useState('');

  // 托管开关:未托管(enabled+riskAck)整行隐藏
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch('/api/fanqie-managed');
        const data = await res.json();
        if (alive) setManaged(Boolean(data.success && data.record?.enabled && data.record?.riskAckAt));
      } catch {
        if (alive) setManaged(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`/api/novels?bookId=${encodeURIComponent(bookId)}`);
      const data = await res.json();
      if (data.success && data.book) setFanqie(data.book.fanqie || null);
    } catch {
      // 静默:保持旧状态,下次轮询/操作再试
    }
  }, [bookId]);

  useEffect(() => {
    if (managed) void refresh();
  }, [managed, refresh]);

  // 有在飞项(建书排队/执行中、章节待同步)时 10s 轮询,全部静默即停
  const chapters = fanqie?.chapters || {};
  const inFlight =
    fanqie?.createStatus === 'pending' ||
    fanqie?.createStatus === 'creating' ||
    Object.values(chapters).some((c) => c.status === 'pending');
  useEffect(() => {
    if (!managed || !inFlight) return;
    const t = setInterval(() => void refresh(), 10_000);
    return () => clearInterval(t);
  }, [managed, inFlight, refresh]);

  if (!managed) return null;

  const post = async (body: Record<string, unknown>) => {
    setBusy(true);
    setError('');
    try {
      const res = await fetch('/api/novels', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!data.success) setError(data.error || '操作失败');
    } catch (err: any) {
      setError(err?.message || '网络异常');
    } finally {
      setBusy(false);
      await refresh();
    }
  };

  const syncEnabled = fanqie?.syncEnabled !== false;
  const entries = Object.values(chapters);
  const synced = entries.filter((c) => c.status === 'synced').length;
  const pending = entries.filter((c) => c.status === 'pending').length;
  const failedIdx = Object.entries(chapters)
    .filter(([, c]) => c.status === 'failed')
    .map(([k]) => Number(k))
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b);
  const status = fanqie?.createStatus;

  return (
    <div className="rounded-xl border border-orange-200 bg-orange-50/40 p-3 space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-zinc-700 flex items-center gap-1.5 min-w-0">
          <BookOpen className="h-3.5 w-3.5 text-orange-500 shrink-0" />
          番茄自动同步
          <span className="text-[10px] font-normal text-zinc-400 hidden sm:inline">
            建书自动开书 · 每章自动存草稿 · 发布永远由你人工确认
          </span>
        </span>
        <button
          type="button"
          role="switch"
          aria-checked={syncEnabled}
          aria-label="番茄自动同步开关"
          title={syncEnabled ? '关闭本书自动同步' : '开启本书自动同步'}
          disabled={busy}
          onClick={() => void post({ action: 'setFanqieSync', bookId, enabled: !syncEnabled })}
          className={`relative shrink-0 w-9 h-5 rounded-full transition disabled:opacity-50 ${
            syncEnabled ? 'bg-orange-500' : 'bg-zinc-300'
          }`}
        >
          <span
            className={`absolute top-0.5 left-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform ${
              syncEnabled ? 'translate-x-4' : ''
            }`}
          />
        </button>
      </div>

      {!syncEnabled ? (
        <p className="text-[11px] text-zinc-500 leading-relaxed">
          本书自动同步已关闭:关闭期间入库的章节不会同步;重新打开开关即整体补排续传。
        </p>
      ) : fanqie?.fanqieBookId ? (
        <p className="text-[11px] text-zinc-600 leading-relaxed">
          <Check className="inline h-3 w-3 text-emerald-600 mr-1 -mt-px" />
          番茄书号 <span className="font-mono">{fanqie.fanqieBookId}</span>
          {synced > 0 || pending > 0
            ? ` · 章节 已同步 ${synced}${pending > 0 ? ` · 排队 ${pending}` : ''}`
            : ''}
          {pending > 0 ? '(排队章节由服务端依次执行;触发每日上限时明日自动续传)' : ''}
        </p>
      ) : status === 'pending' || status === 'creating' ? (
        <p className="text-[11px] text-zinc-600 flex items-start gap-1.5 leading-relaxed">
          <Loader2 className="h-3.5 w-3.5 animate-spin text-orange-500 shrink-0 mt-px" />
          {status === 'pending' ? '排队中:服务端运行器将自动在番茄开书' : '正在番茄开书…'}
          (开书成功后已入库章节自动转入草稿箱)
        </p>
      ) : status === 'failed' ? (
        <div className="space-y-1.5">
          <p className="text-[11px] text-red-600 flex items-start gap-1 leading-relaxed">
            <TriangleAlert className="h-3.5 w-3.5 mt-px shrink-0" />
            番茄开书失败:{fanqie?.createError || '原因未知'}
          </p>
          <div className="flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              disabled={busy}
              onClick={() => void post({ action: 'retryFanqieSync', bookId })}
              className="flex items-center gap-1 px-2.5 py-1 rounded-lg border border-orange-300 bg-white text-orange-700 text-[10px] font-medium hover:bg-orange-50 transition disabled:opacity-50"
            >
              <RefreshCw className="h-3 w-3" />
              重试开书
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => setBindOpen((v) => !v)}
              className="flex items-center gap-1 px-2.5 py-1 rounded-lg border border-zinc-300 bg-white text-zinc-600 text-[10px] font-medium hover:bg-zinc-50 transition disabled:opacity-50"
            >
              <Link2 className="h-3 w-3" />
              手动绑定书号
            </button>
            <span className="text-[10px] text-zinc-400">重试前请先到番茄「作品管理」确认没有建出半截重复书</span>
          </div>
          {bindOpen && (
            <div className="flex items-center gap-1.5">
              <input
                value={bindValue}
                onChange={(e) => setBindValue(e.target.value)}
                placeholder="番茄书号(章节管理页地址栏 chapter-manage/ 后那一段)"
                className="flex-1 min-w-0 px-2.5 py-1 rounded-lg border border-zinc-300 bg-white text-[11px] text-zinc-900 focus:outline-none focus:border-orange-400"
              />
              <button
                type="button"
                disabled={busy || !bindValue.trim()}
                onClick={() =>
                  void post({ action: 'bindFanqieBook', bookId, fanqieBookId: bindValue.trim() }).then(() => {
                    setBindOpen(false);
                    setBindValue('');
                  })
                }
                className="shrink-0 px-2.5 py-1 rounded-lg bg-orange-500 hover:bg-orange-600 text-white text-[10px] font-medium transition disabled:opacity-50"
              >
                绑定
              </button>
            </div>
          )}
        </div>
      ) : (
        <div className="space-y-1">
          <p className="text-[11px] text-zinc-500 leading-relaxed">
            这本书还没排上番茄开书(同步功能上线前入库的书不会自动补排)。
          </p>
          <button
            type="button"
            disabled={busy}
            onClick={() => void post({ action: 'setFanqieSync', bookId, enabled: true })}
            className="flex items-center gap-1 px-2.5 py-1 rounded-lg border border-orange-300 bg-white text-orange-700 text-[10px] font-medium hover:bg-orange-50 transition disabled:opacity-50"
          >
            <RefreshCw className="h-3 w-3" />
            排队开书
          </button>
        </div>
      )}

      {syncEnabled && failedIdx.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
          <span className="text-red-600">章节同步失败:</span>
          {failedIdx.map((n) => (
            <button
              key={n}
              type="button"
              disabled={busy}
              onClick={() => void post({ action: 'retryFanqieSync', bookId, chapterIndex: n })}
              className="px-2 py-0.5 rounded-md border border-red-200 bg-white text-red-600 text-[10px] hover:bg-red-50 transition disabled:opacity-50"
            >
              第{n}章 · 重试
            </button>
          ))}
        </div>
      )}

      {error && (
        <p className="text-[11px] text-red-600 flex items-start gap-1">
          <TriangleAlert className="h-3.5 w-3.5 mt-px shrink-0" />
          {error}
        </p>
      )}
    </div>
  );
}

export function NovelPackageCard({
  pkg,
  onChain,
  progress,
}: {
  pkg: NovelPackage;
  onChain?: NovelChainHandler;
  /** 逐字段交付进度(交付路径传入;文本解析路径不传,卡片行为逐字节不变) */
  progress?: DeliveryProgressView;
}) {
  if (pkg.kind === 'genesis') return <GenesisCard pkg={pkg} />;
  if (pkg.kind === 'genesis_bible') return <GenesisBibleCard pkg={pkg} onChain={onChain} progress={progress} />;
  if (pkg.kind === 'genesis_outline') return <GenesisOutlineCard pkg={pkg} onChain={onChain} progress={progress} />;
  if (pkg.kind === 'style') return <StyleAnchorCard pkg={pkg} />;
  return <ContinueCard pkg={pkg} />;
}
