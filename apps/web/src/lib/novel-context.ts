/**
 * 网文小说 · 纯类型与恒定上下文装配(novel-context · docs/design/novel-workshop.md §2)
 *
 * 从 novel-store 拆出的 **fs-free** 模块:skill.ts → registry.ts 进客户端 bundle,
 * 装配函数与类型必须在客户端可用;文件读写全部留在 novel-store(服务端专属)。
 * novel-store re-export 本模块,服务端旧 import 路径不变。
 */

// ---- 类型 ----

/** 人物卡(结构化;currentState 是每章反思写回的落点) */
export interface NovelCharacter {
  name: string;
  /** 定位:主角/女主/反派/配角…(装配上下文时主角与主要人物恒入) */
  role?: string;
  appearance?: string;
  personality?: string;
  motivation?: string;
  /** 口癖/语言风格 */
  speech?: string;
  relations?: string;
  /** 成长弧光 */
  arc?: string;
  /** 当前状态(受伤?在哪?知道什么秘密?)——随章节滚动更新 */
  currentState?: string;
}

/** 章细纲(当前细纲池,章颗粒;写一章消耗一条,续写契约可补充) */
export interface DetailedChapter {
  index: number;
  title?: string;
  /** 开篇钩子 */
  hook?: string;
  /** 本章事件(细纲主体) */
  events: string;
  /** 情绪点/爽点 */
  emotion?: string;
  /** 伏笔动作(埋什么/收什么) */
  foreshadow?: string;
  targetWords?: number;
}

/** 伏笔台账条目(「收不回不是能力问题,是没台账」) */
export interface ForeshadowItem {
  id: string;
  content: string;
  plantedChapter: number;
  status: 'planted' | 'paid';
  payChapter?: number;
  /** 回收方式一句话(修订对称性用) */
  payMethod?: string;
}

export interface ChapterMeta {
  index: number;
  title: string;
  wordCount: number;
  createdAt: number;
}

/**
 * 番茄自动同步状态(书级,持久化在 book.json.fanqie;P2 全自动同步的意图账本)。
 *
 * 设计不变量:
 * - **意图先落盘再入队**:create/append 钩子先把 pending 写进这里,内存队列只是
 *   执行器;进程重启后 sweeper 按本状态恢复,不丢同步意图。
 * - **create 成功但未捕获书号 = 终态 failed**:绝不自动重试建书(防番茄侧重复
 *   建书),引导人工核对后走 bindFanqieBook 手动绑定。
 * - chapters 的 key 是本地章号字符串(与服务端 progress 序号同源)。
 */
export interface NovelFanqieState {
  /** 书级同步开关(缺省视为开:全自动是默认姿态) */
  syncEnabled?: boolean;
  /** 番茄侧作品书号(captureUrl 捕获或手动绑定写入;有值 = 映射已建立) */
  fanqieBookId?: string;
  /** 番茄开书状态机:pending 排队 → creating 执行中 → created 成功 / failed 终态 */
  createStatus?: 'pending' | 'creating' | 'created' | 'failed';
  createError?: string;
  createAttempts?: number;
  /** 建书成功(或手动绑定)时间 */
  createAt?: number;
  /** 逐章同步状态:key = 本地章号字符串 */
  chapters?: Record<
    string,
    { status: 'pending' | 'synced' | 'failed'; attempts?: number; error?: string; at?: number }
  >;
}

/** 列表页用的番茄同步摘要(NovelBookSummary 轻量口径,由 fanqieDigest 派生) */
export interface NovelFanqieDigest {
  syncEnabled: boolean;
  fanqieBookId?: string;
  createStatus?: NovelFanqieState['createStatus'];
  createError?: string;
  /** 已同步/排队中/失败的章节计数 */
  synced: number;
  pending: number;
  failed: number;
}

/** 状态 → 摘要(纯派生;undefined 视为「从未同步」:开关开、零计数) */
export function fanqieDigest(state?: NovelFanqieState | null): NovelFanqieDigest {
  const chapters = Object.values(state?.chapters || {});
  return {
    syncEnabled: state?.syncEnabled !== false,
    fanqieBookId: state?.fanqieBookId || undefined,
    createStatus: state?.createStatus,
    createError: state?.createError,
    synced: chapters.filter((c) => c.status === 'synced').length,
    pending: chapters.filter((c) => c.status === 'pending').length,
    failed: chapters.filter((c) => c.status === 'failed').length,
  };
}

