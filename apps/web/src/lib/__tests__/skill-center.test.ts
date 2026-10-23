/**
 * skill-center(技能中心宿主服务)单测:
 * - 校验纯函数(repo slug / 相对路径 / 目录名归一)
 * - 最小 tar 解析:正常提取、目录条目、软链/硬链拒绝、路径穿越拒绝、限额
 * - 用户安装域:清单 / 解除引用(围栏 + 台账)/ 技能卡删除(台账 + 审计)
 * - 引用导入:riskAck 强制、仓库名校验、mock fetch 全链路、同名冲突、来源记录
 * - 任务侧接线:显式引用注入块 / 引用收敛 / skill_pack_read 工具(围栏 + 二进制拒绝)
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as zlib from 'zlib';
import * as crypto from 'crypto';

// USER_DATA_DIR 指向临时目录(getDataDir 每次调用时读 env,先设后导入无顺序问题)
let tmpRoot: string;
let prevUserDataDir: string | undefined;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-center-'));
  prevUserDataDir = process.env.USER_DATA_DIR;
  process.env.USER_DATA_DIR = tmpRoot;
  delete process.env.AGTPILOT_SKILL_MARKET;
});

afterEach(() => {
  if (prevUserDataDir === undefined) delete process.env.USER_DATA_DIR;
  else process.env.USER_DATA_DIR = prevUserDataDir;
  vi.unstubAllGlobals();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

import {
  isSafeRepoSlug,
  isSafeModelScopeId,
  isSafeSkillHubId,
  isSafeRelPath,
  sanitizePackName,
  extractTarSubdir,
  userSkillPacksDir,
  listInstalledPacks,
  uninstallSkillPack,
  deleteSkillCard,
  importSkillPack,
  marketSources,
  fetchMarketIndex,
  fetchMarketSkillDetail,
  buildReferencedPacksBlock,
  sanitizeSkillPackRefs,
  buildUserSkillPackTools,
  REFERENCED_PACK_MAX,
  REFERENCED_PACK_CHARS,
  IMPORT_MAX_FILES,
  IMPORT_MAX_FILE_BYTES,
} from '../skill-center';
import { webCardStore } from '../skill-cards';
import { getDeletionLedger } from '../user-store';
import type { SkillCard } from '@agtpilot/plugin-skill';

// ---- 最小 tar 构造器(测试用;与解析器同规格 ustar) ----

function tarEntry(
  name: string,
  content: string | Buffer = '',
  opts: { typeflag?: string; mode?: number } = {}
): Buffer {
  const data = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf-8');
  const header = Buffer.alloc(512);
  header.write(name.slice(0, 100), 0, 'utf-8');
  header.write((opts.mode ?? 0o644).toString(8).padStart(7, '0') + '\0', 100, 'utf-8');
  header.write('0000000\0', 108, 'utf-8');
  header.write('0000000\0', 116, 'utf-8');
  header.write(data.length.toString(8).padStart(11, '0') + '\0', 124, 'utf-8');
  header.write(Math.floor(Date.now() / 1000).toString(8).padStart(11, '0') + '\0', 136, 'utf-8');
  header.write('        ', 148, 'utf-8'); // chksum 占位(解析器不校验)
  header.write(opts.typeflag ?? '0', 156, 'utf-8');
  header.write('ustar\0', 257, 'utf-8');
  header.write('00', 263, 'utf-8');
  const padded = Buffer.alloc(Math.ceil(data.length / 512) * 512);
  data.copy(padded);
  return Buffer.concat([header, padded]);
}

function buildTar(entries: Array<Buffer>): Buffer {
  return Buffer.concat([...entries, Buffer.alloc(1024)]); // 结束双零块
}

const TOP = 'anthropics-skills-aaaaaaa';

function demoSkillTar(topDir = TOP, skillDir = 'document-skills/demo') {
  return buildTar([
    tarEntry(`${topDir}/`, '', { typeflag: '5' }),
    tarEntry(`${topDir}/${skillDir}/`, '', { typeflag: '5' }),
    tarEntry(`${topDir}/${skillDir}/SKILL.md`, '---\nname: demo-skill\ndescription: 演示技能\n---\n\n# 用法\n照做。'),
    tarEntry(`${topDir}/${skillDir}/scripts/`, '', { typeflag: '5' }),
    tarEntry(`${topDir}/${skillDir}/scripts/run.sh`, '#!/bin/sh\necho hi\n', { mode: 0o755 }),
    tarEntry(`${topDir}/${skillDir}/references/guide.md`, '# guide\n'),
  ]);
}

const LIMITS = { maxFiles: IMPORT_MAX_FILES, maxFileBytes: 2 * 1024 * 1024, maxTotalBytes: 20 * 1024 * 1024 };

// ---- 校验纯函数 ----

describe('校验纯函数', () => {
  it('isSafeRepoSlug:owner/repo 合法;穿越/多段/空/非字符串拒绝', () => {
    expect(isSafeRepoSlug('anthropics/skills')).toBe(true);
    expect(isSafeRepoSlug('a.b-c/d_e')).toBe(true);
    expect(isSafeRepoSlug('anthropics/skills/extra')).toBe(false);
    expect(isSafeRepoSlug('../etc/passwd')).toBe(false);
    expect(isSafeRepoSlug('anthropics')).toBe(false);
    expect(isSafeRepoSlug('')).toBe(false);
    expect(isSafeRepoSlug(null as any)).toBe(false);
  });

  it('isSafeModelScopeId:owner/name 与 @owner/name 合法;穿越/多段/空/非字符串拒绝', () => {
    expect(isSafeModelScopeId('iic/fun-denoise')).toBe(true);
    expect(isSafeModelScopeId('@anthropics/pdf')).toBe(true);
    expect(isSafeModelScopeId('a.b_c/d-e')).toBe(true);
    expect(isSafeModelScopeId('../etc/passwd')).toBe(false);
    expect(isSafeModelScopeId('owner/../escape')).toBe(false);
    expect(isSafeModelScopeId('a/b/c')).toBe(false);
    expect(isSafeModelScopeId('single')).toBe(false);
    expect(isSafeModelScopeId('')).toBe(false);
    expect(isSafeModelScopeId(123 as any)).toBe(false);
  });

  it('isSafeSkillHubId:@handle/slug 与 handle/slug 合法;穿越/多段/空/非字符串拒绝', () => {
    expect(isSafeSkillHubId('@ake/dev-god')).toBe(true);
    expect(isSafeSkillHubId('ake/dev-god')).toBe(true);
    expect(isSafeSkillHubId('a.b_c/d-e')).toBe(true);
    expect(isSafeSkillHubId('../etc/passwd')).toBe(false);
    expect(isSafeSkillHubId('@ake/dev-god/extra')).toBe(false);
    expect(isSafeSkillHubId('owner/../escape')).toBe(false);
    expect(isSafeSkillHubId('single')).toBe(false);
    expect(isSafeSkillHubId('')).toBe(false);
    expect(isSafeSkillHubId(123 as any)).toBe(false);
  });

  it('isSafeRelPath:相对路径合法;绝对/..段/首尾斜杠/空拒绝', () => {
    expect(isSafeRelPath('document-skills/demo')).toBe(true);
    expect(isSafeRelPath('a/b/c.md')).toBe(true);
    expect(isSafeRelPath('/etc/passwd')).toBe(false);
    expect(isSafeRelPath('a/../b')).toBe(false);
    expect(isSafeRelPath('a/')).toBe(false);
    expect(isSafeRelPath('')).toBe(false);
    expect(isSafeRelPath(123 as any)).toBe(false);
  });

  it('sanitizePackName:危险字符归一为 -;空值兜底;长度截断', () => {
    expect(sanitizePackName('demo-skill')).toBe('demo-skill');
    expect(sanitizePackName('My Skill!!')).toBe('My-Skill');
    expect(sanitizePackName('../../etc')).toBe('etc');
    expect(sanitizePackName('   ')).toBe('skill-pack');
    expect(sanitizePackName('x'.repeat(100)).length).toBe(64);
  });
});

// ---- tar 提取 ----

describe('extractTarSubdir · 最小 tar 解析', () => {
  it('正常提取:剥 GitHub 首层目录、按 subdir 匹配、保留执行位、目录条目隐式创建', () => {
    const dest = fs.mkdtempSync(path.join(tmpRoot, 'dest-'));
    const out = extractTarSubdir(demoSkillTar(), 'document-skills/demo', dest, LIMITS);
    expect(out).toEqual({ ok: true, files: 3, bytes: expect.any(Number) });
    expect(fs.readFileSync(path.join(dest, 'SKILL.md'), 'utf-8')).toContain('demo-skill');
    expect(fs.readFileSync(path.join(dest, 'references/guide.md'), 'utf-8')).toBe('# guide\n');
    const mode = fs.statSync(path.join(dest, 'scripts/run.sh')).mode & 0o777;
    expect(mode).toBe(0o755); // 执行位保留
  });

  it('只提取目标子目录:兄弟目录与前缀相近目录(demo-evil)不落入', () => {
    const tar = buildTar([
      tarEntry(`${TOP}/document-skills/demo/SKILL.md`, '---\nname: demo\n---\nx'),
      tarEntry(`${TOP}/document-skills/other/SKILL.md`, '---\nname: other\n---\ny'),
      tarEntry(`${TOP}/document-skills/demo-evil/SKILL.md`, '---\nname: evil\n---\nz'),
    ]);
    const dest = fs.mkdtempSync(path.join(tmpRoot, 'dest-'));
    const out = extractTarSubdir(tar, 'document-skills/demo', dest, LIMITS);
    expect(out).toMatchObject({ ok: true, files: 1 });
    expect(fs.readdirSync(dest)).toEqual(['SKILL.md']);
  });

  it('软链/硬链条目 → 整包拒绝', () => {
    const tar = buildTar([
      tarEntry(`${TOP}/demo/SKILL.md`, 'x'),
      tarEntry(`${TOP}/demo/link`, '/etc/passwd', { typeflag: '2' }),
    ]);
    const dest = fs.mkdtempSync(path.join(tmpRoot, 'dest-'));
    const out = extractTarSubdir(tar, 'demo', dest, LIMITS);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toContain('链接文件');
  });

  it('路径穿越(.. 段)→ 整包拒绝,不落盘', () => {
    const tar = buildTar([
      tarEntry(`${TOP}/demo/SKILL.md`, 'x'),
      tarEntry(`${TOP}/demo/../../escaped.md`, 'pwned'),
    ]);
    const dest = fs.mkdtempSync(path.join(tmpRoot, 'dest-'));
    const out = extractTarSubdir(tar, 'demo', dest, LIMITS);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toContain('非法路径');
    expect(fs.existsSync(path.join(tmpRoot, 'escaped.md'))).toBe(false);
  });

  it('文件数超上限 → 整包拒绝', () => {
    const entries = [tarEntry(`${TOP}/demo/SKILL.md`, 'x')];
    for (let i = 0; i < LIMITS.maxFiles + 1; i++) entries.push(tarEntry(`${TOP}/demo/f${i}.txt`, 'x'));
    const dest = fs.mkdtempSync(path.join(tmpRoot, 'dest-'));
    const out = extractTarSubdir(buildTar(entries), 'demo', dest, LIMITS);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toContain('文件数超过上限');
  });

  it('单文件超上限 → 整包拒绝', () => {
    const tar = buildTar([
      tarEntry(`${TOP}/demo/SKILL.md`, 'x'),
      tarEntry(`${TOP}/demo/big.bin`, Buffer.alloc(1024)),
    ]);
    const dest = fs.mkdtempSync(path.join(tmpRoot, 'dest-'));
    const out = extractTarSubdir(tar, 'demo', dest, { maxFiles: 10, maxFileBytes: 512, maxTotalBytes: 10_000 });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toContain('单文件超过上限');
  });
});

// ---- 用户安装域:清单 / 卸载 / 卡删除 ----

function seedInstalledPack(userId: string, dirName: string, fmName: string) {
  const dir = path.join(userSkillPacksDir(userId), dirName);
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${fmName}\ndescription: 测试包\n---\nbody`);
  fs.writeFileSync(
    path.join(dir, '.provenance.json'),
    JSON.stringify({
      source: { repo: 'anthropics/skills', ref: 'HEAD', sha: 'abcdef1234567', path: `document-skills/${dirName}` },
      importedAt: 1700000000000,
      fileCount: 2,
      totalBytes: 100,
      contentHash: 'hash',
    })
  );
  return dir;
}

describe('listInstalledPacks / uninstallSkillPack', () => {
  it('清单:读 frontmatter + 来源记录;隐藏目录跳过;未装过返回空', () => {
    expect(listInstalledPacks('nobody')).toEqual([]);
    seedInstalledPack('u1', 'demo-skill', 'demo-skill');
    fs.mkdirSync(path.join(userSkillPacksDir('u1'), '.tmp-junk'), { recursive: true });
    const packs = listInstalledPacks('u1');
    expect(packs).toHaveLength(1);
    expect(packs[0]).toMatchObject({
      name: 'demo-skill',
      description: '测试包',
      dirName: 'demo-skill',
      hasScripts: true,
      importedAt: 1700000000000,
    });
    expect(packs[0].provenance?.source.repo).toBe('anthropics/skills');
  });

  it('解除引用:删目录 + 删除台账留痕;重复卸载 not-found', () => {
    seedInstalledPack('u2', 'demo-skill', 'demo-skill');
    const res = uninstallSkillPack('u2', 'demo-skill');
    expect(res).toEqual({ ok: true, name: 'demo-skill' });
    expect(fs.existsSync(path.join(userSkillPacksDir('u2'), 'demo-skill'))).toBe(false);
    const ledger = getDeletionLedger('u2');
    expect(ledger.some((e) => e.target.kind === 'skill-pack' && e.target.id === 'demo-skill')).toBe(true);
    expect(uninstallSkillPack('u2', 'demo-skill')).toEqual({ ok: false, error: expect.stringContaining('not-found') });
  });

  it('解除引用只动目标用户:其他用户同名包不受影响', () => {
    seedInstalledPack('u3', 'demo-skill', 'demo-skill');
    seedInstalledPack('u4', 'demo-skill', 'demo-skill');
    uninstallSkillPack('u3', 'demo-skill');
    expect(listInstalledPacks('u3')).toHaveLength(0);
    expect(listInstalledPacks('u4')).toHaveLength(1);
  });
});

describe('deleteSkillCard', () => {
  function seedCard(userId: string, id: string): SkillCard {
    const card: SkillCard = {
      id,
      trigger: '测试场景',
      steps: '第一步',
      avoid: '别跳步',
      keywords: ['测试'],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      hitCount: 2,
    };
    const store = webCardStore();
    store.saveCards(userId, [...(store.listCards(userId) as SkillCard[]), card]);
    return card;
  }

  it('删除:卡片移除 + 台账 + 审计;不存在返回 not-found', () => {
    seedCard('u5', 'card_a');
    seedCard('u5', 'card_b');
    const res = deleteSkillCard('u5', 'card_a');
    expect(res).toEqual({ ok: true, trigger: '测试场景' });
    const store = webCardStore();
    const rest = store.listCards('u5') as SkillCard[];
    expect(rest.map((c) => c.id)).toEqual(['card_b']);
    const ledger = getDeletionLedger('u5');
    expect(ledger.some((e) => e.target.kind === 'skill-card' && e.target.id === 'card_a')).toBe(true);
    expect(deleteSkillCard('u5', 'card_a')).toEqual({ ok: false, error: expect.stringContaining('not-found') });
  });
});

// ---- 引用导入(mock fetch 全链路) ----

function mockGithubFetch(tar: Buffer, sha = 'a'.repeat(40)) {
  const gz = zlib.gzipSync(tar);
  const fn = vi.fn(async (url: any) => {
    const u = String(url);
    if (u.includes('/commits/')) {
      return { ok: true, status: 200, json: async () => ({ sha }) } as any;
    }
    if (u.includes('codeload.github.com')) {
      return {
        ok: true,
        status: 200,
        headers: new Headers({ 'content-length': String(gz.length) }),
        arrayBuffer: async () => gz.buffer.slice(gz.byteOffset, gz.byteOffset + gz.byteLength),
      } as any;
    }
    return { ok: false, status: 404, json: async () => ({}) } as any;
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

describe('importSkillPack', () => {
  it('riskAck 未确认 → 拒绝(不落盘不发请求)', async () => {
    const fn = mockGithubFetch(demoSkillTar());
    const res = await importSkillPack('u6', { repo: 'anthropics/skills', path: 'document-skills/demo' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('risk-ack-required');
    expect(fn).not.toHaveBeenCalled();
  });

  it('仓库名/路径不合法 → 拒绝', async () => {
    mockGithubFetch(demoSkillTar());
    const r1 = await importSkillPack('u6', { repo: '../evil', path: 'a', riskAck: true });
    expect(r1.ok).toBe(false);
    const r2 = await importSkillPack('u6', { repo: 'anthropics/skills', path: '../escape', riskAck: true });
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.error).toContain('不合法');
  });

  it('成功引用:落用户安装域 + 来源记录 + 执行位;listInstalledPacks 可见', async () => {
    mockGithubFetch(demoSkillTar());
    const res = await importSkillPack('u7', {
      repo: 'anthropics/skills',
      path: 'document-skills/demo',
      riskAck: true,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.pack.name).toBe('demo-skill'); // frontmatter name 优先
    expect(res.pack.dirName).toBe('demo-skill');
    expect(res.pack.hasScripts).toBe(true);
    expect(res.pack.provenance?.source.sha).toBe('a'.repeat(40));
    expect(res.pack.provenance?.contentHash).toMatch(/^[0-9a-f]{64}$/);
    // 落盘位置与权限
    const dir = path.join(userSkillPacksDir('u7'), 'demo-skill');
    expect(fs.existsSync(path.join(dir, 'SKILL.md'))).toBe(true);
    expect(fs.statSync(path.join(dir, 'scripts/run.sh')).mode & 0o111).toBeTruthy();
    expect(listInstalledPacks('u7').map((p) => p.dirName)).toEqual(['demo-skill']);
    // 临时目录清理
    expect(fs.readdirSync(userSkillPacksDir('u7')).some((n) => n.startsWith('.tmp-'))).toBe(false);
  });

  it('同名冲突 → already-installed;overwrite=true 允许替换', async () => {
    mockGithubFetch(demoSkillTar());
    const first = await importSkillPack('u8', { repo: 'anthropics/skills', path: 'document-skills/demo', riskAck: true });
    expect(first.ok).toBe(true);
    const dup = await importSkillPack('u8', { repo: 'anthropics/skills', path: 'document-skills/demo', riskAck: true });
    expect(dup.ok).toBe(false);
    if (!dup.ok) expect(dup.error).toContain('already-installed');
    const over = await importSkillPack('u8', {
      repo: 'anthropics/skills',
      path: 'document-skills/demo',
      riskAck: true,
      overwrite: true,
    });
    expect(over.ok).toBe(true);
    expect(listInstalledPacks('u8')).toHaveLength(1);
  });

  it('包内无 SKILL.md → 拒绝且不留残余目录', async () => {
    const tar = buildTar([tarEntry(`${TOP}/demo/readme.md`, 'not a skill')]);
    mockGithubFetch(tar);
    const res = await importSkillPack('u9', { repo: 'anthropics/skills', path: 'demo', riskAck: true });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('SKILL.md');
    const root = userSkillPacksDir('u9');
    const leftovers = fs.existsSync(root) ? fs.readdirSync(root) : [];
    expect(leftovers).toEqual([]);
  });

  it('GitHub API 失败(限流)→ 真实原因透传,不假成功', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 403, json: async () => ({}) }) as any)
    );
    const res = await importSkillPack('u10', { repo: 'anthropics/skills', path: 'demo', riskAck: true });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('403');
  });
});

// ---- 魔搭(ModelScope)源:注册表 / 索引 / 详情 / 导入 ----

/** 注册表源 env 接管(只留一个魔搭源,隔离 GitHub 网络面) */
function useModelScopeRegistry() {
  process.env.AGTPILOT_SKILL_REGISTRY_SOURCES = JSON.stringify([
    { id: 'ms', label: '魔搭技能库(国内)', repo: '', type: 'modelscope' },
  ]);
}

