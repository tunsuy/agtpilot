/**
 * novel-store 状态库测试(docs/design/novel-workshop.md §3 + §9)
 *
 * USER_DATA_DIR 指临时目录(artifact-files.test.ts 同款约定),用完即删。
 * 锁五件事:开书落盘与进度指针;续章反思写回五连(摘要/人物按名合并/台账/
 * 时间线/细纲池+总纲);信任边界(序号永远服务端分配、缺摘要拒绝入库、
 * 路径消毒拒穿越);恒定上下文装配(主角恒入、近3章摘要、只注未回收伏笔);
 * 审查上下文(台账全量含已回收,回收率可见)。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  createNovelBook,
  getNovelBook,
  getChapterContent,
  listNovelBooks,
  appendChapter,
  deleteNovelBook,
  countWords,
  markNovelReviewed,
  updateNovelStyle,
  MAX_STYLE_CHARS,
  isReviewDue,
  REVIEW_EVERY_N,
  assembleChapterContext,
  assembleReviewContext,
  type NovelBook,
} from '../novel-store';

let dataDir: string;
let savedEnv: string | undefined;

beforeEach(async () => {
  dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'novel-store-test-'));
  savedEnv = process.env.USER_DATA_DIR;
  process.env.USER_DATA_DIR = dataDir;
});

afterEach(async () => {
  if (savedEnv === undefined) delete process.env.USER_DATA_DIR;
  else process.env.USER_DATA_DIR = savedEnv;
  await fsp.rm(dataDir, { recursive: true, force: true });
});

const LONG_BODY = '暴雨夜,林凡攥着手机在积水里狂奔,身后的差评像追命的鼓点。'.repeat(8);

function seedBook(userId = 'u1'): NovelBook {
  return createNovelBook(userId, {
    title: '铁拳少年',
    genre: '都市',
    premise: '外卖骑手捡到预知差评的手机',
    style: '爽文快节奏',
    bible: '力量体系:青铜→白银→黄金,严格逐级不可跳级。',
    characters: [
      { name: '林凡', role: '主角', personality: '隐忍', currentState: '右手骨折' },
      { name: '苏晚', role: '女主', currentState: '卧底教团' },
      { name: '路人甲', role: '配角' },
    ],
    outline: '第一卷·崛起(1-30章)。',
    detailed: [
      { index: 2, title: '夜袭', events: '林凡夜探仓库', hook: '仓库异响', targetWords: 3000 },
      { index: 3, events: '对决' },
    ],
    ledgerSeeds: [
      { content: '手机屏幕裂纹的来历', plantedChapter: 1 },
      { content: '苏晚父亲失踪与教团有关', plantedChapter: 1 },
    ],
    timelineSeeds: ['第1章|周五雨夜|林凡捡到手机'],
    chapters: [{ title: '雨夜差评', content: LONG_BODY, summary: '林凡捡到预知手机,躲开第一单差评。' }],
    volumeSummary: '小人物崛起。',
  });
}

describe('createNovelBook · 开书落盘', () => {
  it('书号格式合规,book.json 与章节文件都落在用户目录下', () => {
    const book = seedBook();
    expect(book.bookId).toMatch(/^nv_[a-z0-9]+_[a-f0-9]{6}$/);
    expect(getNovelBook('u1', book.bookId)?.title).toBe('铁拳少年');
    expect(getChapterContent('u1', book.bookId, 1)).toBe(LONG_BODY);
    expect(getChapterContent('u1', book.bookId, 2)).toBeNull();
  });

  it('章节序号从 1 起由服务端分配;进度指针 = 章数+1;字数按去空白口径', () => {
    const book = seedBook();
    expect(book.chapters.map((c) => c.index)).toEqual([1]);
    expect(book.chapters[0].wordCount).toBe(countWords(LONG_BODY));
    expect(countWords(' 你好 世界 ')).toBe(4);
    expect(book.progress).toEqual({
      chapterCount: 1,
      wordCount: countWords(LONG_BODY),
      nextChapter: 2,
    });
    expect(book.summaries[0]).toContain('预知手机');
  });

  it('用户隔离:别的用户读不到这本书', () => {
    const book = seedBook('u1');
    expect(getNovelBook('u2', book.bookId)).toBeNull();
    expect(listNovelBooks('u2')).toEqual([]);
  });
});

describe('listNovelBooks · 书库列表', () => {
  it('按更新时间倒序;损坏目录静默跳过', () => {
    const a = seedBook('u1');
    const b = createNovelBook('u1', { title: '第二本', chapters: [{ title: 't', content: LONG_BODY, summary: 's' }] });
    // 同毫秒建书 updatedAt 会撞(排序平局),显式把 b 拨晚 1s,确定性验证倒序语义
    const bJsonPath = path.join(dataDir, 'novels', 'u1', b.bookId, 'book.json');
    const bJson = JSON.parse(fs.readFileSync(bJsonPath, 'utf8'));
    bJson.updatedAt = a.updatedAt + 1000;
    fs.writeFileSync(bJsonPath, JSON.stringify(bJson), 'utf8');
    const list = listNovelBooks('u1');
    expect(list.map((s) => s.bookId)).toEqual([b.bookId, a.bookId]);
    expect(list[1].openForeshadows).toBe(2);
    // 损坏目录:写一个坏 book.json,列表不炸、只少一本
    const badDir = path.join(dataDir, 'novels', 'u1', 'nv_bad_000000');
    fs.mkdirSync(badDir, { recursive: true });
    fs.writeFileSync(path.join(badDir, 'book.json'), '{ 坏 json', 'utf8');
    expect(listNovelBooks('u1').map((s) => s.bookId)).toEqual([b.bookId, a.bookId]);
  });
});

describe('appendChapter · 续章反思写回五连', () => {
  it('序号永远 = progress.nextChapter(调用方不可指定),正文落独立章文件', () => {
    const book = seedBook();
    const next = appendChapter('u1', book.bookId, {
      title: '夜袭',
      content: LONG_BODY,
      summary: '林凡夜探仓库,发现教团徽记。',
    });
    expect(next.chapters.at(-1)!.index).toBe(2);
    expect(next.progress.nextChapter).toBe(3);
    expect(getChapterContent('u1', book.bookId, 2)).toBe(LONG_BODY);
    expect(next.summaries[1]).toContain('教团徽记');
  });

  it('人物状态按名合并;新名字追加为只有状态的卡(提示人工补全)', () => {
    const book = seedBook();
    const next = appendChapter('u1', book.bookId, {
      title: 't',
      content: LONG_BODY,
      summary: 's',
      characterUpdates: [
        { name: '林凡', currentState: '右手痊愈,晋白银' },
        { name: '王五', currentState: '身份暴露' },
      ],
    });
    expect(next.characters.find((c) => c.name === '林凡')!.currentState).toBe('右手痊愈,晋白银');
    expect(next.characters.find((c) => c.name === '林凡')!.personality).toBe('隐忍'); // 合并不抹旧字段
    expect(next.characters.find((c) => c.name === '王五')).toEqual({ name: '王五', currentState: '身份暴露' });
  });

  it('台账:埋设追加在当前章;回收按关键词命中最早未回收条目', () => {
    const book = seedBook();
    const next = appendChapter('u1', book.bookId, {
      title: 't',
      content: LONG_BODY,
      summary: 's',
      ledgerActions: [
        { action: 'plant', content: '仓库背后的老板' },
        { action: 'pay', keyword: '屏幕裂纹', payMethod: '裂纹中浮现教团徽记' },
      ],
    });
    const planted = next.ledger.find((f) => f.content === '仓库背后的老板')!;
    expect(planted).toMatchObject({ plantedChapter: 2, status: 'planted' });
    const paid = next.ledger.find((f) => f.content === '手机屏幕裂纹的来历')!;
    expect(paid).toMatchObject({ status: 'paid', payChapter: 2, payMethod: '裂纹中浮现教团徽记' });
    // 另一条仍未回收
    expect(next.ledger.find((f) => f.content.includes('苏晚父亲'))!.status).toBe('planted');
  });

  it('回收了台账里没有的线:补一条 plantedChapter=0 的已回收记录(审查可见「无埋设记录的回收」)', () => {
    const book = seedBook();
    const next = appendChapter('u1', book.bookId, {
      title: 't',
      content: LONG_BODY,
      summary: 's',
      ledgerActions: [{ action: 'pay', keyword: '凭空的线' }],
    });
    const orphan = next.ledger.find((f) => f.content === '凭空的线')!;
    expect(orphan).toMatchObject({ plantedChapter: 0, status: 'paid', payChapter: 2 });
  });

  it('时间线追加、细纲池去重补充并排序、总纲滚动更新', () => {
    const book = seedBook();
    const next = appendChapter('u1', book.bookId, {
      title: 't',
      content: LONG_BODY,
      summary: 's',
      timelineAppend: ['第2章|周日凌晨|夜探仓库'],
      detailedAppend: [
        { index: 4, events: '白银试炼' },
        { index: 3, events: '对决' }, // 已存在,不重复
      ],
      volumeSummary: '林凡转入主动出击。',
    });
    expect(next.timeline.at(-1)).toBe('第2章|周日凌晨|夜探仓库');
    expect(next.detailed.map((d) => d.index)).toEqual([2, 3, 4]);
    expect(next.detailed.filter((d) => d.index === 3)).toHaveLength(1);
    expect(next.volumeSummary).toBe('林凡转入主动出击。');
  });

  it('信任边界:缺摘要/空正文/书不存在都抛错,不落半截状态', () => {
    const book = seedBook();
    expect(() =>
      appendChapter('u1', book.bookId, { title: 't', content: LONG_BODY, summary: '' })
    ).toThrow(/摘要/);
    expect(() =>
      appendChapter('u1', book.bookId, { title: 't', content: '   ', summary: 's' })
    ).toThrow(/正文为空/);
    expect(() =>
      appendChapter('u1', 'nv_nope_000000', { title: 't', content: LONG_BODY, summary: 's' })
    ).toThrow(/书不存在/);
    // 失败后进度指针没动
    expect(getNovelBook('u1', book.bookId)!.progress.nextChapter).toBe(2);
  });
});

describe('路径消毒 · 拒绝穿越', () => {
  it('userId/bookId 带穿越字符:消毒后仍在数据目录内,读不到目录外文件', () => {
    const book = createNovelBook('../../evil', {
      title: 't',
      chapters: [{ title: 't', content: LONG_BODY, summary: 's' }],
    });
    // 落在 <dataDir>/novels/<消毒后的id>/ 下(realpath 校验没逃出数据目录)
    const dir = path.join(dataDir, 'novels', '.._.._evil', book.bookId);
    expect(fs.realpathSync(dir).startsWith(fs.realpathSync(dataDir))).toBe(true);
    expect(getNovelBook('../../evil', book.bookId)?.title).toBe('t');
    // 穿越 bookId 读任意文件:永远 null,不炸
    expect(getNovelBook('u1', '../../../../etc/passwd')).toBeNull();
    expect(getChapterContent('u1', '../../../../etc/passwd', 1)).toBeNull();
  });
});

describe('deleteNovelBook', () => {
  it('删除后目录不复存在,重复删除幂等成功', () => {
    const book = seedBook();
    expect(deleteNovelBook('u1', book.bookId)).toBe(true);
    expect(getNovelBook('u1', book.bookId)).toBeNull();
    expect(deleteNovelBook('u1', book.bookId)).toBe(true);
    expect(deleteNovelBook('u1', 'nv_nope_000000')).toBe(true);
  });
});

describe('assembleChapterContext · 恒定上下文装配(§2)', () => {
  it('注入:进度/总纲/设定集/主角与主要人物恒入/本章细纲/近章摘要/未回收伏笔/时间线尾', () => {
    const book = seedBook();
    const ctx = assembleChapterContext(book, { nextIndex: 2 });
    expect(ctx).toContain('## 进度');
    expect(ctx).toContain('现在写第 2 章');
    expect(ctx).toContain('小人物崛起。');
    expect(ctx).toContain('青铜→白银→黄金');
    // 主角与女主恒入;配角未被细纲点名则不入
    expect(ctx).toContain('**林凡**(主角)');
    expect(ctx).toContain('**当前状态:右手骨折**');
    expect(ctx).toContain('苏晚');
    expect(ctx).not.toContain('路人甲');
    // 本章细纲
    expect(ctx).toContain('### 第2章 夜袭');
    expect(ctx).toContain('林凡夜探仓库');
    // 近章摘要 + 未回收伏笔(已回收的不注入)
    expect(ctx).toContain('第1章:林凡捡到预知手机');
    expect(ctx).toContain('手机屏幕裂纹的来历');
    expect(ctx).toContain('苏晚父亲失踪与教团有关');
    // 时间线
    expect(ctx).toContain('第1章|周五雨夜|林凡捡到手机');
    // 注入段头一律 ##(【】是输出契约命名空间,不得出现在注入段头)
    expect(ctx).not.toMatch(/^【/m);
  });

  it('细纲点名的配角也入场(出场人物 = 主角恒入 + 细纲/近摘要点名)', () => {
    const book = seedBook();
    book.detailed.push({ index: 5, events: '路人甲带来关键情报' });
    const ctx = assembleChapterContext(book, { nextIndex: 5 });
    expect(ctx).toContain('路人甲');
  });

  it('恒定规模:摘要再多也只注入近 3 章,时间线只注入尾 5 条', () => {
    const book = seedBook();
    for (let i = 2; i <= 10; i++) book.summaries[i - 1] = `第${i}章摘要内容。`;
    book.timeline = Array.from({ length: 12 }, (_, i) => `第${i + 1}章|日${i + 1}|事件${i + 1}`);
    const ctx = assembleChapterContext(book, { nextIndex: 11 });
    expect(ctx).toContain('第8章:第8章摘要内容。');
    expect(ctx).toContain('第10章:第10章摘要内容。');
    expect(ctx).not.toContain('第7章:第7章摘要内容。');
    expect(ctx).toContain('事件12');
    expect(ctx).not.toContain('第7章|日7');
  });

  it('细纲池已空:注入降级提示,要求先补细纲(契约里有对应输出段)', () => {
    const book = seedBook();
    const ctx = assembleChapterContext(book, { nextIndex: 99 });
    expect(ctx).toContain('细纲池已空');
  });
});

describe('assembleReviewContext · 审查上下文', () => {
  it('台账全量(已回收也在,回收率可见)+ 全时间线 + 全部章摘要', () => {
    const book = seedBook();
    book.ledger[0].status = 'paid';
    book.ledger[0].payChapter = 2;
    book.ledger[0].payMethod = '徽记浮现';
    const ctx = assembleReviewContext(book);
    expect(ctx).toContain('[已回收]');
    expect(ctx).toContain('方式:徽记浮现');
    expect(ctx).toContain('[未回收]');
    expect(ctx).toContain('苏晚父亲失踪与教团有关');
    expect(ctx).toContain('## 逐章摘要');
    expect(ctx).toContain('## 粗纲/卷纲');
    expect(ctx).not.toMatch(/^【/m);
  });
});

describe('markNovelReviewed / isReviewDue · 每 N 章体检提醒(P1)', () => {
  it('新书 lastReviewedChapter=0;写满 N 章提醒触发,标记后归零并持久化', () => {
    const book = seedBook();
    expect(book.lastReviewedChapter).toBe(0);
    expect(isReviewDue(book)).toBe(false); // 只写 1 章,未满 5
    for (let i = 0; i < REVIEW_EVERY_N; i++) {
      appendChapter('u1', book.bookId, { title: 't', content: LONG_BODY, summary: 's' });
    }
    const grown = getNovelBook('u1', book.bookId)!;
    expect(isReviewDue(grown)).toBe(true); // 1+5 章,距上次体检(0)满 5
    const marked = markNovelReviewed('u1', book.bookId);
    expect(marked.lastReviewedChapter).toBe(6);
    expect(isReviewDue(marked)).toBe(false);
    // 落盘:重读仍在
    expect(getNovelBook('u1', book.bookId)!.lastReviewedChapter).toBe(6);
  });

  it('markNovelReviewed 书不存在抛错(调用方 404)', () => {
    expect(() => markNovelReviewed('u1', 'nv_nope_000000')).toThrow(/书不存在/);
  });

  it('legacy book.json 缺 lastReviewedChapter 字段:读取时归 0,不炸', () => {
    const book = seedBook();
    const jsonPath = path.join(dataDir, 'novels', 'u1', book.bookId, 'book.json');
    const raw = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    delete raw.lastReviewedChapter;
    fs.writeFileSync(jsonPath, JSON.stringify(raw), 'utf8');
    const legacy = getNovelBook('u1', book.bookId)!;
    expect(legacy.lastReviewedChapter).toBe(0);
    expect(listNovelBooks('u1').find((s) => s.bookId === book.bookId)!.reviewDue).toBe(false);
  });

  it('书库摘要带 reviewDue(表单下拉直接可显「建议体检」)', () => {
    const book = seedBook();
    for (let i = 0; i < REVIEW_EVERY_N; i++) {
      appendChapter('u1', book.bookId, { title: 't', content: LONG_BODY, summary: 's' });
    }
    expect(listNovelBooks('u1').find((s) => s.bookId === book.bookId)!.reviewDue).toBe(true);
  });
});

describe('updateNovelStyle · 文风锚写回(P2)', () => {
  it('合法文风锚落盘,重读可见', () => {
    const book = seedBook();
    const updated = updateNovelStyle('u1', book.bookId, '第一人称冷叙述,短句为主,动作戏白描');
    expect(updated.style).toBe('第一人称冷叙述,短句为主,动作戏白描');
    expect(getNovelBook('u1', book.bookId)!.style).toBe('第一人称冷叙述,短句为主,动作戏白描');
  });

  it('空样式/超长/书不存在都抛错,不落脏值(文风锚长期注入续写 prompt)', () => {
    const book = seedBook();
    expect(() => updateNovelStyle('u1', book.bookId, '   ')).toThrow(/文风锚为空/);
    expect(() => updateNovelStyle('u1', book.bookId, 'x'.repeat(MAX_STYLE_CHARS + 1))).toThrow(/文风锚超长/);
    expect(() => updateNovelStyle('u1', 'nv_nope_000000', 'x')).toThrow(/书不存在/);
    expect(getNovelBook('u1', book.bookId)!.style).toBe('爽文快节奏'); // 原值未被污染
  });
});
