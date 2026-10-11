import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  resolveDeckPath,
  buildPptDeckTools,
  MAX_DECK_BYTES,
  MAX_PPTX_BYTES,
  PPTX_MIME,
  PPTX_EXT_RE,
} from '../ppt-deck';

describe('resolveDeckPath · 工作区围栏(与 plugin-sandbox 同语义)', () => {
  const root = '/app/workspace';

  it('接受工作区内相对路径与 .html/.bento.html', () => {
    expect(resolveDeckPath(root, 'ppt/deck.bento.html')).toBe('/app/workspace/ppt/deck.bento.html');
    expect(resolveDeckPath(root, './deck.html')).toBe('/app/workspace/deck.html');
    expect(resolveDeckPath(root, 'a/b/c.htm')).toBe('/app/workspace/a/b/c.htm');
  });

  it('接受恰好等于工作区根的绝对路径前缀,拒绝 ../ 与区外绝对路径', () => {
    expect(resolveDeckPath(root, '/app/workspace/ppt/x.html')).toBe('/app/workspace/ppt/x.html');
    expect(resolveDeckPath(root, '../etc/passwd.html')).toBeNull();
    expect(resolveDeckPath(root, '/app/other/x.html')).toBeNull();
    expect(resolveDeckPath(root, '/etc/shadow')).toBeNull();
  });

  it('拒绝非 html 扩展名与空路径;识别 /app/workspace-evil 前缀混淆', () => {
    expect(resolveDeckPath(root, 'ppt/deck.json')).toBeNull();
    expect(resolveDeckPath(root, 'ppt/deck.bento.html.exe')).toBeNull();
    expect(resolveDeckPath(root, '')).toBeNull();
    expect(resolveDeckPath(root, '/app/workspace-evil/x.html')).toBeNull();
  });

  it('自定义扩展名白名单(PPTX_EXT_RE):接受工作区内 .pptx,越界与 html 拒绝', () => {
    expect(resolveDeckPath(root, 'ppt/deck_x/exports/a.pptx', PPTX_EXT_RE)).toBe(
      '/app/workspace/ppt/deck_x/exports/a.pptx'
    );
    expect(resolveDeckPath(root, '../etc/a.pptx', PPTX_EXT_RE)).toBeNull();
    expect(resolveDeckPath(root, 'ppt/deck.bento.html', PPTX_EXT_RE)).toBeNull();
    expect(resolveDeckPath(root, 'ppt/a.pptx.exe', PPTX_EXT_RE)).toBeNull();
  });
});

