'use client';

/**
 * 网文小说包卡片(novel 工坊交付物 · docs/design/novel-workshop.md §6-§7)
 *
 * 五种包五种卡(开书三段化后):
 * - 设定包(第一步):书名/卖点/设定集/人物卡 + 「存入书库」建书(action=create,
 *   不带章正文)+ 「继续:生成大纲」串第二步(genesis_outline 工坊任务);
 * - 大纲包(第二步):粗纲/细纲/伏笔/时间线 + 「存入书库」合并进书(action=
 *   mergeOutline,书号经用户书库校验)+ 「继续:写开篇第 1 章」走续写管线;
 * - 续写包:章节 + 反思五连预览 + 「存入书库」(action=append,写回状态库);
 * - 文风锚包(P2 文风学习):文风锚全文 + 绑书时「写回本书」(action=updateStyle),
 *   未绑书时可复制留作开书文风锚;
 * - 旧开书包(单次全量):历史任务重渲染兼容,照旧走 create。
 *
 * 书号校验(归属闭环):续写包/大纲包回显的【书号】入库前先按当前用户书库核对——
 * 命中直接入;未命中(书被删/串书)绝不猜,给书目下拉由用户指认后再入。
 * 入库成功前按钮始终可用,失败明示原因,不静默假成功。
 */
import React, { useEffect, useMemo, useState } from 'react';
import {
  BookOpen,
  Check,
  ChevronDown,
  Copy,
  Library,
  Loader2,
  Map,
  PenLine,
  Sparkles,
  TriangleAlert,
} from 'lucide-react';
import type {
  NovelPackage,
  NovelGenesisPackage,
  NovelGenesisBiblePackage,
  NovelGenesisOutlinePackage,
  NovelContinuePackage,
  NovelStylePackage,
} from '../../workshops/novel/novel-package';
import type { NovelBookSummary } from '../../lib/novel-context';
import { REVIEW_EVERY_N } from '../../lib/novel-context';
import type { WorkshopRunPayload } from './run';

const countWords = (s: string) => String(s || '').replace(/\s/g, '').length;

/** 可折叠小节(六件套各段共用) */
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
        <div className="px-3 pb-2.5 text-[11px] text-zinc-600 leading-relaxed whitespace-pre-wrap break-words max-h-56 overflow-y-auto border-t border-zinc-100 pt-2">
          {children}
        </div>
      )}
    </div>
  );
}

type SaveState =
  | { phase: 'idle' }
  | { phase: 'saving' }
  | { phase: 'saved'; bookId: string; chapterCount: number; wordCount: number; nextChapter: number; reviewDue?: boolean }
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
        {savedLabel || `已入库 · 共${state.chapterCount}章 ${state.wordCount}字 · 书号 ${state.bookId}`}
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
        <Section label="粗纲/卷纲" count={`${countWords(pkg.outline)}字`}>{pkg.outline}</Section>
        {pkg.detailed.length > 0 && (
          <Section label="细纲池" count={`${pkg.detailed.length}条`}>
            {pkg.detailed
              .map((d) => `第${d.index}章${d.title ? ` ${d.title}` : ''}:${d.events}`)
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
              {ch.content}
              {ch.summary && (
                <p className="mt-2 pt-2 border-t border-zinc-100 text-zinc-500">摘要:{ch.summary}</p>
              )}
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
      </div>
    </div>
  );
}

// ---- 设定包卡(开书三段化 · 第一步) ----

function GenesisBibleCard({ pkg, onChain }: { pkg: NovelGenesisBiblePackage; onChain?: NovelChainHandler }) {
  const [save, setSave] = useState<SaveState>({ phase: 'idle' });

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
        {pkg.style && <Section label="文风锚(回显)" count={`${countWords(pkg.style)}字`}>{pkg.style}</Section>}

        <div className="flex items-center justify-between gap-2 pt-2.5 border-t border-zinc-100">
          <span className="text-[10px] text-zinc-400 leading-relaxed min-w-0">
            建书不带正文:大纲在第二步生成,正文逐章续写。入库前请先审阅,不满意可重跑。
          </span>
          <SaveButton onSave={handleSave} state={save} label="存入书库" savedLabel={`已建书 · 书号 ${save.phase === 'saved' ? save.bookId : ''}`} />
        </div>
        {save.phase === 'error' && (
          <p className="text-[11px] text-red-600 flex items-start gap-1">
            <TriangleAlert className="h-3.5 w-3.5 mt-px shrink-0" />
            {save.message}
          </p>
        )}
        {/* 三段化串联:入库成功才给下一步(没书号没法注入设定地基) */}
        {save.phase === 'saved' && onChain && (
          <div className="flex items-center justify-end">
            <ChainButton onClick={chainOutline} icon={Map} label="继续:生成大纲" />
          </div>
        )}
      </div>
    </div>
  );
}

