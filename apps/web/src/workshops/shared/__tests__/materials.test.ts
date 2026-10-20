import { describe, it, expect } from 'vitest';
import {
  collectWorkshopMaterials,
  resolveMaterials,
  parseMaterials,
  buildMaterialsSection,
  uploadMaterialOptions,
  MATERIAL_COUNT_LIMIT,
  MATERIAL_UPLOAD_ACCEPT,
  MATERIAL_TEXT_EXTS,
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

describe('本地上传条目(uploadMaterialOptions,2026-10-20)', () => {
  it('映射 id/标题/类型并按时间倒序', () => {
    const out = uploadMaterialOptions([
      { id: 'upl_a1_0123456789abcdef', title: '旧报告', kind: 'pdf', createdAt: 100 },
      { id: 'upl_b2_0123456789abcdef', title: '新笔记', kind: 'text', createdAt: 200 },
      { id: 'upl_c3_0123456789abcdef', title: '合同', kind: 'docx', createdAt: 150 },
    ]);
    expect(out.map((o) => o.id)).toEqual([
      'upl_b2_0123456789abcdef',
      'upl_c3_0123456789abcdef',
      'upl_a1_0123456789abcdef',
    ]);
    expect(out[0].type).toBe('upload'); // text 档统一为 upload(选择器徽章只区分 pdf/docx)
    expect(out[1].type).toBe('docx');
    expect(out[2].type).toBe('pdf');
    expect(out[0].missionTitle).toBeUndefined(); // 上传文件不关联任务
  });
  it('过滤非 upl_ id;标题缺失依次回退 fileName → 上传资料', () => {
    const out = uploadMaterialOptions([
      { id: 'art_1', title: '交付物不该出现在这', createdAt: 1 },
      { id: '', title: '空 id', createdAt: 2 },
      { id: 'upl_d4_0123456789abcdef', title: '', fileName: '原始名.md', createdAt: 3 },
      { id: 'upl_e5_0123456789abcdef', title: '', createdAt: 4 },
    ]);
    expect(out.map((o) => o.id)).toEqual([
      'upl_e5_0123456789abcdef',
      'upl_d4_0123456789abcdef',
    ]);
    expect(out[1].title).toBe('原始名.md');
    expect(out[0].title).toBe('上传资料');
  });
  it('与交付物混排后共享 MATERIAL_COUNT_LIMIT(resolveMaterials 截断口径不变)', () => {
    const mixed = [
      ...uploadMaterialOptions([{ id: 'upl_f6_0123456789abcdef', title: '上传件', createdAt: 5 }]),
      ...collectWorkshopMaterials([mission('1', 'x')]),
    ];
    const ids = new Array(MATERIAL_COUNT_LIMIT + 3).fill('upl_f6_0123456789abcdef');
    expect(resolveMaterials(mixed, ids).length).toBeLessThanOrEqual(MATERIAL_COUNT_LIMIT);
  });
  it('accept 串 = 文本白名单 + pdf/docx;白名单本身不含二进制格式', () => {
    expect(MATERIAL_UPLOAD_ACCEPT).toContain('.md');
    expect(MATERIAL_UPLOAD_ACCEPT).toContain('.pdf');
    expect(MATERIAL_UPLOAD_ACCEPT).toContain('.docx');
    expect(MATERIAL_TEXT_EXTS).not.toContain('.pdf');
    expect(MATERIAL_TEXT_EXTS).not.toContain('.docx');
    expect(MATERIAL_UPLOAD_ACCEPT.split(',')).toHaveLength(MATERIAL_TEXT_EXTS.length + 2);
  });
});

describe('buildMaterialsSection 措辞泛化(交付物 + 本地上传)', () => {
  it('提示两种来源与 PDF/Word 已抽文本,并保留工具指令与 id 行', () => {
    const s = buildMaterialsSection([
      { id: 'art_1', title: '研报' },
      { id: 'upl_a1_0123456789abcdef', title: '产品手册' },
    ]);
    expect(s).toContain('【参考资料】');
    expect(s).toContain('本地上传文件');
    expect(s).toContain('PDF/Word 已抽取为文本');
    expect(s).toContain('read_reference_material');
    expect(s).toContain('【资料1：研报】(materialId=art_1)');
    expect(s).toContain('【资料2：产品手册】(materialId=upl_a1_0123456789abcdef)');
  });
});
