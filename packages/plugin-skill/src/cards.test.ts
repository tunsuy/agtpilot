import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  SKILL_CARDS_MAX,
  createSkillCardsEngine,
  createSkillService,
  renderSkillCard,
  buildTrajectoryDigest,
  defaultTokenize,
  type SkillCard,
  type SkillCardStore,
  type SkillCardAuditEntry,
  type SkillCardModel,
} from './index';

/**
 * card 形态(TRS 技能卡)引擎验收:
 * 解析归一化(五字段+关键词,容忍围栏/垃圾输出)→ 入库(trigger 去重合并、
 * 总量上限淘汰、审计经适配器)→ 检索注入(关键词匹配、达标门槛、top-k+预算、
 * 门控指令、命中反馈)→ 任务末蒸馏(信息量门槛、成败都蒸、模型故障静默)→
 * 服务面(无 cards 存储时空转;开关整体关闭)。
 *
 * 存储用内存假件(宿主注入形状的替身),插件测试零宿主依赖。
 */

/** 内存卡片存储(含审计记录) */
function fakeCardStore(): SkillCardStore & { cards: Map<string, SkillCard[]>; audits: SkillCardAuditEntry[] } {
  const cards = new Map<string, SkillCard[]>();
  const audits: SkillCardAuditEntry[] = [];
  return {
    cards,
    audits,
    listCards: (uid) => cards.get(uid) || [],
    saveCards: (uid, list) => void cards.set(uid, list),
    appendCardAudit: (_uid, entry) => void audits.push(entry),
  };
}

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

const engine = () => createSkillCardsEngine({ store: fakeCardStore() });

describe('parseCards / normalizeCard · 蒸馏输出解析与归一化', () => {
  it('```json 围栏与前后说明文字都能解析出卡片', () => {
    const text =
      '好的,蒸馏结果如下:\n```json\n[{"trigger":"发小红书图文","steps":"用 xhs 工具存草稿","avoid":"不要直接发布","check":"草稿箱可见","risk":"登录态过期","keywords":["小红书","草稿"]}]\n```\n以上。';
    const cards = engine().parseCards(text);
    expect(cards).toHaveLength(1);
    expect(cards[0].trigger).toBe('发小红书图文');
    expect(cards[0].keywords).toEqual(['小红书', '草稿']);
  });

  it('垃圾输出/空数组/坏 JSON → 空候选,绝不抛出', () => {
    const e = engine();
    expect(e.parseCards('本次没有值得沉淀的经验')).toEqual([]);
    expect(e.parseCards('[]')).toEqual([]);
    expect(e.parseCards('[{"trigger":"broken"')).toEqual([]);
    expect(e.parseCards('')).toEqual([]);
  });

  it('trigger/steps 必填;字段截断到上限;keywords 缺失时从 trigger 分词兜底派生', () => {
    const e = engine();
    expect(e.normalizeCard({ trigger: '只有触发器' })).toBeNull();
    expect(e.normalizeCard({ steps: '只有步骤' })).toBeNull();
    expect(e.normalizeCard(null)).toBeNull();
    const c = e.normalizeCard({ trigger: 'x'.repeat(200), steps: 'do', do: undefined, keywords: '不是数组' });
    expect(c!.trigger).toHaveLength(80);
    expect(c!.keywords.length).toBeGreaterThan(0); // 兜底派生
    // do 字段是 steps 的别名
    expect(e.normalizeCard({ trigger: 't', do: '别名步骤' })!.steps).toBe('别名步骤');
  });

  it('至多产出 2 张卡(宁缺毋滥)', () => {
    const many = JSON.stringify(
      Array.from({ length: 5 }, (_, i) => ({ trigger: `卡${i}`, steps: 's', keywords: [`k${i}`] }))
    );
    expect(engine().parseCards(many)).toHaveLength(2);
  });
});