/**
 * 魔搭 mock fetch:
 * - openapi/v1/skills → 索引列表
 * - api/v1/skills/<id>/repo/files?Root= → 分层文件列表(listing 以 Root 为键,根目录 '')
 * - www.modelscope.cn/skills/<id>/resolve/master/<path> → 文件原文(files 以 path 为键)
 */
function mockModelScopeFetch(opts: {
  index?: any[];
  listing?: Record<string, any[]>;
  files?: Record<string, string | Buffer>;
}) {
  const fn = vi.fn(async (url: any) => {
    const u = String(url);
    if (u.includes('/openapi/v1/skills')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ success: true, data: { skills: opts.index ?? [], total: (opts.index ?? []).length } }),
      } as any;
    }
    if (u.includes('/repo/files')) {
      const root = new URL(u).searchParams.get('Root') || '';
      const files = opts.listing?.[root];
      if (!files) return { ok: false, status: 404, json: async () => ({}) } as any;
      return { ok: true, status: 200, json: async () => ({ Code: 200, Data: { Files: files } }) } as any;
    }
    if (u.includes('/resolve/master/')) {
      const p = decodeURIComponent(u.split('/resolve/master/')[1]);
      const content = opts.files?.[p];
      if (content === undefined) return { ok: false, status: 404, text: async () => '' } as any;
      const buf = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf-8');
      return {
        ok: true,
        status: 200,
        text: async () => buf.toString('utf-8'),
        arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
      } as any;
    }
    return { ok: false, status: 404, json: async () => ({}) } as any;
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

