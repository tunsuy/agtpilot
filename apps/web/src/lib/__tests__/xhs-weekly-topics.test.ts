import { describe, it, expect } from 'vitest';
import { buildXhsWeeklyTopicsPrompt } from '../xhs-workshop';
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

describe('buildXhsWeeklyTopicsPrompt', () => {
  it('有档案时注入【账号档案】段落与经验结论', () => {
    const prompt = buildXhsWeeklyTopicsPrompt({ count: 7, profile });
    expect(prompt).toContain('【账号档案】');
    expect(prompt).toContain('秋冬通勤穿搭');
    expect(prompt).toContain('优先结合账号档案中的经验结论');
    expect(prompt).toContain('产出 7 条选题');
  });

  it('无档案时不出现「账号档案」字样(回归锚点)', () => {
    const prompt = buildXhsWeeklyTopicsPrompt({ count: 7 });
    expect(prompt).not.toContain('【账号档案】');
    expect(prompt).toContain('无档案时选通用高共鸣方向');
  });

  it('红线:任务只读,严禁发布与写操作(订阅任务绝不进审批态)', () => {
    const prompt = buildXhsWeeklyTopicsPrompt({ count: 5, profile });
    expect(prompt).toContain('本任务全程只读');
    expect(prompt).toContain('严禁发布');
    expect(prompt).toContain('写操作类浏览器工具');
  });

  it('选题字段头齐全:方向/标题钩子/切入角度/依据/配图建议/建议发布日', () => {
    const prompt = buildXhsWeeklyTopicsPrompt({ count: 7 });
    for (const field of ['【选题方向】', '【标题钩子】', '【切入角度】', '【依据】', '【配图建议】', '【建议发布日】']) {
      expect(prompt).toContain(field);
    }
    expect(prompt).toContain('条与条之间用单独一行的 --- 分隔');
  });

  it('count 边界:下限 3、上限 10、缺省 7', () => {
    expect(buildXhsWeeklyTopicsPrompt({ count: 1 })).toContain('产出 3 条选题');
    expect(buildXhsWeeklyTopicsPrompt({ count: 99 })).toContain('产出 10 条选题');
    expect(buildXhsWeeklyTopicsPrompt({})).toContain('产出 7 条选题');
  });
});
