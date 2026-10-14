/**
 * 网文小说工坊表单 · 三模式(开新书/续写下一章/全书体检)
 * docs/design/novel-workshop.md §5-§6
 *
 * 续写/审查需要书状态:表单从 /api/novels 拉书库列表与全书快照,
 * 客户端预览经 ctx.novelState 装配;提交带 {id:'novel', params} 载荷后,
 * /api/agent/run 走服务端权威渲染(server-render 的 novel loader 现读书库,
 * 客户端快照只影响预览,不影响实发)。书未加载完成前预览与提交都不可用——
 * 不拿半截状态拼 prompt。
 */
import { useEffect, useMemo, useState } from 'react';
import { BookOpen, Loader2, PenLine, Stethoscope } from 'lucide-react';
import {
  NOVEL_GENRES,
  NOVEL_STYLES,
  NOVEL_REVIEW_FOCUS,
  clampChapterWords,
  clampOpeningChapters,
} from '@/workshops/novel/context';
import type { NovelBook, NovelBookSummary } from '@/lib/novel-context';
import type { WorkshopDef } from '../registry';
import { buildWorkshopRun, type WorkshopRunPayload } from '../run';
import { recordRun, lastRunOf } from '../history';
import { ACCENTS, ChipGroup, FieldLabel, WorkshopModalShell, inputClass, textareaClass } from './shared';

interface Props {
  workshop: WorkshopDef;
  onRun: (prompt: string, title?: string, workshop?: WorkshopRunPayload) => void | Promise<void>;
  onClose: () => void;
}

type NovelMode = 'genesis' | 'continue' | 'review';

const MODES: Array<{ id: NovelMode; name: string; icon: typeof BookOpen }> = [
  { id: 'genesis', name: '开新书', icon: BookOpen },
  { id: 'continue', name: '续写下一章', icon: PenLine },
  { id: 'review', name: '全书体检', icon: Stethoscope },
];

const CHAPTER_WORDS = [1000, 2000, 3000, 5000];
const OPENING_CHAPTERS = [1, 2, 3, 5];