export interface NovelBook {
  bookId: string;
  title: string;
  genre: string;
  /** 一句话卖点(番茄五步法第一步:这本书在卖什么) */
  premise: string;
  /** 文风锚(平台调性 + 叙事口吻 + 禁忌) */
  style: string;
  status: 'active' | 'paused' | 'finished';
  createdAt: number;
  updatedAt: number;
  progress: { chapterCount: number; wordCount: number; nextChapter: number };
  /** 设定集 markdown(世界规则/力量体系/势力) */
  bible: string;
  characters: NovelCharacter[];
  /** 粗纲 + 卷纲 markdown */
  outline: string;
  detailed: DetailedChapter[];
  ledger: ForeshadowItem[];
  /** 时间线年表(append-only 条目,「第N章|故事时间|事件」) */
  timeline: string[];
  /** 逐章滚动摘要:summaries[i] = 第 i+1 章摘要 */
  summaries: string[];
  /** 全书滚动总纲(反思时更新,分层压缩的顶层) */
  volumeSummary: string;
  /** 上次全书体检时写到的章号(0=从未体检;每 N 章体检提醒的依据,P1) */
  lastReviewedChapter: number;
  /** 番茄自动同步状态(可选:P2 之前的老书没有,读时容忍) */
  fanqie?: NovelFanqieState;
  chapters: ChapterMeta[];
}

/** 书库列表条目(不带六件套与摘要,列表页轻量) */
export interface NovelBookSummary {
  bookId: string;
  title: string;
  genre: string;
  premise: string;
  status: NovelBook['status'];
  createdAt: number;
  updatedAt: number;
  progress: NovelBook['progress'];
  /** 未回收伏笔数(列表徽标) */
  openForeshadows: number;
  /** 是否到了建议体检的节点(距上次体检新写章节 ≥ REVIEW_EVERY_N) */
  reviewDue: boolean;
  /** 大纲是否已入库(卡片派生「已存大纲」用,免去拉全量 book) */
  hasOutline: boolean;
  /** 番茄同步摘要(卡片 FanqieSyncRow 用) */
  fanqie?: NovelFanqieDigest;
}

/** 开书输入(来自开书包契约解析结果) */
export interface CreateNovelInput {
  title: string;
  genre?: string;
  premise?: string;
  style?: string;
  bible?: string;
  characters?: NovelCharacter[];
  outline?: string;
  detailed?: DetailedChapter[];
  ledgerSeeds?: Array<{ content: string; plantedChapter: number }>;
  timelineSeeds?: string[];
  chapters?: Array<{ title: string; content: string; summary?: string }>;
  volumeSummary?: string;
}

/** 续章反思写回输入(来自续写包契约解析结果) */
export interface AppendChapterInput {
  title: string;
  content: string;
  /** 本章摘要(150-250字,分层记忆第一层;缺失时拒绝入库——宁可不落半截状态) */
  summary: string;
  /** 人物当前状态增量(按名合并;新名字追加为只有状态的卡,提示人工补全) */
  characterUpdates?: Array<{ name: string; currentState: string }>;
  /** 伏笔动作:plant 埋设 / pay 回收(按内容关键词匹配最早未回收条目) */
  ledgerActions?: Array<
    | { action: 'plant'; content: string }
    | { action: 'pay'; keyword: string; payMethod?: string }
  >;
  timelineAppend?: string[];
  /** 细纲池补充(续写契约可选段) */
  detailedAppend?: DetailedChapter[];
  /** 全书总纲滚动更新(可选) */
  volumeSummary?: string;
}

// ---- 恒定上下文装配(§2 核心机制,纯函数) ----

/** 体检提醒间隔:距上次体检新写满这么多章,建议跑一次全书体检(P1 自动审查提醒) */
export const REVIEW_EVERY_N = 5;

/** 是否到体检节点(纯派生,不落额外状态;lastReviewedChapter 缺失按 0 兜底) */
export function isReviewDue(book: Pick<NovelBook, 'progress'> & { lastReviewedChapter?: number }): boolean {
  return book.progress.chapterCount - (book.lastReviewedChapter || 0) >= REVIEW_EVERY_N;
}

/** 装配预算:近章摘要条数 / 时间线条数 */
const RECENT_SUMMARIES = 3;
const RECENT_TIMELINE = 5;

function isMajor(c: NovelCharacter): boolean {
  const role = String(c.role || '');
  return /主角|男主|女主|主要|反一|大反派/.test(role);
}

/**
 * 每章生成的注入上下文(恒定 ≈4-6k token,书再长不涨):
 * 设定集 + 出场人物卡(主角恒入 + 细纲点名)+ 本章细纲 + 近3章摘要 +
 * 全书总纲 + 未回收伏笔 + 时间线尾部。
 * opts.nextIndex 缺省 = progress.nextChapter(续写下一章)。
 */