describe('upsertCards · 入库(trigger 去重合并、总量淘汰、审计)', () => {
  it('同 trigger(大小写/空白归一)→ 原位更新保留 id/createdAt/hitCount,keywords 并集', () => {
    const store = fakeCardStore();
    const e = createSkillCardsEngine({ store });
    e.upsertCards('u1', [{ trigger: '发知乎草稿', steps: '旧步骤', keywords: ['知乎'] }]);
    const first = store.cards.get('u1')![0];
    store.cards.get('u1')![0] = { ...first, hitCount: 5 };

    const out = e.upsertCards('u1', [
      { trigger: ' 发知乎草稿 ', steps: '新步骤', avoid: '新教训', keywords: ['草稿'], sourceMissionId: 'm2' },
    ]);
    expect(out.added).toHaveLength(0);
    expect(out.updated).toHaveLength(1);
    const merged = store.cards.get('u1')![0];
    expect(merged.id).toBe(first.id);
    expect(merged.steps).toBe('新步骤');
    expect(merged.avoid).toBe('新教训');
    expect(merged.keywords).toEqual(['知乎', '草稿']);
    expect(merged.hitCount).toBe(5);
    expect(merged.sourceMissionId).toBe('m2');
    expect(store.audits.at(-1)).toMatchObject({ op: 'update', actor: 'auto-distill' });
  });

  it('超过总量上限 → 淘汰(hitCount 低且 updatedAt 旧的先走),高频卡保留', () => {
    const store = fakeCardStore();
    const e = createSkillCardsEngine({ store });
    e.upsertCards('u2', [{ trigger: '高频卡', steps: '常用', keywords: ['高频'] }]);
    store.cards.get('u2')![0] = { ...store.cards.get('u2')![0], hitCount: 99 };
    const flood = Array.from({ length: SKILL_CARDS_MAX + 10 }, (_, i) => ({
      trigger: `灌水卡${i}`,
      steps: 's',
      keywords: [`k${i}`],
    }));
    e.upsertCards('u2', flood);
    const cards = store.cards.get('u2')!;
    expect(cards).toHaveLength(SKILL_CARDS_MAX);
    expect(cards.some((c) => c.trigger === '高频卡')).toBe(true);
  });

  it('损坏条目在入库时被过滤;新 trigger 入库写 add 审计并带来源任务', () => {
    const store = fakeCardStore();
    store.cards.set('u3', [{ id: 'broken' } as any, null]);
    const e = createSkillCardsEngine({ store });
    const out = e.upsertCards('u3', [{ trigger: '新卡', steps: 's', keywords: ['k'], sourceMissionId: 'm9' }]);
    expect(out.added).toHaveLength(1);
    expect(store.cards.get('u3')).toHaveLength(1); // 损坏条目被清掉
    expect(store.audits[0]).toMatchObject({ op: 'add', memoryId: out.added[0].id });
    expect(store.audits[0].detail).toContain('m9');
  });
});

describe('scoreCard / selectCards · 检索与预算', () => {
  it('关键词子串命中 +2;无关目标 0 分;低于门槛分不注入', () => {
    const e = engine();
    const zhihu = sampleCard();
    const deploy = sampleCard({ id: 'c2', trigger: '部署服务', steps: 's', keywords: ['deploy', '部署'] });
    expect(e.scoreCard(zhihu, '帮我在知乎发一篇草稿')).toBeGreaterThanOrEqual(2);
    expect(e.scoreCard(deploy, '帮我写一篇公众号文章')).toBe(0);
    expect(e.selectCards([zhihu, deploy], '今天天气怎么样')).toEqual([]);
  });

  it('top-k 排序取前;总字符预算封顶(大卡挤不进就跳过)', () => {
    const e = engine();
    const zhihu = sampleCard();
    const xhs = sampleCard({ id: 'c-xhs', trigger: '发小红书图文', keywords: ['小红书'] });
    const picked = e.selectCards([zhihu, xhs], '知乎和小红书都要发草稿');
    expect(picked.length).toBeGreaterThanOrEqual(1);

    const big = sampleCard({ id: 'c-big', trigger: '大卡', steps: 'x'.repeat(1000), keywords: ['大卡'] });
    const small = sampleCard({ id: 'c-small', trigger: '小卡', steps: '短', keywords: ['小卡'] });
    const budgeted = e.selectCards([big, small], '大卡 小卡', { maxChars: renderSkillCard(big).length + 10 });
    const total = budgeted.reduce((n, c) => n + renderSkillCard(c).length, 0);
    expect(total).toBeLessThanOrEqual(renderSkillCard(big).length + 10);
  });

  it('注入分词器可替换(宿主注入 tokenize 生效)', () => {
    const store = fakeCardStore();
    const spy = vi.fn(defaultTokenize);
    const e = createSkillCardsEngine({ store, tokenize: spy });
    e.scoreCard(sampleCard(), '知乎发草稿');
    expect(spy).toHaveBeenCalled();
  });
});

