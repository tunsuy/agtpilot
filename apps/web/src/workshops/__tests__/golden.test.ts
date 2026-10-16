import { describe, it, expect } from 'vitest';
import { buildWorkshopRun, type WorkshopRunContext } from '../../components/workshops/run';
import type { WorkshopId } from '../../components/workshops/registry';
import { resolveCronPrompt } from '../../lib/cron-scenario';
import type { ScenarioProfile } from '../../lib/scenario-profile';
import type { NovelBook } from '../../lib/novel-context';

/**
 * 工坊 skill 包重构 · Phase 0 快照锁定(golden master)。
 *
 * 用途:后续 Phase 2(包结构搬家)与 Phase 3(.md 模板化)的每一步,
 * 本文件重跑后的快照必须与本文件首跑逐字节一致 —— 提示词与 title 的
 * 「verbatim 平移」由机器保证,不靠肉眼。
 *
 * import 路径刻意指向 components/workshops/run 与 lib/cron-scenario:
 * 重构后这两个模块保持同路径同签名(run.ts 变薄 re-export、cron-scenario
 * 泛化为查清单),本测试与快照文件永不重指。
 *
 * 矩阵覆盖:默认参数、填充参数、钳制边界(count 0/99、非法枚举 id)、
 * 档案三种形态(完整/空壳/无)、cron 两个场景 + 普通任务透传。
 */

const FULL_PROFILE: ScenarioProfile = {
  scenarioKey: 'xhs',
  version: 1,
  positioning: {
    niche: 'Go / TypeScript',
    audience: 'LLM 基础设施、Agent 框架',
    differentiation: '维护过 k8s operator',
  },
  persona: { toneSamples: ['口语化'], taboos: ['不碰加密货币项目'] },
  cadence: {},
  insights: [],
  createdAt: Date.parse('2026-01-01T00:00:00Z'),
  updatedAt: Date.parse('2026-01-01T00:00:00Z'),
};

/** 空壳档案:字段全空 → buildProfileSection 返回 null,注入段整段省略 */
const HOLLOW_PROFILE: ScenarioProfile = {
  scenarioKey: 'xhs',
  version: 1,
  positioning: { niche: '', audience: '' },
  persona: { toneSamples: [], taboos: [] },
  cadence: {},
  insights: [],
  createdAt: 0,
  updatedAt: 0,
};

/** novel 续写/审查的书状态夹具(全静态字段,快照可复现;时间戳固定) */
const NOVEL_GOLDEN_STYLE = '爽文快节奏:短段落、强钩子、三章一小爽五章一大爽';
const GOLDEN_NOVEL_BOOK: NovelBook = {
  bookId: 'nv_golden_a1b2c3',
  title: '铁拳少年',
  genre: '都市',
  premise: '外卖骑手捡到预知差评的手机',
  style: '爽文快节奏',
  status: 'active',
  createdAt: 1700000000000,
  updatedAt: 1700000001000,
  progress: { chapterCount: 2, wordCount: 6000, nextChapter: 3 },
  bible: '力量体系:青铜→白银→黄金,严格逐级不可跳级。',
  characters: [
    { name: '林凡', role: '主角', currentState: '右手骨折' },
    { name: '苏晚', role: '女主', currentState: '卧底教团' },
  ],
  outline: '第一卷·崛起(1-30章):获得手机,卷入教团阴谋。',
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
    { index: 1, title: '雨夜差评', wordCount: 3000, createdAt: 1700000000000 },
    { index: 2, title: '拜师', wordCount: 3000, createdAt: 1700000001000 },
  ],
};

interface GoldenCase {
  label: string;
  id: WorkshopId;
  params: Record<string, unknown>;
  ctx?: WorkshopRunContext;
}

/** 每 id 的默认参数形态(表单刚打开、未动任何控件) */
const ALL_IDS: WorkshopId[] = [
  'xhs',
  'wechat_mp',
  'zhihu',
  'weibo',
  'video_douyin',
  'video_bilibili',
  'email_triage',
  'weekly',
  'ppt',
  'follow_builders',
  'invest',
  'edu',
  'oss_radar',
  'novel',
];

