import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  saveArtifactFile,
  loadArtifactFileManifest,
  resolveArtifactFilePath,
  artifactFileExists,
  sanitizeFileName,
  FILE_ID_RE,
  ARTIFACT_FILES_DIRNAME,
  MAX_ARTIFACT_FILE_BYTES,
} from '../artifact-files';

/**
 * 文件库测试:USER_DATA_DIR 指向临时目录(getDataDir 每次调用动态读取),
 * 用完即删,不碰真实用户数据。
 */
let dataDir: string;
let savedEnv: string | undefined;

beforeEach(async () => {
  dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'artifact-files-test-'));
  savedEnv = process.env.USER_DATA_DIR;
  process.env.USER_DATA_DIR = dataDir;
});

afterEach(async () => {
  if (savedEnv === undefined) delete process.env.USER_DATA_DIR;
  else process.env.USER_DATA_DIR = savedEnv;
  await fsp.rm(dataDir, { recursive: true, force: true });
});

const PPTX_MIME =
  'application/vnd.openxmlformats-officedocument.presentationml.presentation';

function pptxBuffer(size = 128): Buffer {
  const buf = Buffer.alloc(size);
  buf.write('PK\x03\x04', 0, 'latin1');
  return buf;
}

describe('saveArtifactFile · 入库与 manifest', () => {
  it('返回合规 fileId,文件与 manifest 落在 <dataDir>/artifact_files/<uid>/ 下', () => {
    const res = saveArtifactFile({
      userId: 'user_42',
      fileName: 'Q3 业务汇报.pptx',
      mime: PPTX_MIME,
      data: pptxBuffer(2048),
    });
    expect(res.fileId).toMatch(FILE_ID_RE);
    expect(res.sizeBytes).toBe(2048);

    const dir = path.join(dataDir, ARTIFACT_FILES_DIRNAME, 'user_42');
    expect(fs.existsSync(path.join(dir, res.fileId))).toBe(true);
    const manifest = loadArtifactFileManifest('user_42', res.fileId);
    expect(manifest).not.toBeNull();
    expect(manifest!.fileName).toBe('Q3 业务汇报.pptx');
    expect(manifest!.mime).toBe(PPTX_MIME);
    expect(manifest!.sizeBytes).toBe(2048);
    expect(artifactFileExists('user_42', res.fileId)).toBe(true);
  });

  it('拒绝空内容与超过 32MB 上限', () => {
    expect(() =>
      saveArtifactFile({ userId: 'u', fileName: 'a.pptx', mime: PPTX_MIME, data: Buffer.alloc(0) })
    ).toThrow('为空');
    expect(MAX_ARTIFACT_FILE_BYTES).toBe(32 * 1024 * 1024);
    const oversize = Buffer.alloc(MAX_ARTIFACT_FILE_BYTES + 1);
    oversize.write('PK\x03\x04', 0, 'latin1');
    expect(() =>
      saveArtifactFile({ userId: 'u', fileName: 'a.pptx', mime: PPTX_MIME, data: oversize })
    ).toThrow('过大');
  });

  it('userId/fileName 消毒:路径分量与非法字符进不了文件系统路径', () => {
    const res = saveArtifactFile({
      userId: '../../etc/passwd',
      fileName: '../../..\\evil/中文 名:v1.pptx',
      mime: PPTX_MIME,
      data: pptxBuffer(),
    });
    // userId 消毒后不含路径分隔符,仍在文件库根之内
    const resolved = resolveArtifactFilePath('../../etc/passwd', res.fileId);
    expect(resolved).not.toBeNull();
    const root = path.join(dataDir, ARTIFACT_FILES_DIRNAME);
    expect(resolved!.startsWith(root + path.sep)).toBe(true);
    expect(resolved!.split(path.sep).length).toBe(root.split(path.sep).length + 2);
    // fileName 只保留 basename 且去掉控制字符,中文保留(下载时 RFC5987 还原)
    const manifest = loadArtifactFileManifest('../../etc/passwd', res.fileId);
    expect(manifest!.fileName).toBe('中文 名:v1.pptx');
    expect(manifest!.fileName).not.toContain('/');
    expect(manifest!.fileName).not.toContain('..');
  });
});

describe('resolveArtifactFilePath · fileId 围栏', () => {
  it('非法 fileId 形态一律 null(穿越/绝对路径/畸形字符)', () => {
    expect(resolveArtifactFilePath('u', '../x.pptx')).toBeNull();
    expect(resolveArtifactFilePath('u', '/etc/passwd')).toBeNull();
    expect(resolveArtifactFilePath('u', 'af_x')).toBeNull();
    expect(resolveArtifactFilePath('u', '')).toBeNull();
    expect(resolveArtifactFilePath('u', 'af_a_b')).toBeNull(); // 随机段必须 16 hex
  });

  it('合法 fileId 解析到用户分区内绝对路径;不存在的 manifest 返回 null', () => {
    const res = saveArtifactFile({
      userId: 'u1',
      fileName: 'a.pptx',
      mime: PPTX_MIME,
      data: pptxBuffer(),
    });
    const p = resolveArtifactFilePath('u1', res.fileId);
    expect(p).toBe(
      path.join(dataDir, ARTIFACT_FILES_DIRNAME, 'u1', res.fileId)
    );
    expect(loadArtifactFileManifest('u1', 'af_zzz_0123456789abcdef.pptx')).toBeNull();
    expect(loadArtifactFileManifest('u2', res.fileId)).toBeNull(); // 跨用户不可见
    expect(artifactFileExists('u2', res.fileId)).toBe(false);
  });
});

describe('sanitizeFileName · 下载文件名消毒', () => {
  it('去路径分量/控制字符,保留中文与常见符号,空输入给兜底名', () => {
    expect(sanitizeFileName('/tmp/x/演示稿 v1.pptx')).toBe('演示稿 v1.pptx');
    expect(sanitizeFileName('..\\..\\evil.pptx')).toBe('evil.pptx');
    expect(sanitizeFileName('a\x00b\x1f.pptx')).toBe('ab.pptx');
    expect(sanitizeFileName('   ')).toBe('deliverable');
    expect(sanitizeFileName('')).toBe('deliverable');
    expect(sanitizeFileName('x'.repeat(300)).length).toBeLessThanOrEqual(180);
  });
});
