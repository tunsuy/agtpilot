import { describe, it, expect } from 'vitest';
import {
  capNovelBible,
  NOVEL_BIBLE_MAX_CHARS,
  assembleChapterContext,
  assembleReviewContext,
  type NovelBook,
} from '@/lib/novel-context';
import { buildNovelGenesisOutlinePrompt } from '@/workshops/novel/context';

/**
 * 设定集(bible)注入封顶(2026-10-19 token 盘点放大器④,负责人拍板「好 可以」)。
 *
 * bible 是小说工坊唯一无界注入项:随创作只增不减、任务内每步全量重发。
 * 封顶口径:≤ 上限原样;超限保头 70% + 尾 30%,中段显式标记截断(不静默,
 * 与 MCP output-cap 同原则)。三个嵌入点(续写/体检/开书大纲)全部走 capNovelBible。
 */

function makeBook(overrides: Partial<NovelBook> = {}): NovelBook {
  return {
    bookId: 'nv_cap_test1',
    title: '封顶测试书',
    genre: '都市',
    premise: '测试卖点',
    style: '爽文快节奏',
    status: 'active',
    createdAt: 1,
    updatedAt: 1,
    progress: { chapterCount: 2, wordCount: 6000, nextChapter: 3 },
    bible: '力量体系:青铜→白银→黄金。',
    characters: [{ name: '林凡', role: '主角', currentState: '右手骨折' }],
    outline: '第一卷(1-30章)。',
    detailed: [{ index: 3, title: '夜袭', events: '林凡夜探仓库' }],
    ledger: [{ id: 'f1', content: '手机裂纹来历', plantedChapter: 1, status: 'planted' }],
    timeline: ['第1章|周五雨夜|捡到手机'],
    summaries: ['林凡捡到手机。', '拜师学艺。'],
    volumeSummary: '小人物崛起。',
    lastReviewedChapter: 0,
    chapters: [
      { index: 1, title: '雨夜', wordCount: 3000, createdAt: 1 },
      { index: 2, title: '拜师', wordCount: 3000, createdAt: 2 },
    ],
    ...overrides,
  } as NovelBook;
}

describe('capNovelBible(纯函数)', () => {
  it('≤ 上限原样返回;空/undefined 归空串', () => {
    expect(capNovelBible('短设定集')).toBe('短设定集');
    expect(capNovelBible('x'.repeat(NOVEL_BIBLE_MAX_CHARS))).toBe('x'.repeat(NOVEL_BIBLE_MAX_CHARS));
    expect(capNovelBible('')).toBe('');
    expect(capNovelBible(undefined)).toBe('');
    expect(capNovelBible(null)).toBe('');
  });

  it('超限:头 70% + 尾 30% 保留,中段截断且带显式标记(不静默)', () => {
    const head = 'H'.repeat(9000);
    const middle = 'M'.repeat(10000);
    const tail = 'T'.repeat(9000);
    const capped = capNovelBible(head + middle + tail, 12000);
    // 头部前缀与尾部后缀原样保留
    expect(capped.startsWith('H'.repeat(8400))).toBe(true); // 12000*0.7
    expect(capped.endsWith('T'.repeat(3600))).toBe(true); // 12000*0.3
    // 显式标记:截断字数如实
    expect(capped).toContain('设定集超长');
    expect(capped).toContain(`${28000 - 12000} 字已截断`);
    // 中段内容确实不在(标记行自身除外)
    expect(capped).not.toContain('M'.repeat(100));
  });

  it('自定义上限生效(测试用小上限,不依赖大字符串)', () => {
    const capped = capNovelBible('ABCDEFGHIJ', 6);
    expect(capped).toContain('ABCD'); // 头 70% = 4.2 → 4
    expect(capped).toContain('IJ'); // 尾 2
    expect(capped).toContain('4 字已截断');
  });
});

describe('三个 prompt 嵌入点全部封顶(续写/体检/开书大纲)', () => {
  const hugeBible = `核心世界观:青铜不可跳级。${'设定'.repeat(9000)}最新增补:结局伏笔在尾声。`;

  it('续写上下文块:超大 bible 截断,中段不进 prompt,头尾关键设定保留', () => {
    const ctx = assembleChapterContext(makeBook({ bible: hugeBible }), { nextIndex: 3 });
    expect(ctx).toContain('核心世界观:青铜不可跳级。');
    expect(ctx).toContain('最新增补:结局伏笔在尾声。');
    expect(ctx).toContain('设定集超长');
    // 近章摘要等窗口机制不受影响
    expect(ctx).toContain('第2章:拜师学艺。');
  });

  it('体检上下文块:同口径封顶', () => {
    const ctx = assembleReviewContext(makeBook({ bible: hugeBible }));
    expect(ctx).toContain('设定集超长');
    expect(ctx).not.toContain('设定'.repeat(7000));
  });

  it('开书第二步(大纲)bibleBlock:同口径封顶', () => {
    const p = buildNovelGenesisOutlinePrompt({ book: makeBook({ bible: hugeBible }) });
    expect(p).toContain('设定集超长');
    expect(p).toContain('核心世界观:青铜不可跳级。');
  });

  it('正常体量 bible(≤ 上限)零变化:不出现截断标记', () => {
    const book = makeBook();
    expect(assembleChapterContext(book, { nextIndex: 3 })).toContain('力量体系:青铜→白银→黄金。');
    expect(assembleChapterContext(book, { nextIndex: 3 })).not.toContain('设定集超长');
  });

  it('空 bible 仍渲染「(空)」占位(封顶不吃掉空态语义)', () => {
    expect(assembleChapterContext(makeBook({ bible: '' }), { nextIndex: 3 })).toContain('## 设定集\n(空)');
  });
});
