/**
 * 网文小说包格式契约(docs/design/novel-workshop.md §4,归 novel 工坊包)
 *
 * 「格式即契约」同族(note-package / article-package):prompt 模板约定 Agent 按
 * 【字段头】输出,本模块把 markdown 解析回结构化;解析失败(返回 null)时调用方
 * 降级为普通 markdown 渲染。纯函数,无 React/node 运行时依赖,固定样例做契约测试。
 *
 * 三种包,互斥锚:
 * - 开书包(genesis):必含【设定集】+【粗纲】+ 至少一章正文;
 * - 续写包(continue):必含【书号】(nv_ 前缀)+【本章摘要】+ 章节正文;
 * - 文风锚包(style,P2 文风学习):必含【文风锚】;【书号】可选(绑书时回显,
 *   入库前仍按用户书库校验);不含正文段,与前两种互斥。
 * 【本章摘要】不命中文章包的【摘要】锚(其正则要求「摘要」顶格),双向互斥由测试锚定。
 *
 * 可信边界:包里的章节序号只做展示,入库序号永远由 novel-store 按 progress.nextChapter
 * 分配(模型数数不可信);书号入库前按当前用户书库校验(见 /api/novels 与入库卡片)。
 */
import type { NovelCharacter, DetailedChapter } from '@/lib/novel-context';
import { clampChapterWords } from './context';

// ---- 解析结果类型 ----

export interface NovelGenesisPackage {
  kind: 'genesis';
  title: string;
  premise: string;
  bible: string;
  characters: NovelCharacter[];
  outline: string;
  detailed: DetailedChapter[];
  ledgerSeeds: Array<{ content: string; plantedChapter: number }>;
  timelineSeeds: string[];
  chapters: Array<{ title: string; content: string; summary?: string }>;
  /** 作品简介(平台书页用;历史包读容忍,缺省不报错) */
  synopsis?: string;
}

/** 开书三段化 · 第一步设定包:书名/卖点/设定集/人物卡(无正文,锚=设定集+人物卡) */
export interface NovelGenesisBiblePackage {
  kind: 'genesis_bible';
  title: string;
  premise: string;
  bible: string;
  characters: NovelCharacter[];
  /** 回显的表单值(题材/文风锚/每章字数):卡片「继续:生成大纲」按钮串下一步用;
   *  模型漏回显时缺省,卡片走各自的兜底 */
  genre?: string;
  style?: string;
  chapterWords?: number;
  /** 作品简介(平台书页用;漏交付时缺省,卡片走兜底) */
  synopsis?: string;
}

/** 开书三段化 · 第二步大纲包:粗纲/细纲/伏笔/时间线(锚=粗纲+细纲,无正文) */
export interface NovelGenesisOutlinePackage {
  kind: 'genesis_outline';
  /** 目标书号(服务端渲染时注入 prompt 的 bookId 回显;入库前按用户书库校验) */
  bookId: string;
  outline: string;
  detailed: DetailedChapter[];
  ledgerSeeds: Array<{ content: string; plantedChapter: number }>;
  timelineSeeds: string[];
}

export interface NovelContinuePackage {
  kind: 'continue';
  /** 书号(nv_…;服务端渲染时注入、Agent 回显;入库时按用户书库校验) */
  bookId: string;
  /** 包里自称的章序号(仅展示;入库序号以状态库为准) */
  claimedIndex?: number;
  title: string;
  content: string;
  summary: string;
  characterUpdates: Array<{ name: string; currentState: string }>;
  ledgerActions: Array<
    | { action: 'plant'; content: string }
    | { action: 'pay'; keyword: string; payMethod?: string }
  >;
  timelineAppend: string[];
  detailedAppend: DetailedChapter[];
  volumeSummary?: string;
}

export interface NovelStylePackage {
  kind: 'style';
  /** 绑定书号(【书号】回显且格式合法才有;null = 未绑定,产出可用作开书文风锚) */
  bookId: string | null;
  /** 提炼出的文风锚(纯风格描述,不含情节) */
  style: string;
}

/** 序章包(开书三段化的可选旁支:写第 1 章前生成楔子/序章) */
export interface NovelProloguePackage {
  kind: 'prologue';
  /** 书号(nv_…;服务端渲染时注入、Agent 回显;入库时按用户书库校验) */
  bookId: string;
  title: string;
  content: string;
  /** 序章摘要(续写上下文注入用,必填——缺摘要拒绝入库) */
  summary: string;
}

