import { describe, it, expect } from 'vitest';
import {
  collectWorkshopMaterials,
  resolveMaterials,
  parseMaterials,
  buildMaterialsSection,
  MATERIAL_COUNT_LIMIT,
} from '../materials';

const mission = (id: string, content: string, extra?: Record<string, unknown>) => ({
  id,
  title: `任务${id}`,
  startedAt: 1000,
  artifact: { title: `成果${id}`, content, type: 'markdown', ...extra },
});

describe('collectWorkshopMaterials', () => {
  it('汇总任务交付物并按时间倒序(条目只 id + 标题,无正文)', () => {
    const out = collectWorkshopMaterials([
      { ...mission('1', 'aaa'), startedAt: 100 },
      { ...mission('2', 'bbb'), startedAt: 200 },
    ]);
    expect(out.map((o) => o.id)).toEqual(['art_2', 'art_1']);
    expect(out[0]).not.toHaveProperty('content');
  });
  it('去重相同内容、跳过无正文;file 类型也列出(正文由工具端解析)', () => {
    const out = collectWorkshopMaterials([
      mission('1', 'same'),
      mission('2', 'same'),
      { id: '3', title: '空', startedAt: 1, artifact: null },
      mission('4', 'binary', { type: 'file' }),
    ]);
    expect(out.map((o) => o.id)).toEqual(['art_1', 'art_4']);
  });
});

describe('resolveMaterials / parseMaterials', () => {
  it('只收勾选项、超数丢弃(无正文,体积恒定)', () => {
    const options = collectWorkshopMaterials([mission('1', 'x'.repeat(99999))]);
    const resolved = resolveMaterials(options, ['art_1', 'art_missing']);
    expect(resolved).toEqual([{ id: 'art_1', title: '成果1' }]);
    expect(resolveMaterials(options, [])).toEqual([]);
  });
  it('parseMaterials 收敛脏数据(无 content 也保留引用)', () => {
    expect(parseMaterials(undefined)).toEqual([]);
    expect(parseMaterials('str')).toEqual([]);
    const out = parseMaterials([
      { id: 'a', title: 't' },
      { id: 1, title: 't' },
      { id: 'b' },
    ]);
    expect(out).toEqual([
      { id: 'a', title: 't' },
      { id: 'b', title: '参考资料' },
    ]);
    expect(parseMaterials(new Array(MATERIAL_COUNT_LIMIT + 3).fill({ id: 'x' }))).toHaveLength(
      MATERIAL_COUNT_LIMIT
    );
  });
});

describe('buildMaterialsSection', () => {
  it('空数组返回空字符串(无资料时 prompt 逐字节一致)', () => {
    expect(buildMaterialsSection([])).toBe('');
  });
  it('只列引用 id + 标题并指令用工具拉取(不进正文)', () => {
    const s = buildMaterialsSection([
      { id: 'art_1', title: '研报' },
      { id: 'art_2', title: '长文' },
    ]);
    expect(s).toContain('【参考资料】');
    expect(s).toContain('【资料1：研报】(materialId=art_1)');
    expect(s).toContain('read_reference_material');
    expect(s).not.toContain('核心结论');
  });
});