const MS_SKILL_MD = '---\nname: fun-denoise\ndescription: 音频降噪\n---\n\n# 用法\n照做。';

function blob(name: string, p: string, size: number, committed = 1_700_000_000) {
  return { Name: name, Path: p, Type: 'blob', Size: size, Sha256: 'x'.repeat(64), CommittedDate: committed };
}
function tree(name: string, p: string) {
  return { Name: name, Path: p, Type: 'tree', Size: 0, CommittedDate: 0 };
}

describe('marketSources · 魔搭注册表', () => {
  afterEach(() => {
    delete process.env.AGTPILOT_SKILL_REGISTRY_SOURCES;
  });

  it('缺省源含魔搭;env 配置 type=modelscope 时 repo 可空', () => {
    const defaults = marketSources();
    expect(defaults.some((s) => s.type === 'modelscope')).toBe(true);
    useModelScopeRegistry();
    const custom = marketSources();
    expect(custom).toHaveLength(1);
    expect(custom[0]).toMatchObject({ id: 'ms', type: 'modelscope', repo: '' });
  });

  it('env 配置里 github 源仍须过 repo 校验(坏条目整批回落缺省)', () => {
    process.env.AGTPILOT_SKILL_REGISTRY_SOURCES = JSON.stringify([{ id: 'bad', label: 'x', repo: '../evil' }]);
    const srcs = marketSources();
    expect(srcs.some((s) => s.id === 'bad')).toBe(false);
    expect(srcs.length).toBeGreaterThan(0);
  });
});