const FILLED: GoldenCase[] = [
  {
    label: 'filled',
    id: 'xhs',
    params: { topic: '周末露营装备清单', style: '种草推荐', count: 3 },
    ctx: { scenarioProfile: FULL_PROFILE },
  },
  {
    label: 'filled',
    id: 'wechat_mp',
    params: { topic: 'AI 编程工具横评', style: '深度长文', count: 3, theme: '科技观察' },
    ctx: { scenarioProfile: FULL_PROFILE },
  },
  {
    label: 'filled',
    id: 'zhihu',
    params: { topic: 'RAG 架构演进', style: '技术长文', count: 3 },
    ctx: { scenarioProfile: FULL_PROFILE },
  },
  { label: 'filled', id: 'weibo', params: { topic: '台风预警', style: '热点点评', count: 3 } },
  {
    label: 'filled',
    id: 'video_douyin',
    params: { topic: '一人食晚餐', duration: '60 秒', count: 3 },
  },
  {
    label: 'filled',
    id: 'video_bilibili',
    params: { topic: '装机避坑', duration: '3 分钟', count: 2 },
  },
  {
    label: 'filled',
    id: 'email_triage',
    params: { scope: 'unread', focus: '发票与账单', draft: true },
  },
  {
    label: 'filled',
    id: 'weekly',
    params: { period: 'this_week', audience: 'leader', delivery: 'chat', extras: '含周会纪要' },
  },
  {
    label: 'filled',
    id: 'ppt',
    params: {
      topic: 'Q3 业务复盘',
      material: '见附件数据',
      purpose: 'report',
      style: 'business',
      pages: 12,
      output: 'bento',
    },
  },
  {
    label: 'filled',
    id: 'follow_builders',
    params: { language: 'zh', range: '24h', categories: ['ai', 'oss'] },
  },
  {
    label: 'filled',
    id: 'invest',
    params: {
      mode: 'stock_check',
      symbols: 'AAPL,TSLA',
      focus: '财报季',
      holdings: 'AAPL 100 股',
      riskProfile: 'balanced',
      markets: ['a_share', 'us'],
      delivery: 'chat',
    },
  },
  {
    label: 'filled',
    id: 'edu',
    params: {
      mode: 'literature_review',
      topic: '多智能体协作',
      focus: '任务分解',
      paper: 'AutoGen 论文',
      subject: '信息科技',
      grade: '初二',
      duration: '40 分钟',
      extras: '附板书设计',
      material: '教材第三章',
      cardType: 'mixed',
      cardFormat: 'anki_csv',
      delivery: 'chat',
    },
  },
  {
    label: 'filled',
    id: 'oss_radar',
    params: { stack: 'Go', interests: ['agent', 'rag'], kinds: ['good_first_issue'], count: 5 },
    ctx: { scenarioProfile: { ...FULL_PROFILE, scenarioKey: 'oss_radar' } },
  },
  {
    label: 'filled-genesis',
    id: 'novel',
    params: {
      mode: 'genesis',
      genre: '玄幻',
      premise: '废柴少年觉醒吞天魔骨',
      style: NOVEL_GOLDEN_STYLE,
      chapterWords: 2500,
      openingChapters: 2,
    },
  },
  {
    label: 'filled-continue',
    id: 'novel',
    params: { mode: 'continue', bookId: GOLDEN_NOVEL_BOOK.bookId, chapterWords: 2000, style: '定制文风:冷峻白描' },
    ctx: { novelState: GOLDEN_NOVEL_BOOK },
  },
  {
    label: 'filled-review',
    id: 'novel',
    params: { mode: 'review', bookId: GOLDEN_NOVEL_BOOK.bookId, focus: '伏笔盘点' },
    ctx: { novelState: GOLDEN_NOVEL_BOOK },
  },
  // 开书三段化:第一步设定包(无书状态依赖)/ 第二步大纲包(吃第一步入库的书)
  {
    label: 'filled-genesis-bible',
    id: 'novel',
    params: {
      mode: 'genesis_bible',
      genre: '玄幻',
      premise: '废柴少年觉醒吞天魔骨',
      style: NOVEL_GOLDEN_STYLE,
      chapterWords: 2500,
    },
  },
  {
    label: 'filled-genesis-outline',
    id: 'novel',
    params: { mode: 'genesis_outline', bookId: GOLDEN_NOVEL_BOOK.bookId, chapterWords: 2500, style: NOVEL_GOLDEN_STYLE },
    ctx: { novelState: GOLDEN_NOVEL_BOOK },
  },
];

