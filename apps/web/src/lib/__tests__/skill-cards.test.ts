import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
// 纯类型导入(编译期擦除,不影响「先设环境变量再加载被测模块」的运行时顺序)
import type { SkillCard } from '@/lib/skill-cards';

/**
 * TRS 技能卡验收测试:
 * 解析归一化(五字段+关键词,容忍围栏/垃圾输出)→ 入库(trigger 去重合并、
 * 总量上限淘汰)→ 检索注入(关键词匹配、达标门槛、top-k+预算、门控指令、
 * 命中反馈)→ 任务末蒸馏(信息量门槛、成败都蒸、模型故障静默)。
 *
 * 环境隔离:USER_DATA_DIR 指向一次性临时目录(同 governance.spec.ts 模式),
 * 必须在动态 import 被测模块之前设置。
 */

let tmpDir: string;
let sc: typeof import('@/lib/skill-cards');
let us: typeof import('@/lib/user-store');

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agtpilot-skill-'));
  process.env.USER_DATA_DIR = tmpDir;
  process.env.AGTPILOT_SECRET_KEY = 'skill-cards-test-key';
  us = await import('@/lib/user-store');
  sc = await import('@/lib/skill-cards');
});

afterAll(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // 临时目录清理失败不影响测试结果
  }
});

/** 一张合格的样例卡(可覆盖字段) */
function sampleCard(over: Partial<SkillCard> = {}): SkillCard {
  return {
    id: `skill_test_${Math.random().toString(36).slice(2, 8)}`,
    trigger: '向知乎发布文章草稿',
    steps: '先 browser_navigate 打开创作中心 → 填标题正文 → 存草稿箱,不直接发布',
    avoid: '不要跳过登录态检查,未登录时保存会静默丢失',
    check: '草稿箱列表能看到新条目才算完成',
    risk: '知乎改版时选择器可能失效,需人工核对',
    keywords: ['知乎', '草稿', 'zhihu', '发布文章'],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...over,
  };
}

describe('parseSkillCards · 蒸馏输出解析与归一化', () => {
  it('```json 围栏与前后说明文字都能解析出卡片', () => {
    const text =
      '好的,蒸馏结果如下:\n```json\n[{"trigger":"发小红书图文","steps":"用 xhs 工具存草稿","avoid":"不要直接发布","check":"草稿箱可见","risk":"登录态过期","keywords":["小红书","草稿"]}]\n```\n以上。';
    const cards = sc.parseSkillCards(text);
    expect(cards).toHaveLength(1);
    expect(cards[0].trigger).toBe('发小红书图文');
    expect(cards[0].avoid).toBe('不要直接发布');
    expect(cards[0].keywords).toContain('小红书');
  });

  it('垃圾输出/空数组/非法 JSON → 空结果不抛错', () => {
    expect(sc.parseSkillCards('本次没有值得沉淀的经验')).toEqual([]);
    expect(sc.parseSkillCards('[]')).toEqual([]);
    expect(sc.parseSkillCards('[{"trigger":"broken"')).toEqual([]);
    expect(sc.parseSkillCards('')).toEqual([]);
  });

  it('trigger/steps 缺失的卡片被丢弃;字段超长被截断;至多保留 2 张', () => {
    const text = JSON.stringify([
      { trigger: '只有场景没有步骤' }, // 缺 steps → 丢
      { steps: '只有步骤没有场景' }, // 缺 trigger → 丢
      { trigger: '卡一', steps: 'A'.repeat(500) }, // steps 截断到 400
      { trigger: '卡二', steps: 'ok' },
      { trigger: '卡三', steps: 'ok' }, // 超过 2 张 → 丢
    ]);
    const cards = sc.parseSkillCards(text);
    expect(cards).toHaveLength(2);
    expect(cards[0].trigger).toBe('卡一');
    expect(cards[0].steps).toHaveLength(400);
    expect(cards[1].trigger).toBe('卡二');
  });

  it('keywords 缺失时从 trigger 分词兜底派生(保证可被检索)', () => {
    const cards = sc.parseSkillCards('[{"trigger":"微信公众号投草稿","steps":"走官方 API"}]');
    expect(cards).toHaveLength(1);
    expect(cards[0].keywords.length).toBeGreaterThan(0);
  });
});

