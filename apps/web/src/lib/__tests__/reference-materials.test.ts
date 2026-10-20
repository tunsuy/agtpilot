import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  buildReferenceTools,
  resolveReferenceMaterial,
  REFERENCE_CONTENT_LIMIT,
  TOOL_PROVIDER,
} from '../reference-materials';

const seedMissions = [
  {
    id: 'm1',
    title: '研报任务',
    artifact: { title: 'AI 研报', content: '核心结论AAA', type: 'markdown' },
  },
  {
    id: 'm2',
    title: '长文任务',
    artifact: { title: '万字长文', content: 'x'.repeat(REFERENCE_CONTENT_LIMIT + 100), type: 'markdown' },
  },
  { id: 'm3', title: '空任务', artifact: null },
];

vi.mock('../user-store', () => ({
  getUserMissions: (uid: string) =>
    uid === 'u1' ? seedMissions : [],
}));

// 上传库替身(真库落盘逻辑在 material-uploads.test.ts 覆盖;这里只测解析分支)
const UPL_ID = 'upl_lz4k1a2b3c_0123456789abcdef';
vi.mock('../material-uploads', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../material-uploads')>();
  return {
    ...actual,
    loadMaterialUploadManifest: (uid: string, id: string) =>
      uid === 'u1' && id === UPL_ID ? { uploadId: id, fileName: '手册.pdf', title: '产品手册', kind: 'pdf' } : null,
    readMaterialText: (uid: string, id: string) =>
      uid === 'u1' && id === UPL_ID ? 'y'.repeat(9000) : null,
  };
});

describe('TOOL_PROVIDER 描述符', () => {
  it('id 为 reference,依赖 uid,build 闭包使用 uid', () => {
    expect(TOOL_PROVIDER.id).toBe('reference');
    expect(TOOL_PROVIDER.deps).toEqual(['uid']);
    expect(String(TOOL_PROVIDER.build)).toContain('uid');
  });
});

describe('resolveReferenceMaterial', () => {
  it('art_ 前缀与裸 missionId 都可解析', () => {
    expect(resolveReferenceMaterial('u1', 'art_m1')?.title).toBe('AI 研报');
    expect(resolveReferenceMaterial('u1', 'm1')?.content).toBe('核心结论AAA');
  });
  it('不存在/无交付物/他用户返回 null', () => {
    expect(resolveReferenceMaterial('u1', 'art_missing')).toBeNull();
    expect(resolveReferenceMaterial('u1', 'art_m3')).toBeNull();
    expect(resolveReferenceMaterial('other', 'art_m1')).toBeNull();
    expect(resolveReferenceMaterial('u1', '')).toBeNull();
  });
  it('超长返回全文 + truncated 标记(分页由 execute 做)', () => {
    const body = resolveReferenceMaterial('u1', 'art_m2');
    expect(body?.content).toHaveLength(REFERENCE_CONTENT_LIMIT + 100);
    expect(body?.truncated).toBe(true);
  });
});

describe('read_reference_material 工具', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  it('元信息正确(只读/low/参数)', () => {
    const [tool] = buildReferenceTools('u1');
    expect(tool.name).toBe('read_reference_material');
    expect(tool.readOnly).toBe(true);
    expect(tool.dangerLevel).toBe('low');
  });
  it('命中返回正文,超长截断并给 nextOffset', async () => {
    const [tool] = buildReferenceTools('u1');
    const r1: any = await (tool.execute as any)({ materialId: 'art_m1' });
    expect(r1.success).toBe(true);
    expect(r1.content).toBe('核心结论AAA');
    expect(r1.truncated).toBe(false);
    const r2: any = await (tool.execute as any)({ materialId: 'art_m2' });
    expect(r2.success).toBe(true);
    expect(r2.content).toHaveLength(REFERENCE_CONTENT_LIMIT);
    expect(r2.truncated).toBe(true);
    expect(r2.nextOffset).toBe(REFERENCE_CONTENT_LIMIT);
    const r3: any = await (tool.execute as any)({ materialId: 'art_m2', offset: REFERENCE_CONTENT_LIMIT });
    expect(r3.success).toBe(true);
    expect(r3.content).toHaveLength(100);
    expect(r3.truncated).toBe(false);
  });
  it(' miss 返回 success:false + 降级提示', async () => {
    const [tool] = buildReferenceTools('u1');
    const r: any = await (tool.execute as any)({ materialId: 'art_missing' });
    expect(r.success).toBe(false);
    expect(r.error).toContain('降级');
  });
});

describe('resolveReferenceMaterial · upl_ 上传文件分支(2026-10-20)', () => {
  it('合法 upl_ id → 上传库解析(标题取 manifest,正文为抽取文本,超长标 truncated)', () => {
    const body = resolveReferenceMaterial('u1', UPL_ID);
    expect(body?.title).toBe('产品手册');
    expect(body?.content).toHaveLength(9000);
    expect(body?.truncated).toBe(true);
    expect(body?.missionTitle).toBeUndefined(); // 上传文件不关联任务
  });
  it('他用户/不存在的 upl_ id → null', () => {
    expect(resolveReferenceMaterial('other', UPL_ID)).toBeNull();
    expect(resolveReferenceMaterial('u1', 'upl_zzzzz_ffffffffffffffff')).toBeNull();
  });
  it('art_ 分支不受影响(mock 上传库存在时交付物照常解析)', () => {
    expect(resolveReferenceMaterial('u1', 'art_m1')?.content).toBe('核心结论AAA');
  });
});

describe('read_reference_material 工具 · 上传资料分页', () => {
  it('execute 按 offset 分段,首段 truncated + nextOffset 指路', async () => {
    const tools = buildReferenceTools('u1');
    const tool = tools.find((t) => t.name === 'read_reference_material')!;
    const r1: any = await tool.execute!({ materialId: UPL_ID } as any, {} as any);
    expect(r1.success).toBe(true);
    expect(r1.content).toHaveLength(REFERENCE_CONTENT_LIMIT);
    expect(r1.truncated).toBe(true);
    expect(r1.nextOffset).toBe(REFERENCE_CONTENT_LIMIT);
    const r2: any = await tool.execute!({ materialId: UPL_ID, offset: REFERENCE_CONTENT_LIMIT } as any, {} as any);
    expect(r2.content).toHaveLength(9000 - REFERENCE_CONTENT_LIMIT);
    expect(r2.truncated).toBe(false);
  });
  it('解析失败给降级话术(上传文件已删除场景)', async () => {
    const tools = buildReferenceTools('u1');
    const tool = tools.find((t) => t.name === 'read_reference_material')!;
    const r: any = await tool.execute!({ materialId: 'upl_gone0_ffffffffffffffff' } as any, {} as any);
    expect(r.success).toBe(false);
    expect(String(r.error)).toContain('降级路径');
  });
  it('工具描述覆盖两种来源(交付物 + 上传文件)', () => {
    const tools = buildReferenceTools('u1');
    const tool = tools.find((t) => t.name === 'read_reference_material')!;
    expect(tool.description).toContain('art_');
    expect(tool.description).toContain('upl_');
    expect(tool.description).toContain('PDF/Word');
  });
});