export function NovelWorkshopForm({ workshop, onRun, onClose }: Props) {
  const saved = lastRunOf(workshop.id)?.params || {};
  const [mode, setMode] = useState<NovelMode>(
    saved.mode === 'continue' || saved.mode === 'review' ? saved.mode : 'genesis'
  );

  // ---- 开新书参数 ----
  const [genre, setGenre] = useState<string>(typeof saved.genre === 'string' && saved.genre ? saved.genre : NOVEL_GENRES[0]);
  const [customGenre, setCustomGenre] = useState<string>(
    typeof saved.genre === 'string' && saved.genre && !(NOVEL_GENRES as readonly string[]).includes(saved.genre)
      ? saved.genre
      : ''
  );
  const [premise, setPremise] = useState<string>(typeof saved.premise === 'string' ? saved.premise : '');
  const [style, setStyle] = useState<string>(typeof saved.style === 'string' && saved.style ? saved.style : NOVEL_STYLES[0]);
  const [chapterWords, setChapterWords] = useState<number>(clampChapterWords(saved.chapterWords));
  const [openingChapters, setOpeningChapters] = useState<number>(clampOpeningChapters(saved.openingChapters));

  // ---- 书库(续写/审查) ----
  const [books, setBooks] = useState<NovelBookSummary[] | null>(null);
  const [bookId, setBookId] = useState<string>(typeof saved.bookId === 'string' ? saved.bookId : '');
  const [book, setBook] = useState<NovelBook | null>(null);
  const [bookLoading, setBookLoading] = useState(false);
  const [focus, setFocus] = useState<string>(
    typeof saved.focus === 'string' && saved.focus ? saved.focus : NOVEL_REVIEW_FOCUS[0]
  );

  const needBook = mode !== 'genesis';

  useEffect(() => {
    if (!needBook || books !== null) return;
    (async () => {
      try {
        const res = await fetch('/api/novels');
        const data = await res.json();
        setBooks(data.success && Array.isArray(data.books) ? data.books : []);
      } catch {
        setBooks([]);
      }
    })();
  }, [needBook, books]);

  useEffect(() => {
    if (!needBook || !bookId) {
      setBook(null);
      return;
    }
    let alive = true;
    setBookLoading(true);
    (async () => {
      try {
        const res = await fetch(`/api/novels?bookId=${encodeURIComponent(bookId)}`);
        const data = await res.json();
        if (alive) setBook(data.success && data.book ? data.book : null);
      } catch {
        if (alive) setBook(null);
      } finally {
        if (alive) setBookLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [needBook, bookId]);

  const params = useMemo(
    () => ({
      mode,
      genre: customGenre.trim() || genre,
      premise,
      style,
      chapterWords,
      openingChapters,
      bookId,
      focus,
    }),
    [mode, genre, customGenre, premise, style, chapterWords, openingChapters, bookId, focus]
  );

  // 预览:续写/审查在书快照到位前不拼(宁空勿错;实发 prompt 由服务端 loader 现读重建)
  const preview = useMemo(() => {
    if (needBook && !book) return null;
    try {
      return buildWorkshopRun(workshop.id, params, book ? { novelState: book } : undefined);
    } catch {
      return null;
    }
  }, [workshop.id, params, needBook, book]);

  const handleSubmit = () => {
    if (!preview) return;
    recordRun(workshop.id, preview.title, params);
    onRun(preview.prompt, preview.title, { id: workshop.id, params });
  };

  const accent = ACCENTS[workshop.accent];
  const submitLabel = mode === 'genesis' ? '开始开书' : mode === 'continue' ? '生成下一章' : '开始体检';

  return (
    <WorkshopModalShell
      def={workshop}
      onClose={onClose}
      onSubmit={handleSubmit}
      submitLabel={submitLabel}
      previewPrompt={preview?.prompt || (bookLoading ? '书状态加载中…' : '请先选择一本书(书库为空时先「开新书」)')}
    >
      {/* 模式切换 */}
      <div className="flex gap-1.5">
        {MODES.map((m) => {
          const Icon = m.icon;
          const active = mode === m.id;
          return (
            <button
              key={m.id}
              type="button"
              onClick={() => setMode(m.id)}
              className={`flex-1 flex items-center justify-center gap-1.5 py-2 rounded-xl text-xs font-medium border transition ${
                active ? accent.chipActive : 'bg-white text-zinc-600 border-zinc-200 hover:border-zinc-300'
              }`}
            >
              <Icon className="h-3.5 w-3.5" />
              {m.name}
            </button>
          );
        })}
      </div>

      {mode === 'genesis' && (
        <>
          <div className="space-y-1.5">
            <FieldLabel>题材</FieldLabel>
            <ChipGroup
              options={NOVEL_GENRES.map((g) => ({ id: g as string, name: g }))}
              value={customGenre.trim() ? '__custom__' : genre}
              onChange={(v) => {
                if (v !== '__custom__') {
                  setGenre(v);
                  setCustomGenre('');
                }
              }}
              accent={workshop.accent}
            />
            <input
              type="text"
              value={customGenre}
              onChange={(e) => setCustomGenre(e.target.value)}
              placeholder="自定义题材(填写后优先于上方选择),如:末世废土"
              className={inputClass}
            />
          </div>

          <div className="space-y-1.5">
            <FieldLabel optional>一句话卖点 / 核心创意</FieldLabel>
            <textarea
              value={premise}
              onChange={(e) => setPremise(e.target.value)}
              placeholder="留空则由 Agent 按题材自行拍板。例:外卖骑手捡到能预知差评的手机,每躲开一单差评就变强"
              rows={2}
              className={textareaClass}
            />
          </div>

          <div className="space-y-1.5">
            <FieldLabel>文风锚</FieldLabel>
            <ChipGroup
              options={NOVEL_STYLES.map((s) => ({ id: s as string, name: s.split(':')[0] }))}
              value={style}
              onChange={setStyle}
              accent={workshop.accent}
            />
            <p className="text-[10px] text-zinc-400 leading-relaxed">{style}</p>
          </div>

          <div className="flex gap-4">
            <div className="space-y-1.5 flex-1">
              <FieldLabel>每章字数</FieldLabel>
              <ChipGroup
                options={CHAPTER_WORDS.map((n) => ({ id: n, name: `${n}` }))}
                value={chapterWords}
                onChange={setChapterWords}
                accent={workshop.accent}
              />
            </div>
            <div className="space-y-1.5">
              <FieldLabel>开篇章数</FieldLabel>
              <ChipGroup
                options={OPENING_CHAPTERS.map((n) => ({ id: n, name: `${n}` }))}
                value={openingChapters}
                onChange={setOpeningChapters}
                accent={workshop.accent}
              />
            </div>
          </div>

          <p className="text-[11px] text-zinc-500 leading-relaxed rounded-xl border border-zinc-200 bg-zinc-50/60 px-3 py-2.5">
            开书产出「六件套」(设定集/人物卡/三层大纲/伏笔台账/时间线/文风锚)+ 开篇正文。
            任务完成后在结果卡片上点「存入书库」,之后就能续写与体检。
          </p>
        </>
      )}

      {needBook && (
        <>
          <div className="space-y-1.5">
            <FieldLabel>选择书目</FieldLabel>
            {books === null ? (
              <p className="text-[11px] text-zinc-400 flex items-center gap-1.5">
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> 书库加载中…
              </p>
            ) : books.length === 0 ? (
              <p className="text-[11px] text-zinc-500 leading-relaxed rounded-xl border border-zinc-200 bg-zinc-50/60 px-3 py-2.5">
                书库还是空的:先用「开新书」生成,再在任务结果卡片上点「存入书库」。
              </p>
            ) : (
              <select
                value={bookId}
                onChange={(e) => setBookId(e.target.value)}
                className={inputClass}
              >
                <option value="">— 请选择 —</option>
                {books.map((b) => (
                  <option key={b.bookId} value={b.bookId}>
                    《{b.title}》 第{b.progress.chapterCount}章 · {b.progress.wordCount}字 · 未回收伏笔{b.openForeshadows}
                  </option>
                ))}
              </select>
            )}
          </div>

          {bookLoading && bookId && (
            <p className="text-[11px] text-zinc-400 flex items-center gap-1.5">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> 书状态加载中…
            </p>
          )}

          {book && mode === 'continue' && (
            <>
              <div className="rounded-xl border border-zinc-200 bg-zinc-50/60 px-3 py-2.5 text-[11px] text-zinc-500 leading-relaxed">
                下一章:第{book.progress.nextChapter}章 · 细纲池余{' '}
                {book.detailed.filter((d) => d.index > book.progress.nextChapter).length} 条 · 未回收伏笔{' '}
                {book.ledger.filter((f) => f.status === 'planted').length} 条。
                生成时注入恒定上下文(设定集+出场人物卡+细纲+近章摘要),写后反思自动写回书库。
              </div>
              <div className="space-y-1.5">
                <FieldLabel>每章字数</FieldLabel>
                <ChipGroup
                  options={CHAPTER_WORDS.map((n) => ({ id: n, name: `${n}` }))}
                  value={chapterWords}
                  onChange={setChapterWords}
                  accent={workshop.accent}
                />
              </div>
            </>
          )}

          {book && mode === 'review' && (
            <div className="space-y-1.5">
              <FieldLabel>体检侧重</FieldLabel>
              <ChipGroup
                options={NOVEL_REVIEW_FOCUS.map((f) => ({ id: f as string, name: f }))}
                value={focus}
                onChange={setFocus}
                accent={workshop.accent}
              />
              <p className="text-[10px] text-zinc-400 leading-relaxed">
                体检只读状态库交叉核对(不读全文),输出问题清单 + 健康度评分,不改动书库。
              </p>
            </div>
          )}
        </>
      )}

      {/* 提交不可用原因(诚实提示,不静默禁用) */}
      {needBook && !preview && !bookLoading && (
        <p className="text-[11px] text-amber-600 leading-relaxed">
          {books && books.length > 0 && !bookId
            ? '请先选择一本书。'
            : '书状态未就绪,无法生成任务。'}
        </p>
      )}
    </WorkshopModalShell>
  );
}
