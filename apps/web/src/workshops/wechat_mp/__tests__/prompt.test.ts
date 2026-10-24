import { describe, it, expect, vi } from 'vitest';
import { buildWechatMpWorkshopPrompt, buildStyleRefToolHint, parseStyleRefs, WECHAT_MP_TOPIC_PRESETS } from '../context';
import { normalizeScenarioProfile } from '@/lib/scenario-profile';

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
  it('成品字段头约定与 --- 分隔约定出现在 prompt 中', () => {
    const prompt = buildWechatMpWorkshopPrompt({ topic: '大模型科普', style: '深度长文', count: 2 });
    for (const header of ['【标题】', '【摘要】', '【正文】']) {
      expect(prompt).toContain(header);
    }
    // 交付物 = 可直接发布的成品:Agent 拍板唯一终版标题,参谋性字段不再出现在交付规格里
    expect(prompt).toContain('只输出终版这一个');
    expect(prompt).toContain('可直接发布的成品');
    expect(prompt).not.toContain('【标题候选】');
    expect(prompt).not.toContain('5 个备选');
    expect(prompt).not.toContain('【封面建议】');
    expect(prompt).not.toContain('【发布建议】');
    expect(prompt).toContain('单独一行的 ---');
    expect(prompt).toContain('不要输出寒暄');
    // 公众号平台限制写进契约(标题 64 字 / 摘要 120 字);字数预算按风格分档
    expect(prompt).toContain('64 字');
    expect(prompt).toContain('120 字');
    expect(prompt).toContain('2500-5000');
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
  it('无主题:检索梯度(NewsNow/知乎/X/网页搜索) → 自身知识并注明来源', () => {
    const prompt = buildWechatMpWorkshopPrompt({ style: '热点解读', count: 1 });
    expect(prompt).toContain('主题:未指定');
    expect(prompt).toContain('mcp_newsnow_');
    expect(prompt).toContain('mcp_zhihu_');
    expect(prompt).toContain('mcp_twitterapi_io_');
    expect(prompt).toContain('网页搜索');
    expect(prompt).toContain('基于自身知识判断');
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

describe('buildWechatMpWorkshopPrompt · 材料模式(勾交付物 + 空主题)', () => {
  const materials = [{ id: 'art_1', title: '行业研报' }];

  it('空主题 + 有材料:以参考资料为素材直接编写,不进热点调研;材料翻译契约与人工语气条款在位', () => {
    const prompt = buildWechatMpWorkshopPrompt({ style: '深度长文', count: 1, materials });
    expect(prompt).toContain('主题:未指定,不需要调研热点选题');
    expect(prompt).toContain('【参考资料】列出的交付物为核心素材直接编写');
    expect(prompt).toContain('read_reference_material');
    expect(prompt).toContain('「深度长文」');
    // 材料翻译契约:本条事故的三处病灶(搬运结构/证据壳进正文/编造出处)各有一钉
    expect(prompt).toContain('素材不是结构');
    expect(prompt).toContain('只删证据壳不删知识点');
    expect(prompt).toContain('不编造出处');
    expect(prompt).not.toContain('请先调研热点选题');
    expect(prompt).toContain('【资料1：行业研报】(materialId=art_1)');
  });

  it('深度长文按 2500-5000 字预算;其他风格维持 1500-3000 字', () => {
    const deep = buildWechatMpWorkshopPrompt({ topic: 'x', style: '深度长文', count: 1 });
    expect(deep).toContain('2500-5000 字');
    expect(deep).not.toContain('1500-3000');
    const casual = buildWechatMpWorkshopPrompt({ topic: 'x', style: '热点解读', count: 1 });
    expect(casual).toContain('1500-3000 字');
    expect(casual).not.toContain('2500-5000');
  });

  it('反 AI 语气条款在位:直说、不硬造比喻、不逐段配金句、术语随用随讲', () => {
    const prompt = buildWechatMpWorkshopPrompt({ topic: 'x', style: '深度长文', count: 1 });
    expect(prompt).toContain('像工程师写技术博客那样直说');
    expect(prompt).toContain('不硬造比喻');
    expect(prompt).toContain('不把观点包装成金句警句');
    expect(prompt).toContain('随用随讲');
  });

  it('有主题 + 有材料:主题段与材料段并存', () => {
    const prompt = buildWechatMpWorkshopPrompt({ topic: 'AI 编程工具横评', style: '深度长文', count: 1, materials });
    expect(prompt).toContain('主题:AI 编程工具横评');
    expect(prompt).not.toContain('主题:未指定');
    expect(prompt).toContain('【参考资料】');
  });
});

describe('buildWechatMpWorkshopPrompt · 风格参照(范文链接)', () => {
  it('回归锚点:无 styleRefs 时 prompt 不出现「风格参照」段(与旧版逐字节一致)', () => {
    const prompt = buildWechatMpWorkshopPrompt({ topic: '大模型科普', style: '深度长文', count: 1 });
    expect(prompt).not.toContain('【风格参照】');
    expect(prompt).not.toContain('browser_navigate');
  });

  it('有效链接 → 注入风格契约:先读范文、提炼风格档案、优先于抽象风格、只学不抄、失败降级', () => {
    const prompt = buildWechatMpWorkshopPrompt({
      topic: 'AI 编程工具横评',
      style: '深度长文',
      count: 1,
      styleRefs: 'https://blog.example.com/post-1',
    });
    expect(prompt).toContain('【风格参照】');
    expect(prompt).toContain('1. https://blog.example.com/post-1');
    // 读取工具指路:browser_navigate 主腿 + nextOffset 续读语义
    expect(prompt).toContain('browser_navigate');
    expect(prompt).toContain('nextOffset');
    // 覆盖关系:范文档案优先于「文章风格」一行
    expect(prompt).toContain('优先于上面「文章风格」一行');
    // 版权红线:只学风格
    expect(prompt).toContain('不得复用范文的表达、例子、数据或标题');
    // 全部读取失败的降级:按风格行继续 + 成稿末尾注明
    expect(prompt).toContain('范文未能读取');
    // 契约段位于「文章风格」行之后(覆盖关系就近声明)
    expect(prompt.indexOf('文章风格:深度长文')).toBeLessThan(prompt.indexOf('【风格参照】'));
  });

  it('多条链接按编号列出;超过 3 条截断', () => {
    const prompt = buildWechatMpWorkshopPrompt({
      style: '深度长文',
      count: 1,
      topic: 'x',
      styleRefs: 'https://a.com/1\nhttps://a.com/2\nhttps://a.com/3\nhttps://a.com/4',
    });
    expect(prompt).toContain('1. https://a.com/1');
    expect(prompt).toContain('3. https://a.com/3');
    expect(prompt).not.toContain('a.com/4');
  });

  it('与材料模式并存:内容来源不变,风格契约叠加(选题从资料、风格从范文)', async () => {
    const prompt = buildWechatMpWorkshopPrompt({
      style: '深度长文',
      count: 1,
      materials: [{ id: 'art_1', title: '行业研报' }],
      styleRefs: 'https://blog.example.com/style',
    });
    expect(prompt).toContain('主题:未指定,不需要调研热点选题');
    expect(prompt).toContain('【参考资料】');
    expect(prompt).toContain('【风格参照】');
  });
});

describe('buildStyleRefToolHint · 按实际挂载面渲染工具指引', () => {
  it('无 FIRECRAWL_API_KEY → 只指 browser_navigate 主腿,不提未挂载的 Firecrawl', async () => {
    vi.stubEnv('FIRECRAWL_API_KEY', '');
    try {
      const hint = buildStyleRefToolHint();
      expect(hint).toContain('browser_navigate');
      expect(hint).toContain('nextOffset');
      expect(hint).not.toContain('browser_firecrawl_scrape');
      const prompt = buildWechatMpWorkshopPrompt({
        topic: 'x',
        style: '深度长文',
        count: 1,
        styleRefs: 'https://blog.example.com/a',
      });
      expect(prompt).toContain('browser_navigate');
      expect(prompt).not.toContain('browser_firecrawl_scrape');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('配了 FIRECRAWL_API_KEY → 追加 Firecrawl 降级腿', async () => {
    vi.stubEnv('FIRECRAWL_API_KEY', 'test-key');
    try {
      const hint = buildStyleRefToolHint();
      expect(hint).toContain('browser_navigate');
      expect(hint).toContain('browser_firecrawl_scrape');
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('parseStyleRefs · 输入收敛', () => {
  it('textarea 原文按换行/逗号/空格切分,数组形态同样接受', () => {
    expect(parseStyleRefs('https://a.com/1\nhttps://a.com/2,https://a.com/3 https://a.com/4')).toEqual([
      'https://a.com/1',
      'https://a.com/2',
      'https://a.com/3',
    ]);
    expect(parseStyleRefs(['https://a.com/1', 'https://a.com/2'])).toEqual([
      'https://a.com/1',
      'https://a.com/2',
    ]);
  });

  it('非 http(s) 协议与非法链接整条丢弃(javascript:/ftp:/裸文本不进 prompt)', () => {
    expect(
      parseStyleRefs('javascript:alert(1)\nftp://x.com/a\nnot-a-url\nhttps://ok.com/x')
    ).toEqual(['https://ok.com/x']);
  });

  it('去重;空输入/非字符串非数组 → 空数组', () => {
    expect(parseStyleRefs('https://a.com/1\nhttps://a.com/1')).toEqual(['https://a.com/1']);
    expect(parseStyleRefs('')).toEqual([]);
    expect(parseStyleRefs('   \n  ')).toEqual([]);
    expect(parseStyleRefs(undefined)).toEqual([]);
    expect(parseStyleRefs(42)).toEqual([]);
    expect(parseStyleRefs(['https://a.com/1', 42, null])).toEqual(['https://a.com/1']);
  });

  it('超长链接(>500 字符)整条丢弃(截断会指向错误页面)', () => {
    const long = `https://a.com/${'p'.repeat(600)}`;
    expect(parseStyleRefs(`${long}\nhttps://ok.com/x`)).toEqual(['https://ok.com/x']);
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