export type NovelPackage =
  | NovelGenesisPackage
  | NovelContinuePackage
  | NovelStylePackage
  | NovelProloguePackage
  | NovelGenesisBiblePackage
  | NovelGenesisOutlinePackage;

// ---- 字段头 ----

const BOOK_ID_RE = /^nv_[a-z0-9]+_[a-f0-9]{6}$/;
/** 章节正文最短长度(去空白):低于此按解析失败降级,防把寒暄当正文入库 */
const MIN_CHAPTER_CHARS = 200;
/** 文风锚最短长度(去空白):一句话不算锚,防把寒暄/评论当文风写回全书 */
const MIN_STYLE_CHARS = 30;

type HeaderKey =
  | 'bookId'
  | 'title'
  | 'premise'
  | 'bible'
  | 'characters'
  | 'outline'
  | 'detailed'
  | 'ledger'
  | 'timeline'
  | 'summary'
  | 'charUpdates'
  | 'ledgerActions'
  | 'nextDetailed'
  | 'volumeSummary'
  | 'styleAnchor'
  | 'chapter'
  | 'genre'
  | 'chapterWords'
  | 'synopsis'
  | 'prologue'
  | 'prologueSummary';

/** 字段头正则(允许行尾追加说明,如【第3章 · 3000字】) */
const HEADERS: Array<[HeaderKey, RegExp]> = [
  ['bookId', /^\s*【\s*书号\s*[^】]*】\s*$/],
  ['title', /^\s*【\s*书名\s*[^】]*】\s*$/],
  ['premise', /^\s*【\s*(?:卖点|一句话卖点)\s*[^】]*】\s*$/],
  ['bible', /^\s*【\s*设定集\s*[^】]*】\s*$/],
  ['characters', /^\s*【\s*(?:人物卡|人物卡集)\s*[^】]*】\s*$/],
  ['outline', /^\s*【\s*(?:粗纲|大纲)\s*[^】]*】\s*$/],
  ['detailed', /^\s*【\s*(?:细纲|章细纲)\s*[^】]*】\s*$/],
  // 伏笔动作必须排在伏笔之前,且伏笔锚用负向断言拒吃「动作」——【伏笔】[^】]* 尾缀规则
  // 会把【伏笔动作】整行吞掉(双保险,不依赖遍历顺序)
  ['ledgerActions', /^\s*【\s*伏笔动作\s*[^】]*】\s*$/],
  ['ledger', /^\s*【\s*伏笔(?!\s*动作)[^】]*】\s*$/],
  ['timeline', /^\s*【\s*时间线\s*[^】]*】\s*$/],
  ['summary', /^\s*【\s*本章摘要\s*[^】]*】\s*$/],
  ['charUpdates', /^\s*【\s*人物状态更新\s*[^】]*】\s*$/],
  ['nextDetailed', /^\s*【\s*下章细纲\s*[^】]*】\s*$/],
  ['volumeSummary', /^\s*【\s*总纲更新\s*[^】]*】\s*$/],
  ['styleAnchor', /^\s*【\s*文风锚\s*[^】]*】\s*$/],
  // 三段化回显段(设定包:题材/文风锚/每章字数——表单值经模型回显,卡片据此串下一步)
  ['genre', /^\s*【\s*题材\s*[^】]*】\s*$/],
  ['chapterWords', /^\s*【\s*每章字数\s*[^】]*】\s*$/],
  // 只匹配全称「作品简介」——不给其他包的【…简介…】留误吞口子
  ['synopsis', /^\s*【\s*作品简介\s*[^】]*】\s*$/],
  // 序章摘要:与续写包【本章摘要】不同名,双向互斥(continue 要求本章摘要)
  ['prologueSummary', /^\s*【\s*序章摘要\s*[^】]*】\s*$/],
];

/** 动态章头:【第N章】(N 支持阿拉伯数字;章头允许追加标题,如【第3章 夜袭】) */
const CHAPTER_HEADER = /^\s*【\s*第\s*([0-9]+)\s*章\s*([^】]*)】\s*$/;

/** 动态序章头:【序章|楔子|前言】(允许追加标题,如【楔子 · 雨夜】——别名词本身
 *  是标题的一部分,捕获组含别名整串)。负向断言拒吃「摘要」——【序章摘要】是独立
 *  段头,尾缀规则会把它整行吞成序章正文头(与【伏笔】/【伏笔动作】的贪婪尾缀坑
 *  同款,双保险不依赖 segmentize 遍历顺序) */
