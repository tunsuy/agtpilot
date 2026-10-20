import { describe, it, expect } from 'vitest';
import { buildWeiboWorkshopPrompt } from '../context';
import { WORKSHOP_SKILL } from '../skill';

/**
 * 微博工坊接通参考资料(2026-10-20):此前 skill.run 不读 params.materials,
 * 表单勾选被静默丢弃。这里锁定 materials 透传与空主题的材料模式分支。
 */
describe('buildWeiboWorkshopPrompt · 材料模式(勾交付物 + 空主题)', () => {
  const materials = [{ id: 'art_1', title: '行业研报' }];

  it('空主题 + 有材料:以参考资料为素材直接编写,不进热点调研', () => {
    const prompt = buildWeiboWorkshopPrompt({ style: '热点点评', count: 1, materials });
    expect(prompt).toContain('主题:未指定,不需要调研热点选题');
    expect(prompt).toContain('【参考资料】列出的交付物为核心素材直接编写');
    expect(prompt).toContain('read_reference_material');
    expect(prompt).toContain('「热点点评」');
    expect(prompt).not.toContain('请先调研热点选题');
    expect(prompt).not.toContain('微博实时热搜');
    expect(prompt).toContain('【资料1：行业研报】(materialId=art_1)');
  });

  it('有主题 + 有材料:主题段与材料段并存', () => {
    const prompt = buildWeiboWorkshopPrompt({ topic: '台风预警', style: '热点点评', count: 1, materials });
    expect(prompt).toContain('主题:台风预警');
    expect(prompt).not.toContain('主题:未指定');
    expect(prompt).toContain('【参考资料】');
  });

  it('无材料:热点调研分支保留(NewsNow 微博热搜提示不受影响)', () => {
    const prompt = buildWeiboWorkshopPrompt({ style: '热点点评', count: 1 });
    expect(prompt).toContain('请先调研热点选题');
    expect(prompt).toContain('微博实时热搜');
    expect(prompt).not.toContain('不需要调研热点选题');
    expect(prompt).not.toContain('【参考资料】');
  });
});

describe('weibo skill.run · params.materials 透传', () => {
  it('勾选材料进入 prompt(不再静默丢弃)', () => {
    const run = WORKSHOP_SKILL.run(
      { topic: '', style: '干货分享', count: 1, materials: [{ id: 'art_9', title: '周报' }] },
      {} as any
    );
    expect(run.prompt).toContain('不需要调研热点选题');
    expect(run.prompt).toContain('【资料1：周报】(materialId=art_9)');
  });

  it('无材料时 prompt 与不传 materials 逐字节一致', () => {
    const a = WORKSHOP_SKILL.run({ topic: '', style: '干货分享', count: 1 }, {} as any).prompt;
    const b = WORKSHOP_SKILL.run({ topic: '', style: '干货分享', count: 1, materials: [] }, {} as any).prompt;
    expect(a).toBe(b);
  });
});
