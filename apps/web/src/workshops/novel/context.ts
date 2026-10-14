/**
 * 网文小说工坊 · 模板上下文(docs/design/novel-workshop.md §5)
 *
 * 三模式:genesis(开新书,五步法出六件套+开篇)/ continue(续写,恒定上下文装配)/
 * review(全书体检,状态库交叉核对)。书状态(NovelBook)由调用方注入:
 * 客户端预览用表单已拉取的书快照,服务端权威渲染经 server-render 的 loader 现读
 * novel-store —— 本模块只吃纯数据,不碰 fs(客户端 bundle 安全)。
 */
import promptGenesis from './prompt.genesis.md';
import promptContinue from './prompt.continue.md';
import promptReview from './prompt.review.md';
import { renderTemplate } from '../engine';
// fs-free 纯模块:novel-store(带 node:fs)绝不能进客户端 bundle(context.ts ←
// skill.ts ← registry.ts ← 客户端组件);类型与装配函数都住 novel-context
import { assembleChapterContext, assembleReviewContext, type NovelBook } from '@/lib/novel-context';

/** 题材预设(表单 chip;可自由输入,不是白名单) */
export const NOVEL_GENRES = ['都市', '玄幻', '仙侠', '言情', '悬疑', '历史', '科幻', '游戏竞技', '现实题材'] as const;

/** 文风锚预设(表单 chip;可自由输入) */
export const NOVEL_STYLES = [
  '爽文快节奏:短段落、强钩子、三章一小爽五章一大爽',
  '轻松幽默:吐槽役叙事、生活化对白、轻喜剧节奏',
  '正剧厚重:多线叙事、人物弧光优先、克制文风',
  '悬疑冷峻:信息差控制、伏笔密集、短章快节奏',
] as const;

/** 审查侧重预设(表单 chip) */
export const NOVEL_REVIEW_FOCUS = ['全面体检', '伏笔盘点', '人物一致性', '时间线与逻辑'] as const;

// ---- 参数钳制(表单与 run() 共用,单一事实源) ----

/** 每章字数:1000-6000,缺省 3000 */
export function clampChapterWords(v: unknown): number {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return 3000;
  return Math.min(6000, Math.max(1000, n));
}

/** 开书初始章数:1-5,缺省 3 */
export function clampOpeningChapters(v: unknown): number {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return 3;
  return Math.min(5, Math.max(1, n));
}

/** 细纲池余量低于此值时,续写契约要求补充细纲 */
const DETAIL_LOW_WATER = 3;

// ---- 三模式 prompt 构建 ----

export interface NovelGenesisInput {
  genre: string;
  premise?: string;
  style: string;
  chapterWords?: unknown;
  openingChapters?: unknown;
}

export function buildNovelGenesisPrompt(input: NovelGenesisInput): string {
  return renderTemplate(promptGenesis, {
    genre: String(input.genre || '').trim() || '不限(自行拍板最有张力的方向)',
    premise: String(input.premise || '').trim(),
    style: String(input.style || '').trim() || NOVEL_STYLES[0],
    chapterWords: clampChapterWords(input.chapterWords),
    openingChapters: clampOpeningChapters(input.openingChapters),
  });
}

export interface NovelContinueInput {
  book: NovelBook;
  style?: string;
  chapterWords?: unknown;
}

/** 续写下一章:恒定上下文装配 + 低水位细纲补充指令 */
export function buildNovelContinuePrompt(input: NovelContinueInput): { prompt: string; nextIndex: number } {
  const { book } = input;
  const nextIndex = book.progress.nextChapter;
  const contextBlock = assembleChapterContext(book, { nextIndex });
  const remainingDetail = book.detailed.filter((d) => d.index > nextIndex).length;
  const needDetailed = remainingDetail < DETAIL_LOW_WATER;
  const prompt = renderTemplate(promptContinue, {
    bookTitle: book.title,
    nextIndex,
    contextBlock,
    chapterWords: clampChapterWords(input.chapterWords),
    style: String(input.style || '').trim() || book.style || NOVEL_STYLES[0],
    bookId: book.bookId,
    needDetailed,
    detailFrom: nextIndex + 1,
  });
  return { prompt, nextIndex };
}

export interface NovelReviewInput {
  book: NovelBook;
  focus?: string;
}

export function buildNovelReviewPrompt(input: NovelReviewInput): string {
  return renderTemplate(promptReview, {
    bookTitle: input.book.title,
    focus: String(input.focus || '').trim() || NOVEL_REVIEW_FOCUS[0],
    reviewContext: assembleReviewContext(input.book),
  });
}