describe('fetchMarketIndex · 魔搭索引', () => {
  afterEach(() => {
    delete process.env.AGTPILOT_SKILL_REGISTRY_SOURCES;
  });

  it('openapi 列表映射:platform/repo=id/path 空/中文名/外链/下载量;非法 id 跳过', async () => {
    useModelScopeRegistry();
    mockModelScopeFetch({
      index: [
        {
          id: 'iic/fun-denoise',
          display_name: '音频降噪',
          description: '中文描述自带',
          category: 'audio',
          downloads: 12345,
        },
        { id: 'bad id/../../evil', display_name: '脏数据' },
      ],
    });
    const idx = await fetchMarketIndex(true);
    expect(idx.sources).toHaveLength(1);
    const skills = idx.sources[0].skills;
    expect(skills).toHaveLength(1);
    expect(skills[0]).toMatchObject({
      platform: 'modelscope',
      repo: 'iic/fun-denoise',
      path: '',
      name: '音频降噪',
      category: 'audio',
      description: '中文描述自带',
      downloads: 12345,
      externalUrl: 'https://www.modelscope.cn/skills/iic/fun-denoise',
    });
  });

  it('search 透传到服务端(魔搭 8 万+ 条目必须服务端搜索)', async () => {
    useModelScopeRegistry();
    const fn = mockModelScopeFetch({ index: [] });
    await fetchMarketIndex(true, 'pdf');
    const url = String(fn.mock.calls[0][0]);
    expect(url).toContain('/openapi/v1/skills');
    expect(url).toContain('search=pdf');
  });

  it('单源失败带 error 返回(不静默)', async () => {
    useModelScopeRegistry();
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) }) as any));
    const idx = await fetchMarketIndex(true);
    expect(idx.sources[0].error).toContain('500');
    expect(idx.sources[0].skills).toEqual([]);
  });
});

describe('fetchMarketSkillDetail · 魔搭详情', () => {
  it('resolve/master/SKILL.md → frontmatter + 全文', async () => {
    mockModelScopeFetch({ files: { 'SKILL.md': MS_SKILL_MD } });
    const res = await fetchMarketSkillDetail('iic/fun-denoise', '', 'HEAD', 'modelscope');
    expect(res).toMatchObject({ ok: true, name: 'fun-denoise', description: '音频降噪' });
    if (res.ok) expect(res.content).toContain('# 用法');
  });

  it('非法 id 拒绝;404 真实报错', async () => {
    mockModelScopeFetch({ files: {} });
    const bad = await fetchMarketSkillDetail('../evil', '', 'HEAD', 'modelscope');
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toContain('不合法');
    const miss = await fetchMarketSkillDetail('iic/nope', '', 'HEAD', 'modelscope');
    expect(miss.ok).toBe(false);
    if (!miss.ok) expect(miss.error).toContain('SKILL.md');
  });
});

