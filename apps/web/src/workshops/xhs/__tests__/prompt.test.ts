import { describe, it, expect } from 'vitest';
import { buildXhsWorkshopPrompt } from '../context';
import { normalizeScenarioProfile } from '@/lib/scenario-profile';

const profileInput = {
  niche: '秋冬通勤穿搭',
  audience: '30+ 通勤女性',
  toneSamples: '姐妹们这套真的绝',
  taboos: '不要感叹号',
};

describe('buildXhsWorkshopPrompt · 档案注入', () => {
  it('回归锚点:无档案时 prompt 不出现「账号档案」字样', () => {
    const prompt = buildXhsWorkshopPrompt({ topic: '羽绒服', style: '种草推荐', count: 1 });
    expect(prompt).not.toContain('账号档案');
    expect(prompt).toContain('主题:羽绒服');
  });

  it('profile 传入但档案为空时同样不注入', () => {
    const emptyProfile = normalizeScenarioProfile('xhs', { niche: 'x', audience: 'y' });
    // 构造一个定位人设全空的档案
    const hollow = { ...emptyProfile!, positioning: { niche: '', audience: '' }, persona: { toneSamples: [], taboos: [] } };
    const prompt = buildXhsWorkshopPrompt({ topic: '羽绒服', style: '种草推荐', count: 1, profile: hollow });
    expect(prompt).not.toContain('账号档案');
  });

  it('有档案时注入段出现在主题段之前,且含档案字段', () => {
    const profile = normalizeScenarioProfile('xhs', profileInput)!;
    const prompt = buildXhsWorkshopPrompt({ topic: '羽绒服', style: '种草推荐', count: 1, profile });
    const profileIdx = prompt.indexOf('【账号档案】');
    const topicIdx = prompt.indexOf('主题:羽绒服');
    expect(profileIdx).toBeGreaterThan(0);
    expect(profileIdx).toBeLessThan(topicIdx);
    expect(prompt).toContain('- 赛道:秋冬通勤穿搭');
    expect(prompt).toContain('- 目标人群:30+ 通勤女性');
    expect(prompt).toContain('「姐妹们这套真的绝」');
    expect(prompt).toContain('- 禁忌(绝对不允许出现):不要感叹号');
  });
});

describe('buildXhsWorkshopPrompt · 笔记包格式契约', () => {
  it('字段头约定与 --- 分隔约定出现在 prompt 中', () => {
    const prompt = buildXhsWorkshopPrompt({ topic: '羽绒服', style: '种草推荐', count: 2 });
    for (const header of ['【标题】', '【封面文案】', '【正文】', '【标签】']) {
      expect(prompt).toContain(header);
    }
    // 交付物 = 可直接发布的成品:唯一终版标题,参谋性字段移除
    expect(prompt).toContain('只输出终版这一个');
    expect(prompt).not.toContain('【标题候选】');
    expect(prompt).not.toContain('5 个备选');
    expect(prompt).not.toContain('【发布建议】');
    expect(prompt).toContain('单独一行的 ---');
    expect(prompt).toContain('不要输出寒暄');
  });

  it('篇数钳制在 1-3', () => {
    expect(buildXhsWorkshopPrompt({ style: '种草推荐', count: 99 })).toContain('产出数量:3 篇');
    expect(buildXhsWorkshopPrompt({ style: '种草推荐', count: 0 })).toContain('产出数量:1 篇');
    expect(buildXhsWorkshopPrompt({ style: '种草推荐', count: 2 })).toContain('产出数量:2 篇');
  });

  it('红线与人工发布提醒保留', () => {
    const prompt = buildXhsWorkshopPrompt({ style: '种草推荐', count: 1 });
    expect(prompt).toContain('创作红线');
    expect(prompt).toContain('人工确认完成');
    expect(prompt).toContain('真机唤起');
  });
});

describe('buildXhsWorkshopPrompt · 主题缺省回退(P1 降级链)', () => {
  it('无主题:调研热点选题,优先 xhs_read_creator_data,末级回退自身知识并注明来源', () => {
    const prompt = buildXhsWorkshopPrompt({ style: '干货教程', count: 1 });
    expect(prompt).toContain('主题:未指定');
    expect(prompt).toContain('xhs_read_creator_data');
    expect(prompt).toContain('page=hot_topics');
    expect(prompt).toContain('query=关键词');
    // 降级链②:共享检索梯度(NewsNow/知乎/X/网页搜索)③自身知识
    expect(prompt).toContain('mcp_newsnow_');
    expect(prompt).toContain('mcp_zhihu_');
    expect(prompt).toContain('mcp_twitterapi_io_');
    expect(prompt).toContain('网页搜索');
    expect(prompt).toContain('基于自身知识判断');
    expect(prompt).toContain('注明选题数据来源');
    // 提示嵌入风格语境
    expect(prompt).toContain('「干货教程」');
  });

  it('有主题:不出现调研回退链(主题即指令)', () => {
    const prompt = buildXhsWorkshopPrompt({ topic: '羽绒服', style: '种草推荐', count: 1 });
    expect(prompt).toContain('主题:羽绒服');
    expect(prompt).not.toContain('主题:未指定');
    expect(prompt).not.toContain('page=hot_topics');
  });
});

describe('buildXhsWorkshopPrompt · 材料模式(勾交付物 + 空主题)', () => {
  const materials = [{ id: 'art_1', title: '行业研报' }];

  it('空主题 + 有材料:以参考资料为素材直接编写,不进热点调研', () => {
    const prompt = buildXhsWorkshopPrompt({ style: '干货教程', count: 1, materials });
    expect(prompt).toContain('主题:未指定,不需要调研热点选题');
    expect(prompt).toContain('【参考资料】列出的交付物为核心素材直接编写');
    expect(prompt).toContain('read_reference_material');
    expect(prompt).toContain('「干货教程」');
    // 热点调研分支不出现
    expect(prompt).not.toContain('请先调研热点选题');
    expect(prompt).not.toContain('page=hot_topics');
    // 材料引用段照常追加
    expect(prompt).toContain('【资料1：行业研报】(materialId=art_1)');
  });

  it('有主题 + 有材料:主题段与材料段并存(主题=角度,材料=事实来源)', () => {
    const prompt = buildXhsWorkshopPrompt({ topic: '羽绒服', style: '种草推荐', count: 1, materials });
    expect(prompt).toContain('主题:羽绒服');
    expect(prompt).not.toContain('主题:未指定');
    expect(prompt).toContain('【参考资料】');
  });

  it('空主题 + 材料为脏数据(解析后为空):回退热点调研分支', () => {
    const prompt = buildXhsWorkshopPrompt({ style: '种草推荐', count: 1, materials: [{ title: '无id' }] as any });
    expect(prompt).toContain('请先调研热点选题');
    expect(prompt).not.toContain('不需要调研热点选题');
  });
});
