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

describe('CRON_SCENARIOS 注册表(场景单一事实源)', () => {
  it('场景声明齐全:三个订阅场景在注册表内', () => {
    expect(Object.keys(CRON_SCENARIOS).sort()).toEqual([
      'novel_daily_chapter',
      'oss_radar_weekly',
      'xhs_weekly_topics',
    ]);
  });

  it('声明字段完备:key 与注册表条目一致、count 区间自洽、纯函数场景 build 可调', () => {
    for (const [entryKey, spec] of Object.entries(CRON_SCENARIOS)) {
      expect(spec.key).toBe(entryKey);
      expect(spec.profileSlot).toBeTruthy();
      expect(spec.countMin).toBeLessThan(spec.countMax);
      expect(spec.defaultCount).toBeGreaterThanOrEqual(spec.countMin);
      expect(spec.defaultCount).toBeLessThanOrEqual(spec.countMax);
      if (spec.requiresServerState) {
        // novel 日更(现读书库)与 oss_radar 周扫(现读派发历史):build 是诚实占位
        // ——纯函数调它必须抛错并指名服务端路径,绝不静默产出假 prompt
        // (触发时走 server-render.resolveCronPromptServer)
        expect(['novel', 'oss_radar']).toContain(spec.workshopId);
        expect(() => spec.build(spec.defaultCount, undefined)).toThrow(/server-render/);
      } else {
        // 无档案可调(触发时档案可能缺失,绝不能抛)
        expect(typeof spec.build(spec.defaultCount, undefined)).toBe('string');
      }
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

  it('bookId(novel 日更目标书):字符串去空白保留,超长截断 64,非字符串/空白丢弃', () => {
    expect(
      normalizeCronScenario({ key: 'novel_daily_chapter', count: 3000, bookId: '  nv_x1_abc123  ' })
    ).toEqual({ key: 'novel_daily_chapter', count: 3000, bookId: 'nv_x1_abc123' });
    expect(normalizeCronScenario({ key: 'novel_daily_chapter', bookId: 'a'.repeat(100) })).toEqual({
      key: 'novel_daily_chapter',
      count: undefined,
      bookId: 'a'.repeat(64),
    });
    // 非字符串/空白:丢弃(权威校验在触发时 getNovelBook,这里只做松散清洗)
    expect(normalizeCronScenario({ key: 'novel_daily_chapter', bookId: 42 })).toEqual({
      key: 'novel_daily_chapter',
      count: undefined,
      bookId: undefined,
    });
    expect(normalizeCronScenario({ key: 'novel_daily_chapter', bookId: '   ' })).toEqual({
      key: 'novel_daily_chapter',
      count: undefined,
      bookId: undefined,
    });
    // novel count 区间 = 每章字数 1000-6000
    expect(normalizeCronScenario({ key: 'novel_daily_chapter', count: 500 })!.count).toBeUndefined();
    expect(normalizeCronScenario({ key: 'novel_daily_chapter', count: 2500 })!.count).toBe(2500);
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

  it('oss_radar_weekly:requiresServerState(派发历史服务端现读),纯函数路径诚实抛错', () => {
    const job = { prompt: '旧快照', scenario: { key: 'oss_radar_weekly' as const, count: 5 } };
    expect(() => resolveCronPrompt(job, () => undefined)).toThrow(/需要服务端现读状态/);
    // 服务端重建(档案 + 派发历史注入)的断言在 server-render.test.ts
  });

  it('普通任务:原样返回 job.prompt', () => {
    const job = { prompt: '帮我总结今天的邮件' };
    expect(resolveCronPrompt(job, () => profile)).toBe('帮我总结今天的邮件');
  });

  it('requiresServerState 场景(novel 日更):纯函数路径诚实抛错,强制走服务端解析', () => {
    const job = {
      prompt: '旧快照',
      scenario: { key: 'novel_daily_chapter' as const, count: 3000, bookId: 'nv_x1_a1b2c3' },
    };
    expect(() => resolveCronPrompt(job, () => undefined)).toThrow(/需要服务端现读状态/);
  });

  it('scenario 非法(脏数据/恶意 key):降级回 job.prompt', () => {
    const job = { prompt: '兜底文本', scenario: { key: 'anything_else' } as any };
    expect(resolveCronPrompt(job, () => profile)).toBe('兜底文本');
  });

  it('普通任务 prompt 为空:返回空串(不崩溃)', () => {
    expect(resolveCronPrompt({}, () => undefined)).toBe('');
  });
});