describe('importSkillPack · 魔搭链路', () => {
  const MS_OPTS = { platform: 'modelscope', repo: 'iic/fun-denoise', path: '', riskAck: true } as const;

  function msDemoMocks() {
    return mockModelScopeFetch({
      listing: {
        '': [blob('SKILL.md', 'SKILL.md', Buffer.byteLength(MS_SKILL_MD), 1_700_000_001), tree('scripts', 'scripts')],
        scripts: [blob('run.sh', 'scripts/run.sh', 12, 1_700_000_002)],
      },
      files: { 'SKILL.md': MS_SKILL_MD, 'scripts/run.sh': '#!/bin/sh\nhi\n' },
    });
  }

  it('成功引用:递归列表 → 逐文件拉取 → provenance 记 platform/sha=ms-<时间戳>', async () => {
    msDemoMocks();
    const res = await importSkillPack('m1', { ...MS_OPTS });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.pack.name).toBe('fun-denoise'); // frontmatter name 优先
    expect(res.pack.dirName).toBe('fun-denoise');
    expect(res.pack.hasScripts).toBe(true);
    expect(res.pack.provenance?.source).toMatchObject({
      platform: 'modelscope',
      repo: 'iic/fun-denoise',
      ref: 'master',
      sha: 'ms-1700000002', // 列表里最新 CommittedDate
      path: '',
    });
    const dir = path.join(userSkillPacksDir('m1'), 'fun-denoise');
    expect(fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf-8')).toContain('音频降噪');
    expect(fs.readFileSync(path.join(dir, 'scripts/run.sh'), 'utf-8')).toBe('#!/bin/sh\nhi\n');
    expect(fs.readdirSync(userSkillPacksDir('m1')).some((n) => n.startsWith('.tmp-'))).toBe(false);
    expect(listInstalledPacks('m1').map((p) => p.dirName)).toEqual(['fun-denoise']);
  });

  it('riskAck 未确认 / id 不合法 → 拒绝且不发请求', async () => {
    const fn = msDemoMocks();
    const noAck = await importSkillPack('m2', { platform: 'modelscope', repo: 'iic/fun-denoise', path: '' });
    expect(noAck.ok).toBe(false);
    if (!noAck.ok) expect(noAck.error).toContain('risk-ack-required');
    const badId = await importSkillPack('m2', { ...MS_OPTS, repo: '../../etc' });
    expect(badId.ok).toBe(false);
    if (!badId.ok) expect(badId.error).toContain('不合法');
    expect(fn).not.toHaveBeenCalled();
  });

  it('列表含穿越路径 → 下载前整包拒绝,不落盘', async () => {
    mockModelScopeFetch({
      listing: { '': [blob('SKILL.md', 'SKILL.md', 10), blob('evil.md', '../../escaped.md', 5)] },
      files: { 'SKILL.md': MS_SKILL_MD },
    });
    const res = await importSkillPack('m3', { ...MS_OPTS });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('非法路径');
    const root = userSkillPacksDir('m3');
    expect(fs.existsSync(root) ? fs.readdirSync(root) : []).toEqual([]);
    expect(fs.existsSync(path.join(tmpRoot, 'escaped.md'))).toBe(false);
  });

  it('列表 Size 超单文件上限 → 下载前整包拒绝(resolve 一次不打)', async () => {
    const fn = mockModelScopeFetch({
      listing: { '': [blob('SKILL.md', 'SKILL.md', 10), blob('big.bin', 'big.bin', IMPORT_MAX_FILE_BYTES + 1)] },
      files: { 'SKILL.md': MS_SKILL_MD },
    });
    const res = await importSkillPack('m4', { ...MS_OPTS });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('单文件超过上限');
    expect(fn.mock.calls.map((c) => String(c[0])).some((u) => u.includes('/resolve/'))).toBe(false);
  });

  it('列表 Size 撒谎(实际字节超限)→ 拉取时复核拒绝', async () => {
    mockModelScopeFetch({
      listing: { '': [blob('SKILL.md', 'SKILL.md', 10), blob('big.bin', 'big.bin', 10)] },
      files: { 'SKILL.md': MS_SKILL_MD, 'big.bin': Buffer.alloc(IMPORT_MAX_FILE_BYTES + 1, 7) },
    });
    const res = await importSkillPack('m5', { ...MS_OPTS });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('单文件超过上限');
    const root = userSkillPacksDir('m5');
    expect(fs.existsSync(root) ? fs.readdirSync(root) : []).toEqual([]);
  });

  it('文件数超上限 → 整包拒绝', async () => {
    const files: any[] = [blob('SKILL.md', 'SKILL.md', 10)];
    const contents: Record<string, string> = { 'SKILL.md': MS_SKILL_MD };
    for (let i = 0; i < IMPORT_MAX_FILES + 1; i++) {
      files.push(blob(`f${i}.txt`, `f${i}.txt`, 1));
      contents[`f${i}.txt`] = 'x';
    }
    mockModelScopeFetch({ listing: { '': files }, files: contents });
    const res = await importSkillPack('m6', { ...MS_OPTS });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('文件数超过上限');
  });

  it('缺 SKILL.md → 拒绝且不留残余;同名冲突 → already-installed,overwrite 可替换', async () => {
    mockModelScopeFetch({
      listing: { '': [blob('readme.md', 'readme.md', 5)] },
      files: { 'readme.md': 'hello' },
    });
    const noMd = await importSkillPack('m7', { ...MS_OPTS });
    expect(noMd.ok).toBe(false);
    if (!noMd.ok) expect(noMd.error).toContain('SKILL.md');
    const root = userSkillPacksDir('m7');
    expect(fs.existsSync(root) ? fs.readdirSync(root) : []).toEqual([]);

    msDemoMocks();
    const first = await importSkillPack('m7', { ...MS_OPTS });
    expect(first.ok).toBe(true);
    const dup = await importSkillPack('m7', { ...MS_OPTS });
    expect(dup.ok).toBe(false);
    if (!dup.ok) expect(dup.error).toContain('already-installed');
    const over = await importSkillPack('m7', { ...MS_OPTS, overwrite: true });
    expect(over.ok).toBe(true);
    expect(listInstalledPacks('m7')).toHaveLength(1);
  });

  it('技能不存在(repo/files 404)→ 真实原因透传', async () => {
    mockModelScopeFetch({ listing: {} });
    const res = await importSkillPack('m8', { ...MS_OPTS });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('不存在');
  });
});

// ---- SkillHub(腾讯)源:注册表 / 索引 / 详情 / 导入 ----

/** 注册表源 env 接管(只留一个 SkillHub 源,隔离 GitHub 网络面) */
function useSkillHubRegistry() {
  process.env.AGTPILOT_SKILL_REGISTRY_SOURCES = JSON.stringify([
    { id: 'sh', label: 'SkillHub(腾讯·国内)', repo: '', type: 'skillhub' },
  ]);
}

const SH_SKILL_MD = '---\nname: dev-god\ndescription: 编程大神\n---\n\n# 用法\n照做。';

