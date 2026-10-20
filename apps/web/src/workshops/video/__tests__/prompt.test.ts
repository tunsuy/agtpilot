import { describe, it, expect } from 'vitest';
import { buildVideoScriptPrompt } from '../context';
import { WORKSHOP_SKILL_DOUYIN, WORKSHOP_SKILL_BILIBILI } from '../skill';

/**
 * 抖音/B站脚本工坊接通参考资料(2026-10-20):此前 skill.run 不读 params.materials,
 * 表单勾选被静默丢弃。这里锁定 materials 透传与空主题的材料模式分支。
 */
describe('buildVideoScriptPrompt · 材料模式(勾交付物 + 空主题)', () => {
  const materials = [{ id: 'art_1', title: '行业研报' }];

  it('空主题 + 有材料:以参考资料为素材直接编写,平台/时长入语境', () => {
    const prompt = buildVideoScriptPrompt({ platform: 'douyin', duration: '60 秒', count: 1, materials });
    expect(prompt).toContain('主题:未指定,不需要调研热点选题');
    expect(prompt).toContain('【参考资料】列出的交付物为核心素材直接编写');
    expect(prompt).toContain('read_reference_material');
    expect(prompt).toContain('抖音「60 秒」时长');
    expect(prompt).not.toContain('请先调研热点选题');
    expect(prompt).toContain('【资料1：行业研报】(materialId=art_1)');
  });

  it('B站平台名注入材料模式文案', () => {
    const prompt = buildVideoScriptPrompt({ platform: 'bilibili', duration: '3 分钟', count: 1, materials });
    expect(prompt).toContain('B站「3 分钟」时长');
  });

  it('有主题 + 有材料:主题段与材料段并存', () => {
    const prompt = buildVideoScriptPrompt({ topic: '一人食晚餐', platform: 'douyin', duration: '60 秒', count: 1, materials });
    expect(prompt).toContain('主题:一人食晚餐');
    expect(prompt).not.toContain('主题:未指定');
    expect(prompt).toContain('【参考资料】');
  });

  it('无材料:热点调研分支保留', () => {
    const prompt = buildVideoScriptPrompt({ platform: 'douyin', duration: '60 秒', count: 1 });
    expect(prompt).toContain('请先调研热点选题');
    expect(prompt).not.toContain('不需要调研热点选题');
    expect(prompt).not.toContain('【参考资料】');
  });
});

describe('video skill.run · params.materials 透传', () => {
  it('抖音:勾选材料进入 prompt(不再静默丢弃)', () => {
    const run = WORKSHOP_SKILL_DOUYIN.run(
      { topic: '', duration: '60 秒', count: 1, materials: [{ id: 'art_9', title: '周报' }] },
      {} as any
    );
    expect(run.prompt).toContain('不需要调研热点选题');
    expect(run.prompt).toContain('【资料1：周报】(materialId=art_9)');
  });

  it('B站:同款透传', () => {
    const run = WORKSHOP_SKILL_BILIBILI.run(
      { topic: '', duration: '3 分钟', count: 1, materials: [{ id: 'art_9', title: '周报' }] },
      {} as any
    );
    expect(run.prompt).toContain('【资料1：周报】(materialId=art_9)');
  });

  it('无材料时 prompt 与不传 materials 逐字节一致', () => {
    const a = WORKSHOP_SKILL_DOUYIN.run({ topic: '', duration: '60 秒', count: 1 }, {} as any).prompt;
    const b = WORKSHOP_SKILL_DOUYIN.run({ topic: '', duration: '60 秒', count: 1, materials: [] }, {} as any).prompt;
    expect(a).toBe(b);
  });
});
