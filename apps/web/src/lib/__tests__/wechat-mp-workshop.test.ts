import { describe, it, expect } from 'vitest';
import { buildWechatMpWorkshopPrompt, WECHAT_MP_TOPIC_PRESETS } from '../wechat-mp-workshop';
import { normalizeScenarioProfile } from '../scenario-profile';

const profileInput = {
  niche: 'AI 工具测评',
  audience: '科技自媒体读者',
  toneSamples: '说人话,别端着',
  taboos: '不写标题党',
};

describe('buildWechatMpWorkshopPrompt · 档案注入', () => {
  it('回归锚点:无档案时 prompt 不出现「账号档案」字样', () => {
    const prompt = buildWechatMpWorkshopPrompt({ topic: '大模型科普', style: '深度长文', count: 1 });
    expect(prompt).not.toContain('账号档案');
    expect(prompt).toContain('主题:大模型科普');
  });

  it('profile 传入但档案为空时同样不注入', () => {
    const emptyProfile = normalizeScenarioProfile('wechat_mp', { niche: 'x', audience: 'y' });
    const hollow = {
      ...emptyProfile!,
      positioning: { niche: '', audience: '' },
      persona: { toneSamples: [], taboos: [] },
    };
    const prompt = buildWechatMpWorkshopPrompt({ topic: 'x', style: '深度长文', count: 1, profile: hollow });
    expect(prompt).not.toContain('账号档案');
  });

  it('有档案时注入段出现在主题段之前,且含档案字段', () => {
    const profile = normalizeScenarioProfile('wechat_mp', profileInput)!;
    const prompt = buildWechatMpWorkshopPrompt({ topic: '大模型科普', style: '深度长文', count: 1, profile });
    const profileIdx = prompt.indexOf('【账号档案】');
    const topicIdx = prompt.indexOf('主题:大模型科普');
    expect(profileIdx).toBeGreaterThan(0);
    expect(profileIdx).toBeLessThan(topicIdx);
    expect(prompt).toContain('- 赛道:AI 工具测评');
    expect(prompt).toContain('- 目标人群:科技自媒体读者');
    expect(prompt).toContain('「说人话,别端着」');
    expect(prompt).toContain('- 禁忌(绝对不允许出现):不写标题党');
  });
});

describe('buildWechatMpWorkshopPrompt · 文章包格式契约', () => {
  it('五字段头约定与 --- 分隔约定出现在 prompt 中', () => {
    const prompt = buildWechatMpWorkshopPrompt({ topic: '大模型科普', style: '深度长文', count: 2 });
    for (const header of ['【标题候选】', '【摘要】', '【正文】', '【封面建议】', '【发布建议】']) {
      expect(prompt).toContain(header);
    }
    expect(prompt).toContain('单独一行的 ---');
    expect(prompt).toContain('不要输出寒暄');
    // 公众号平台限制写进契约(标题 64 字 / 摘要 120 字 / 正文 1500-3000 字)
    expect(prompt).toContain('64 字');
    expect(prompt).toContain('120 字');
    expect(prompt).toContain('1500-3000');
  });

  it('篇数钳制在 1-3', () => {
    expect(buildWechatMpWorkshopPrompt({ style: '深度长文', count: 99 })).toContain('产出数量:3 篇');
    expect(buildWechatMpWorkshopPrompt({ style: '深度长文', count: 0 })).toContain('产出数量:1 篇');
    expect(buildWechatMpWorkshopPrompt({ style: '深度长文', count: 2 })).toContain('产出数量:2 篇');
  });

  it('红线与投草稿审批、人工发布提醒保留', () => {
    const prompt = buildWechatMpWorkshopPrompt({ style: '观点评论', count: 1 });
    expect(prompt).toContain('创作红线');
    expect(prompt).toContain('不得编造');
    expect(prompt).toContain('不标题党');
    expect(prompt).toContain('投草稿箱');
    expect(prompt).toContain('审批确认');
    expect(prompt).toContain('人工完成');
    // 草稿箱直投工具名写进 prompt(Agent 知道用哪个工具)
    expect(prompt).toContain('wechat_mp_create_draft');
    // 群发/发布禁令
    expect(prompt).toContain('freepublish');
  });
});

describe('buildWechatMpWorkshopPrompt · 主题缺省降级链', () => {
  it('无主题:知乎热榜/网页搜索 → 自身知识并注明来源', () => {
    const prompt = buildWechatMpWorkshopPrompt({ style: '热点解读', count: 1 });
    expect(prompt).toContain('主题:未指定');
    expect(prompt).toContain('知乎热榜');
    expect(prompt).toContain('网页搜索');
    expect(prompt).toContain('基于你自身知识');
    expect(prompt).toContain('注明选题数据来源');
    // 风格嵌入选题语境
    expect(prompt).toContain('「热点解读」');
  });

  it('有主题:不出现调研回退链(主题即指令)', () => {
    const prompt = buildWechatMpWorkshopPrompt({ topic: '大模型科普', style: '深度长文', count: 1 });
    expect(prompt).toContain('主题:大模型科普');
    expect(prompt).not.toContain('主题:未指定');
  });
});

describe('WECHAT_MP_TOPIC_PRESETS · 方向预设契约', () => {
  it('三个 AI 垂类方向,互不重复(看行业/追新/上手)', () => {
    expect(WECHAT_MP_TOPIC_PRESETS).toHaveLength(3);
    expect(new Set(WECHAT_MP_TOPIC_PRESETS).size).toBe(3);
    for (const p of WECHAT_MP_TOPIC_PRESETS) expect(p).toContain('AI');
  });

  it('预设填入主题后走「主题即指令」路径', () => {
    const prompt = buildWechatMpWorkshopPrompt({
      topic: WECHAT_MP_TOPIC_PRESETS[0],
      style: '观点评论',
      count: 1,
    });
    expect(prompt).toContain(`主题:${WECHAT_MP_TOPIC_PRESETS[0]}`);
    expect(prompt).not.toContain('主题:未指定');
  });
});