describe('buildCardsBlock · 注入块与命中反馈', () => {
  beforeEach(() => delete process.env.AGTPILOT_SKILL_CARDS);

  it('有达标卡 → 门控指令 + 五字段渲染,被注入卡累计 hitCount', () => {
    const store = fakeCardStore();
    const e = createSkillCardsEngine({ store });
    e.upsertCards('u4', [{ trigger: '向知乎发布文章草稿', steps: '存草稿流程', keywords: ['知乎', '草稿'] }]);
    const block = e.buildCardsBlock('u4', '去知乎发草稿');
    expect(block).toContain('技能卡');
    expect(block).toContain('仅采用与当前任务直接适用');
    expect(block).toContain('Trigger(适用)');
    expect(block).toContain('Do(步骤)');
    expect(store.cards.get('u4')![0].hitCount).toBe(1);
  });

  it('无关目标 / 无卡用户 → 空串(不注入);开关关闭 → 空串', () => {
    const store = fakeCardStore();
    const e = createSkillCardsEngine({ store });
    e.upsertCards('u5', [{ trigger: '向知乎发布文章草稿', steps: 's', keywords: ['知乎'] }]);
    expect(e.buildCardsBlock('u5', '完全无关的任务:修水管')).toBe('');
    expect(e.buildCardsBlock('u-nobody', '去知乎发草稿')).toBe('');
    process.env.AGTPILOT_SKILL_CARDS = '0';
    try {
      expect(e.buildCardsBlock('u5', '去知乎发草稿')).toBe('');
    } finally {
      delete process.env.AGTPILOT_SKILL_CARDS;
    }
  });
});