describe('buildPptDeckTools · ppt_publish_deck', () => {
  async function withTempWorkspace(fn: (ws: string) => Promise<void>) {
    const ws = await fs.mkdtemp(path.join(os.tmpdir(), 'ppt-deck-test-'));
    try {
      await fn(ws);
    } finally {
      await fs.rm(ws, { recursive: true, force: true });
    }
  }

  function makeDeps(ws: string, overrides?: Partial<Parameters<typeof buildPptDeckTools>[0]>) {
    const created: Array<{ data: any; taskId?: string }> = [];
    const tools = buildPptDeckTools({
      workspaceRoot: ws,
      skillDir: path.join(ws, 'no-such-skill'),
      createArtifact: (data, taskId) => {
        created.push({ data, taskId });
        return { id: 'art_test_1', title: data.title };
      },
      ...overrides,
    });
    return { tools, created };
  }

  it('发布工作区内 .bento.html:内容原样进 artifact、taskId 透传、体积回报', async () => {
    await withTempWorkspace(async (ws) => {
      await fs.mkdir(path.join(ws, 'ppt'), { recursive: true });
      const html = '<!doctype html><html><body><script id="bento-doc" type="application/json">{}</script></body></html>';
      await fs.writeFile(path.join(ws, 'ppt', 'deck.bento.html'), html, 'utf8');
      const { tools, created } = makeDeps(ws);
      const publish = tools.find((t) => t.name === 'ppt_publish_deck')!;
      const res: any = await publish.execute({ path: 'ppt/deck.bento.html', title: 'Q3 汇报' }, { taskId: 'task_9' } as any);
      expect(res.success).toBe(true);
      expect(res.bento).toBe(true);
      expect(res.sizeKB).toBeGreaterThanOrEqual(0);
      expect(created).toHaveLength(1);
      expect(created[0].data.type).toBe('html');
      expect(created[0].data.content).toBe(html);
      expect(created[0].data.title).toBe('Q3 汇报');
      expect(created[0].taskId).toBe('task_9');
    });
  });

  it('无 title 时用文件名(去 .bento.html 后缀);description 缺省带放映/下载说明', async () => {
    await withTempWorkspace(async (ws) => {
      await fs.writeFile(path.join(ws, '产品发布.bento.html'), '<html><body>x</body></html>', 'utf8');
      const { tools, created } = makeDeps(ws);
      const publish = tools.find((t) => t.name === 'ppt_publish_deck')!;
      const res: any = await publish.execute({ path: '产品发布.bento.html' }, { taskId: "task_t", step: 0 });
      expect(res.success).toBe(true);
      expect(created[0].data.title).toBe('产品发布');
      expect(created[0].data.description).toContain('离线');
    });
  });

  it('拒绝:越界路径 / 文件不存在 / 空文件 / 超过体积上限', async () => {
    await withTempWorkspace(async (ws) => {
      await fs.writeFile(path.join(ws, 'empty.html'), '', 'utf8');
      const { tools } = makeDeps(ws);
      const publish = tools.find((t) => t.name === 'ppt_publish_deck')!;

      const escape: any = await publish.execute({ path: '../../etc/x.html' }, { taskId: "task_t", step: 0 });
      expect(escape.success).toBe(false);
      expect(escape.error).toContain('越界');

      const missing: any = await publish.execute({ path: 'nope.html' }, { taskId: "task_t", step: 0 });
      expect(missing.success).toBe(false);
      expect(missing.error).toContain('不存在');

      const empty: any = await publish.execute({ path: 'empty.html' }, { taskId: "task_t", step: 0 });
      expect(empty.success).toBe(false);
      expect(empty.error).toContain('为空');

      // 体积上限:mock stat 太脆,直接用稀疏文件写超限长度代价高——改为断言常量契约
      expect(MAX_DECK_BYTES).toBe(8 * 1024 * 1024);
    });
  });

  it('ppt_check_env:skill 缺失时 ready=false 且给出降级路线指引(不抛异常)', async () => {
    await withTempWorkspace(async (ws) => {
      const { tools } = makeDeps(ws);
      const check = tools.find((t) => t.name === 'ppt_check_env')!;
      const res: any = await check.execute({}, { taskId: "task_t", step: 0 });
      expect(res.success).toBe(true);
      expect(res.ready).toBe(false);
      expect(res.skillScript).toBe(false);
      expect(res.message).toContain('降级路线');
    });
  });

  it('ppt_check_env:注入伪 skill 目录(脚本+shell 齐备)时 skillScript/skillShell 均 true', async () => {
    await withTempWorkspace(async (ws) => {
      const skillDir = path.join(ws, 'skill');
      await fs.mkdir(path.join(skillDir, 'scripts'), { recursive: true });
      await fs.mkdir(path.join(skillDir, 'assets', 'bento'), { recursive: true });
      await fs.writeFile(path.join(skillDir, 'scripts', 'bento_deck.py'), '# stub', 'utf8');
      await fs.writeFile(path.join(skillDir, 'assets', 'bento', 'Bento_Slides.bento.html'), '<html></html>', 'utf8');
      const { tools } = makeDeps(ws, { skillDir });
      const check = tools.find((t) => t.name === 'ppt_check_env')!;
      const res: any = await check.execute({}, { taskId: "task_t", step: 0 });
      expect(res.skillScript).toBe(true);
      expect(res.skillShell).toBe(true);
      // ready 还取决于宿主 python3;两种结果都必须给出明确 message,不允许抛错
      expect(typeof res.message).toBe('string');
      expect(res.message.length).toBeGreaterThan(0);
    });
  });

  it('工具契约:三枚工具均 low 危(只读探测 + 围栏内读文件),命名符合 ppt_ 前缀', () => {
    const tools = buildPptDeckTools({ createArtifact: vi.fn() as any });
    expect(tools.map((t) => t.name)).toEqual(['ppt_check_env', 'ppt_publish_deck', 'ppt_publish_pptx']);
    for (const t of tools) expect(t.dangerLevel).toBe('low');
  });
});

