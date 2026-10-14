/**
 * novel 工坊 prompt 构建测试(docs/design/novel-workshop.md §9)
 *
 * 锁:三模式模板变量注入、参数钳制(context.ts 单一事实源)、续写的
 * 恒定上下文块与书号逐字内嵌、细纲低水位条件段、审查的只读边界与红线文案。
 */
import { describe, it, expect } from 'vitest';
import {
  buildNovelGenesisPrompt,
  buildNovelContinuePrompt,
  buildNovelReviewPrompt,
  clampChapterWords,
  clampOpeningChapters,
  NOVEL_GENRES,
  NOVEL_STYLES,
  NOVEL_REVIEW_FOCUS,
} from '../context';
import { WORKSHOP_SKILL } from '../skill';
import type { NovelBook } from '@/lib/novel-context';

function makeBook(overrides: Partial<NovelBook> = {}): NovelBook {
  return {
    bookId: 'nv_test01_a1b2c3',
    title: '铁拳少年',
    genre: '都市',
    premise: '外卖骑手捡到预知差评的手机',
    style: '爽文快节奏',
    status: 'active',
    createdAt: 1,
    updatedAt: 1,
    progress: { chapterCount: 2, wordCount: 6000, nextChapter: 3 },
    bible: '力量体系:青铜→白银→黄金,严格逐级不可跳级。',
    characters: [
      { name: '林凡', role: '主角', currentState: '右手骨折' },
      { name: '苏晚', role: '女主', currentState: '卧底教团' },
    ],
    outline: '第一卷·崛起(1-30章)。',
    detailed: [
      { index: 3, title: '夜袭', events: '林凡夜探仓库', hook: '仓库异响' },
      { index: 4, events: '对决' },
      { index: 5, events: '白银试炼' },
      { index: 6, events: '教团来袭' },
    ],
    ledger: [
      { id: 'f1', content: '手机屏幕裂纹的来历', plantedChapter: 1, status: 'planted' },
      { id: 'f2', content: '师父失踪之谜', plantedChapter: 1, status: 'paid', payChapter: 2, payMethod: '回忆揭示' },
    ],
    timeline: ['第1章|周五雨夜|林凡捡到手机', '第2章|周六|拜师'],
    summaries: ['林凡捡到预知手机。', '拜师学艺,右手骨折。'],
    volumeSummary: '小人物崛起。',
    chapters: [
      { index: 1, title: '雨夜差评', wordCount: 3000, createdAt: 1 },
      { index: 2, title: '拜师', wordCount: 3000, createdAt: 2 },
    ],
    ...overrides,
  };
}

describe('参数钳制(单一事实源,表单与 run() 共用)', () => {
  it('章字数 1000-6000,缺省 3000', () => {
    expect(clampChapterWords(99999)).toBe(6000);
    expect(clampChapterWords(0)).toBe(1000);
    expect(clampChapterWords(undefined)).toBe(3000);
    expect(clampChapterWords('bogus')).toBe(3000);
    expect(clampChapterWords('2500')).toBe(2500);
  });
  it('开书章数 1-5,缺省 3', () => {
    expect(clampOpeningChapters(99)).toBe(5);
    expect(clampOpeningChapters(0)).toBe(1);
    expect(clampOpeningChapters(undefined)).toBe(3);
  });
});

describe('开新书 prompt', () => {
  it('注入题材/卖点/文风锚/字数/章数,含发布合规红线与入库提醒', () => {
    const p = buildNovelGenesisPrompt({
      genre: '都市',
      premise: '外卖骑手捡到预知差评的手机',
      style: NOVEL_STYLES[0],
      chapterWords: 2500,
      openingChapters: 2,
    });
    expect(p).toContain('都市');
    expect(p).toContain('外卖骑手捡到预知差评的手机');
    expect(p).toContain('2500');
    expect(p).toContain('开篇 2 章');
    // 契约锚(与 parseNovelPackage 同源)
    for (const anchor of ['【书名】', '【设定集】', '【人物卡】', '【粗纲】', '【细纲】', '【伏笔】', '【时间线】', '【本章摘要】']) {
      expect(p).toContain(anchor);
    }
    // 红线:不自动发布 + AI 声明人工如实勾选 + 原创
    expect(p).toContain('严禁调用任何发布/投稿/自动上传类工具');
    expect(p).toContain('AI 辅助声明由作者本人在平台如实勾选');
    expect(p).toContain('必须原创');
    expect(p).toContain('存入书库');
  });

  it('卖点留空走 else 分支(自行拍板);钳制越界参数', () => {
    const p = buildNovelGenesisPrompt({ genre: '', premise: '', style: '', chapterWords: 99999, openingChapters: 99 });
    expect(p).toContain('种子创意:未指定');
    expect(p).toContain('6000');
    expect(p).toContain('开篇 5 章');
    expect(p).toContain('不限'); // genre 空 → 模板收「不限(自行拍板)」;run() 层缺省才是 NOVEL_GENRES[0]
  });
});