const PROLOGUE_HEADER = /^\s*【\s*((?:序章(?!摘要)|楔子|前言)[^】]*)】\s*$/;

function matchHeader(line: string): HeaderKey | null {
  for (const [key, re] of HEADERS) {
    if (re.test(line)) return key;
  }
  return null;
}

/** 行扫描:把全文切成 [段键, 行数组] 序列;章段键为 {chapter, claimedIndex, headerRest};序章段 key='prologue' 带 headerRest */
interface Segment {
  key: HeaderKey;
  /** 仅 chapter/prologue 段:自称序号(章)与段头余文(可能是标题) */
  claimedIndex?: number;
  headerRest?: string;
  lines: string[];
}

function segmentize(text: string): Segment[] {
  const segs: Segment[] = [];
  let cur: Segment | null = null;
  for (const line of String(text || '').split('\n')) {
    const ch = line.match(CHAPTER_HEADER);
    if (ch) {
      cur = { key: 'chapter', claimedIndex: Number(ch[1]), headerRest: (ch[2] || '').trim(), lines: [] };
      segs.push(cur);
      continue;
    }
    const pl = line.match(PROLOGUE_HEADER);
    if (pl) {
      cur = { key: 'prologue', headerRest: (pl[1] || '').trim(), lines: [] };
      segs.push(cur);
      continue;
    }
    const h = matchHeader(line);
    if (h) {
      cur = { key: h, lines: [] };
      segs.push(cur);
      continue;
    }
    if (cur) cur.lines.push(line);
    // 首个字段头之前的行(寒暄)丢弃:契约要求零寒暄,残余不值得保留
  }
  return segs;
}

const joinLines = (lines: string[] | undefined): string => (lines || []).join('\n').trim();
const stripBullet = (s: string): string => s.replace(/^\s*[-*·]\s*/, '').trim();

/** 首行非空文本(书名/章标题/书号取段内第一行) */
function firstLine(lines: string[] | undefined): string {
  for (const l of lines || []) {
    const t = l.trim();
    if (t) return t;
  }
  return '';
}

/** 书名规整:去《》与「」包裹 */
function normalizeTitle(raw: string): string {
  return raw.replace(/^《(.+)》$/, '$1').replace(/^「(.+)」$/, '$1').trim();
}

// ---- 人物卡 / 细纲子解析(genesis 与续写共用) ----

const CHAR_KEY_MAP: Array<[RegExp, keyof NovelCharacter]> = [
  [/^(?:定位|角色定位|身份)$/, 'role'],
  [/^(?:外貌|外形|形象)$/, 'appearance'],
  [/^(?:性格|个性)$/, 'personality'],
  [/^(?:动机|目标|欲望)$/, 'motivation'],
  [/^(?:口癖|语言风格|说话风格|台词风格)$/, 'speech'],
  [/^(?:关系|人物关系|关系网)$/, 'relations'],
  [/^(?:弧光|成长弧光|人物弧光|成长线)$/, 'arc'],
  [/^(?:当前状态|现状|状态)$/, 'currentState'],
];