// ---- 大纲包卡(开书三段化 · 第二步) ----

function GenesisOutlineCard({ pkg, onChain }: { pkg: NovelGenesisOutlinePackage; onChain?: NovelChainHandler }) {
  const [save, setSave] = useState<SaveState>({ phase: 'idle' });
  // 书号校验同续写包:回显书号按用户书库核对,未命中(书被删/串书/漏回显)给下拉指认
  const [books, setBooks] = useState<NovelBookSummary[] | null>(null);
  const [chosenBookId, setChosenBookId] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch('/api/novels');
        const data = await res.json();
        setBooks(data.success && Array.isArray(data.books) ? data.books : []);
      } catch {
        setBooks([]);
      }
    })();
  }, []);

  const claimedValid = useMemo(
    () => (books ? books.some((b) => b.bookId === pkg.bookId) : null),
    [books, pkg.bookId]
  );
  const targetBookId = claimedValid ? pkg.bookId : chosenBookId;
  const targetBook = books?.find((b) => b.bookId === targetBookId) || null;

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
    if (save.phase !== 'saved' || !onChain) return;
    const bookTitle = targetBook?.title || '本书';
    const nextIndex = save.nextChapter;
    onChain(
      { id: 'novel', params: { mode: 'continue', bookId: save.bookId } },
      { prompt: `继续《${bookTitle}》:按刚合并的细纲写第 ${nextIndex} 章(开书第三步,此后逐章续写)`, title: `《${bookTitle}》第${nextIndex}章` }
    );
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

      <div className="p-4 space-y-2.5">
        <Section label="粗纲/卷纲" count={`${countWords(pkg.outline)}字`}>{pkg.outline}</Section>
        {pkg.detailed.length > 0 && (
          <Section label="细纲池" count={`${pkg.detailed.length}条`}>
            {pkg.detailed
              .map((d) => `第${d.index}章${d.title ? ` ${d.title}` : ''}:${d.events}`)
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
            disabled={!targetBookId}
            label="存入书库"
            savedLabel={`已合并 · 书号 ${save.phase === 'saved' ? save.bookId : ''}`}
          />
        </div>
        {save.phase === 'error' && (
          <p className="text-[11px] text-red-600 flex items-start gap-1">
            <TriangleAlert className="h-3.5 w-3.5 mt-px shrink-0" />
            {save.message}
          </p>
        )}
        {save.phase === 'saved' && onChain && (
          <div className="flex items-center justify-end">
            <ChainButton onClick={chainOpening} icon={PenLine} label={`继续:写第 ${save.nextChapter} 章`} />
          </div>
        )}
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
    (async () => {
      try {
        const res = await fetch('/api/novels');
        const data = await res.json();
        setBooks(data.success && Array.isArray(data.books) ? data.books : []);
      } catch {
        setBooks([]);
      }
    })();
  }, []);

  const claimedValid = useMemo(
    () => (books ? books.some((b) => b.bookId === pkg.bookId) : null),
    [books, pkg.bookId]
  );
  const targetBookId = claimedValid ? pkg.bookId : chosenBookId;
  const targetBook = books?.find((b) => b.bookId === targetBookId) || null;

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
            {pkg.detailedAppend.map((d) => `第${d.index}章${d.title ? ` ${d.title}` : ''}:${d.events}`).join('\n')}
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
        <div className="rounded-lg border border-zinc-200 px-3 py-2.5 text-[11px] text-zinc-600 leading-relaxed whitespace-pre-wrap break-words max-h-64 overflow-y-auto">
          {pkg.style}
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

export function NovelPackageCard({ pkg, onChain }: { pkg: NovelPackage; onChain?: NovelChainHandler }) {
  if (pkg.kind === 'genesis') return <GenesisCard pkg={pkg} />;
  if (pkg.kind === 'genesis_bible') return <GenesisBibleCard pkg={pkg} onChain={onChain} />;
  if (pkg.kind === 'genesis_outline') return <GenesisOutlineCard pkg={pkg} onChain={onChain} />;
  if (pkg.kind === 'style') return <StyleAnchorCard pkg={pkg} />;
  return <ContinueCard pkg={pkg} />;
}
