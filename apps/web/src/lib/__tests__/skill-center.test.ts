/**
 * skill-center(技能中心宿主服务)单测:
 * - 校验纯函数(repo slug / 相对路径 / 目录名归一)
 * - 最小 tar 解析:正常提取、目录条目、软链/硬链拒绝、路径穿越拒绝、限额
 * - 用户安装域:清单 / 解除引用(围栏 + 台账)/ 技能卡删除(台账 + 审计)
 * - 引用导入:riskAck 强制、仓库名校验、mock fetch 全链路、同名冲突、来源记录
 * - 任务侧接线:目录块 / skill_pack_read 工具(围栏 + 二进制拒绝)
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as zlib from 'zlib';

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
  isSafeRelPath,
  sanitizePackName,
  extractTarSubdir,
  userSkillPacksDir,
  listInstalledPacks,
  uninstallSkillPack,
  deleteSkillCard,
  importSkillPack,
  buildUserPackCatalogBlock,
  buildUserSkillPackTools,
  IMPORT_MAX_FILES,
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

// ---- 任务侧接线 ----

describe('目录块与 skill_pack_read 工具', () => {
  it('无安装 → 目录块空串;有安装 → 含名字与描述与第三方警示', () => {
    expect(buildUserPackCatalogBlock('u11')).toBe('');
    seedInstalledPack('u11', 'demo-skill', 'demo-skill');
    const block = buildUserPackCatalogBlock('u11');
    expect(block).toContain('用户安装技能包');
    expect(block).toContain('demo-skill');
    expect(block).toContain('skill_pack_read');
    expect(block).toContain('第三方');
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
