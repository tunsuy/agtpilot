/**
 * 网文小说工坊表单 · 五模式(开新书/续写下一章/写序章/全书体检/文风学习)
 * docs/design/novel-workshop.md §5-§7
 *
 * 续写/审查需要书状态:表单从 /api/novels 拉书库列表与全书快照,
 * 客户端预览经 ctx.novelState 装配;提交带 {id:'novel', params} 载荷后,
 * /api/agent/run 走服务端权威渲染(server-render 的 novel loader 现读书库,
 * 客户端快照只影响预览,不影响实发)。书未加载完成前预览与提交都不可用——
 * 不拿半截状态拼 prompt。
 *
 * P1 增量:作者档案注入(profileSlot 'novel',摘要条 + 编辑入口);
 * 订阅日更(scenario 型 cron 任务,按书绑定,触发时服务端现读书库重建);
 * 全书导出 TXT/EPUB(直下);每 N 章体检提醒(isReviewDue,发起体检即落
 * markReviewed——提醒启发式的落点,失败可重跑不影响状态一致性)。
 *
 * P2 增量:文风学习(样文提炼文风锚,绑书可选——绑书则结果卡可写回本书,
 * 之后续写自动注入;不绑则复制留作开书自定义文风锚)。续写模式的文风以
 * 书自己的锚为准(表单风格选择只属于开书),否则写回的锚永远被表单值盖掉。
 */
import { useEffect, useMemo, useState } from 'react';
import { BookOpen, CalendarClock, Download, Feather, Loader2, PenLine, Sparkles, Stethoscope } from 'lucide-react';
import {
  NOVEL_GENRES,
  NOVEL_STYLES,
  NOVEL_REVIEW_FOCUS,
  STYLE_SAMPLES_MAX,
  clampChapterWords,
} from '@/workshops/novel/context';
import type { NovelBook, NovelBookSummary } from '@/lib/novel-context';
import { isReviewDue, REVIEW_EVERY_N } from '@/lib/novel-context';
import type { ScenarioProfile } from '@/lib/scenario-profile';
import type { CronJobItem } from '@/types/agent';
import type { WorkshopDef } from '../registry';
import { buildWorkshopRun, type WorkshopRunPayload } from '../run';
import { recordRun, lastRunOf } from '../history';
import { ACCENTS, ChipGroup, FieldLabel, WorkshopModalShell, inputClass, textareaClass } from './shared';

interface Props {
  workshop: WorkshopDef;
  onRun: (prompt: string, title?: string, workshop?: WorkshopRunPayload) => void | Promise<void>;
  onClose: () => void;
  /** 作者档案(WorkshopsView 按 profileSlot 'novel' 预取下传);有值时注入 Prompt 并展示摘要条 */
  scenarioProfile?: ScenarioProfile | null;
  /** 点击摘要条「查看/编辑」打开档案向导 */
  onEditProfile?: () => void;
}

type NovelMode = 'genesis' | 'continue' | 'prologue' | 'review' | 'style';

const MODES: Array<{ id: NovelMode; name: string; icon: typeof BookOpen }> = [
  { id: 'genesis', name: '开新书', icon: BookOpen },
  { id: 'continue', name: '续写下一章', icon: PenLine },
  { id: 'prologue', name: '写序章', icon: Feather },
  { id: 'review', name: '全书体检', icon: Stethoscope },
  { id: 'style', name: '文风学习', icon: Sparkles },
];

const CHAPTER_WORDS = [1000, 2000, 3000, 5000];
/** 日更时刻 chip(cron 整点触发:`0 H * * *`) */
const SUB_HOURS = [6, 9, 12, 18, 21];