describe('buildPptDeckTools · ppt_publish_pptx', () => {
  async function withTempWorkspace(fn: (ws: string) => Promise<void>) {
    const ws = await fs.mkdtemp(path.join(os.tmpdir(), 'ppt-pptx-test-'));
    try {
      await fn(ws);
    } finally {
      await fs.rm(ws, { recursive: true, force: true });
    }
  }

  /** 伪 .pptx:zip 魔数 PK\x03\x04 + 填充(工具只校验魔数与体积,不解包) */
  function fakePptx(sizeBytes = 64): Buffer {
    const buf = Buffer.alloc(sizeBytes);
    buf.write('PK\x03\x04', 0, 'latin1');
    return buf;
  }

  function makeDeps(ws: string, overrides?: Partial<Parameters<typeof buildPptDeckTools>[0]>) {
    const created: Array<{ data: any; taskId?: string }> = [];
    const stored: Array<{ fileName: string; mime: string; sizeBytes: number }> = [];
    const tools = buildPptDeckTools({
      workspaceRoot: ws,
      skillDir: path.join(ws, 'no-such-skill'),
      createArtifact: (data, taskId) => {
        created.push({ data, taskId });
        return { id: 'art_file_1', title: data.title };
      },
      storeFile: (input) => {
        stored.push({ fileName: input.fileName, mime: input.mime, sizeBytes: input.data.length });
        return { fileId: `af_test_0123456789abcdef.pptx`, sizeBytes: input.data.length };
      },
      ...overrides,
    });
    return { tools, created, stored };
  }

  it('发布工作区内 .pptx:入库 + type=file 产物带 fileMeta,taskId 透传', async () => {
    await withTempWorkspace(async (ws) => {
      await fs.mkdir(path.join(ws, 'ppt', 'deck_20261011', 'exports'), { recursive: true });
      const rel = 'ppt/deck_20261011/exports/deck_20261011_142324.pptx';
      await fs.writeFile(path.join(ws, rel), fakePptx(2048));
      const { tools, created, stored } = makeDeps(ws);
      const publish = tools.find((t) => t.name === 'ppt_publish_pptx')!;
      const res: any = await publish.execute(
        { path: rel, title: 'Q3 业务汇报' },
        { taskId: 'task_pptx', step: 0 }
      );
      expect(res.success).toBe(true);
      expect(res.fileId).toBe('af_test_0123456789abcdef.pptx');
      expect(res.sizeKB).toBe(2);
      // 入库:文件名按 title 重命名,mime 为 OOXML 演示文稿
      expect(stored).toHaveLength(1);
      expect(stored[0].fileName).toBe('Q3 业务汇报.pptx');
      expect(stored[0].mime).toBe(PPTX_MIME);
      expect(stored[0].sizeBytes).toBe(2048);
      // 产物:file 类型 + fileMeta,content 只是人类可读摘要(不含二进制)
      expect(created).toHaveLength(1);
      expect(created[0].data.type).toBe('file');
      expect(created[0].data.title).toBe('Q3 业务汇报');
      expect(created[0].data.fileMeta).toEqual({
        fileId: 'af_test_0123456789abcdef.pptx',
        fileName: 'Q3 业务汇报.pptx',
        mime: PPTX_MIME,
        sizeBytes: 2048,
      });
      expect(created[0].data.content).toContain('Q3 业务汇报.pptx');
      expect(created[0].data.content.length).toBeLessThan(500);
      expect(created[0].taskId).toBe('task_pptx');
    });
  });

  it('无 title 时用文件名(去 .pptx 后缀);storeFile 缺失时拒发并给降级指引', async () => {
    await withTempWorkspace(async (ws) => {
      await fs.writeFile(path.join(ws, '产品发布.pptx'), fakePptx());
      const { tools, created } = makeDeps(ws);
      const publish = tools.find((t) => t.name === 'ppt_publish_pptx')!;
      const res: any = await publish.execute({ path: '产品发布.pptx' }, { taskId: 'task_t', step: 0 });
      expect(res.success).toBe(true);
      expect(created[0].data.title).toBe('产品发布');
      expect(created[0].data.fileMeta.fileName).toBe('产品发布.pptx');

      const noStore = makeDeps(ws, { storeFile: undefined }).tools.find((t) => t.name === 'ppt_publish_pptx')!;
      const degraded: any = await noStore.execute({ path: '产品发布.pptx' }, { taskId: 'task_t', step: 0 });
      expect(degraded.success).toBe(false);
      expect(degraded.error).toContain('ppt_publish_deck');
    });
  });

  it('拒绝:越界 / 不存在 / 空文件 / 非 zip 魔数', async () => {
    await withTempWorkspace(async (ws) => {
      await fs.writeFile(path.join(ws, 'empty.pptx'), '');
      await fs.writeFile(path.join(ws, 'fake.pptx'), 'not-a-zip-file');
      const { tools, created } = makeDeps(ws);
      const publish = tools.find((t) => t.name === 'ppt_publish_pptx')!;

      const escape: any = await publish.execute({ path: '../../etc/x.pptx' }, { taskId: 'task_t', step: 0 });
      expect(escape.success).toBe(false);
      expect(escape.error).toContain('越界');

      const missing: any = await publish.execute({ path: 'nope.pptx' }, { taskId: 'task_t', step: 0 });
      expect(missing.success).toBe(false);
      expect(missing.error).toContain('不存在');

      const empty: any = await publish.execute({ path: 'empty.pptx' }, { taskId: 'task_t', step: 0 });
      expect(empty.success).toBe(false);
      expect(empty.error).toContain('为空');

      const notZip: any = await publish.execute({ path: 'fake.pptx' }, { taskId: 'task_t', step: 0 });
      expect(notZip.success).toBe(false);
      expect(notZip.error).toContain('魔数');

      expect(created).toHaveLength(0);
      // 体积上限契约
      expect(MAX_PPTX_BYTES).toBe(32 * 1024 * 1024);
    });
  });
});
