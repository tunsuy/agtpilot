/**
 * 网文小说状态库(novel-store · docs/design/novel-workshop.md §3,服务端专属)
 *
 * 每用户 × 每本书一个目录:getDataDir()/novels/<safeUserId>/<bookId>/
 * - book.json       单一事实源:meta + 六件套结构化状态 + 分层记忆(摘要/总纲)
 * - chapters/NNN.md 章节正文单独成文件(书可长达 MB 级,不塞 JSON)
 *
 * 设计不变量:
 * - **状态文件化可审计**:与 OpenNovel 的向量库黑盒相反,所有记忆都是可手改的
 *   JSON/markdown;一致性靠「恒定上下文装配 + 反思写回」而非语义检索。
 * - **原子写**(tmp + rename,artifact-files 同款):章文件先落、book.json 后落,
 *   崩溃最坏丢一次进度指针,不丢正文。
 * - **路径消毒**:userId/bookId 白名单字符消毒后拼路径,拒绝穿越;章节序号
 *   服务端钳制(= progress.nextChapter),调用方传什么不算什么。
 * - 本库只存创作内容,不存任何凭证(P2 托管连接器凭证走 user-store 托管通道)。
 *
 * 类型与恒定上下文装配在 ./novel-context(fs-free,客户端 bundle 安全);
 * 本文件 re-export 保持服务端 import 路径稳定。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { getDataDir } from './user-store';
import type {
  NovelBook,
  NovelBookSummary,
  ChapterMeta,
  ForeshadowItem,
  CreateNovelInput,
  AppendChapterInput,
  DetailedChapter,
} from './novel-context';
import { isReviewDue } from './novel-context';

export type {
  NovelCharacter,
  DetailedChapter,
  ForeshadowItem,
  ChapterMeta,
  NovelBook,
  NovelBookSummary,
  CreateNovelInput,
  AppendChapterInput,
} from './novel-context';
export { assembleChapterContext, assembleReviewContext, isReviewDue, REVIEW_EVERY_N } from './novel-context';

// ---- 路径消毒(artifact-files 同款) ----

function sanitizeSegment(input: string): string {
  return String(input || '').replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 120) || 'unknown';
}

function novelsRoot(): string {
  return path.join(getDataDir(), 'novels');
}

function userRoot(userId: string): string {
  return path.join(novelsRoot(), sanitizeSegment(userId));
}

function bookDir(userId: string, bookId: string): string {
  return path.join(userRoot(userId), sanitizeSegment(bookId));
}

/** 章文件路径:序号钳制在 [1, 9999],三位以上零填充(001.md / 1234.md) */
function chapterFile(userId: string, bookId: string, index: number): string {
  const n = Math.min(9999, Math.max(1, Math.floor(index)));
  return path.join(bookDir(userId, bookId), 'chapters', `${String(n).padStart(3, '0')}.md`);
}

// ---- 原子写 ----

function atomicWriteJson(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

function atomicWriteText(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, file);
}

// ---- 读 ----

function readBookJson(userId: string, bookId: string): NovelBook | null {
  const file = path.join(bookDir(userId, bookId), 'book.json');
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || typeof parsed.bookId !== 'string') return null;
    // P0 落盘的老书没有体检字段:读时兜底,不迁移文件(下次写回自然补齐)
    if (typeof parsed.lastReviewedChapter !== 'number' || !Number.isFinite(parsed.lastReviewedChapter)) {
      parsed.lastReviewedChapter = 0;
    }
    return parsed as NovelBook;
  } catch {
    return null;
  }
}

/** 取一本书(不存在/损坏返回 null) */
export function getNovelBook(userId: string, bookId: string): NovelBook | null {
  if (!userId || !bookId) return null;
  return readBookJson(userId, bookId);
}

/** 取一章正文(不存在返回 null) */
export function getChapterContent(userId: string, bookId: string, index: number): string | null {
  const book = readBookJson(userId, bookId);
  if (!book) return null;
  try {
    return fs.readFileSync(chapterFile(userId, bookId, index), 'utf8');
  } catch {
    return null;
  }
}

