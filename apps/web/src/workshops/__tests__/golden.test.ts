import { describe, it, expect } from 'vitest';
import { buildWorkshopRun, type WorkshopRunContext } from '../../components/workshops/run';
import type { WorkshopId } from '../../components/workshops/registry';
import { resolveCronPrompt } from '../../lib/cron-scenario';
import type { ScenarioProfile } from '../../lib/scenario-profile';

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

  it('oss_radar_weekly · count 5 · 完整档案', () => {
    expect(
      resolveCronPrompt({ scenario: { key: 'oss_radar_weekly', count: 5 } }, getProfile)
    ).toMatchSnapshot();
  });

  it('oss_radar_weekly · 缺省 count · 无档案', () => {
    expect(resolveCronPrompt({ scenario: { key: 'oss_radar_weekly' } }, getNone)).toMatchSnapshot();
  });

  it('非场景任务原样透传(不受重构影响)', () => {
    expect(
      resolveCronPrompt({ prompt: '手输 prompt 原文', scenario: { key: 'bogus' } as any }, getProfile)
    ).toBe('手输 prompt 原文');
  });
});