/** 边界:钳制与非法枚举(count 0/99、未知 style/mode、数组里混入非法 id) */
const EDGE: GoldenCase[] = [
  { label: 'edge-clamp', id: 'xhs', params: { topic: '', style: '未知风格', count: 99 } },
  { label: 'edge-zero', id: 'xhs', params: { topic: '', style: '', count: 0 } },
  {
    label: 'edge-hollow-profile',
    id: 'xhs',
    params: { topic: '空档案形态', style: '种草推荐', count: 1 },
    ctx: { scenarioProfile: HOLLOW_PROFILE },
  },
  {
    label: 'edge-hollow-profile',
    id: 'wechat_mp',
    params: { topic: '空档案形态', style: '深度长文', count: 1 },
    ctx: { scenarioProfile: HOLLOW_PROFILE },
  },
  {
    label: 'edge-hollow-profile',
    id: 'zhihu',
    params: { topic: '空档案形态', style: '技术长文', count: 1 },
    ctx: { scenarioProfile: HOLLOW_PROFILE },
  },
  {
    label: 'edge-hollow-profile',
    id: 'oss_radar',
    params: { stack: '', interests: ['bogus', 'agent'], kinds: ['bogus2'], count: 99 },
    ctx: { scenarioProfile: { ...HOLLOW_PROFILE, scenarioKey: 'oss_radar' } },
  },
  // 指定项目:归一(owner/repo + GitHub 链接)、畸形过滤(带空格/穿越)、section verbatim 锁定
  {
    label: 'edge-target-repos',
    id: 'oss_radar',
    params: {
      stack: '',
      count: 5,
      targetRepos: 'milvus-io/milvus\nhttps://github.com/vllm-project/vllm/issues/1\nbogus name\n../evil',
    },
  },
  { label: 'edge-clamp', id: 'weibo', params: { topic: '', count: 99, style: '' } },
  { label: 'edge-clamp', id: 'video_douyin', params: { topic: '', count: 99, duration: '' } },
  { label: 'edge-unknown-scope', id: 'email_triage', params: { scope: 'bogus', draft: false } },
  {
    label: 'edge-unknown-period',
    id: 'weekly',
    params: { period: 'bogus', audience: 'bogus', delivery: 'bogus' },
  },
  { label: 'edge-clamp', id: 'ppt', params: { topic: '', pages: 99, output: 'pptx', purpose: 'bogus' } },
  {
    label: 'edge-bogus-categories',
    id: 'follow_builders',
    params: { language: 'bogus', range: 'bogus', categories: ['ai', 'bogus', 42] },
  },
  { label: 'edge-unknown-mode', id: 'invest', params: { mode: 'bogus', markets: 'not-array' } },
  {
    label: 'edge-unknown-mode',
    id: 'edu',
    params: { mode: 'bogus', cardType: 'bogus', cardFormat: 'bogus' },
  },
  // novel 钳制:字数/章数越界收敛,空 genre 走「不限」分支
  {
    label: 'edge-clamp',
    id: 'novel',
    params: { mode: 'genesis', genre: '', premise: '', style: '', chapterWords: 99999, openingChapters: 99 },
  },
];

describe('工坊 golden 快照 · buildWorkshopRun', () => {
  it.each(ALL_IDS.map((id) => ({ label: 'defaults', id, params: {} })))(
    'defaults · $id',
    ({ id, params }) => {
      const run = buildWorkshopRun(id, params);
      expect({ title: run.title, prompt: run.prompt }).toMatchSnapshot();
    }
  );

  it.each([...FILLED, ...EDGE])('$id · $label', ({ id, params, ctx }) => {
    const run = buildWorkshopRun(id, params, ctx);
    expect({ title: run.title, prompt: run.prompt }).toMatchSnapshot();
  });
});

describe('工坊 golden 快照 · cron 场景重建', () => {
  const getProfile = (key: string) =>
    key === 'oss_radar' ? { ...FULL_PROFILE, scenarioKey: 'oss_radar' } : FULL_PROFILE;
  const getHollow = () => HOLLOW_PROFILE;
  const getNone = () => undefined;

  it('xhs_weekly_topics · count 7 · 完整档案', () => {
    expect(
      resolveCronPrompt({ scenario: { key: 'xhs_weekly_topics', count: 7 } }, getProfile)
    ).toMatchSnapshot();
  });

  it('xhs_weekly_topics · 缺省 count · 空壳档案', () => {
    expect(resolveCronPrompt({ scenario: { key: 'xhs_weekly_topics' } }, getHollow)).toMatchSnapshot();
  });

  it('oss_radar_weekly:requiresServerState(派发历史服务端现读)——纯函数路径诚实抛错,无 golden 快照', () => {
    // 缺了派发历史的周扫 prompt 是假 prompt(会把已核实无需改动的 Issue 再推一遍),
    // 服务端重建(档案 + 历史黑名单注入)的断言在 server-render.test.ts
    expect(() =>
      resolveCronPrompt({ scenario: { key: 'oss_radar_weekly', count: 5 } }, getProfile)
    ).toThrow(/需要服务端现读状态/);
    expect(() => resolveCronPrompt({ scenario: { key: 'oss_radar_weekly' } }, getNone)).toThrow(
      /需要服务端现读状态/
    );
  });

  it('非场景任务原样透传(不受重构影响)', () => {
    expect(
      resolveCronPrompt({ prompt: '手输 prompt 原文', scenario: { key: 'bogus' } as any }, getProfile)
    ).toBe('手输 prompt 原文');
  });
});
