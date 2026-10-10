import { describe, it, expect } from 'vitest';
import { normalizeScenarioProfile, buildProfileSection, type ScenarioProfile } from '../scenario-profile';

const baseInput = {
  niche: '秋冬通勤穿搭',
  audience: '30+ 通勤女性',
  differentiation: '只写平价可复制的组合',
  toneSamples: '姐妹们这套真的绝\n打工人早八也能三分钟出门',
  taboos: '不要感叹号、不提价格',
  postsPerWeek: 3,
};

describe('normalizeScenarioProfile', () => {
  it('扁平输入全字段:拆语气样例按行、禁忌按标点、节奏合法', () => {
    const p = normalizeScenarioProfile('xhs', baseInput);
    expect(p).not.toBeNull();
    expect(p!.scenarioKey).toBe('xhs');
    expect(p!.positioning.niche).toBe('秋冬通勤穿搭');
    expect(p!.positioning.audience).toBe('30+ 通勤女性');
    expect(p!.positioning.differentiation).toBe('只写平价可复制的组合');
    expect(p!.persona.toneSamples).toEqual(['姐妹们这套真的绝', '打工人早八也能三分钟出门']);
    expect(p!.persona.taboos).toEqual(['不要感叹号', '不提价格']);
    expect(p!.cadence.postsPerWeek).toBe(3);
    expect(p!.insights).toEqual([]);
    expect(p!.version).toBe(1);
  });

  it('嵌套输入(positioning/persona/cadence)也能识别', () => {
    const p = normalizeScenarioProfile('xhs', {
      positioning: { niche: '职场干货', audience: '应届生' },
      persona: { toneSamples: ['语气一'], taboos: ['禁忌一', '禁忌二'] },
      cadence: { postsPerWeek: 5 },
    });
    expect(p!.positioning.niche).toBe('职场干货');
    expect(p!.persona.taboos).toEqual(['禁忌一', '禁忌二']);
    expect(p!.cadence.postsPerWeek).toBe(5);
  });

  it('必填缺失(无赛道或无人群)返回 null', () => {
    expect(normalizeScenarioProfile('xhs', { niche: '', audience: 'x' })).toBeNull();
    expect(normalizeScenarioProfile('xhs', { niche: 'x' })).toBeNull();
    expect(normalizeScenarioProfile('xhs', null)).toBeNull();
    expect(normalizeScenarioProfile('xhs', '不是对象')).toBeNull();
  });

  it('类型不对的字段静默剔除而不是报错', () => {
    const p = normalizeScenarioProfile('xhs', { ...baseInput, postsPerWeek: 999, differentiation: 123 });
    expect(p!.cadence.postsPerWeek).toBeUndefined();
    expect(p!.positioning.differentiation).toBeUndefined();
  });

  it('insights 只保留有 claim 的条目并补 at', () => {
    const p = normalizeScenarioProfile('xhs', {
      ...baseInput,
      insights: [{ claim: '封面带价格数字数据更好', evidence: '近 4 篇对比' }, { claim: '' }, '垃圾条目'],
    });
    expect(p!.insights).toHaveLength(1);
    expect(p!.insights[0].claim).toBe('封面带价格数字数据更好');
    expect(p!.insights[0].at).toBeGreaterThan(0);
  });

  it('保留既有 createdAt/version(编辑回传场景)', () => {
    const p = normalizeScenarioProfile('xhs', { ...baseInput, createdAt: 1000, version: 4 });
    expect(p!.createdAt).toBe(1000);
    expect(p!.version).toBe(4);
  });
});

const profile: ScenarioProfile = {
  scenarioKey: 'xhs',
  version: 1,
  positioning: { niche: '秋冬通勤穿搭', audience: '30+ 通勤女性', differentiation: '只写平价可复制的组合' },
  persona: {
    toneSamples: ['姐妹们这套真的绝', '打工人早八也能三分钟出门'],
    taboos: ['不要感叹号', '不提价格'],
  },
  cadence: { postsPerWeek: 3 },
  insights: [{ claim: '封面带价格数字的笔记数据稳定更好', at: 1 }],
  createdAt: 1,
  updatedAt: 1,
};

describe('buildProfileSection', () => {
  it('完整档案输出全部段落,含账号档案标题行与认知段', () => {
    const section = buildProfileSection(profile)!;
    expect(section).toContain('【账号档案】');
    expect(section).toContain('- 赛道:秋冬通勤穿搭');
    expect(section).toContain('- 目标人群:30+ 通勤女性');
    expect(section).toContain('- 差异点:只写平价可复制的组合');
    expect(section).toContain('「姐妹们这套真的绝」');
    expect(section).toContain('- 禁忌(绝对不允许出现):不要感叹号;不提价格');
    expect(section).toContain('- 发布节奏:每周约 3 篇');
    expect(section).toContain('- 已验证认知(选题与创作优先遵循):');
    expect(section).toContain('  - 封面带价格数字的笔记数据稳定更好');
  });

  it('空档案(无定位无人设)返回 null,不注入', () => {
    const empty: ScenarioProfile = {
      scenarioKey: 'xhs',
      version: 1,
      positioning: { niche: '', audience: '' },
      persona: { toneSamples: [], taboos: [] },
      cadence: {},
      insights: [],
      createdAt: 1,
      updatedAt: 1,
    };
    expect(buildProfileSection(empty)).toBeNull();
  });

  it('部分字段只出非空行;insights 空不出认知段', () => {
    const partial: ScenarioProfile = {
      ...profile,
      positioning: { niche: '职场干货', audience: '' },
      persona: { toneSamples: [], taboos: ['不提价格'] },
      cadence: {},
      insights: [],
    };
    const section = buildProfileSection(partial)!;
    expect(section).toContain('- 赛道:职场干货');
    expect(section).not.toContain('目标人群');
    expect(section).not.toContain('语气样例');
    expect(section).toContain('- 禁忌(绝对不允许出现):不提价格');
    expect(section).not.toContain('已验证认知');
    expect(section).not.toContain('发布节奏');
  });
});