function sha256Hex(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/** 列表项 fixture(照 api.skillhub.cn 实测样本形态) */
function shItem(over: Record<string, any> = {}) {
  return {
    name: '编程大神.Skill',
    slug: 'dev-god',
    namespace: { canonicalName: '@ake/dev-god', handle: 'ake', displayName: 'ake' },
    description_zh: '编程大神技能',
    description: 'dev god skill',
    category: 'dev-programming',
    subCategories: [{ key: 'code-gen', name: '代码生成' }],
    downloads: 8005822,
    version: '1.2.4',
    ...over,
  };
}

/**
 * SkillHub mock fetch:
 * - /api/v1/skills/<slug>/files? → 文件清单 {count,files:[{path,sha256,size}],version}
 *   (sha256 由内容现算;shaOverride 篡改/置空模拟缺字段;sizeOverride 撒谎)
 * - /api/v1/skills/<slug>/file? → 文件原文(files 以 path 为键)
 * - /api/v1/skills/<slug>? → 详情裸对象(securityReports.keen;detailStatus 故障注入)
 * - /api/skills? → 索引信封 {code:0,data:{skills,total}}
 * 分发顺序敏感:/files? → /file? → 详情裸对象 → 索引信封
 */
function mockSkillHubFetch(opts: {
  index?: any[];
  files?: Record<string, string | Buffer>;
  version?: string;
  shaOverride?: string;
  sizeOverride?: number;
  filesStatus?: number;
  detailStatus?: number;
}) {
  const fn = vi.fn(async (url: any) => {
    const u = String(url);
    if (u.includes('/api/v1/skills/') && u.includes('/files?')) {
      if (opts.filesStatus && opts.filesStatus !== 200) {
        return { ok: false, status: opts.filesStatus, json: async () => ({}) } as any;
      }
      const entries = Object.entries(opts.files ?? {}).map(([p, content]) => {
        const buf = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf-8');
        return {
          path: p,
          sha256: opts.shaOverride !== undefined ? opts.shaOverride : sha256Hex(buf),
          size: opts.sizeOverride !== undefined ? opts.sizeOverride : buf.length,
        };
      });
      return {
        ok: true,
        status: 200,
        json: async () => ({
          count: entries.length,
          files: entries,
          namespace: 'ake',
          version: opts.version ?? '1.2.4',
        }),
      } as any;
    }
    if (u.includes('/api/v1/skills/') && u.includes('/file?')) {
      const p = new URL(u).searchParams.get('path') || '';
      const content = opts.files?.[p];
      if (content === undefined) return { ok: false, status: 404, text: async () => '' } as any;
      const buf = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf-8');
      return {
        ok: true,
        status: 200,
        text: async () => buf.toString('utf-8'),
        arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
      } as any;
    }
    if (u.includes('/api/v1/skills/')) {
      if (opts.detailStatus && opts.detailStatus !== 200) {
        return { ok: false, status: opts.detailStatus, json: async () => ({}) } as any;
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          securityReports: {
            keen: { status: 'benign', statusText: '安全,无风险', reportUrl: 'https://tix.qq.com/report/x' },
          },
        }),
      } as any;
    }
    if (u.includes('/api/skills?')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ code: 0, data: { skills: opts.index ?? [], total: (opts.index ?? []).length } }),
      } as any;
    }
    return { ok: false, status: 404, json: async () => ({}) } as any;
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

describe('marketSources · SkillHub 注册表', () => {
  afterEach(() => {
    delete process.env.AGTPILOT_SKILL_REGISTRY_SOURCES;
  });

  it('缺省源含 SkillHub;env 配置 type=skillhub 时 repo 可空', () => {
    const defaults = marketSources();
    expect(defaults.some((s) => s.type === 'skillhub')).toBe(true);
    useSkillHubRegistry();
    const custom = marketSources();
    expect(custom).toHaveLength(1);
    expect(custom[0]).toMatchObject({ id: 'sh', type: 'skillhub', repo: '' });
  });
});

describe('fetchMarketIndex · SkillHub 索引', () => {
  afterEach(() => {
    delete process.env.AGTPILOT_SKILL_REGISTRY_SOURCES;
  });

  it('/api/skills 列表映射:platform/repo=canonicalName/path 空/中文名与分类/外链/下载量;脏数据跳过', async () => {
    useSkillHubRegistry();
    mockSkillHubFetch({
      index: [
        shItem(),
        shItem({ slug: 'evil', namespace: { canonicalName: 'bad id/../../evil', handle: 'ake' } }),
        shItem({ slug: undefined }),
      ],
    });
    const idx = await fetchMarketIndex(true);
    expect(idx.sources).toHaveLength(1);
    const skills = idx.sources[0].skills;
    expect(skills).toHaveLength(1);
    expect(skills[0]).toMatchObject({
      platform: 'skillhub',
      repo: '@ake/dev-god',
      path: '',
      name: '编程大神.Skill',
      category: '代码生成', // 中文子类名优先于平台分类 key
      description: '编程大神技能',
      downloads: 8005822,
      externalUrl: 'https://skillhub.cn/skills/ake/dev-god', // web 主机,非 API 主机
    });
  });

  it('search 透传到服务端(20 万+ 条目必须服务端搜索;sortBy=score 精选)', async () => {
    useSkillHubRegistry();
    const fn = mockSkillHubFetch({ index: [] });
    await fetchMarketIndex(true, 'pdf');
    const url = String(fn.mock.calls[0][0]);
    expect(url).toContain('/api/skills?');
    expect(url).toContain('keyword=pdf');
    expect(url).toContain('sortBy=score');
    expect(url).toContain('pageSize=50');
  });

  it('单源失败带 error 返回(HTTP 500 / 信封 code≠0,不静默成空列表)', async () => {
    useSkillHubRegistry();
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) }) as any));
    const idx = await fetchMarketIndex(true);
    expect(idx.sources[0].error).toContain('500');
    expect(idx.sources[0].skills).toEqual([]);
    // 信封 code≠0(HTTP 200)同样显式报错
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ code: 500, message: 'rate limited' }) }) as any)
    );
    const idx2 = await fetchMarketIndex(true);
    expect(idx2.sources[0].error).toContain('code=500');
    expect(idx2.sources[0].skills).toEqual([]);
  });
});

