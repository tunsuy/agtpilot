/**
 * 网文小说工坊 · 模板上下文(docs/design/novel-workshop.md §5)
 *
 * 三模式:genesis(开新书,五步法出六件套+开篇)/ continue(续写,恒定上下文装配)/
 * review(全书体检,状态库交叉核对)。书状态(NovelBook)由调用方注入:
 * 客户端预览用表单已拉取的书快照,服务端权威渲染经 server-render 的 loader 现读
 * novel-store —— 本模块只吃纯数据,不碰 fs(客户端 bundle 安全)。
 */
import promptGenesis from './prompt.genesis.md';
import promptGenesisBible from './prompt.genesis-bible.md';
import promptGenesisOutline from './prompt.genesis-outline.md';
import promptGenesisBibleLegacy from './prompt.genesis-bible.legacy.md';
import promptGenesisOutlineLegacy from './prompt.genesis-outline.legacy.md';
import promptContinue from './prompt.continue.md';
import promptReview from './prompt.review.md';
import promptStyle from './prompt.style.md';
import { renderTemplate } from '../engine';
// 灰度保险丝:AGTPILOT_NOVEL_FIELD_DELIVERY=0 → 设定包/大纲包回退 legacy 单轮巨文本契约
import { novelFieldDeliveryEnabled } from './delivery';
// fs-free 纯模块:novel-store(带 node:fs)绝不能进客户端 bundle(context.ts ←
// skill.ts ← registry.ts ← 客户端组件);类型与装配函数都住 novel-context
import { assembleChapterContext, assembleReviewContext, capNovelBible, type NovelBook } from '@/lib/novel-context';
import { buildProfileSection, type ScenarioProfile } from '@/lib/scenario-profile';

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
  /** 作者档案(profileSlot 'novel',P1):注入【账号档案】段,无档案渲染零差异 */
  profile?: ScenarioProfile | null;
}

export function buildNovelGenesisPrompt(input: NovelGenesisInput): string {
  const profileSection = input.profile ? buildProfileSection(input.profile) : null;
  return renderTemplate(promptGenesis, {
    genre: String(input.genre || '').trim() || '不限(自行拍板最有张力的方向)',
    premise: String(input.premise || '').trim(),
    style: String(input.style || '').trim() || NOVEL_STYLES[0],
    chapterWords: clampChapterWords(input.chapterWords),
    openingChapters: clampOpeningChapters(input.openingChapters),
    profileSection: profileSection || '',
  });
}

// ---- 开书三段化(docs/design/novel-workshop.md §5 修订):单次响应塞
// 「六件套+多章正文」会把推理模型推向 token 上限(rk1yt:52k 思考后
// 撞 32768 输出顶,正文零字)。拆成 设定包→大纲包→逐章(走续写管线):
// 每段输出量小、失败粒度细、逐章天然带恒定上下文。三段都用「存入书库
// 卡片 → 下一步按钮」串联,每步入库后下一步服务端现读书库注入。

export interface NovelGenesisBibleInput {
  genre: string;
  premise?: string;
  style: string;
  chapterWords?: unknown;
  profile?: ScenarioProfile | null;
}

/** 开书第一步:书名/卖点/设定集/人物卡(建书的地基) */
export function buildNovelGenesisBiblePrompt(input: NovelGenesisBibleInput): string {
  const profileSection = input.profile ? buildProfileSection(input.profile) : null;
  // 保险丝现读(不在模块加载期定格):vitest vi.stubEnv 与生产灰度都靠它切模板
  const template = novelFieldDeliveryEnabled() ? promptGenesisBible : promptGenesisBibleLegacy;
  return renderTemplate(template, {
    genre: String(input.genre || '').trim() || '不限(自行拍板最有张力的方向)',
    premise: String(input.premise || '').trim(),
    style: String(input.style || '').trim() || NOVEL_STYLES[0],
    chapterWords: clampChapterWords(input.chapterWords),
    profileSection: profileSection || '',
  });
}

export interface NovelGenesisOutlineInput {
  book: NovelBook;
  style?: string;
  chapterWords?: unknown;
  profile?: ScenarioProfile | null;
}

