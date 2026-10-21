/**
 * novel 工坊 prompt 构建测试(docs/design/novel-workshop.md §9)
 *
 * 锁:三模式模板变量注入、参数钳制(context.ts 单一事实源)、续写的
 * 恒定上下文块与书号逐字内嵌、细纲低水位条件段、审查的只读边界与红线文案。
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  buildNovelGenesisPrompt,
  buildNovelGenesisBiblePrompt,
  buildNovelGenesisOutlinePrompt,
  buildNovelContinuePrompt,
  buildNovelProloguePrompt,
  buildNovelReviewPrompt,
  buildNovelStylePrompt,
  STYLE_SAMPLES_MAX,
  clampChapterWords,
  clampOpeningChapters,
  NOVEL_GENRES,
  NOVEL_STYLES,
  NOVEL_REVIEW_FOCUS,
} from '../context';
import { WORKSHOP_SKILL } from '../skill';
import { NOVEL_BIBLE_CONTRACT_ID, NOVEL_OUTLINE_CONTRACT_ID } from '../delivery';
import type { NovelBook } from '@/lib/novel-context';
import type { ScenarioProfile } from '@/lib/scenario-profile';

afterEach(() => {
  vi.unstubAllEnvs();
});

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
    lastReviewedChapter: 0,
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
    // 红线:不自动发布 + AI 声明由自动化如实代勾(2026-10-16 拍板)+ 原创
    expect(p).toContain('严禁调用任何发布/投稿/自动上传类工具');
    expect(p).toContain('AI 辅助声明由自动化如实代勾「AI辅助」');
    expect(p).toContain('发布永远由作者本人人工确认');
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
  });  it('style 分发(P2):不绑书可跑;绑了 bookId 但缺书状态抛错;绑书标题带书名', () => {
    const loose = WORKSHOP_SKILL.run({ mode: 'style', samples: '我的样文片段。' });
    expect(loose.title).toBe('文风学习');
    expect(loose.prompt).toContain('【文风锚】');

    expect(() => WORKSHOP_SKILL.run({ mode: 'style', bookId: 'nv_x_000000', samples: '样文' })).toThrow(
      /缺少小说状态/
    );

    const bound = WORKSHOP_SKILL.run(
      { mode: 'style', bookId: 'nv_test01_a1b2c3', samples: '样文' },
      { novelState: makeBook() }
    );
    expect(bound.title).toBe('《铁拳少年》文风学习');
    expect(bound.prompt).toContain('nv_test01_a1b2c3');
  });
});

describe('开书三段化 · 第一步设定包 prompt(genesis_bible)', () => {
  it('注入题材/卖点/文风锚/字数;逐字段交付契约(不再用【字段头】整轮巨文本)', () => {
    const p = buildNovelGenesisBiblePrompt({
      genre: '都市',
      premise: '外卖骑手捡到预知差评的手机',
      style: NOVEL_STYLES[0],
      chapterWords: 2500,
    });
    expect(p).toContain('题材:都市');
    expect(p).toContain('外卖骑手捡到预知差评的手机');
    expect(p).toContain('2500');
    // 逐字段交付契约:工具名 + 交付方式段 + 字段名以裸词出现(不再是【字段头】锚)
    expect(p).toContain('workshop_deliver_field');
    expect(p).toContain('交付方式(逐字段交付');
    for (const f of ['书名', '卖点', '设定集', '人物卡', '题材', '文风锚', '每章字数']) {
      expect(p).toContain(f);
    }
    // 旧的整轮巨文本【字段头】锚不再出现(逐字段交付 content 不含字段头)
    expect(p).not.toContain('【设定集】');
    expect(p).not.toContain('【人物卡】');
    // 不建看板(planner 步是步数最大泄漏源)
    expect(p).toContain('不要为本任务创建看板');
    // 三段化:第一步只产地基,不出大纲与正文
    expect(p).not.toContain('【粗纲】');
    expect(p).not.toContain('【细纲】');
    expect(p).toContain('严禁调用任何发布/投稿/自动上传类工具');
    expect(p).toContain('必须原创');
  });

  it('skill.run() 分发:genesis_bible 不需要书状态,题材缺省取 NOVEL_GENRES[0],附逐字段交付契约', () => {
    const run = WORKSHOP_SKILL.run({ mode: 'genesis_bible' });
    expect(run.title).toBe(`网文开书:${NOVEL_GENRES[0]}`);
    expect(run.prompt).toContain(NOVEL_GENRES[0]);
    expect(run.prompt).toContain('workshop_deliver_field');
    // 交付契约挂载(与模板选择同一保险丝)
    expect(run.delivery?.id).toBe(NOVEL_BIBLE_CONTRACT_ID);
    expect(run.delivery?.fields.map((f) => f.key)).toContain('设定集');
  });

  it('灰度保险丝 AGTPILOT_NOVEL_FIELD_DELIVERY=0:回退 legacy 单轮【字段头】契约,不附 delivery', () => {
    vi.stubEnv('AGTPILOT_NOVEL_FIELD_DELIVERY', '0');
    const run = WORKSHOP_SKILL.run({ mode: 'genesis_bible', genre: '都市' });
    expect(run.prompt).toContain('【设定集】');
    expect(run.prompt).toContain('【人物卡】');
    expect(run.prompt).not.toContain('workshop_deliver_field');
    expect(run.delivery).toBeUndefined();
  });
});

describe('开书三段化 · 第二步大纲包 prompt(genesis_outline)', () => {
  it('书状态注入(设定集/人物卡)+ 书号/文风锚/字数注入;逐字段交付契约', () => {
    const run = WORKSHOP_SKILL.run(
      { mode: 'genesis_outline', bookId: 'nv_test01_a1b2c3', style: '快节奏爽文', chapterWords: 3000 },
      { novelState: makeBook() }
    );
    expect(run.title).toBe('《铁拳少年》大纲规划');
    expect(run.prompt).toContain('《铁拳少年》');
    expect(run.prompt).toContain('青铜→白银→黄金'); // 设定集注入是大纲的约束源
    expect(run.prompt).toContain('nv_test01_a1b2c3'); // 书号原样注入,入库对账
    expect(run.prompt).toContain('快节奏爽文');
    expect(run.prompt).toContain('3000');
    // 逐字段交付契约:工具名 + 字段名裸词(不再【字段头】锚)
    expect(run.prompt).toContain('workshop_deliver_field');
    for (const f of ['书号', '粗纲', '细纲', '伏笔', '时间线']) {
      expect(run.prompt).toContain(f);
    }
    expect(run.prompt).not.toContain('【粗纲】');
    // 交付契约挂载
    expect(run.delivery?.id).toBe(NOVEL_OUTLINE_CONTRACT_ID);
    // 一致性硬要求逐字保留
    expect(run.prompt).toContain('一致性硬要求(违反等于废稿)');
    // 第二步不产设定与正文(那是第一步/续写的事)
    expect(run.prompt).not.toContain('【人物卡】');
  });

  it('灰度保险丝 AGTPILOT_NOVEL_FIELD_DELIVERY=0:回退 legacy 单轮【字段头】契约,不附 delivery', () => {
    vi.stubEnv('AGTPILOT_NOVEL_FIELD_DELIVERY', '0');
    const run = WORKSHOP_SKILL.run(
      { mode: 'genesis_outline', bookId: 'nv_test01_a1b2c3' },
      { novelState: makeBook() }
    );
    expect(run.prompt).toContain('【粗纲】');
    expect(run.prompt).toContain('【细纲】');
    expect(run.prompt).not.toContain('workshop_deliver_field');
    expect(run.delivery).toBeUndefined();
  });

  it('缺书状态诚实抛错:第二步必须吃第一步入库的书', () => {
    expect(() => WORKSHOP_SKILL.run({ mode: 'genesis_outline', bookId: 'nv_x_000000' })).toThrow(
      /缺少小说状态/
    );
  });
});

describe('序章 prompt(prologue)', () => {
  // 序章只在写第 1 章前允许:chapterCount 必须为 0(chapterCount>0 派发即抛)
  const zeroBook = () =>
    makeBook({
      progress: { chapterCount: 0, wordCount: 0, nextChapter: 1 },
      chapters: [],
      summaries: [],
      prologue: undefined,
    });

  it('书号逐字内嵌 + 设定地基(卖点/设定集/人物卡)与粗纲注入;契约三锚 + 摘要必填威慑', () => {
    const p = buildNovelProloguePrompt({ book: zeroBook(), style: '快节奏爽文', chapterWords: 2500 });
    expect(p).toContain('《铁拳少年》');
    expect(p).toContain('nv_test01_a1b2c3');
    expect(p).toContain('## 卖点');
    expect(p).toContain('青铜→白银→黄金');
    expect(p).toContain('**林凡**');
    expect(p).toContain('第一卷·崛起(1-30章)。');
    expect(p).toContain('文风锚:快节奏爽文');
    expect(p).toContain('2500');
    for (const anchor of ['【书号】', '【序章】', '【序章摘要】']) {
      expect(p).toContain(anchor);
    }
    expect(p).not.toContain('【本章摘要】'); // 与续写包契约互斥,不得混头
    expect(p).toContain('缺它会被拒绝入库');
    expect(p).toContain('严禁调用任何发布/投稿/自动上传类工具');
    expect(p).toContain('不复述粗纲第 1 章的事件'); // 与第 1 章分工的职能约束
  });

  it('skill.run() 分发:零章书正常渲染;缺状态/已有正文诚实抛错', () => {
    const run = WORKSHOP_SKILL.run(
      { mode: 'prologue', bookId: 'nv_test01_a1b2c3', style: '快节奏爽文' },
      { novelState: zeroBook() }
    );
    expect(run.title).toBe('《铁拳少年》序章');
    expect(run.prompt).toContain('nv_test01_a1b2c3');
    expect(run.delivery).toBeUndefined(); // 单轮文本包,无逐字段交付契约

    expect(() => WORKSHOP_SKILL.run({ mode: 'prologue', bookId: 'nv_x_000000' })).toThrow(/缺少小说状态/);
    expect(() => WORKSHOP_SKILL.run({ mode: 'prologue', bookId: 'nv_test01_a1b2c3' }, { novelState: makeBook() })).toThrow(
      /已有正文章节,不能再插入序章/
    );
  });
});

describe('文风学习 prompt(P2)', () => {
  const SAMPLES = '雨夜,外卖箱撞在背上,冰凉。他攥紧手机,冲进巷子深处,身后的差评像追命的鼓点。';

  it('缺样文诚实抛错(绝不凭空编造文风)', () => {
    expect(() => buildNovelStylePrompt({ samples: '   ' })).toThrow(/需要样文/);
  });

  it('绑书:书名/书号注入 + 契约含【书号】回显段;含发布红线与样文合规红线', () => {
    const p = buildNovelStylePrompt({ samples: SAMPLES, book: makeBook() });
    expect(p).toContain('绑定书目:《铁拳少年》');
    expect(p).toContain('nv_test01_a1b2c3');
    expect(p).toContain('【书号】');
    expect(p).toContain('【文风锚】');
    expect(p).toContain(SAMPLES);
    expect(p).toContain('不生成任何情节正文');
    expect(p).toContain('严禁调用任何发布/投稿/自动上传类工具');
    expect(p).toContain('严禁复刻其情节链/人名组合/名场面');
    // 五点覆盖要求
    for (const point of ['叙事节奏与章感', '句式与用词偏好', '对白风格', '情绪与爽点处理', '氛围与意象习惯']) {
      expect(p).toContain(point);
    }
  });

  it('不绑书:无绑定书目行与【书号】段(锚留作开书用)', () => {
    const p = buildNovelStylePrompt({ samples: SAMPLES });
    expect(p).not.toContain('绑定书目');
    expect(p).not.toContain('【书号】');
    expect(p).toContain('【文风锚】');
  });

  it('样文超长截断到上限(防整本粘贴撑爆 prompt),截断有显式标注', () => {
    const long = 'x'.repeat(STYLE_SAMPLES_MAX + 1000);
    const p = buildNovelStylePrompt({ samples: long });
    expect(p).toContain(`(样文超长,已截断到 ${STYLE_SAMPLES_MAX} 字)`);
    expect(p).toContain('x'.repeat(STYLE_SAMPLES_MAX));
    expect(p).not.toContain('x'.repeat(STYLE_SAMPLES_MAX + 1));
  });
});

describe('作者档案注入(P1 · profileSlot novel)', () => {
  const novelProfile: ScenarioProfile = {
    scenarioKey: 'novel',
    version: 1,
    positioning: { niche: '都市异能升级流', audience: '男频 18-30' },
    persona: { toneSamples: ['短句直给'], taboos: ['不写虐主'] },
    cadence: { postsPerWeek: 7 },
    insights: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  it('有档案:四模式都注入【账号档案】段(定位/禁忌进 prompt)', () => {
    for (const p of [
      buildNovelGenesisPrompt({ genre: '都市', style: '', profile: novelProfile }),
      buildNovelContinuePrompt({ book: makeBook(), profile: novelProfile }).prompt,
      buildNovelReviewPrompt({ book: makeBook(), profile: novelProfile }),
      buildNovelStylePrompt({ samples: '样文样文', profile: novelProfile }),
    ]) {
      expect(p).toContain('【账号档案】');
      expect(p).toContain('都市异能升级流');
      expect(p).toContain('不写虐主');
    }
  });

  it('无档案:渲染与显式传 null 逐字节一致(黄金快照零漂移)', () => {
    expect(buildNovelGenesisPrompt({ genre: '都市', style: NOVEL_STYLES[0], premise: 'p' })).toBe(
      buildNovelGenesisPrompt({ genre: '都市', style: NOVEL_STYLES[0], premise: 'p', profile: null })
    );
    expect(buildNovelContinuePrompt({ book: makeBook() }).prompt).toBe(
      buildNovelContinuePrompt({ book: makeBook(), profile: null }).prompt
    );
    expect(buildNovelReviewPrompt({ book: makeBook() })).toBe(
      buildNovelReviewPrompt({ book: makeBook(), profile: null })
    );
    expect(buildNovelStylePrompt({ samples: '样文' })).toBe(
      buildNovelStylePrompt({ samples: '样文', profile: null })
    );
  });
});