describe('fetchMarketSkillDetail · SkillHub 详情', () => {
  it('SKILL.md frontmatter + 全文 + 安全扫描摘要透传', async () => {
    mockSkillHubFetch({ files: { 'SKILL.md': SH_SKILL_MD } });
    const res = await fetchMarketSkillDetail('@ake/dev-god', '', 'HEAD', 'skillhub');
    expect(res).toMatchObject({ ok: true, name: 'dev-god', description: '编程大神' });
    if (res.ok) {
      expect(res.content).toContain('# 用法');
      expect(res.security).toEqual({
        status: 'benign',
        statusText: '安全,无风险',
        reportUrl: 'https://tix.qq.com/report/x',
      });
    }
  });

  it('security 端点故障 → best-effort 不阻塞 SKILL.md 预览', async () => {
    mockSkillHubFetch({ files: { 'SKILL.md': SH_SKILL_MD }, detailStatus: 500 });
    const res = await fetchMarketSkillDetail('@ake/dev-god', '', 'HEAD', 'skillhub');
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.content).toContain('# 用法');
      expect(res.security).toBeUndefined();
    }
  });

  it('非法 id 拒绝;SKILL.md 404 真实报错', async () => {
    mockSkillHubFetch({ files: {} });
    const bad = await fetchMarketSkillDetail('../evil', '', 'HEAD', 'skillhub');
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toContain('不合法');
    const miss = await fetchMarketSkillDetail('@ake/nope', '', 'HEAD', 'skillhub');
    expect(miss.ok).toBe(false);
    if (!miss.ok) expect(miss.error).toContain('SKILL.md');
  });
});

describe('importSkillPack · SkillHub 链路', () => {
  const SH_OPTS = { platform: 'skillhub', repo: '@ake/dev-god', path: '', riskAck: true } as const;

  function shDemoMocks() {
    return mockSkillHubFetch({
      files: { 'SKILL.md': SH_SKILL_MD, 'scripts/run.sh': '#!/bin/sh\nhi\n' },
    });
  }

  it('成功引用:files 清单 → 逐文件拉取(version 钉快照)→ provenance 记 sha=sh-<版本号>', async () => {
    const fn = shDemoMocks();
    const res = await importSkillPack('h1', { ...SH_OPTS });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.pack.name).toBe('dev-god'); // frontmatter name 优先
    expect(res.pack.dirName).toBe('dev-god');
    expect(res.pack.hasScripts).toBe(true);
    expect(res.pack.provenance?.source).toMatchObject({
      platform: 'skillhub',
      repo: '@ake/dev-god',
      ref: '1.2.4',
      sha: 'sh-1.2.4', // 版本号即内容版本信号(无 commit sha)
      path: '',
    });
    // version 钉快照:全部 /file 请求携带清单解析出的同一 version
    const fileUrls = fn.mock.calls.map((c) => String(c[0])).filter((u) => u.includes('/file?'));
    expect(fileUrls).toHaveLength(2);
    expect(fileUrls.every((u) => u.includes('version=1.2.4'))).toBe(true);
    const dir = path.join(userSkillPacksDir('h1'), 'dev-god');
    expect(fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf-8')).toContain('编程大神');
    expect(fs.readFileSync(path.join(dir, 'scripts/run.sh'), 'utf-8')).toBe('#!/bin/sh\nhi\n');
    expect(fs.readdirSync(userSkillPacksDir('h1')).some((n) => n.startsWith('.tmp-'))).toBe(false);
    expect(listInstalledPacks('h1').map((p) => p.dirName)).toEqual(['dev-god']);
  });

  it('riskAck 未确认 / id 不合法 → 拒绝且不发请求', async () => {
    const fn = shDemoMocks();
    const noAck = await importSkillPack('h2', { platform: 'skillhub', repo: '@ake/dev-god', path: '' });
    expect(noAck.ok).toBe(false);
    if (!noAck.ok) expect(noAck.error).toContain('risk-ack-required');
    const badId = await importSkillPack('h2', { ...SH_OPTS, repo: '../../etc' });
    expect(badId.ok).toBe(false);
    if (!badId.ok) expect(badId.error).toContain('不合法');
    expect(fn).not.toHaveBeenCalled();
  });

  it('清单含穿越路径 → 下载前整包拒绝,不落盘', async () => {
    mockSkillHubFetch({ files: { 'SKILL.md': SH_SKILL_MD, '../../escaped.md': 'evil' } });
    const res = await importSkillPack('h3', { ...SH_OPTS });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('非法路径');
    const root = userSkillPacksDir('h3');
    expect(fs.existsSync(root) ? fs.readdirSync(root) : []).toEqual([]);
    expect(fs.existsSync(path.join(tmpRoot, 'escaped.md'))).toBe(false);
  });

  it('清单 size 超单文件上限 → 下载前整包拒绝(/file 一次不打)', async () => {
    const fn = mockSkillHubFetch({
      files: { 'SKILL.md': SH_SKILL_MD, 'big.bin': 'small' },
      sizeOverride: IMPORT_MAX_FILE_BYTES + 1,
    });
    const res = await importSkillPack('h4', { ...SH_OPTS });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('单文件超过上限');
    expect(fn.mock.calls.map((c) => String(c[0])).some((u) => u.includes('/file?'))).toBe(false);
  });

  it('清单 size 撒谎(实际字节超限)→ 拉取时字节复核拒绝', async () => {
    mockSkillHubFetch({
      files: { 'SKILL.md': SH_SKILL_MD, 'big.bin': Buffer.alloc(IMPORT_MAX_FILE_BYTES + 1, 7) },
      sizeOverride: 10,
    });
    const res = await importSkillPack('h5', { ...SH_OPTS });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('单文件超过上限');
    const root = userSkillPacksDir('h5');
    expect(fs.existsSync(root) ? fs.readdirSync(root) : []).toEqual([]);
  });

  it('文件内容 sha256 不匹配(调包/篡改)→ 拒绝', async () => {
    mockSkillHubFetch({
      files: { 'SKILL.md': SH_SKILL_MD, 'notes.md': 'original' },
      shaOverride: 'b'.repeat(64), // 形态合法但内容不匹配
    });
    const res = await importSkillPack('h6', { ...SH_OPTS });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('sha256');
    const root = userSkillPacksDir('h6');
    expect(fs.existsSync(root) ? fs.readdirSync(root) : []).toEqual([]);
  });

  it('清单缺 sha256 → 整包拒绝(硬护栏不降级,/file 一次不打)', async () => {
    const fn = mockSkillHubFetch({ files: { 'SKILL.md': SH_SKILL_MD }, shaOverride: '' });
    const res = await importSkillPack('h6b', { ...SH_OPTS });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('缺少 sha256');
    expect(fn.mock.calls.map((c) => String(c[0])).some((u) => u.includes('/file?'))).toBe(false);
  });

  it('文件数超上限 → 整包拒绝', async () => {
    const files: Record<string, string> = { 'SKILL.md': SH_SKILL_MD };
    for (let i = 0; i < IMPORT_MAX_FILES + 1; i++) files[`f${i}.txt`] = 'x';
    mockSkillHubFetch({ files });
    const res = await importSkillPack('h7', { ...SH_OPTS });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('文件数超过上限');
  });

  it('缺 SKILL.md → 拒绝且不留残余;同名冲突 → already-installed,overwrite 可替换', async () => {
    mockSkillHubFetch({ files: { 'readme.md': 'hello' } });
    const noMd = await importSkillPack('h8', { ...SH_OPTS });
    expect(noMd.ok).toBe(false);
    if (!noMd.ok) expect(noMd.error).toContain('SKILL.md');
    const root = userSkillPacksDir('h8');
    expect(fs.existsSync(root) ? fs.readdirSync(root) : []).toEqual([]);

    shDemoMocks();
    const first = await importSkillPack('h8', { ...SH_OPTS });
    expect(first.ok).toBe(true);
    const dup = await importSkillPack('h8', { ...SH_OPTS });
    expect(dup.ok).toBe(false);
    if (!dup.ok) expect(dup.error).toContain('already-installed');
    const over = await importSkillPack('h8', { ...SH_OPTS, overwrite: true });
    expect(over.ok).toBe(true);
    expect(listInstalledPacks('h8')).toHaveLength(1);
  });

  it('技能不存在(/files 404)→ 真实原因透传', async () => {
    mockSkillHubFetch({ files: { 'SKILL.md': SH_SKILL_MD }, filesStatus: 404 });
    const res = await importSkillPack('h9', { ...SH_OPTS });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('不存在或已下架');
  });
});