function toSummary(book: NovelBook): NovelBookSummary {
  return {
    bookId: book.bookId,
    title: book.title,
    genre: book.genre,
    premise: book.premise,
    status: book.status,
    createdAt: book.createdAt,
    updatedAt: book.updatedAt,
    progress: book.progress,
    openForeshadows: book.ledger.filter((f) => f.status === 'planted').length,
    reviewDue: isReviewDue(book),
  };
}

/** 列出用户书库(按更新时间倒序;损坏目录静默跳过) */
export function listNovelBooks(userId: string): NovelBookSummary[] {
  const root = userRoot(userId);
  let entries: string[];
  try {
    entries = fs.readdirSync(root);
  } catch {
    return [];
  }
  const books: NovelBook[] = [];
  for (const e of entries) {
    const book = readBookJson(userId, e);
    if (book) books.push(book);
  }
  books.sort((a, b) => b.updatedAt - a.updatedAt);
  return books.map(toSummary);
}

// ---- 写 ----

export function newNovelBookId(): string {
  return `nv_${Date.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}`;
}

/** 中文字数口径:去空白后的字符数(与平台字数统计近似) */
export function countWords(text: string): number {
  return String(text || '').replace(/\s/g, '').length;
}

/**
 * 开书:建目录 + 落 book.json + 逐章落正文文件。
 * 章节序号从 1 起由服务端分配(契约里模型写的序号不可信,只做展示)。
 */
export function createNovelBook(userId: string, input: CreateNovelInput): NovelBook {
  const now = Date.now();
  const bookId = newNovelBookId();
  const chapters: ChapterMeta[] = [];
  const summaries: string[] = [];
  let wordCount = 0;

  const ledger: ForeshadowItem[] = (input.ledgerSeeds || []).map((s, i) => ({
    id: `fs_${now.toString(36)}_${i}`,
    content: s.content,
    plantedChapter: Math.max(1, Math.floor(s.plantedChapter) || 1),
    status: 'planted' as const,
  }));

  // 章文件先落(book.json 后落,崩溃最坏丢指针不丢正文)
  (input.chapters || []).forEach((ch, i) => {
    const index = i + 1;
    const wc = countWords(ch.content);
    atomicWriteText(chapterFile(userId, bookId, index), ch.content);
    chapters.push({ index, title: ch.title || `第${index}章`, wordCount: wc, createdAt: now });
    if (ch.summary) summaries[index - 1] = ch.summary;
    wordCount += wc;
  });

  const book: NovelBook = {
    bookId,
    title: String(input.title || '').trim() || '无题',
    genre: String(input.genre || '').trim(),
    premise: String(input.premise || '').trim(),
    style: String(input.style || '').trim(),
    status: 'active',
    createdAt: now,
    updatedAt: now,
    progress: { chapterCount: chapters.length, wordCount, nextChapter: chapters.length + 1 },
    bible: String(input.bible || ''),
    characters: input.characters || [],
    outline: String(input.outline || ''),
    detailed: input.detailed || [],
    ledger,
    timeline: input.timelineSeeds || [],
    summaries,
    volumeSummary: String(input.volumeSummary || ''),
    lastReviewedChapter: 0,
    chapters,
  };
  atomicWriteJson(path.join(bookDir(userId, bookId), 'book.json'), book);
  return book;
}

/**
 * 续章 + 反思写回(一次事务落库,§2 五连):
 * 章正文文件 → 摘要 → 人物状态按名合并 → 台账动作 → 时间线追加 → 细纲池补充 →
 * 总纲滚动 → 进度指针/字数。序号永远取 progress.nextChapter(调用方不可指定)。
 * 书不存在抛错;summary 缺失抛错(宁可不落半截状态)。
 */
