import { describe, it, expect } from 'vitest';
import { normalizeCronScenario, resolveCronPrompt } from '../cron-scenario';
import { CRON_SCENARIOS } from '@/workshops/registry';
import type { ScenarioProfile } from '../scenario-profile';

const profile: ScenarioProfile = {
  scenarioKey: 'xhs',
  version: 1,
  positioning: { niche: '秋冬通勤穿搭', audience: '30+ 通勤女性' },
  persona: { toneSamples: ['姐妹们这套真的绝'], taboos: ['不提价格'] },
  cadence: { postsPerWeek: 3 },
  insights: [{ claim: '周三晚 8 点发布打开率最高', at: Date.now() }],
  createdAt: Date.now(),
  updatedAt: Date.now(),
};

/** 贡献者档案(scenarioKey='oss_radar'):niche=主力技术栈,taboos=排除项 */
const ossProfile: ScenarioProfile = {
  scenarioKey: 'oss_radar',
  version: 1,
  positioning: { niche: 'Go / TypeScript', audience: 'LLM 基础设施、Agent 框架' },
  persona: { toneSamples: [], taboos: ['不碰加密货币项目'] },
  cadence: {},
  insights: [],
  createdAt: Date.now(),
  updatedAt: Date.now(),
};

describe('CRON_SCENARIOS 注册表(场景单一事实源)', () => {
  it('场景声明齐全:两个订阅场景在注册表内', () => {
    expect(Object.keys(CRON_SCENARIOS).sort()).toEqual(['oss_radar_weekly', 'xhs_weekly_topics']);
  });

  it('声明字段完备:key 与注册表条目一致、count 区间自洽、build 可调', () => {
    for (const [entryKey, spec] of Object.entries(CRON_SCENARIOS)) {
      expect(spec.key).toBe(entryKey);
      expect(spec.profileSlot).toBeTruthy();
      expect(spec.countMin).toBeLessThan(spec.countMax);
      expect(spec.defaultCount).toBeGreaterThanOrEqual(spec.countMin);
      expect(spec.defaultCount).toBeLessThanOrEqual(spec.countMax);
      // 无档案可调(触发时档案可能缺失,绝不能抛)
      expect(typeof spec.build(spec.defaultCount, undefined)).toBe('string');
    }
  });
});

describe('normalizeCronScenario', () => {
  it('白名单 key + 合法 count 保留', () => {
    expect(normalizeCronScenario({ key: 'xhs_weekly_topics', count: 5 })).toEqual({
      key: 'xhs_weekly_topics',
      count: 5,
    });
  });

  it('白名单外的 key 无效(安全降级,不抛错)', () => {
    expect(normalizeCronScenario({ key: 'other_scenario', count: 5 })).toBeNull();
    expect(normalizeCronScenario('xhs_weekly_topics')).toBeNull();
    expect(normalizeCronScenario(null)).toBeNull();
    expect(normalizeCronScenario(undefined)).toBeNull();
  });

  it('count 越界/非法时丢弃 count(重建时走缺省 7)', () => {
    expect(normalizeCronScenario({ key: 'xhs_weekly_topics', count: 1 })).toEqual({
      key: 'xhs_weekly_topics',
      count: undefined,
    });
    expect(normalizeCronScenario({ key: 'xhs_weekly_topics', count: 99 })).toEqual({
      key: 'xhs_weekly_topics',
      count: undefined,
    });
    expect(normalizeCronScenario({ key: 'xhs_weekly_topics', count: 'abc' })).toEqual({
      key: 'xhs_weekly_topics',
      count: undefined,
    });
  });

  it('oss_radar_weekly 在白名单内,合法 count 保留', () => {
    expect(normalizeCronScenario({ key: 'oss_radar_weekly', count: 5 })).toEqual({
      key: 'oss_radar_weekly',
      count: 5,
    });
    expect(normalizeCronScenario({ key: 'oss_radar_weekly' })).toEqual({
      key: 'oss_radar_weekly',
      count: undefined,
    });
  });
});

describe('resolveCronPrompt', () => {
  it('scenario 任务:用注入的当前档案重建(档案更新→prompt 跟着变)', () => {
    const job = { prompt: '旧快照', scenario: { key: 'xhs_weekly_topics' as const, count: 5 } };
    const prompt = resolveCronPrompt(job, (k) => (k === 'xhs' ? profile : undefined));
    expect(prompt).toContain('【账号档案】');
    expect(prompt).toContain('产出 5 条选题');
    expect(prompt).not.toContain('旧快照');
  });

  it('scenario 任务无档案:仍重建,选通用方向', () => {
    const job = { scenario: { key: 'xhs_weekly_topics' as const } };
    const prompt = resolveCronPrompt(job, () => undefined);
    expect(prompt).toContain('无档案时选通用高共鸣方向');
    expect(prompt).toContain('产出 7 条选题');
  });

  it('oss_radar_weekly:用贡献者档案(oss_radar 槽位)重建扫描 prompt', () => {
    const job = { prompt: '旧快照', scenario: { key: 'oss_radar_weekly' as const, count: 5 } };
    const prompt = resolveCronPrompt(job, (k) => (k === 'oss_radar' ? ossProfile : undefined));
    expect(prompt).toContain('【开源贡献雷达 · 只读调研】');
    expect(prompt).toContain('【贡献者档案】');
    expect(prompt).toContain('主力技术栈:Go / TypeScript');
    expect(prompt).toContain('排除项(一票否决,不要推荐):不碰加密货币项目');
    expect(prompt).toContain('产出数量:5 条机会');
    expect(prompt).not.toContain('旧快照');
  });

  it('oss_radar_weekly 无档案/无 count:仍重建,缺省 5 条、技术栈未指定', () => {
    const job = { scenario: { key: 'oss_radar_weekly' as const } };
    const prompt = resolveCronPrompt(job, () => undefined);
    expect(prompt).toContain('产出数量:5 条机会');
    expect(prompt).toContain('我的技术栈:未指定');
    expect(prompt).not.toContain('贡献者档案');
  });

  it('普通任务:原样返回 job.prompt', () => {
    const job = { prompt: '帮我总结今天的邮件' };
    expect(resolveCronPrompt(job, () => profile)).toBe('帮我总结今天的邮件');
  });

  it('scenario 非法(脏数据/恶意 key):降级回 job.prompt', () => {
    const job = { prompt: '兜底文本', scenario: { key: 'anything_else' } as any };
    expect(resolveCronPrompt(job, () => profile)).toBe('兜底文本');
  });

  it('普通任务 prompt 为空:返回空串(不崩溃)', () => {
    expect(resolveCronPrompt({}, () => undefined)).toBe('');
  });
});
