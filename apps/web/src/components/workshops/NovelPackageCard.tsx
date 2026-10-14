'use client';

/**
 * 网文小说包卡片(novel 工坊交付物 · docs/design/novel-workshop.md §6)
 *
 * 两种包两种卡:
 * - 开书包:六件套折叠预览 + 开篇章节列表 + 「存入书库」(POST /api/novels action=create);
 * - 续写包:章节 + 反思五连预览 + 「存入书库」(action=append,写回状态库)。
 *
 * 书号校验(归属闭环):续写包回显的【书号】入库前先按当前用户书库核对——
 * 命中直接入;未命中(书被删/串书)绝不猜,给书目下拉由用户指认后再入。
 * 入库成功前按钮始终可用,失败明示原因,不静默假成功。
 */
import React, { useEffect, useMemo, useState } from 'react';
import {
  BookOpen,
  Check,
  ChevronDown,
  Library,
  Loader2,
  PenLine,
  TriangleAlert,
} from 'lucide-react';
import type {
  NovelPackage,
  NovelGenesisPackage,
  NovelContinuePackage,
} from '../../workshops/novel/novel-package';
import type { NovelBookSummary } from '../../lib/novel-context';

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
  | { phase: 'saved'; bookId: string; chapterCount: number; wordCount: number; nextChapter: number }
  | { phase: 'error'; message: string };

function SaveButton({
  onSave,
  state,
  disabled,
  label,
}: {
  onSave: () => void | Promise<void>;
  state: SaveState;
  disabled?: boolean;
  label: string;
}) {
  if (state.phase === 'saved') {
    return (
      <span className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-50 border border-emerald-200 text-emerald-700 text-[11px] font-medium">
        <Check className="h-3.5 w-3.5" />
        已入库 · 共{state.chapterCount}章 {state.wordCount}字 · 书号 {state.bookId}
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
        setSave({ phase: 'saved', bookId: targetBookId, ...data.progress });
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
      </div>
    </div>
  );
}

export function NovelPackageCard({ pkg }: { pkg: NovelPackage }) {
  return pkg.kind === 'genesis' ? <GenesisCard pkg={pkg} /> : <ContinueCard pkg={pkg} />;
}