export function appendChapter(userId: string, bookId: string, input: AppendChapterInput): NovelBook {
  const book = readBookJson(userId, bookId);
  if (!book) throw new Error(`书不存在: ${bookId}`);
  const content = String(input.content || '');
  if (!content.trim()) throw new Error('章节正文为空,拒绝入库');
  const summary = String(input.summary || '').trim();
  if (!summary) throw new Error('缺少本章摘要(反思写回必填),拒绝入库——不落半截状态');

  const index = book.progress.nextChapter;
  const wc = countWords(content);
  atomicWriteText(chapterFile(userId, bookId, index), content);

  book.chapters.push({
    index,
    title: String(input.title || '').trim() || `第${index}章`,
    wordCount: wc,
    createdAt: Date.now(),
  });
  book.summaries[index - 1] = summary;
  book.progress = {
    chapterCount: book.progress.chapterCount + 1,
    wordCount: book.progress.wordCount + wc,
    nextChapter: index + 1,
  };

  // 人物状态按名合并;新名字追加为只有状态的卡(提示人工补全)
  for (const u of input.characterUpdates || []) {
    const name = String(u.name || '').trim();
    if (!name) continue;
    const hit = book.characters.find((c) => c.name === name);
    if (hit) hit.currentState = String(u.currentState || '').trim();
    else book.characters.push({ name, currentState: String(u.currentState || '').trim() });
  }

  // 台账:埋设追加;回收按关键词匹配最早一条未回收(内容包含或被包含均算命中)
  for (const act of input.ledgerActions || []) {
    if (act.action === 'plant') {
      const content2 = String(act.content || '').trim();
      if (!content2) continue;
      book.ledger.push({
        id: `fs_${Date.now().toString(36)}_${book.ledger.length}`,
        content: content2,
        plantedChapter: index,
        status: 'planted',
      });
    } else if (act.action === 'pay') {
      const kw = String(act.keyword || '').trim();
      if (!kw) continue;
      const open = book.ledger.find(
        (f) => f.status === 'planted' && (f.content.includes(kw) || kw.includes(f.content))
      );
      if (open) {
        open.status = 'paid';
        open.payChapter = index;
        open.payMethod = String(act.payMethod || '').trim() || undefined;
      } else {
        // 回收了台账里没有的线:补一条已回收记录,审查时可见「无埋设记录的回收」
        book.ledger.push({
          id: `fs_${Date.now().toString(36)}_${book.ledger.length}`,
          content: kw,
          plantedChapter: 0,
          status: 'paid',
          payChapter: index,
          payMethod: String(act.payMethod || '').trim() || undefined,
        });
      }
    }
  }

  for (const t of input.timelineAppend || []) {
    const line = String(t || '').trim();
    if (line) book.timeline.push(line);
  }

  if (input.detailedAppend?.length) {
    const existing = new Set(book.detailed.map((d) => d.index));
    for (const d of input.detailedAppend) {
      if (!existing.has(d.index)) book.detailed.push(d);
    }
    book.detailed.sort((a, b) => a.index - b.index);
  }

  if (String(input.volumeSummary || '').trim()) book.volumeSummary = String(input.volumeSummary).trim();
  book.updatedAt = Date.now();
  atomicWriteJson(path.join(bookDir(userId, bookId), 'book.json'), book);
  return book;
}

/**
 * 标记「已体检到当前章」:发起全书体检任务时调用(P1 每 N 章自动审查提醒)。
 * 只是提醒启发式的落点,不是状态一致性的一部分——体检任务失败可重跑,
 * 重跑会再次标记,不会造成书库状态错误。书不存在抛错(调用方 404)。
 */
export function markNovelReviewed(userId: string, bookId: string): NovelBook {
  const book = readBookJson(userId, bookId);
  if (!book) throw new Error(`书不存在: ${bookId}`);
  book.lastReviewedChapter = book.progress.chapterCount;
  book.updatedAt = Date.now();
  atomicWriteJson(path.join(bookDir(userId, bookId), 'book.json'), book);
  return book;
}