/** 人物卡段:## 姓名 起卡,- 键:值 行填充 */
export function parseCharacters(block: string): NovelCharacter[] {
  const out: NovelCharacter[] = [];
  let cur: NovelCharacter | null = null;
  for (const line of block.split('\n')) {
    const name = line.match(/^\s*#{2,3}\s*(.+?)\s*$/);
    if (name) {
      const n = normalizeTitle(name[1]).replace(/^\*\*(.+)\*\*$/, '$1');
      if (n) {
        cur = { name: n };
        out.push(cur);
      }
      continue;
    }
    if (!cur) continue;
    const kv = line.match(/^\s*[-*·]?\s*\**([^:：*]{1,12})\**\s*[:：]\s*(.+)$/);
    if (!kv) continue;
    const key = kv[1].trim();
    const val = kv[2].trim();
    if (!key || !val) continue;
    for (const [re, field] of CHAR_KEY_MAP) {
      if (re.test(key)) {
        (cur as unknown as Record<string, unknown>)[field] = val;
        break;
      }
    }
  }
  return out.filter((c) => c.name);
}

const DETAIL_KEY_MAP: Array<[RegExp, 'title' | 'hook' | 'events' | 'emotion' | 'foreshadow' | 'targetWords']> = [
  [/^(?:钩子|开篇钩子|开场钩子)$/, 'hook'],
  [/^(?:事件|本章事件|剧情|情节)$/, 'events'],
  [/^(?:情绪|情绪点|爽点|看点)$/, 'emotion'],
  [/^(?:伏笔|伏笔动作)$/, 'foreshadow'],
  [/^(?:字数|目标字数)$/, 'targetWords'],
];

/** 细纲段:### 第N章 标题? 起条,- 键:值 行填充;无序号时按出现顺序编号 */
export function parseDetailed(block: string): DetailedChapter[] {
  const out: DetailedChapter[] = [];
  let cur: DetailedChapter | null = null;
  let auto = 0;
  for (const line of block.split('\n')) {
    const head = line.match(/^\s*#{2,4}\s*第\s*([0-9]+)\s*章\s*(.*)$/);
    if (head) {
      auto = Number(head[1]);
      cur = { index: auto, events: '' };
      const t = normalizeTitle((head[2] || '').trim());
      if (t) cur.title = t;
      out.push(cur);
      continue;
    }
    // 无章头的裸条目(- 事件:…)挂到上一条;没有上一条则忽略
    if (!cur) continue;
    const kv = line.match(/^\s*[-*·]?\s*\**([^:：*]{1,12})\**\s*[:：]\s*(.+)$/);
    if (!kv) continue;
    const key = kv[1].trim();
    const val = kv[2].trim();
    if (!key || !val) continue;
    for (const [re, field] of DETAIL_KEY_MAP) {
      if (re.test(key)) {
        if (field === 'targetWords') {
          const n = parseInt(val.replace(/[^\d]/g, ''), 10);
          if (Number.isFinite(n) && n > 0) cur.targetWords = n;
        } else {
          (cur as unknown as Record<string, unknown>)[field] = val;
        }
        break;
      }
    }
  }
  return out.filter((d) => d.events || d.hook);
}

/** 伏笔行:- [埋设] 内容 (@N)? / - [回收] 关键词 (@方式:…)? */
function parseLedgerLines(block: string, mode: 'genesis' | 'actions'): {
  seeds: Array<{ content: string; plantedChapter: number }>;
  actions: NovelContinuePackage['ledgerActions'];
} {
  const seeds: Array<{ content: string; plantedChapter: number }> = [];
  const actions: NovelContinuePackage['ledgerActions'] = [];
  for (const raw of block.split('\n')) {
    const line = stripBullet(raw);
    if (!line) continue;
    const m = line.match(/^\[(埋设|回收)\]\s*(.+)$/);
    if (!m) continue;
    let body = m[2].trim();
    if (m[1] === '埋设') {
      let plantedChapter = 1;
      const at = body.match(/[@(（]\s*(?:第)?\s*([0-9]+)\s*章\s*[)）]?\s*$/);
      if (at) {
        plantedChapter = Number(at[1]);
        body = body.slice(0, at.index).trim();
      }
      if (!body) continue;
      if (mode === 'genesis') seeds.push({ content: body, plantedChapter });
      else actions.push({ action: 'plant', content: body });
    } else {
      // 回收:关键词 @方式:xxx / (方式:xxx) / 方式:xxx 尾缀均可
      let keyword = body;
      let payMethod: string | undefined;
      const mm = body.match(/[@(（]?\s*方式\s*[:：]\s*(.+?)\s*[)）]?$/);
      if (mm) {
        payMethod = mm[1].trim();
        keyword = body.slice(0, mm.index).replace(/[@(（\s]+$/, '').trim();
      }
      if (!keyword) continue;
      actions.push({ action: 'pay', keyword, ...(payMethod ? { payMethod } : {}) });
    }
  }
  return { seeds, actions };
}

/** 人物状态更新行:- 姓名: 新状态 */
function parseCharUpdates(block: string): Array<{ name: string; currentState: string }> {
  const out: Array<{ name: string; currentState: string }> = [];
  for (const raw of block.split('\n')) {
    const line = stripBullet(raw);
    if (!line) continue;
    const m = line.match(/^([^:：]{1,20})\s*[:：]\s*(.+)$/);
    if (!m) continue;
    const name = normalizeTitle(m[1].trim());
    const state = m[2].trim();
    if (name && state) out.push({ name, currentState: state });
  }
  return out;
}

/** 时间线段:去 bullet 的非空行 */
function parseTimelineLines(block: string): string[] {
  return block
    .split('\n')
    .map((l) => stripBullet(l))
    .filter(Boolean);
}

/** 章段 → {title, content, summary}:标题取章头余文或正文首行,摘要取段内摘要子段(summaryKey:章=【本章摘要】/序章=【序章摘要】,头不同天然互斥) */
function buildChapter(seg: Segment, nextSegs: Segment[], summaryKey: HeaderKey = 'summary'): { title: string; content: string; summary?: string } | null {
  // 章段自身的 lines 到下一个任意字段头为止(segmentize 已切好);
  // 摘要是独立段,紧跟在章段后面才归属本章
  const summarySeg = nextSegs[0] && nextSegs[0].key === summaryKey ? nextSegs[0] : null;
  const bodyLines = [...seg.lines];
  let title = seg.headerRest ? normalizeTitle(seg.headerRest) : '';
  // 无章头标题:正文首个非空行若是短行(<30字且无句读结尾)按标题处理
  if (!title) {
    const idx = bodyLines.findIndex((l) => l.trim());
    if (idx >= 0) {
      const cand = bodyLines[idx].trim();
      if (cand.length > 0 && cand.length <= 30 && !/[。!?！？]$/.test(cand)) {
        title = normalizeTitle(cand);
        bodyLines.splice(idx, 1);
      }
    }
  }
  const content = joinLines(bodyLines);
  if (content.replace(/\s/g, '').length < MIN_CHAPTER_CHARS) return null;
  const summary = summarySeg ? joinLines(summarySeg.lines) : '';
  return { title, content, ...(summary ? { summary } : {}) };
}

// ---- 主解析 ----

/**
 * 解析小说包:按锚依次判定——
 * 1) 开书包(genesis,旧单次全量):【设定集】+【粗纲】+ 至少一章正文;
 * 2) 设定包(genesis_bible,三段化第一步):【设定集】+【人物卡】,无章正文;
 * 3) 大纲包(genesis_outline,三段化第二步):【粗纲】+【细纲】,无设定集无章正文;
 * 4) 序章包(prologue):【书号】(nv_ 前缀)+【序章摘要】+ 序章正文(【序章|楔子|前言】头);
 * 5) 续写包(continue):【书号】(nv_ 前缀)+【本章摘要】+ 章节正文;
 * 6) 文风锚包(style):【文风锚】。
 * 互斥性:设定包 vs 开书包靠「有无章正文段」区分;大纲包无【设定集】不与
 * 前两者相撞;序章包与续写包靠【序章摘要】≠【本章摘要】天然互斥。
 * 都不满足返回 null(调用方降级 markdown 渲染)。
 */
export function parseNovelPackage(text: string): NovelPackage | null {
  if (!text || typeof text !== 'string') return null;
  const segs = segmentize(text);
  if (segs.length === 0) return null;
  const byKey = (k: HeaderKey): Segment | undefined => segs.find((s) => s.key === k);

  const bible = joinLines(byKey('bible')?.lines);
  const outline = joinLines(byKey('outline')?.lines);
  const bookIdRaw = normalizeTitle(firstLine(byKey('bookId')?.lines));
  const hasSummarySeg = Boolean(byKey('summary'));
  const hasChapterSeg = segs.some((s) => s.key === 'chapter');

  // ---- 开书包(旧单次全量) ----
  if (bible && outline && hasChapterSeg) {
    const chapters: Array<{ title: string; content: string; summary?: string }> = [];
    segs.forEach((seg, i) => {
      if (seg.key !== 'chapter') return;
      const rest = segs.slice(i + 1);
      const ch = buildChapter(seg, rest);
      if (ch) chapters.push(ch);
    });
    if (chapters.length === 0) return null;
    const title = normalizeTitle(firstLine(byKey('title')?.lines)) || '无题';
    const { seeds } = parseLedgerLines(joinLines(byKey('ledger')?.lines), 'genesis');
    const genesisSynopsis = joinLines(byKey('synopsis')?.lines);
    return {
      kind: 'genesis',
      title,
      premise: joinLines(byKey('premise')?.lines),
      bible,
      characters: parseCharacters(joinLines(byKey('characters')?.lines)),
      outline,
      detailed: parseDetailed(joinLines(byKey('detailed')?.lines)),
      ledgerSeeds: seeds,
      timelineSeeds: parseTimelineLines(joinLines(byKey('timeline')?.lines)),
      chapters,
      ...(genesisSynopsis ? { synopsis: genesisSynopsis } : {}),
    };
  }

  // ---- 设定包(三段化第一步):有设定集+人物卡,无章正文 ----
  if (bible && !hasChapterSeg && byKey('characters')) {
    const title = normalizeTitle(firstLine(byKey('title')?.lines)) || '无题';
    // 表单值回显段(题材/文风锚/每章字数):模型漏回显时为空,卡片给缺省
    const styleEcho = joinLines(byKey('styleAnchor')?.lines);
    const wordsEcho = firstLine(byKey('chapterWords')?.lines).replace(/[^0-9]/g, '');
    const synopsis = joinLines(byKey('synopsis')?.lines);
    return {
      kind: 'genesis_bible',
      title,
      premise: joinLines(byKey('premise')?.lines),
      bible,
      characters: parseCharacters(joinLines(byKey('characters')?.lines)),
      genre: joinLines(byKey('genre')?.lines) || undefined,
      style: styleEcho || undefined,
      chapterWords: wordsEcho ? clampChapterWords(wordsEcho) : undefined,
      synopsis: synopsis || undefined,
    };
  }

  // ---- 大纲包(三段化第二步):粗纲+细纲,无设定集无章正文 ----
  if (outline && byKey('detailed') && !bible && !hasChapterSeg) {
    const { seeds } = parseLedgerLines(joinLines(byKey('ledger')?.lines), 'genesis');
    return {
      kind: 'genesis_outline',
      bookId: BOOK_ID_RE.test(bookIdRaw) ? bookIdRaw : '',
      outline,
      detailed: parseDetailed(joinLines(byKey('detailed')?.lines)),
      ledgerSeeds: seeds,
      timelineSeeds: parseTimelineLines(joinLines(byKey('timeline')?.lines)),
    };
  }

  // ---- 序章包:置于续写包之前(【序章摘要】≠【本章摘要】互斥;序章包不含任何
  // 章段——混入【第N章】+【本章摘要】的杂包按 continue 语义走,不让序章分支抢走
  // 日更主路径的章正文) ----
  if (BOOK_ID_RE.test(bookIdRaw) && byKey('prologueSummary') && !hasChapterSeg) {
    const prologueSeg = segs.find((s) => s.key === 'prologue');
    if (prologueSeg) {
      const rest = segs.slice(segs.indexOf(prologueSeg) + 1);
      const pl = buildChapter(prologueSeg, rest, 'prologueSummary');
      const summary = joinLines(byKey('prologueSummary')?.lines);
      if (pl && summary) {
        return {
          kind: 'prologue',
          bookId: bookIdRaw,
          title: pl.title || '序章',
          content: pl.content,
          summary,
        };
      }
    }
    // 有书号+【序章摘要】但正文不达标/缺段:落到后面各分支判别,兜底 null
  }

  // ---- 续写包 ----
  if (BOOK_ID_RE.test(bookIdRaw) && hasSummarySeg) {
    const chapterSeg = segs.find((s) => s.key === 'chapter');
    if (!chapterSeg) return null;
    const rest = segs.slice(segs.indexOf(chapterSeg) + 1);
    const ch = buildChapter(chapterSeg, rest);
    if (!ch) return null;
    const summary = joinLines(byKey('summary')?.lines);
    if (!summary) return null;
    const { actions } = parseLedgerLines(joinLines(byKey('ledgerActions')?.lines), 'actions');
    const volumeSummary = joinLines(byKey('volumeSummary')?.lines);
    return {
      kind: 'continue',
      bookId: bookIdRaw,
      ...(chapterSeg.claimedIndex ? { claimedIndex: chapterSeg.claimedIndex } : {}),
      title: ch.title,
      content: ch.content,
      summary,
      characterUpdates: parseCharUpdates(joinLines(byKey('charUpdates')?.lines)),
      ledgerActions: actions,
      timelineAppend: parseTimelineLines(joinLines(byKey('timeline')?.lines)),
      detailedAppend: parseDetailed(joinLines(byKey('nextDetailed')?.lines)),
      ...(volumeSummary ? { volumeSummary } : {}),
    };
  }

  // ---- 文风锚包(P2 文风学习):无正文段,靠【文风锚】锚与前几种互斥。
  // 设定包(三段化第一步)也回显【文风锚】——有【设定集】或【人物卡】的输出
  // 绝不是文风锚包,拒吞(宁可降级 null,不渲染成文风卡误导写回)
  const styleSeg = byKey('styleAnchor');
  if (styleSeg && !bible && !byKey('characters')) {
    const styleText = joinLines(styleSeg.lines);
    if (styleText.replace(/\s/g, '').length < MIN_STYLE_CHARS) return null;
    return {
      kind: 'style',
      bookId: BOOK_ID_RE.test(bookIdRaw) ? bookIdRaw : null,
      style: styleText,
    };
  }

  return null;
}

// ---- 逐字段交付(设定包/大纲包多步小交付,见计划「novel 工坊逐字段交付」) ----
//
// 与整包解析的关系:整包 parseNovelPackage(一次吃完整文本)保持原样服务
// fallback 与历史任务;这里新增两个纯函数——
// - validateDeliverField:交付工具端的单字段校验(结构从严、篇幅从宽,防重试死循环);
// - assembleNovelDelivery:把已交付字段直接组装成 NovelPackage(不经过 segmentize——
//   半包的互斥锚判定不成立,且字段 content 里杂散的【…】行会被误切段)。
// 两者共用子解析器(parseCharacters/parseDetailed/parseLedgerLines/parseTimelineLines),
// 与整包解析同一套结构口径,单一事实源。

/** content 首行误带字段头(【书名】等整行)时剥掉:交付契约要求 content 不含字段头 */
function stripLeadingHeader(content: string): string {
  const lines = String(content || '').split('\n');
  if (lines.length > 0) {
    const first = lines[0];
    if (matchHeader(first) || CHAPTER_HEADER.test(first) || /^\s*【[^】]*】\s*$/.test(first)) {
      lines.shift();
    }
  }
  return lines.join('\n').trim();
}

/** 文本首个非空行(书名/书号/每章字数取首行) */
function firstLineOf(text: string): string {
  return firstLine(String(text || '').split('\n'));
}

const dense = (s: string): number => String(s || '').replace(/\s/g, '').length;
const nonEmptyLines = (s: string): string[] =>
  String(s || '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

/** 人物卡张数区间(与设定包契约"主要人物 4-8 人"对齐,上限放宽到 10 防误杀) */
const CHAR_CARDS_MIN = 4;
const CHAR_CARDS_MAX = 10;

/**
 * 单字段交付校验:返回错误清单(空数组=通过)。错误文案直接回给模型重试,
 * 必须可执行(说清差在哪、怎么改)。校验底线:结构从严(锚/格式/张数),
 * 篇幅从宽(远低于模板标称值才打回),防"重试死循环"烧步数。
 */
export function validateDeliverField(contractId: string, field: string, rawContent: string): string[] {
  const content = stripLeadingHeader(rawContent);
  if (contractId === 'novel_bible') {
    switch (field) {
      case '题材':
        return content ? [] : ['题材不能为空:回显任务给定的题材(仅一行)'];
      case '文风锚':
        return dense(content) >= 8
          ? []
          : ['文风锚过短:原样回显任务给定的文风锚全文(≥8字,不增删改)'];
      case '每章字数': {
        const digits = firstLineOf(content).replace(/[^0-9]/g, '');
        const n = Number(digits);
        return digits && Number.isFinite(n) && n >= 1000 && n <= 6000
          ? []
          : ['每章字数须是 1000-6000 的数字(回显任务给定的每章字数)'];
      }
      case '书名': {
        if (!content) return ['书名不能为空'];
        if (nonEmptyLines(content).length > 1) return ['书名仅一行,不要附加说明或候选清单'];
        const t = normalizeTitle(firstLineOf(content));
        if (!t) return ['书名不能为空(不带书名号)'];
        return t.length <= 30 ? [] : ['书名过长(≤30字),12 字以内优先'];
      }
      case '卖点':
        if (!content) return ['卖点不能为空'];
        return dense(content) >= 10 ? [] : ['卖点过短:一句话说清卖什么、给谁看、爽在哪'];
      case '设定集':
        return dense(content) >= 100
          ? []
          : ['设定集过短(≥100字):世界规则/力量体系(层级与上限)/势力与地理/关键道具术语'];
      case '作品简介': {
        const len = dense(content);
        if (len < 50) return ['作品简介过短(建议 150-300 字,最少 50 字):平台书页口吻,抛核心钩子,不剧透设定期之后的剧情'];
        if (len > 500) return ['作品简介过长(≤500 字,建议 150-300):删掉复述设定的部分,只留钩子与悬念'];
        return [];
      }
      case '人物卡': {
        const cards = parseCharacters(content);
        if (cards.length < CHAR_CARDS_MIN) {
          return [`人物卡不足 ${CHAR_CARDS_MIN} 张(现 ${cards.length}):以「## 姓名」起卡、"- 键:值"逐行填字段`];
        }
        return cards.length <= CHAR_CARDS_MAX ? [] : [`人物卡至多 ${CHAR_CARDS_MAX} 张(现 ${cards.length}),只留主要人物`];
      }
      default:
        return [`novel_bible 契约无字段「${field}」`];
    }
  }
  if (contractId === 'novel_outline') {
    switch (field) {
      case '书号': {
        const id = normalizeTitle(firstLineOf(content));
        return BOOK_ID_RE.test(id) ? [] : ['书号格式不对:原样回显任务给定的目标书号(nv_ 开头,别改)'];
      }
      case '粗纲':
        return dense(content) >= 300
          ? []
          : ['粗纲过短(≥300字):起承转合主线 + 分卷规划(每卷目标/主要冲突/卷末钩子)'];
      case '细纲': {
        const items = parseDetailed(content);
        return items.length >= 5
          ? []
          : [`细纲不足 5 章(现 ${items.length}):每章「### 第N章 标题」起条,含 - 钩子:/- 事件: 行`];
      }
      case '伏笔': {
        if (content === '无') return [];
        const { seeds } = parseLedgerLines(content, 'genesis');
        return seeds.length >= 1
          ? []
          : ['伏笔台账格式:每行「- [埋设] 伏笔内容 @第N章」;确实没有伏笔则只输出一个字「无」'];
      }
      case '时间线':
        return parseTimelineLines(content).length >= 1
          ? []
          : ['时间线至少一行:「- 第N章|故事内时间|关键事件」'];
      default:
        return [`novel_outline 契约无字段「${field}」`];
    }
  }
  return [`未知交付契约「${contractId}」`];
}

/**
 * 交付的【书号】字段 content → 归一化 bookId(服务端权威校验/入库对账共用口径):
 * 剥字段头 → 取首行 → normalizeTitle。格式合法性由调用方用 BOOK_ID_RE 复核。
 */
export function extractDeliverBookId(rawContent: string): string {
  return normalizeTitle(firstLineOf(stripLeadingHeader(rawContent)));
}

/**
 * 已交付字段 → NovelPackage(渐进卡数据源)。kind 由契约 id 映射(不靠解析锚
 * 判定,半包不会误路由);缺的字段给空占位,卡片按 progress 渲染骨架行,
 * required 齐了才激活「存入书库」。未知契约返回 null。
 */
export function assembleNovelDelivery(
  contractId: string,
  fields: Record<string, string>
): NovelGenesisBiblePackage | NovelGenesisOutlinePackage | null {
  const get = (k: string): string => stripLeadingHeader(fields?.[k] ?? '');
  if (contractId === 'novel_bible') {
    const words = firstLineOf(get('每章字数')).replace(/[^0-9]/g, '');
    const genre = get('题材');
    const style = get('文风锚');
    const synopsis = get('作品简介');
    return {
      kind: 'genesis_bible',
      title: normalizeTitle(firstLineOf(get('书名'))) || '无题',
      premise: get('卖点'),
      bible: get('设定集'),
      characters: parseCharacters(get('人物卡')),
      ...(genre ? { genre } : {}),
      ...(style ? { style } : {}),
      ...(words ? { chapterWords: clampChapterWords(words) } : {}),
      ...(synopsis ? { synopsis } : {}),
    };
  }
  if (contractId === 'novel_outline') {
    const bookIdRaw = normalizeTitle(firstLineOf(get('书号')));
    const ledgerRaw = get('伏笔');
    const { seeds } = parseLedgerLines(ledgerRaw === '无' ? '' : ledgerRaw, 'genesis');
    return {
      kind: 'genesis_outline',
      bookId: BOOK_ID_RE.test(bookIdRaw) ? bookIdRaw : '',
      outline: get('粗纲'),
      detailed: parseDetailed(get('细纲')),
      ledgerSeeds: seeds,
      timelineSeeds: parseTimelineLines(get('时间线')),
    };
  }
  return null;
}