describe('upsertSkillCards · 入库去重与总量上限', () => {
  beforeEach(() => {
    const data = us.getUserData('u-upsert');
    data.skillCards = [];
    us.saveUserData(data);
  });

  it('新卡追加;同 trigger(忽略大小写与空白)合并更新而非重复入库', () => {
    const first = sc.upsertSkillCards('u-upsert', [
      { trigger: '知乎发草稿', steps: 'v1', keywords: ['知乎'], sourceMissionId: 'm1' },
    ]);
    expect(first.added).toHaveLength(1);
    expect(first.updated).toHaveLength(0);

    const second = sc.upsertSkillCards('u-upsert', [
      { trigger: ' 知乎发草稿 ', steps: 'v2 修正版', avoid: '别直接发布', keywords: ['zhihu'], sourceMissionId: 'm2' },
    ]);
    expect(second.added).toHaveLength(0);
    expect(second.updated).toHaveLength(1);

    const cards = sc.listSkillCards('u-upsert');
    expect(cards).toHaveLength(1);
    expect(cards[0].id).toBe(first.added[0].id); // 保留原 id
    expect(cards[0].steps).toBe('v2 修正版'); // steps 以新为准
    expect(cards[0].avoid).toBe('别直接发布'); // 可选字段新值补入
    expect(cards[0].keywords).toEqual(expect.arrayContaining(['知乎', 'zhihu'])); // 关键词并集
    expect(cards[0].sourceMissionId).toBe('m2');
  });

  it('超过总量上限 → 淘汰到 SKILL_CARDS_MAX,高命中卡优先保留', () => {
    // 先种一张高命中卡
    sc.upsertSkillCards('u-upsert', [{ trigger: '高频卡', steps: '常用', keywords: ['高频'] }]);
    const seeded = sc.listSkillCards('u-upsert')[0];
    seeded.hitCount = 9;
    const data0 = us.getUserData('u-upsert');
    data0.skillCards = [seeded];
    us.saveUserData(data0);

    // 再灌满超限
    const flood = Array.from({ length: sc.SKILL_CARDS_MAX + 10 }, (_, i) => ({
      trigger: `批量卡${i}`,
      steps: 'x',
      keywords: [`k${i}`],
    }));
    sc.upsertSkillCards('u-upsert', flood);
    const cards = sc.listSkillCards('u-upsert');
    expect(cards).toHaveLength(sc.SKILL_CARDS_MAX);
    expect(cards.some((c) => c.trigger === '高频卡')).toBe(true); // hitCount 高的活下来
  });

  it('损坏条目(缺字段/类型错)读取时被过滤,不污染检索', () => {
    const data = us.getUserData('u-upsert');
    data.skillCards = [
      sampleCard({ id: 'ok1' }),
      { id: 'bad1' }, // 缺 trigger/steps/keywords
      { id: 'bad2', trigger: '', steps: '', keywords: [] },
      null,
    ];
    us.saveUserData(data);
    const cards = sc.listSkillCards('u-upsert');
    expect(cards).toHaveLength(1);
    expect(cards[0].id).toBe('ok1');
  });
});

describe('scoreSkillCard / selectSkillCards · 关键词检索', () => {
  const zhihu = sampleCard({ id: 'c-zhihu', keywords: ['知乎', '草稿', 'zhihu'] });
  const xhs = sampleCard({
    id: 'c-xhs',
    trigger: '发小红书图文笔记',
    keywords: ['小红书', '图文', 'xhs'],
  });
  const deploy = sampleCard({
    id: 'c-deploy',
    trigger: '部署 Node 服务到服务器',
    keywords: ['docker', '部署', 'nginx'],
  });

  it('目标含关键词子串 → 达到注入门槛;无关目标 → 0 分被过滤', () => {
    expect(sc.scoreSkillCard(zhihu, '帮我在知乎发一篇草稿')).toBeGreaterThanOrEqual(2);
    expect(sc.scoreSkillCard(deploy, '帮我写一篇公众号文章')).toBe(0);
  });

  it('top-k 按分数排序,无关卡不入选', () => {
    const picked = sc.selectSkillCards([deploy, xhs, zhihu], '知乎和小红书都要发草稿');
    const ids = picked.map((c) => c.id);
    expect(ids).toEqual(expect.arrayContaining(['c-zhihu', 'c-xhs']));
    expect(ids).not.toContain('c-deploy');
  });

  it('条数与字符预算封顶:预算只够一张时不硬塞', () => {
    const big = sampleCard({ id: 'c-big', trigger: '大卡', steps: 'B'.repeat(400), keywords: ['大卡'] });
    const picked = sc.selectSkillCards([big, sampleCard({ id: 'c-small', trigger: '小卡', steps: '短', keywords: ['小卡'] })], '大卡 小卡', {
      maxItems: 3,
      maxChars: 500,
    });
    const total = picked.reduce((n, c) => n + sc.renderSkillCard(c).length, 0);
    expect(total).toBeLessThanOrEqual(500);
    expect(picked.length).toBeLessThan(2);
  });

  it('零相关时返回空(不注入无关卡片制造噪音)', () => {
    expect(sc.selectSkillCards([zhihu, xhs, deploy], '今天天气怎么样')).toEqual([]);
  });
});