// ---- 任务侧接线 ----

describe('显式引用注入块 / 引用收敛 / skill_pack_read 工具', () => {
  it('无引用或全部解析不到 → 空串(零开销)', () => {
    expect(buildReferencedPacksBlock('u11', undefined)).toBe('');
    expect(buildReferencedPacksBlock('u11', [])).toBe('');
    seedInstalledPack('u11', 'demo-skill', 'demo-skill');
    expect(buildReferencedPacksBlock('u11', ['没装过的包'])).toBe('');
  });

  it('引用已装包 → SKILL.md 全文注入,含「用户指定/严格遵循」与第三方护栏,frontmatter 已剥', () => {
    seedInstalledPack('u11', 'demo-skill', 'demo-skill');
    const block = buildReferencedPacksBlock('u11', ['demo-skill']);
    expect(block).toContain('用户指定技能包');
    expect(block).toContain('严格遵循');
    expect(block).toContain('第三方');
    expect(block).toContain('不得越权');
    expect(block).toContain('技能包「demo-skill」');
    expect(block).toContain('body'); // 正文注入
    expect(block).not.toContain('description: 测试包'); // frontmatter 已剥
  });

  it('dirName 寻址命中(fm.name ≠ dirName 时按 dirName 引用也解析,注入用 canonical name)', () => {
    seedInstalledPack('u14', 'pack-dir', '包名甲');
    const block = buildReferencedPacksBlock('u14', ['pack-dir']);
    expect(block).toContain('技能包「包名甲」');
  });

  it('去重 + 上限:同名重复只注入一次;超过上限只取前 N 个可解析的', () => {
    for (let i = 0; i < REFERENCED_PACK_MAX + 2; i++) {
      seedInstalledPack('u15', `pack-${i}`, `pack-${i}`);
    }
    const names = ['pack-0', 'pack-0', ...Array.from({ length: REFERENCED_PACK_MAX + 1 }, (_, i) => `pack-${i + 1}`)];
    const block = buildReferencedPacksBlock('u15', names);
    expect(block).toContain('技能包「pack-0」');
    expect(block.split('### 技能包「').length - 1).toBe(REFERENCED_PACK_MAX);
    expect(block).not.toContain(`pack-${REFERENCED_PACK_MAX + 1}`);
  });

  it('超长 SKILL.md → 截断到预算并附指向 skill_pack_read 的截断标记', () => {
    const dir = seedInstalledPack('u16', 'big-skill', 'big-skill');
    const long = 'x'.repeat(REFERENCED_PACK_CHARS + 5000);
    fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: big-skill\n---\n${long}`);
    const block = buildReferencedPacksBlock('u16', ['big-skill']);
    expect(block).toContain('全文已截断');
    expect(block).toContain('skill_pack_read');
    expect(block).not.toContain('x'.repeat(REFERENCED_PACK_CHARS + 1));
  });

  it('sanitizeSkillPackRefs:过滤未安装/非字符串/空串,dirName 归一 canonical name,去重 + cap', () => {
    seedInstalledPack('u17', 'pack-dir', '包名乙');
    seedInstalledPack('u17', 'other', 'other');
    expect(sanitizeSkillPackRefs('u17', '不是数组')).toEqual([]);
    expect(sanitizeSkillPackRefs('u17', ['包名乙', 'pack-dir', 'other', 42, '', '  ', '没装的'])).toEqual([
      '包名乙',
      'other',
    ]);
    const many = Array.from({ length: REFERENCED_PACK_MAX + 3 }, (_, i) => `pack-${i}`);
    for (let i = 0; i < REFERENCED_PACK_MAX + 3; i++) seedInstalledPack('u18', `pack-${i}`, `pack-${i}`);
    expect(sanitizeSkillPackRefs('u18', many)).toHaveLength(REFERENCED_PACK_MAX);
  });

  it('skill_pack_read:读 SKILL.md / 子文件;未装包、越界路径、不存在文件都真实报错', async () => {
    seedInstalledPack('u12', 'demo-skill', 'demo-skill');
    const [tool] = buildUserSkillPackTools('u12');
    expect(tool.name).toBe('skill_pack_read');

    const ok = await tool.execute({ pack: 'demo-skill' });
    expect(ok).toMatchObject({ success: true, file: 'SKILL.md' });
    expect(ok.content).toContain('测试包');

    const noPack = await tool.execute({ pack: '不存在的包' });
    expect(noPack).toMatchObject({ success: false });
    expect(noPack.installed).toEqual(['demo-skill']);

    const escape = await tool.execute({ pack: 'demo-skill', file: '../../../etc/passwd' });
    expect(escape).toMatchObject({ success: false });

    const missing = await tool.execute({ pack: 'demo-skill', file: 'nope.md' });
    expect(missing).toMatchObject({ success: false, error: expect.stringContaining('不存在') });
  });

  it('skill_pack_read:二进制文件拒绝', async () => {
    const dir = seedInstalledPack('u13', 'demo-skill', 'demo-skill');
    fs.writeFileSync(path.join(dir, 'blob.bin'), Buffer.from([0x00, 0x01, 0x02]));
    const [tool] = buildUserSkillPackTools('u13');
    const res = await tool.execute({ pack: 'demo-skill', file: 'blob.bin' });
    expect(res).toMatchObject({ success: false, error: expect.stringContaining('二进制') });
  });
});