export function assembleChapterContext(book: NovelBook, opts: { nextIndex?: number } = {}): string {
  const nextIndex = opts.nextIndex ?? book.progress.nextChapter;
  const detail = book.detailed.find((d) => d.index === nextIndex);
  const detailText = detail
    ? [
        `### 第${detail.index}章${detail.title ? ` ${detail.title}` : ''}`,
        detail.hook ? `- 钩子:${detail.hook}` : '',
        `- 事件:${detail.events}`,
        detail.emotion ? `- 情绪点:${detail.emotion}` : '',
        detail.foreshadow ? `- 伏笔动作:${detail.foreshadow}` : '',
        detail.targetWords ? `- 目标字数:${detail.targetWords}` : '',
      ]
        .filter(Boolean)
        .join('\n')
    : '(细纲池已空:请先在输出里按契约补充后续细纲,再写本章)';

  // 出场人物:主角/主要恒入 + 本章细纲文本点名的其他角色
  const detailHaystack = detailText + (book.summaries[book.summaries.length - 1] || '');
  const cast = book.characters.filter((c) => isMajor(c) || (c.name && detailHaystack.includes(c.name)));
  const castText = cast.length
    ? cast
        .map((c) =>
          [
            `- **${c.name}**${c.role ? `(${c.role})` : ''}`,
            c.personality ? `  性格:${c.personality}` : '',
            c.motivation ? `  动机:${c.motivation}` : '',
            c.speech ? `  口癖:${c.speech}` : '',
            c.relations ? `  关系:${c.relations}` : '',
            c.currentState ? `  **当前状态:${c.currentState}**` : '',
          ]
            .filter(Boolean)
            .join('\n')
        )
        .join('\n')
    : '(暂无人物卡)';

  const recentSummaries = book.summaries
    .map((s, i) => ({ s, i }))
    .filter((x) => x.s && x.i + 1 < nextIndex)
    .slice(-RECENT_SUMMARIES)
    .map((x) => `第${x.i + 1}章:${x.s}`)
    .join('\n');

  const openLedger = book.ledger
    .filter((f) => f.status === 'planted')
    .map((f) => `- [未回收·第${f.plantedChapter}章埋] ${f.content}`)
    .join('\n');

  const timelineTail = book.timeline.slice(-RECENT_TIMELINE).map((t) => `- ${t}`).join('\n');

  // 段头用 markdown ##(不用【】——【】是输出契约的命名空间,注入段头若同用
  // 会被模型回显进输出、污染 parseNovelPackage 的判定)
  return [
    `## 进度\n已写 ${book.progress.chapterCount} 章 / ${book.progress.wordCount} 字;现在写第 ${nextIndex} 章。`,
    book.volumeSummary ? `## 全书总纲\n${book.volumeSummary}` : '',
    `## 设定集\n${book.bible || '(空)'}`,
    `## 出场人物卡\n${castText}`,
    `## 本章细纲\n${detailText}`,
    recentSummaries ? `## 近章摘要\n${recentSummaries}` : '',
    openLedger ? `## 伏笔台账(未回收,写到相关情节时必须呼应或回收)\n${openLedger}` : '',
    timelineTail ? `## 时间线(近${RECENT_TIMELINE}条,严禁时间矛盾)\n${timelineTail}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');
}

/**
 * 审查模式上下文:只基于状态库交叉核对(不读全文,P0 口径):
 * 六件套 + 全部台账 + 完整时间线 + 全部章摘要。
 */
export function assembleReviewContext(book: NovelBook): string {
  const ledgerText = book.ledger
    .map((f) =>
      f.status === 'planted'
        ? `- [未回收] (第${f.plantedChapter}章埋) ${f.content}`
        : `- [已回收] (第${f.plantedChapter || '?'}章埋,第${f.payChapter}章收${f.payMethod ? `,方式:${f.payMethod}` : ''}) ${f.content}`
    )
    .join('\n');
  const summariesText = book.summaries
    .map((s, i) => (s ? `第${i + 1}章:${s}` : ''))
    .filter(Boolean)
    .join('\n');
  const castText = book.characters
    .map((c) => `- ${c.name}${c.role ? `(${c.role})` : ''}${c.currentState ? ` 当前状态:${c.currentState}` : ''}`)
    .join('\n');
  // 段头用 markdown ##(不用【】,理由同 assembleChapterContext)
  return [
    `## 书目\n《${book.title}》 ${book.genre} · 已写 ${book.progress.chapterCount} 章 / ${book.progress.wordCount} 字`,
    book.premise ? `## 卖点\n${book.premise}` : '',
    book.volumeSummary ? `## 全书总纲\n${book.volumeSummary}` : '',
    `## 设定集\n${book.bible || '(空)'}`,
    `## 人物卡与当前状态\n${castText || '(空)'}`,
    `## 粗纲/卷纲\n${book.outline || '(空)'}`,
    `## 伏笔台账(全量,注意回收率与超期未回收)\n${ledgerText || '(空)'}`,
    `## 时间线(全量,检查时序矛盾/角色瞬移)\n${book.timeline.map((t) => `- ${t}`).join('\n') || '(空)'}`,
    `## 逐章摘要(检查前后矛盾/人设漂移)\n${summariesText || '(空)'}`,
  ]
    .filter(Boolean)
    .join('\n\n');
}