describe('buildSkillCardsBlock · prompt 注入块', () => {
  beforeEach(() => {
    const data = us.getUserData('u-block');
    data.skillCards = [sampleCard({ id: 'c1', hitCount: 0 })];
    us.saveUserData(data);
    delete process.env.AGTPILOT_SKILL_CARDS;
  });

  it('命中卡 → 注入块含门控指令与五字段标签;无命中/无卡 → 空串', () => {
    const block = sc.buildSkillCardsBlock('u-block', '去知乎发草稿');
    expect(block).toContain('仅采用与当前任务直接适用');
    expect(block).toContain('以用户指示为准');
    expect(block).toContain('Trigger(适用)');
    expect(block).toContain('Do(步骤)');
    expect(block).toContain('Avoid(反模式)');
    expect(block).toContain('Check(必验)');
    expect(block).toContain('Risk(边界)');

    expect(sc.buildSkillCardsBlock('u-block', '完全无关的任务:修水管')).toBe('');
    expect(sc.buildSkillCardsBlock('u-nobody', '去知乎发草稿')).toBe('');
  });

  it('被注入的卡片累计 hitCount(供淘汰策略与衰减)', () => {
    sc.buildSkillCardsBlock('u-block', '去知乎发草稿');
    const cards = sc.listSkillCards('u-block');
    expect(cards[0].hitCount).toBe(1);
    expect(cards[0].lastHitAt).toBeGreaterThan(0);
  });

  it('AGTPILOT_SKILL_CARDS=0 → 整体关闭不注入', () => {
    process.env.AGTPILOT_SKILL_CARDS = '0';
    try {
      expect(sc.buildSkillCardsBlock('u-block', '去知乎发草稿')).toBe('');
    } finally {
      delete process.env.AGTPILOT_SKILL_CARDS;
    }
  });
});