/** 大纲包合并输入(开书三段化第二步的入库载荷) */
export interface OutlineMergeInput {
  outline: string;
  detailed?: DetailedChapter[];
  ledgerSeeds?: Array<{ content: string; plantedChapter: number }>;
  timelineSeeds?: string[];
}

/**
 * 大纲包合并入库(开书三段化第二步):粗纲/细纲池/伏笔台账/时间线并入
 * 第一步建的书。只写规划层,不动正文与人物卡。合并语义:
 * - outline:整体替换(第二步是全书规划的权威产出);
 * - detailed:按章号去重并入(不覆盖第一步可能已有的条目);
 * - ledgerSeeds / timelineSeeds:追加(时间线并集去重)。
 * 书不存在抛错;大纲为空抛错(空规划没有合并意义)。
 */
export function mergeNovelOutline(userId: string, bookId: string, input: OutlineMergeInput): NovelBook {
  const book = readBookJson(userId, bookId);
  if (!book) throw new Error(`书不存在: ${bookId}`);
  const outline = String(input.outline || '').trim();
  if (!outline) throw new Error('大纲包没有粗纲内容,拒绝合并(不落半截状态)');

  book.outline = outline;

  if (input.detailed?.length) {
    // dedup-by-index:同章号的细纲以本次包为准(重跑修订要能覆盖旧条目——粗纲
    // 整体替换了,细纲留着旧版会跟新粗纲打架);新章号追加后按序排
    const byIndex = new Map(book.detailed.map((d) => [d.index, d]));
    for (const d of input.detailed) byIndex.set(d.index, d);
    book.detailed = [...byIndex.values()].sort((a, b) => a.index - b.index);
  }

  // 伏笔按内容去重:重跑大纲包会重发同一批种子,重复条目会污染续写上下文
  // 与体检回收率统计(同一条伏笔显示两次)
  const seenForeshadow = new Set(book.ledger.map((f) => f.content.trim()));
  for (const s of input.ledgerSeeds || []) {
    const content = String(s?.content || '').trim();
    if (!content || seenForeshadow.has(content)) continue;
    seenForeshadow.add(content);
    book.ledger.push({
      id: `fs_${Date.now().toString(36)}_${book.ledger.length}`,
      content,
      plantedChapter: Math.max(1, Math.floor(Number(s.plantedChapter)) || 1),
      status: 'planted',
    });
  }

  const seen = new Set(book.timeline.map((t) => t.trim()));
  for (const t of input.timelineSeeds || []) {
    const line = String(t || '').trim();
    if (line && !seen.has(line)) {
      book.timeline.push(line);
      seen.add(line);
    }
  }

  book.updatedAt = Date.now();
  atomicWriteJson(path.join(bookDir(userId, bookId), 'book.json'), book);
  return book;
}

/** 文风锚上限:一段可注入 prompt 的风格描述,2000 字足够(超长必是误粘贴正文) */
export const MAX_STYLE_CHARS = 2000;

/**
 * 更新一本书的文风锚(P2 文风学习的落库点;表单手改也走这里)。
 * 空样式/超长抛错——文风锚每次续写都注入,脏值会长期污染全书文风。
 */
export function updateNovelStyle(userId: string, bookId: string, style: string): NovelBook {
  const book = readBookJson(userId, bookId);
  if (!book) throw new Error(`书不存在: ${bookId}`);
  const next = String(style || '').trim();
  if (!next) throw new Error('文风锚为空,拒绝写入(会长期注入续写 prompt,不落脏值)');
  if (next.length > MAX_STYLE_CHARS) throw new Error(`文风锚超长(> ${MAX_STYLE_CHARS} 字),拒绝写入`);
  book.style = next;
  book.updatedAt = Date.now();
  atomicWriteJson(path.join(bookDir(userId, bookId), 'book.json'), book);
  return book;
}

/** 删除一本书(连目录;bookId 消毒后不存在则幂等成功) */
export function deleteNovelBook(userId: string, bookId: string): boolean {
  const dir = bookDir(userId, bookId);
  try {
    fs.rmSync(dir, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}