const postCron = (body: Record<string, unknown>) =>
  fetch('/api/cron/jobs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).then((r) => r.json());

export function NovelWorkshopForm({ workshop, onRun, onClose, scenarioProfile, onEditProfile }: Props) {
  const saved = lastRunOf(workshop.id)?.params || {};
  const [mode, setMode] = useState<NovelMode>(
    saved.mode === 'continue' || saved.mode === 'prologue' || saved.mode === 'review' || saved.mode === 'style'
      ? saved.mode
      : 'genesis'
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
  // 自定义文风锚:非预设值回填(与 customGenre 同模式);「文风学习」提炼的锚可粘贴进来开书
  const [customStyle, setCustomStyle] = useState<string>(
    typeof saved.style === 'string' && saved.style && !(NOVEL_STYLES as readonly string[]).includes(saved.style)
      ? saved.style
      : ''
  );
  const [chapterWords, setChapterWords] = useState<number>(clampChapterWords(saved.chapterWords));

  // ---- 文风学习(P2):样文必填,绑书可选 ----
  const [samples, setSamples] = useState<string>(typeof saved.samples === 'string' ? saved.samples : '');

  // ---- 书库(续写/审查) ----
  const [books, setBooks] = useState<NovelBookSummary[] | null>(null);
  const [bookId, setBookId] = useState<string>(typeof saved.bookId === 'string' ? saved.bookId : '');
  const [book, setBook] = useState<NovelBook | null>(null);
  const [bookLoading, setBookLoading] = useState(false);
  const [focus, setFocus] = useState<string>(
    typeof saved.focus === 'string' && saved.focus ? saved.focus : NOVEL_REVIEW_FOCUS[0]
  );

  // ---- 订阅日更(P1:scenario 型 cron,按书绑定) ----
  const [cronJob, setCronJob] = useState<CronJobItem | null>(null);
  const [cronLoading, setCronLoading] = useState(false);
  const [cronBusy, setCronBusy] = useState(false);
  const [cronMsg, setCronMsg] = useState<string | null>(null);
  const [subHour, setSubHour] = useState<number>(9);

  // ---- 作品简介手动编辑(存量书唯一全书入口;番茄建书 intro 优先取它) ----
  const [synopsisDraft, setSynopsisDraft] = useState<string>('');
  const [synopsisBusy, setSynopsisBusy] = useState(false);
  const [synopsisMsg, setSynopsisMsg] = useState<string | null>(null);

  useEffect(() => {
    setSynopsisDraft(typeof book?.synopsis === 'string' ? book.synopsis : '');
    setSynopsisMsg(null);
  }, [book?.bookId, book?.synopsis]);

  const handleSaveSynopsis = async () => {
    if (!bookId || synopsisBusy) return;
    const synopsis = synopsisDraft.trim();
    if (!synopsis) {
      setSynopsisMsg('简介不能为空');
      return;
    }
    setSynopsisBusy(true);
    setSynopsisMsg(null);
    try {
      const res = await fetch('/api/novels', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'updateSynopsis', bookId, synopsis }),
      });
      const data = await res.json();
      if (data.success) {
        setBook((cur) => (cur ? { ...cur, synopsis } : cur));
        setSynopsisMsg('已保存');
      } else {
        setSynopsisMsg(data.error || '保存失败');
      }
    } catch (err: any) {
      setSynopsisMsg(err?.message || '网络异常');
    } finally {
      setSynopsisBusy(false);
    }
  };

  const needBook = mode !== 'genesis';
  /** 续写/序章/审查必须先有书;文风学习绑书可选——不绑定也能纯提炼(预览不依赖书快照) */
  const requiresBook = mode === 'continue' || mode === 'prologue' || mode === 'review' || (mode === 'style' && Boolean(bookId));

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

  // 订阅状态按书查:同一本书最多一条活跃的日更任务(换书重新查)
  useEffect(() => {
    if (mode !== 'continue' || !bookId) {
      setCronJob(null);
      setCronMsg(null);
      return;
    }
    let alive = true;
    setCronLoading(true);
    (async () => {
      try {
        const res = await fetch('/api/cron/jobs');
        const data = await res.json();
        const job = data.success
          ? (data.jobs || []).find(
              (j: CronJobItem) =>
                j.scenario?.key === 'novel_daily_chapter' &&
                j.scenario?.bookId === bookId &&
                j.status !== 'cancelled'
            )
          : null;
        if (alive) setCronJob(job || null);
      } catch {
        // 未登录/后端未就绪时静默:订阅区显示未订阅,可重试
        if (alive) setCronJob(null);
      } finally {
        if (alive) setCronLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [mode, bookId]);

  // 开书三段化:表单「开新书」发的是 genesis_bible(设定包,第一步);后续
  // 大纲包/逐章续写由结果卡片上的「继续」按钮串,不再回表单。旧 genesis
  // (单次全量)只留给历史重跑,本表单不再产。
  const params = useMemo(
    () => ({
      mode: mode === 'genesis' ? 'genesis_bible' : mode,
      genre: customGenre.trim() || genre,
      premise,
      // 序章走书自己的文风锚(同续写);开书/文风学习用表单值
      style: mode === 'continue' || mode === 'prologue' ? '' : customStyle.trim() || style,
      chapterWords,
      bookId,
      focus,
      samples,
    }),
    [mode, genre, customGenre, premise, style, customStyle, chapterWords, bookId, focus, samples]
  );

  // 预览:续写/审查在书快照到位前不拼;文风学习绑了书同样等快照,不绑直接拼
  // (宁空勿错;实发 prompt 由服务端 loader 现读重建)
  // 作者档案与书快照同路注入 ctx(服务端权威渲染时两者都现读,这里只影响预览)
  const preview = useMemo(() => {
    if (requiresBook && !book) return null;
    const ctx =
      book || scenarioProfile
        ? {
            ...(book ? { novelState: book } : {}),
            ...(scenarioProfile ? { scenarioProfile } : {}),
          }
        : undefined;
    try {
      return buildWorkshopRun(workshop.id, params, ctx);
    } catch {
      return null;
    }
  }, [workshop.id, params, requiresBook, book, scenarioProfile]);

  const handleSubmit = () => {
    if (!preview) return;
    // 发起体检即记「已体检到当前章」:提醒启发式的落点(fire-and-forget,
    // 失败不拦提交——体检任务可重跑,重跑会再次标记,不影响书库一致性)
    if (mode === 'review' && bookId) {
      fetch('/api/novels', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'markReviewed', bookId }),
      }).catch(() => {});
    }
    recordRun(workshop.id, preview.title, params);
    onRun(preview.prompt, preview.title, { id: workshop.id, params });
  };

  /** 开通/修改日更:同书先取消旧任务再建新任务(保证时刻/字数一致) */
  const handleSubscribe = async () => {
    if (!book) return;
    setCronBusy(true);
    setCronMsg(null);
    try {
      if (cronJob) await postCron({ action: 'cancel', id: cronJob.id });
      const data = await postCron({
        action: 'create',
        name: `《${book.title}》日更`,
        pattern: `0 ${subHour} * * *`,
        // 存档的 prompt 仅作展示快照;触发时服务端现读书库+档案重建(requiresServerState)
        prompt:
          preview?.prompt || `(场景订阅:小说日更,触发时服务端现读《${book.title}》续写下一章)`,
        scenario: { key: 'novel_daily_chapter', count: chapterWords, bookId },
      });
      if (data.success) {
        setCronJob(data.newJob || null);
        setCronMsg(`已订阅:每天 ${subHour}:00 自动续写本章约 ${chapterWords} 字`);
      } else {
        setCronMsg(data.error || '订阅失败,请重试');
      }
    } catch {
      setCronMsg('网络异常,订阅失败,请重试');
    } finally {
      setCronBusy(false);
    }
  };

  const handleUnsubscribe = async () => {
    if (!cronJob) return;
    setCronBusy(true);
    setCronMsg(null);
    try {
      await postCron({ action: 'cancel', id: cronJob.id });
      setCronJob(null);
      setCronMsg('已取消日更');
    } catch {
      setCronMsg('网络异常,取消失败,请重试');
    } finally {
      setCronBusy(false);
    }
  };

  const accent = ACCENTS[workshop.accent];
  const submitLabel =
    mode === 'genesis'
      ? '开始开书'
      : mode === 'continue'
        ? '生成下一章'
        : mode === 'prologue'
          ? '生成序章'
          : mode === 'review'
            ? '开始体检'
            : '提炼文风锚';

  return (
    <WorkshopModalShell
      def={workshop}
      onClose={onClose}
      onSubmit={handleSubmit}
      submitLabel={submitLabel}
      previewPrompt={
        preview?.prompt ||
        (bookLoading
          ? '书状态加载中…'
          : mode === 'style' && !samples.trim()
            ? '粘贴样文后即可预览文风学习任务(仅限你本人创作或已获授权的文本)'
            : '请先选择一本书(书库为空时先「开新书」)')
      }
    >
      {/* 作者档案摘要条:让用户看见「Agent 已经认识我」,可回访编辑(注入开书/续写/体检 prompt) */}
      {scenarioProfile && (
        <div className="flex items-center justify-between gap-2 px-3 py-2 rounded-xl bg-violet-50/70 border border-violet-100">
          <span className="text-[11px] text-violet-700 leading-relaxed min-w-0 truncate">
            作者档案:{scenarioProfile.positioning.niche} · {scenarioProfile.positioning.audience}
            {scenarioProfile.cadence.postsPerWeek ? ` · 每周 ${scenarioProfile.cadence.postsPerWeek} 章` : ''}
          </span>
          {onEditProfile && (
            <button
              type="button"
              onClick={onEditProfile}
              className="shrink-0 text-[11px] font-medium text-violet-600 hover:text-violet-800 transition"
            >
              查看/编辑
            </button>
          )}
        </div>
      )}

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
              value={customStyle.trim() ? '__custom__' : style}
              onChange={setStyle}
              accent={workshop.accent}
            />
            <input
              type="text"
              value={customStyle}
              onChange={(e) => setCustomStyle(e.target.value)}
              placeholder="自定义文风锚(填写后优先于上方预设;「文风学习」提炼的锚可粘贴到这)"
              className={inputClass}
            />
            <p className="text-[10px] text-zinc-400 leading-relaxed">{customStyle.trim() || style}</p>
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

          <p className="text-[11px] text-zinc-500 leading-relaxed rounded-xl border border-zinc-200 bg-zinc-50/60 px-3 py-2.5">
            开书分三步走:① 本任务产「设定包」(书名/卖点/设定集/人物卡),点「存入书库」建书;② 卡片上点「继续:生成大纲」产粗纲/细纲/伏笔/时间线并入书,入库后卡片上可直接「开通日更」;③ 再点「继续:写第 1 章」,此后逐章续写(或交给日更)。每步结果都先给你审,不满意可重跑。
          </p>
        </>
      )}

      {/* 文风学习(P2):样文必填(不凭空编造文风);绑书可选,在下方「绑定书目」 */}
      {mode === 'style' && (
        <>
          <div className="space-y-1.5">
            <FieldLabel>作者样文(必填)</FieldLabel>
            <textarea
              value={samples}
              onChange={(e) => setSamples(e.target.value)}
              placeholder={'粘贴你本人创作或已获授权的文本片段(建议 500-6000 字)。\n样文越能代表你的调性,提炼出的文风锚越准。'}
              rows={8}
              className={textareaClass}
            />
            <p className="text-[10px] text-zinc-400 leading-relaxed">
              仅限本人创作或已获授权的文本;超过 {STYLE_SAMPLES_MAX} 字自动截断。疑似他人作品只提炼通用文风特征,
              严禁复刻其情节链/人名组合/名场面(版权红线)。
            </p>
          </div>
          <p className="text-[11px] text-zinc-500 leading-relaxed rounded-xl border border-zinc-200 bg-zinc-50/60 px-3 py-2.5">
            产出 150-600 字「文风锚」(只描述怎么写,不生成情节正文)。绑定书目后可在结果卡片上一键写回,
            之后这本书每次续写自动注入;不绑定则复制留作开书时的自定义文风锚。
          </p>
        </>
      )}

      {needBook && (
        <>
          <div className="space-y-1.5">
            <FieldLabel>{mode === 'style' ? '绑定书目(可选)' : '选择书目'}</FieldLabel>
            {books === null ? (
              <p className="text-[11px] text-zinc-400 flex items-center gap-1.5">
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> 书库加载中…
              </p>
            ) : books.length === 0 ? (
              <p className="text-[11px] text-zinc-500 leading-relaxed rounded-xl border border-zinc-200 bg-zinc-50/60 px-3 py-2.5">
                {mode === 'style'
                  ? '书库为空:可不绑定直接提炼,产出的文风锚复制留作开书用。'
                  : '书库还是空的:先用「开新书」生成,再在任务结果卡片上点「存入书库」。'}
              </p>
            ) : (
              <select
                value={bookId}
                onChange={(e) => setBookId(e.target.value)}
                className={inputClass}
              >
                <option value="">{mode === 'style' ? '— 不绑定书目(纯提炼) —' : '— 请选择 —'}</option>
                {books.map((b) => (
                  <option key={b.bookId} value={b.bookId}>
                    《{b.title}》 第{b.progress.chapterCount}章 · {b.progress.wordCount}字 · 未回收伏笔{b.openForeshadows}
                    {b.reviewDue ? ' · 建议体检' : ''}
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

          {/* 全书导出(P1):直下 TXT/EPUB,人工审阅后自行投稿——不经过任何平台投递 */}
          {book && bookId && (
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-[11px] text-zinc-500 flex items-center gap-1">
                <Download className="h-3.5 w-3.5" /> 全书导出:
              </span>
              <a
                href={`/api/novels?bookId=${encodeURIComponent(bookId)}&export=txt`}
                className="px-2.5 py-1 rounded-lg text-[11px] font-medium border border-zinc-200 bg-white text-zinc-600 hover:border-zinc-300 transition"
              >
                TXT
              </a>
              <a
                href={`/api/novels?bookId=${encodeURIComponent(bookId)}&export=epub`}
                className="px-2.5 py-1 rounded-lg text-[11px] font-medium border border-zinc-200 bg-white text-zinc-600 hover:border-zinc-300 transition"
              >
                EPUB
              </a>
              <span className="text-[10px] text-zinc-400">下载后人工审阅,投稿平台由你操作</span>
            </div>
          )}

          {/* 作品简介(平台书页用;开书时交付,存量书在此手动改——番茄建书 intro 优先取它) */}
          {book && bookId && (
            <div className="space-y-1.5">
              <FieldLabel>作品简介</FieldLabel>
              <textarea
                value={synopsisDraft}
                onChange={(e) => setSynopsisDraft(e.target.value)}
                rows={4}
                placeholder="读者向简介(150-300 字,平台书页口吻):开篇抛核心钩子,收在让读者想点开第 1 章的悬念上。"
                className={textareaClass}
              />
              <div className="flex items-center justify-between gap-2">
                <span className="text-[10px] text-zinc-400 leading-relaxed">
                  {synopsisMsg ? (
                    <span className={synopsisMsg === '已保存' ? 'text-emerald-600' : 'text-rose-500'}>{synopsisMsg}</span>
                  ) : (
                    '番茄建书简介优先取这段;平台上已建书的简介请到平台手动改。'
                  )}
                </span>
                <button
                  type="button"
                  onClick={handleSaveSynopsis}
                  disabled={synopsisBusy || synopsisDraft.trim() === (book.synopsis || '')}
                  className={`shrink-0 px-3 py-1.5 rounded-lg text-[11px] font-medium text-white transition disabled:opacity-50 ${accent.btn}`}
                >
                  {synopsisBusy ? '保存中…' : '保存简介'}
                </button>
              </div>
            </div>
          )}

          {book && mode === 'continue' && (
            <>
              <div className="rounded-xl border border-zinc-200 bg-zinc-50/60 px-3 py-2.5 text-[11px] text-zinc-500 leading-relaxed">
                下一章:第{book.progress.nextChapter}章 · 细纲池余{' '}
                {book.detailed.filter((d) => d.index > book.progress.nextChapter).length} 条 · 未回收伏笔{' '}
                {book.ledger.filter((f) => f.status === 'planted').length} 条。
                生成时注入恒定上下文(设定集+出场人物卡+细纲+近章摘要),写后反思自动写回书库。
              </div>

              {/* 体检提醒(P1):距上次体检新写满 N 章建议先体检(发起体检即消提醒) */}
              {isReviewDue(book) && (
                <p className="text-[11px] text-amber-600 leading-relaxed rounded-xl border border-amber-200 bg-amber-50/60 px-3 py-2.5">
                  距上次全书体检已新写 {book.progress.chapterCount - (book.lastReviewedChapter || 0)} 章(每{' '}
                  {REVIEW_EVERY_N} 章提醒一次):长篇连更最容易积累前后矛盾,建议先切到「全书体检」核对一遍再继续。
                </p>
              )}

              <div className="space-y-1.5">
                <FieldLabel>每章字数</FieldLabel>
                <ChipGroup
                  options={CHAPTER_WORDS.map((n) => ({ id: n, name: `${n}` }))}
                  value={chapterWords}
                  onChange={setChapterWords}
                  accent={workshop.accent}
                />
              </div>

              {/* 订阅日更(P1):scenario 型 cron,按书绑定;产物仍走任务交付+人工入库 */}
              <div className="rounded-xl border border-zinc-200 bg-zinc-50/60 px-3 py-2.5 space-y-2">
                <div className="flex items-center gap-1.5 text-[11px] font-medium text-zinc-600">
                  <CalendarClock className="h-3.5 w-3.5" /> 订阅日更(每天自动续写这本书)
                </div>
                {cronLoading ? (
                  <p className="text-[11px] text-zinc-400 flex items-center gap-1.5">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" /> 订阅状态加载中…
                  </p>
                ) : cronJob ? (
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-[11px] text-zinc-500 leading-relaxed min-w-0">
                      已订阅:每天 {cronJob.pattern.split(' ')[1]}:00 自动续写(触发时服务端现读书库与档案重建任务)。
                    </p>
                    <button
                      type="button"
                      onClick={handleUnsubscribe}
                      disabled={cronBusy}
                      className="shrink-0 text-[11px] font-medium text-rose-500 hover:text-rose-700 disabled:opacity-50 transition"
                    >
                      取消日更
                    </button>
                  </div>
                ) : (
                  <>
                    <ChipGroup
                      options={SUB_HOURS.map((h) => ({ id: h, name: `${h}:00` }))}
                      value={subHour}
                      onChange={setSubHour}
                      accent={workshop.accent}
                    />
                    <button
                      type="button"
                      onClick={handleSubscribe}
                      disabled={cronBusy}
                      className={`px-3 py-1.5 rounded-lg text-[11px] font-medium text-white transition disabled:opacity-50 ${accent.btn}`}
                    >
                      {cronBusy ? '订阅中…' : `订阅每天 ${subHour}:00 日更`}
                    </button>
                  </>
                )}
                {cronMsg && <p className="text-[10px] text-zinc-500">{cronMsg}</p>}
                <p className="text-[10px] text-zinc-400 leading-relaxed">
                  日更产物以任务交付,仍需你人工审阅后点「存入书库」才写回本书(反思写回只在入库时发生);
                  发布到任何平台永远由你手动操作。
                </p>
              </div>
            </>
          )}

          {book && mode === 'prologue' && (
            <>
              <div className="rounded-xl border border-zinc-200 bg-zinc-50/60 px-3 py-2.5 text-[11px] text-zinc-500 leading-relaxed">
                序章(楔子)放在第 1 章之前,作为第 0 篇落库(不占章节索引、不动进度)。
                生成时注入设定地基与粗纲,与第 1 章分工:抛钩子,不复述第 1 章事件。
              </div>
              {/* 硬顺序闸的表单前置提示:零章书才放行(服务端同闸双保险) */}
              {book.progress.chapterCount > 0 ? (
                <p className="text-[11px] text-amber-600 leading-relaxed rounded-xl border border-amber-200 bg-amber-50/60 px-3 py-2.5">
                  《{book.title}》已有正文章节,不能再插入序章(序章只在写第 1 章之前落库)。
                </p>
              ) : book.prologue ? (
                <p className="text-[11px] text-amber-600 leading-relaxed rounded-xl border border-amber-200 bg-amber-50/60 px-3 py-2.5">
                  《{book.title}》已有序章(一次性槽位,不覆盖);直接「续写下一章」即可。
                </p>
              ) : (
                <div className="space-y-1.5">
                  <FieldLabel>序章字数</FieldLabel>
                  <ChipGroup
                    options={CHAPTER_WORDS.map((n) => ({ id: n, name: `${n}` }))}
                    value={chapterWords}
                    onChange={setChapterWords}
                    accent={workshop.accent}
                  />
                </div>
              )}
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
          {mode === 'style'
            ? samples.trim()
              ? '文风学习任务未就绪,请检查样文内容与绑定书目。'
              : '请先粘贴样文:没有样文就提炼不出文风,绝不凭空编造。'
            : books && books.length > 0 && !bookId
              ? '请先选择一本书。'
              : '书状态未就绪,无法生成任务。'}
        </p>
      )}
    </WorkshopModalShell>
  );
}