describe('distillCards · 任务末蒸馏(旁路,失败静默)', () => {
  beforeEach(() => delete process.env.AGTPILOT_SKILL_CARDS);

  const toolSteps = Array.from({ length: 4 }, (_, i) => ({
    tool: `tool_${i}`,
    args: { a: i },
    output: 'ok',
    status: 'DONE',
    role: 'assistant',
  }));

  function fakeModel(reply: string | (() => string)): SkillCardModel & { calls: number } {
    const m = {
      calls: 0,
      invokeStep: vi.fn(async () => {
        m.calls += 1;
        const text = typeof reply === 'function' ? reply() : reply;
        if (text === '__throw__') throw new Error('模型故障');
        return { text };
      }),
    };
    return m as any;
  }

  it('成功任务:轨迹喂给模型,产出卡入库并带来源任务', async () => {
    const store = fakeCardStore();
    const e = createSkillCardsEngine({ store });
    const model = fakeModel('[{"trigger":"知乎存草稿","steps":"导航→填写→核对","keywords":["知乎"]}]');
    const out = await e.distillCards(model, {
      userId: 'd1',
      goal: '往知乎存一篇草稿',
      taskSucceeded: true,
      mission: { id: 'm-d1', steps: toolSteps },
      missionId: 'm-d1',
    });
    expect(out.added).toHaveLength(1);
    expect(out.added[0].sourceMissionId).toBe('m-d1');
    expect(store.cards.get('d1')).toHaveLength(1);
    // 蒸馏 prompt 里带任务目标与轨迹
    const req = (model.invokeStep as any).mock.calls[0][0];
    expect(req.system).toContain('技能卡蒸馏器');
    expect(req.messages[0].content).toContain('往知乎存一篇草稿');
    expect(req.disableTools).toBe(true);
  });

  it('失败任务也蒸(失败轨迹是 Avoid/Check 素材),prompt 明示失败', async () => {
    const store = fakeCardStore();
    const e = createSkillCardsEngine({ store });
    const model = fakeModel('[{"trigger":"失败教训卡","steps":"s","avoid":"别这样做","keywords":["教训"]}]');
    const out = await e.distillCards(model, {
      userId: 'd2',
      goal: 'g',
      taskSucceeded: false,
      mission: { steps: [{ tool: 't', status: 'FAILED', output: 'boom 异常', role: 'assistant' }] },
      efficiency: { failedCalls: 2 },
    });
    expect(out.added).toHaveLength(1);
    const content = (model.invokeStep as any).mock.calls[0][0].messages[0].content;
    expect(content).toContain('失败');
  });

  it('信息量门槛:工具调用不足且无失败 → 不调模型;开关关闭/无模型 → 空结果', async () => {
    const e = engine();
    const model = fakeModel('[]');
    const chatty = await e.distillCards(model, {
      userId: 'd3',
      goal: 'g',
      taskSucceeded: true,
      mission: { steps: [{ role: 'user' }, { tool: 'one', role: 'assistant' }] },
    });
    expect(chatty).toEqual({ added: [], updated: [] });
    expect(model.calls).toBe(0);

    expect(await e.distillCards(undefined, { userId: 'd3', goal: 'g', taskSucceeded: true, mission: { steps: toolSteps } })).toEqual({ added: [], updated: [] });

    process.env.AGTPILOT_SKILL_CARDS = '0';
    try {
      expect(await e.distillCards(model, { userId: 'd3', goal: 'g', taskSucceeded: true, mission: { steps: toolSteps } })).toEqual({ added: [], updated: [] });
      expect(model.calls).toBe(0);
    } finally {
      delete process.env.AGTPILOT_SKILL_CARDS;
    }
  });

  it('模型故障 / 垃圾输出 → 静默空结果,绝不抛出', async () => {
    const e = engine();
    const throwing = fakeModel('__throw__');
    expect(
      await e.distillCards(throwing, { userId: 'd4', goal: 'g', taskSucceeded: true, mission: { steps: toolSteps } })
    ).toEqual({ added: [], updated: [] });
    const garbage = fakeModel('我觉得这次没有什么值得沉淀的');
    expect(
      await e.distillCards(garbage, { userId: 'd4', goal: 'g', taskSucceeded: true, mission: { steps: toolSteps } })
    ).toEqual({ added: [], updated: [] });
  });

  it('已有卡 trigger 清单进 prompt(防重复蒸馏)', async () => {
    const store = fakeCardStore();
    const e = createSkillCardsEngine({ store });
    e.upsertCards('d5', [{ trigger: '已存在的卡', steps: 's', keywords: ['k'] }]);
    const model = fakeModel('[]');
    await e.distillCards(model, { userId: 'd5', goal: 'g', taskSucceeded: true, mission: { steps: toolSteps } });
    const content = (model.invokeStep as any).mock.calls[0][0].messages[0].content;
    expect(content).toContain('已存在的卡');
  });
});

describe('检索可观测 · scoreCardDetailed + 检索轨迹(P2)', () => {
  beforeEach(() => delete process.env.AGTPILOT_SKILL_CARDS);

  /** 带轨迹收集器的卡片存储 */
  function tracingStore() {
    const base = fakeCardStore();
    const traces: Array<Record<string, unknown>> = [];
    return {
      ...base,
      traces,
      appendRetrievalTrace: (_uid: string, entry: Record<string, unknown>) => void traces.push(entry),
    };
  }

  it('scoreCardDetailed 返回得分 + 命中描述符(子串 kw / 分词 kwTok / trigger 重叠 trg)', () => {
    const e = engine();
    const d = e.scoreCardDetailed(sampleCard(), '帮我在知乎发一篇草稿');
    expect(d.score).toBeGreaterThanOrEqual(2);
    expect(d.matched.some((m) => m.startsWith('kw:知乎'))).toBe(true);
    expect(e.scoreCardDetailed(sampleCard(), '帮我修一下厨房水管漏水')).toEqual({ score: 0, matched: [] });
  });

  it('buildCardsBlock 落检索轨迹:入选带得分明细,落选带原因(below-threshold)', () => {
    const store = tracingStore();
    const e = createSkillCardsEngine({ store });
    e.upsertCards('tr1', [
      { trigger: '向知乎发布文章草稿', steps: 's', keywords: ['知乎', '草稿'] },
      { trigger: '部署 k8s 服务', steps: 's', keywords: ['k8s', '部署'] },
    ]);
    const block = e.buildCardsBlock('tr1', '去知乎发草稿');
    expect(block).toContain('知乎');
    expect(store.traces).toHaveLength(1);
    const t = store.traces[0] as any;
    expect(t.kind).toBe('skill-card');
    expect(t.goal).toContain('知乎');
    expect(t.selected.length).toBeGreaterThanOrEqual(1);
    expect(t.selected[0].score).toBeGreaterThanOrEqual(2);
    expect(Array.isArray(t.selected[0].matched)).toBe(true);
    const omitted = t.omitted.find((o: any) => o.trigger.includes('k8s'));
    expect(omitted).toBeTruthy();
    expect(omitted.reason).toBe('below-threshold');
  });

  it('全部落选也留轨迹(回答「为什么一张都没注入」);无卡用户不写', () => {
    const store = tracingStore();
    const e = createSkillCardsEngine({ store });
    e.upsertCards('tr2', [{ trigger: '向知乎发布文章草稿', steps: 's', keywords: ['知乎'] }]);
    expect(e.buildCardsBlock('tr2', '修水管')).toBe('');
    expect(store.traces).toHaveLength(1);
    expect((store.traces[0] as any).selected).toEqual([]);
    expect(e.buildCardsBlock('tr-nobody', '去知乎发草稿')).toBe('');
    expect(store.traces).toHaveLength(1); // 无卡 → 不新增轨迹
  });

  it('store 未实现轨迹接口(可选方法缺失)→ 注入照常,绝不抛出', () => {
    const e = createSkillCardsEngine({ store: fakeCardStore() });
    e.upsertCards('tr3', [{ trigger: '向知乎发布文章草稿', steps: 's', keywords: ['知乎'] }]);
    expect(e.buildCardsBlock('tr3', '去知乎发草稿')).toContain('知乎');
  });
});