describe('续写 prompt', () => {
  it('书号逐字内嵌 + 恒定上下文块注入(设定集/人物当前状态/未回收伏笔/近章摘要)', () => {
    const { prompt, nextIndex } = buildNovelContinuePrompt({ book: makeBook() });
    expect(nextIndex).toBe(3);
    expect(prompt).toContain('《铁拳少年》第 3 章');
    expect(prompt).toContain('nv_test01_a1b2c3'); // 书号原样,入库对账
    expect(prompt).toContain('## 设定集');
    expect(prompt).toContain('青铜→白银→黄金');
    expect(prompt).toContain('**当前状态:右手骨折**');
    expect(prompt).toContain('手机屏幕裂纹的来历');
    expect(prompt).not.toContain('师父失踪之谜'); // 已回收伏笔不注入续写上下文
    expect(prompt).toContain('第2章:拜师学艺,右手骨折。');
    expect(prompt).toContain('### 第3章 夜袭');
    expect(prompt).toContain('严禁调用任何发布/投稿/自动上传类工具');
    expect(prompt).toContain('缺它会被拒绝入库'); // 摘要必填的契约威慑
    expect(prompt).toContain('角色不能瞬移、死人不能说话');
  });

  it('细纲池低水位(<3 条):出现【下章细纲】补充段,起始章 = nextIndex+1', () => {
    const book = makeBook({ detailed: [{ index: 3, events: '夜探仓库' }, { index: 4, events: '对决' }] });
    const { prompt } = buildNovelContinuePrompt({ book });
    expect(prompt).toContain('【下章细纲】');
    expect(prompt).toContain('补第 4 章起的 5-10 章细纲');
  });

  it('细纲池充足:不出现【下章细纲】段', () => {
    const { prompt } = buildNovelContinuePrompt({ book: makeBook() }); // index>3 的余 3 条
    expect(prompt).not.toContain('【下章细纲】');
  });

  it('文风锚:入参 > 书库存量 > 预设缺省', () => {
    expect(buildNovelContinuePrompt({ book: makeBook(), style: '定制文风' }).prompt).toContain('文风锚:定制文风');
    expect(buildNovelContinuePrompt({ book: makeBook() }).prompt).toContain('文风锚:爽文快节奏');
    expect(buildNovelContinuePrompt({ book: makeBook({ style: '' }) }).prompt).toContain(`文风锚:${NOVEL_STYLES[0]}`);
  });
});

describe('审查 prompt', () => {
  it('注入全量状态库上下文(已回收伏笔也在,回收率可见)+ 只读边界', () => {
    const p = buildNovelReviewPrompt({ book: makeBook(), focus: '伏笔盘点' });
    expect(p).toContain('《铁拳少年》');
    expect(p).toContain('伏笔盘点');
    expect(p).toContain('[已回收]');
    expect(p).toContain('方式:回忆揭示');
    expect(p).toContain('[未回收]');
    expect(p).toContain('手机屏幕裂纹的来历');
    expect(p).toContain('健康度评分');
    expect(p).toContain('通过'); // 没问题的项写「通过」,不得硬凑
  });

  it('侧重缺省 = 全面体检', () => {
    expect(buildNovelReviewPrompt({ book: makeBook() })).toContain(NOVEL_REVIEW_FOCUS[0]);
  });
});

describe('skill.run() 分发与信任边界', () => {
  it('genesis 不需要书状态;continue/review 缺状态诚实抛错(不静默降级)', () => {
    const g = WORKSHOP_SKILL.run({ mode: 'genesis', genre: '玄幻' });
    expect(g.title).toBe('网文开书:玄幻');
    expect(g.prompt).toContain('玄幻');

    expect(() => WORKSHOP_SKILL.run({ mode: 'continue', bookId: 'nv_x_000000' })).toThrow(/缺少小说状态/);
    expect(() => WORKSHOP_SKILL.run({ mode: 'review', bookId: 'nv_x_000000' })).toThrow(/缺少小说状态/);

    const c = WORKSHOP_SKILL.run({ mode: 'continue' }, { novelState: makeBook() });
    expect(c.title).toBe('《铁拳少年》第3章');
    const r = WORKSHOP_SKILL.run({ mode: 'review' }, { novelState: makeBook() });
    expect(r.title).toBe('《铁拳少年》全书体检');
  });

  it('mode 缺省 = genesis(旧参数/空参数不炸)', () => {
    const run = WORKSHOP_SKILL.run({});
    expect(run.title).toContain('网文开书');
    expect(run.prompt).toContain(NOVEL_GENRES[0]);
  });
});
