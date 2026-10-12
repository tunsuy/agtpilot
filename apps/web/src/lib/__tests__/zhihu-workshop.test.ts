import { describe, it, expect } from 'vitest';
import { buildZhihuWorkshopPrompt, ZHIHU_ARTICLE_STYLES, ZHIHU_TOPIC_PRESETS } from '../zhihu-workshop';
import { normalizeScenarioProfile } from '../scenario-profile';

const profileInput = {
  niche: 'AI 工程实践',
  audience: '知乎技术读者',
  toneSamples: '讲依据,不空谈',
  taboos: '不写标题党',
};

describe('buildZhihuWorkshopPrompt · 档案注入', () => {
  it('回归锚点:无档案时 prompt 不出现「账号档案」字样', () => {
    const prompt = buildZhihuWorkshopPrompt({ topic: '大模型科普', style: '专业干货', count: 1 });
    expect(prompt).not.toContain('账号档案');
    expect(prompt).toContain('主题:大模型科普');
  });

  it('profile 传入但档案为空时同样不注入', () => {
    const emptyProfile = normalizeScenarioProfile('zhihu', { niche: 'x', audience: 'y' });
    const hollow = {
      ...emptyProfile!,
      positioning: { niche: '', audience: '' },
      persona: { toneSamples: [], taboos: [] },
    };
    const prompt = buildZhihuWorkshopPrompt({ topic: 'x', style: '专业干货', count: 1, profile: hollow });
    expect(prompt).not.toContain('账号档案');
  });

  it('有档案时注入段出现在主题段之前,且含档案字段', () => {
    const profile = normalizeScenarioProfile('zhihu', profileInput)!;
    const prompt = buildZhihuWorkshopPrompt({ topic: '大模型科普', style: '专业干货', count: 1, profile });
    const profileIdx = prompt.indexOf('【账号档案】');
    const topicIdx = prompt.indexOf('主题:大模型科普');
    expect(profileIdx).toBeGreaterThan(0);
    expect(profileIdx).toBeLessThan(topicIdx);
    expect(prompt).toContain('- 赛道:AI 工程实践');
    expect(prompt).toContain('- 目标人群:知乎技术读者');
    expect(prompt).toContain('「讲依据,不空谈」');
    expect(prompt).toContain('- 禁忌(绝对不允许出现):不写标题党');
  });
});

describe('buildZhihuWorkshopPrompt · 文章包格式契约(与公众号工坊同构)', () => {
  it('成品字段头约定与 --- 分隔约定出现在 prompt 中', () => {
    const prompt = buildZhihuWorkshopPrompt({ topic: '大模型科普', style: '深度分析', count: 2 });
    for (const header of ['【标题】', '【摘要】', '【正文】']) {
      expect(prompt).toContain(header);
    }
    // 交付物 = 成品:唯一终版标题,参谋性字段移除
    expect(prompt).toContain('只输出终版这一个');
    expect(prompt).not.toContain('【标题候选】');
    expect(prompt).not.toContain('5 个备选');
    expect(prompt).not.toContain('【封面建议】');
    expect(prompt).not.toContain('【发布建议】');
    expect(prompt).toContain('单独一行的 ---');
    expect(prompt).toContain('不要输出寒暄');
    // 知乎侧限制写进契约(标题 40 字 / 摘要 120 字 / 正文 1500-3000 字)
    expect(prompt).toContain('40 字');
    expect(prompt).toContain('120 字');
    expect(prompt).toContain('1500-3000');
    // 存草稿是纯文本填入的口径说明(避免 Agent 承诺排版)
    expect(prompt).toContain('纯文本填入');
  });

  it('篇数钳制在 1-3', () => {
    expect(buildZhihuWorkshopPrompt({ style: '专业干货', count: 99 })).toContain('产出数量:3 篇');
    expect(buildZhihuWorkshopPrompt({ style: '专业干货', count: 0 })).toContain('产出数量:1 篇');
    expect(buildZhihuWorkshopPrompt({ style: '专业干货', count: 2 })).toContain('产出数量:2 篇');
  });

  it('红线与存草稿审批、人工发布围栏保留', () => {
    const prompt = buildZhihuWorkshopPrompt({ style: '热点解读', count: 1 });
    expect(prompt).toContain('创作红线');
    expect(prompt).toContain('不得编造');
    expect(prompt).toContain('不标题党');
    expect(prompt).toContain('存入知乎草稿');
    expect(prompt).toContain('审批确认');
    expect(prompt).toContain('人工完成');
    // 草稿托管工具名写进 prompt(Agent 知道用哪个工具)
    expect(prompt).toContain('zhihu_save_article_draft');
    // 发布禁令(三层红线之三:系统提示词层)
    expect(prompt).toContain('严禁调用任何发布类接口');
  });
});

describe('buildZhihuWorkshopPrompt · 主题缺省降级链', () => {
  it('无主题:检索梯度(NewsNow/知乎/X/网页搜索) → 自身知识并注明来源', () => {
    const prompt = buildZhihuWorkshopPrompt({ style: '经验分享', count: 1 });
    expect(prompt).toContain('主题:未指定');
    expect(prompt).toContain('mcp_newsnow_');
    expect(prompt).toContain('mcp_zhihu_');
    expect(prompt).toContain('mcp_twitterapi_io_');
    expect(prompt).toContain('网页搜索');
    expect(prompt).toContain('基于自身知识判断');
    expect(prompt).toContain('注明选题数据来源');
    // 风格嵌入选题语境
    expect(prompt).toContain('「经验分享」');
  });

  it('有主题:不出现调研回退链(主题即指令)', () => {
    const prompt = buildZhihuWorkshopPrompt({ topic: '大模型科普', style: '专业干货', count: 1 });
    expect(prompt).toContain('主题:大模型科普');
    expect(prompt).not.toContain('主题:未指定');
  });
});

describe('ZHIHU_TOPIC_PRESETS / ZHIHU_ARTICLE_STYLES · 预设契约', () => {
  it('三个方向预设,互不重复', () => {
    expect(ZHIHU_TOPIC_PRESETS).toHaveLength(3);
    expect(new Set(ZHIHU_TOPIC_PRESETS).size).toBe(3);
  });

  it('四种文章风格,互不重复', () => {
    expect(ZHIHU_ARTICLE_STYLES).toHaveLength(4);
    expect(new Set(ZHIHU_ARTICLE_STYLES).size).toBe(4);
  });

  it('预设填入主题后走「主题即指令」路径', () => {
    const prompt = buildZhihuWorkshopPrompt({
      topic: ZHIHU_TOPIC_PRESETS[0],
      style: '深度分析',
      count: 1,
    });
    expect(prompt).toContain(`主题:${ZHIHU_TOPIC_PRESETS[0]}`);
    expect(prompt).not.toContain('主题:未指定');
  });
});