describe('buildTrajectoryDigest · 轨迹摘录', () => {
  it('含目标/结果/轨迹/统计/交付节选,失败输出标注异常,总量封顶', () => {
    const digest = buildTrajectoryDigest({
      goal: '把报告存进知乎草稿',
      taskSucceeded: false,
      mission: {
        steps: [
          { role: 'user' },
          { tool: 'browser_navigate', args: { url: 'https://zhihu.com' }, status: 'DONE', role: 'assistant' },
          { tool: 'fill', output: 'error: 选择器失效', status: 'FAILED', role: 'assistant' },
          { role: 'assistant', answer: '最终交付说明'.repeat(100) },
        ],
      },
      efficiency: { stepsCount: 4, toolCalls: 2, failedCalls: 1 },
    });
    expect(digest).toContain('把报告存进知乎草稿');
    expect(digest).toContain('失败');
    expect(digest).toContain('browser_navigate');
    expect(digest).toContain('异常');
    expect(digest).toContain('执行统计');
    expect(digest).toContain('最终交付');
    expect(digest.length).toBeLessThanOrEqual(6000);
  });
});

describe('服务面 · card 形态经 ctx.skills 暴露', () => {
  beforeEach(() => delete process.env.AGTPILOT_SKILL_CARDS);

  it('无 cards 存储 → buildCardsBlock 空串、distillCards 空结果(保守空转)', async () => {
    const svc = createSkillService({});
    expect(svc.buildCardsBlock('u', '任何目标')).toBe('');
    expect(await svc.distillCards({ userId: 'u', goal: 'g', taskSucceeded: true, mission: { steps: [] } })).toEqual({
      added: [],
      updated: [],
    });
  });

  it('注入 cards 存储 + getModel → 服务面全链路(注入块 + 蒸馏)', async () => {
    const store = fakeCardStore();
    const model = fakeModelLike('[{"trigger":"服务面卡","steps":"s","keywords":["服务面"]}]');
    const svc = createSkillService({ cards: store, getModel: () => model as any });

    const out = await svc.distillCards({
      userId: 's1',
      goal: 'g',
      taskSucceeded: true,
      mission: {
        id: 'm-s1',
        steps: Array.from({ length: 3 }, (_, i) => ({ tool: `t${i}`, role: 'assistant', status: 'DONE' })),
      },
    });
    expect(out.added).toHaveLength(1);

    const block = svc.buildCardsBlock('s1', '看看服务面卡');
    expect(block).toContain('服务面卡');
    expect(store.cards.get('s1')![0].hitCount).toBe(1);
  });

  function fakeModelLike(reply: string) {
    return { invokeStep: vi.fn(async () => ({ text: reply })) };
  }
});