/** 大纲包注入的设定地基:设定集 + 人物卡(## 段头,不占【】契约命名空间) */
function assembleBibleBlock(book: NovelBook): string {
  const castText = book.characters
    .map((c) =>
      [
        `- **${c.name}**${c.role ? `(${c.role})` : ''}`,
        c.personality ? `  性格:${c.personality}` : '',
        c.motivation ? `  动机:${c.motivation}` : '',
        c.speech ? `  口癖:${c.speech}` : '',
        c.relations ? `  关系:${c.relations}` : '',
        c.arc ? `  弧光:${c.arc}` : '',
      ]
        .filter(Boolean)
        .join('\n')
    )
    .join('\n');
  return [
    `## 卖点\n${book.premise || '(空)'}`,
    `## 设定集\n${capNovelBible(book.bible) || '(空)'}`,
    `## 人物卡\n${castText || '(空)'}`,
  ].join('\n\n');
}

/** 开书第二步:粗纲/细纲/伏笔/时间线(服务端现读第一步入库的书状态) */
export function buildNovelGenesisOutlinePrompt(input: NovelGenesisOutlineInput): string {
  const { book } = input;
  const profileSection = input.profile ? buildProfileSection(input.profile) : null;
  const template = novelFieldDeliveryEnabled() ? promptGenesisOutline : promptGenesisOutlineLegacy;
  return renderTemplate(template, {
    bookTitle: book.title,
    bookId: book.bookId,
    bibleBlock: assembleBibleBlock(book),
    style: String(input.style || '').trim() || book.style || NOVEL_STYLES[0],
    chapterWords: clampChapterWords(input.chapterWords),
    profileSection: profileSection || '',
  });
}

export interface NovelContinueInput {
  book: NovelBook;
  style?: string;
  chapterWords?: unknown;
  profile?: ScenarioProfile | null;
}

/** 续写下一章:恒定上下文装配 + 低水位细纲补充指令 */
export function buildNovelContinuePrompt(input: NovelContinueInput): { prompt: string; nextIndex: number } {
  const { book } = input;
  const nextIndex = book.progress.nextChapter;
  const contextBlock = assembleChapterContext(book, { nextIndex });
  const remainingDetail = book.detailed.filter((d) => d.index > nextIndex).length;
  const needDetailed = remainingDetail < DETAIL_LOW_WATER;
  const profileSection = input.profile ? buildProfileSection(input.profile) : null;
  const prompt = renderTemplate(promptContinue, {
    bookTitle: book.title,
    nextIndex,
    contextBlock,
    chapterWords: clampChapterWords(input.chapterWords),
    style: String(input.style || '').trim() || book.style || NOVEL_STYLES[0],
    bookId: book.bookId,
    needDetailed,
    detailFrom: nextIndex + 1,
    profileSection: profileSection || '',
  });
  return { prompt, nextIndex };
}

export interface NovelReviewInput {
  book: NovelBook;
  focus?: string;
  profile?: ScenarioProfile | null;
}

export function buildNovelReviewPrompt(input: NovelReviewInput): string {
  const profileSection = input.profile ? buildProfileSection(input.profile) : null;
  return renderTemplate(promptReview, {
    bookTitle: input.book.title,
    focus: String(input.focus || '').trim() || NOVEL_REVIEW_FOCUS[0],
    reviewContext: assembleReviewContext(input.book),
    profileSection: profileSection || '',
  });
}

// ---- 文风学习(P2):从作者样文提炼文风锚,可绑定书目写回 ----

/** 样文上限:提炼文风不需要长文,超长截断(防整本粘贴撑爆 prompt) */
export const STYLE_SAMPLES_MAX = 6000;

export interface NovelStyleInput {
  /** 作者样文(仅限本人创作或已获授权文本,prompt 里有红线声明) */
  samples: string;
  /** 绑定书目(可空:未绑定产出可用作开书文风锚) */
  book?: NovelBook | null;
  profile?: ScenarioProfile | null;
}

export function buildNovelStylePrompt(input: NovelStyleInput): string {
  const samples = String(input.samples || '').trim();
  if (!samples) {
    // 没有样文就没有文风可提炼——诚实抛错,绝不凭空编造「作者文风」
    throw new Error('文风学习需要样文:请先粘贴你本人创作或已获授权的文本');
  }
  const capped =
    samples.length > STYLE_SAMPLES_MAX
      ? `${samples.slice(0, STYLE_SAMPLES_MAX)}\n(样文超长,已截断到 ${STYLE_SAMPLES_MAX} 字)`
      : samples;
  const profileSection = input.profile ? buildProfileSection(input.profile) : null;
  return renderTemplate(promptStyle, {
    samples: capped,
    bookTitle: input.book?.title || '',
    bookId: input.book?.bookId || '',
    profileSection: profileSection || '',
  });
}