describe('distillSkillCards · 任务末蒸馏', () => {
  function mockCtx(replyText: string) {
    return {
      model: {
        invokeStep: vi.fn(async () => ({ text: replyText })),
      },
    };
  }
  const reply = JSON.stringify([
    { trigger: '知乎发文草稿流程', steps: '导航→填写→存草稿', avoid: '别直接发布', check: '草稿箱可见', risk: '改版失效', keywords: ['知乎', '草稿'] },
  ]);

  beforeEach(() => {
    const data = us.getUserData('u-distill');
    data.skillCards = [];
    us.saveUserData(data);
    delete process.env.AGTPILOT_SKILL_CARDS;
  });

  it('信息量门槛:工具调用少且无失败 → 不调模型', async () => {
    const ctx = mockCtx(reply);
    const out = await sc.distillSkillCards(ctx, {
      userId: 'u-distill',
      goal: '你好',
      taskSucceeded: true,
      mission: { steps: [{ tool: 'a', role: 'tool' }] },
      efficiency: { failedCalls: 0, skippedCalls: 0 },
    });
    expect(ctx.model.invokeStep).not.toHaveBeenCalled();
    expect(out.added).toHaveLength(0);
  });

  it('成功任务(调用数达标)→ 蒸馏入库并带来源任务引用', async () => {
    const ctx = mockCtx(reply);
    const out = await sc.distillSkillCards(ctx, {
      userId: 'u-distill',
      goal: '在知乎发布一篇草稿',
      taskSucceeded: true,
      mission: {
        id: 'm-100',
        steps: [
          { tool: 'browser_navigate', role: 'tool', status: 'DONE' },
          { tool: 'browser_type', role: 'tool', status: 'DONE' },
          { tool: 'browser_click', role: 'tool', status: 'DONE' },
        ],
      },
      efficiency: { stepsCount: 3, toolCalls: 3, failedCalls: 0 },
      missionId: 'm-100',
    });
    expect(ctx.model.invokeStep).toHaveBeenCalledTimes(1);
    expect(out.added).toHaveLength(1);
    const cards = sc.listSkillCards('u-distill');
    expect(cards).toHaveLength(1);
    expect(cards[0].trigger).toBe('知乎发文草稿流程');
    expect(cards[0].sourceMissionId).toBe('m-100');
  });

  it('失败任务也蒸(有失败调用即过门槛),digest 标注失败提示重点提炼 Avoid', async () => {
    const ctx = mockCtx(reply);
    await sc.distillSkillCards(ctx, {
      userId: 'u-distill',
      goal: '知乎发草稿',
      taskSucceeded: false,
      mission: { steps: [{ tool: 'browser_click', role: 'tool', status: 'FAILED' }] },
      efficiency: { failedCalls: 2, skippedCalls: 0 },
    });
    expect(ctx.model.invokeStep).toHaveBeenCalledTimes(1);
    const userMsg = (ctx.model.invokeStep as any).mock.calls[0][0].messages[0].content as string;
    expect(userMsg).toContain('失败');
    expect(userMsg).toContain('Avoid/Check');
    expect((ctx.model.invokeStep as any).mock.calls[0][0].disableTools).toBe(true);
    expect(sc.listSkillCards('u-distill')).toHaveLength(1);
  });

  it('已有卡片 trigger 清单进入蒸馏 prompt(防重复产出)', async () => {
    sc.upsertSkillCards('u-distill', [{ trigger: '已存在的卡', steps: 's', keywords: ['x'] }]);
    const ctx = mockCtx('[]');
    await sc.distillSkillCards(ctx, {
      userId: 'u-distill',
      goal: 'g',
      taskSucceeded: true,
      mission: { steps: [{ tool: 'a', role: 'tool' }, { tool: 'b', role: 'tool' }, { tool: 'c', role: 'tool' }] },
    });
    const userMsg = (ctx.model.invokeStep as any).mock.calls[0][0].messages[0].content as string;
    expect(userMsg).toContain('已存在的卡');
  });

  it('模型抛错/输出垃圾/输出空数组 → 静默返回空,不落库', async () => {
    const boom = { model: { invokeStep: vi.fn(async () => { throw new Error('llm down'); }) } };
    const out1 = await sc.distillSkillCards(boom, {
      userId: 'u-distill',
      goal: 'g',
      taskSucceeded: true,
      mission: { steps: [{ tool: 'a', role: 'tool' }, { tool: 'b', role: 'tool' }, { tool: 'c', role: 'tool' }] },
    });
    expect(out1.added).toHaveLength(0);

    const garbage = mockCtx('我觉得这次没什么可写的');
    const out2 = await sc.distillSkillCards(garbage, {
      userId: 'u-distill',
      goal: 'g',
      taskSucceeded: true,
      mission: { steps: [{ tool: 'a', role: 'tool' }, { tool: 'b', role: 'tool' }, { tool: 'c', role: 'tool' }] },
    });
    expect(out2.added).toHaveLength(0);
    expect(sc.listSkillCards('u-distill')).toHaveLength(0);
  });

  it('AGTPILOT_SKILL_CARDS=0 → 蒸馏整体关闭', async () => {
    process.env.AGTPILOT_SKILL_CARDS = '0';
    try {
      const ctx = mockCtx(reply);
      const out = await sc.distillSkillCards(ctx, {
        userId: 'u-distill',
        goal: 'g',
        taskSucceeded: true,
        mission: { steps: [{ tool: 'a', role: 'tool' }, { tool: 'b', role: 'tool' }, { tool: 'c', role: 'tool' }] },
      });
      expect(ctx.model.invokeStep).not.toHaveBeenCalled();
      expect(out.added).toHaveLength(0);
    } finally {
      delete process.env.AGTPILOT_SKILL_CARDS;
    }
  });
});

describe('buildTrajectoryDigest · 轨迹摘录', () => {
  it('含目标/结果/工具行/统计/最终交付;失败工具行带异常摘要;总量封顶', () => {
    const digest = sc.buildTrajectoryDigest({
      goal: '知乎发草稿',
      taskSucceeded: false,
      mission: {
        steps: [
          { tool: 'browser_click', args: { sel: '#btn' }, role: 'tool', status: 'FAILED', output: { error: '元素不可点' } },
          { role: 'assistant', answer: '最终没能完成' } as any,
        ],
      },
      efficiency: { stepsCount: 1, toolCalls: 1, failedCalls: 1, skippedCalls: 0, effectiveRate: 0 },
    });
    expect(digest).toContain('【任务目标】知乎发草稿');
    expect(digest).toContain('失败');
    expect(digest).toContain('browser_click');
    expect(digest).toContain('异常');
    expect(digest).toContain('最终没能完成');
    expect(digest.length).toBeLessThanOrEqual(6000);
  });
});
