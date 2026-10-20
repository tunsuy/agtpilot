import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  classifyMaterialFile,
  sanitizeUploadName,
  titleOfFileName,
  resolveMaterialUploadPath,
  saveMaterialUpload,
  listMaterialUploads,
  readMaterialText,
  deleteMaterialUpload,
  loadMaterialUploadManifest,
  maxBytesFor,
  UPLOAD_ID_RE,
  MAX_TEXT_BYTES,
  MAX_FILE_COUNT,
  MATERIAL_UPLOADS_DIRNAME,
  type MaterialExtractors,
} from '../material-uploads';

let tmpDir: string;
let savedEnv: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'material-uploads-test-'));
  savedEnv = process.env.USER_DATA_DIR;
  process.env.USER_DATA_DIR = tmpDir;
});

afterEach(() => {
  if (savedEnv === undefined) delete process.env.USER_DATA_DIR;
  else process.env.USER_DATA_DIR = savedEnv;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** 抽取器替身:避免测试真解析 pdf/docx(解析正确性归 unpdf/mammoth 自身) */
const fakeExtractors = (text: string): MaterialExtractors => ({
  pdf: async () => text,
  docx: async () => text,
});

const buf = (s: string) => Buffer.from(s, 'utf8');

describe('classifyMaterialFile(类型档位白名单)', () => {
  it('文本/代码 → text;pdf/docx → 对应档;大小写不敏感', () => {
    expect(classifyMaterialFile('notes.md')).toEqual({ kind: 'text', ext: '.md' });
    expect(classifyMaterialFile('data.CSV')).toEqual({ kind: 'text', ext: '.csv' });
    expect(classifyMaterialFile('main.py')).toEqual({ kind: 'text', ext: '.py' });
    expect(classifyMaterialFile('report.pdf')).toEqual({ kind: 'pdf', ext: '.pdf' });
    expect(classifyMaterialFile('合同.DOCX')).toEqual({ kind: 'docx', ext: '.docx' });
  });
  it('白名单外一律 null(旧 .doc/图片/压缩包/无扩展名)', () => {
    expect(classifyMaterialFile('old.doc')).toBeNull();
    expect(classifyMaterialFile('pic.png')).toBeNull();
    expect(classifyMaterialFile('deck.pptx')).toBeNull();
    expect(classifyMaterialFile('archive.zip')).toBeNull();
    expect(classifyMaterialFile('README')).toBeNull();
    expect(classifyMaterialFile('')).toBeNull();
  });
  it('档位体积上限:text 2MB,pdf/docx 20MB', () => {
    expect(maxBytesFor('text')).toBe(MAX_TEXT_BYTES);
    expect(maxBytesFor('pdf')).toBe(20 * 1024 * 1024);
  });
});

describe('文件名消毒与标题', () => {
  it('去路径分量/控制字符,保留中文;空名兜底', () => {
    expect(sanitizeUploadName('../../etc/passwd.md')).toBe('passwd.md');
    expect(sanitizeUploadName('C:\\Users\\a\\报告 v2.pdf')).toBe('报告 v2.pdf');
    expect(sanitizeUploadName('bad\x00name.txt')).toBe('badname.txt');
    expect(sanitizeUploadName('')).toBe('未命名文件');
  });
  it('标题 = 去扩展名限长', () => {
    expect(titleOfFileName('年度报告.pdf')).toBe('年度报告');
    expect(titleOfFileName('x'.repeat(300) + '.md')).toHaveLength(120);
    expect(titleOfFileName('.md')).toBe('上传资料');
  });
});

describe('resolveMaterialUploadPath(路径围栏)', () => {
  it('id 形态非法拒绝;合法 id 落在库根内', () => {
    expect(resolveMaterialUploadPath('u1', 'nope')).toBeNull();
    expect(resolveMaterialUploadPath('u1', 'upl_x')).toBeNull();
    expect(resolveMaterialUploadPath('u1', '../../etc/passwd')).toBeNull();
    const p = resolveMaterialUploadPath('u1', 'upl_abc_0123456789abcdef');
    expect(p).not.toBeNull();
    expect(p!.startsWith(path.join(tmpDir, MATERIAL_UPLOADS_DIRNAME) + path.sep)).toBe(true);
  });
  it('UPLOAD_ID_RE 与 saveMaterialUpload 产出一致', () => {
    expect(UPLOAD_ID_RE.test('upl_lz4k1_0123456789abcdef')).toBe(true);
    expect(UPLOAD_ID_RE.test('upl_LZ_0123456789abcdef')).toBe(false);
  });
});

describe('saveMaterialUpload · text(直存直读)', () => {
  it('入库后 manifest/列表/正文读取三处一致', async () => {
    const m = await saveMaterialUpload({
      userId: 'u1',
      fileName: 'notes.md',
      mime: 'text/markdown',
      data: buf('# 标题\n正文内容'),
      now: 1_760_000_000_000,
    });
    expect(m.uploadId).toMatch(UPLOAD_ID_RE);
    expect(m.kind).toBe('text');
    expect(m.title).toBe('notes');
    expect(m.sizeBytes).toBe(Buffer.byteLength('# 标题\n正文内容'));
    expect(m.textChars).toBe('# 标题\n正文内容'.length);

    expect(readMaterialText('u1', m.uploadId)).toBe('# 标题\n正文内容');
    const list = listMaterialUploads('u1');
    expect(list).toHaveLength(1);
    expect(list[0].uploadId).toBe(m.uploadId);
    expect(loadMaterialUploadManifest('u1', m.uploadId)?.fileName).toBe('notes.md');
    // text 档不产 .txt(直读原件)
    const filePath = resolveMaterialUploadPath('u1', m.uploadId)!;
    expect(fs.existsSync(`${filePath}.txt`)).toBe(false);
  });

  it('用户分区隔离:他人读不到、列不出', async () => {
    const m = await saveMaterialUpload({ userId: 'u1', fileName: 'a.txt', data: buf('secret') });
    expect(readMaterialText('u2', m.uploadId)).toBeNull();
    expect(listMaterialUploads('u2')).toEqual([]);
    expect(deleteMaterialUpload('u2', m.uploadId)).toBe(false);
    expect(readMaterialText('u1', m.uploadId)).toBe('secret'); // 原用户不受影响
  });

  it('空文件/白名单外类型/超文本上限 → 拒收(抛人话错误,不落任何文件)', async () => {
    await expect(saveMaterialUpload({ userId: 'u1', fileName: 'a.txt', data: Buffer.alloc(0) })).rejects.toThrow('为空');
    await expect(saveMaterialUpload({ userId: 'u1', fileName: 'pic.png', data: buf('x') })).rejects.toThrow('不支持的文件类型');
    await expect(
      saveMaterialUpload({ userId: 'u1', fileName: 'big.txt', data: Buffer.alloc(MAX_TEXT_BYTES + 1, 97) })
    ).rejects.toThrow('文件过大');
    expect(listMaterialUploads('u1')).toEqual([]);
  });

  it('份数上限:第 MAX_FILE_COUNT+1 份拒收并提示先删', async () => {
    for (let i = 0; i < MAX_FILE_COUNT; i++) {
      await saveMaterialUpload({ userId: 'u1', fileName: `f${i}.txt`, data: buf('x'), now: 1_700_000_000_000 + i });
    }
    await expect(saveMaterialUpload({ userId: 'u1', fileName: 'one-more.txt', data: buf('x') })).rejects.toThrow(
      '上传份数超限'
    );
  }, 30_000);
});

describe('saveMaterialUpload · pdf/docx(上传时抽取文本)', () => {
  it('pdf:原件 + .txt + manifest 三件套;读取走抽取文本', async () => {
    const m = await saveMaterialUpload({
      userId: 'u1',
      fileName: 'report.pdf',
      mime: 'application/pdf',
      data: buf('%PDF-1.4 fake'),
      extractors: fakeExtractors('第一页内容\n第二页内容'),
    });
    expect(m.kind).toBe('pdf');
    expect(m.textChars).toBe('第一页内容\n第二页内容'.length);
    const filePath = resolveMaterialUploadPath('u1', m.uploadId)!;
    expect(fs.existsSync(filePath)).toBe(true); // 原件保留可复查
    expect(fs.readFileSync(`${filePath}.txt`, 'utf8')).toBe('第一页内容\n第二页内容');
    expect(readMaterialText('u1', m.uploadId)).toBe('第一页内容\n第二页内容');
  });

  it('docx:同款三件套', async () => {
    const m = await saveMaterialUpload({
      userId: 'u1',
      fileName: '合同.docx',
      data: buf('PK fake docx'),
      extractors: fakeExtractors('合同条款正文'),
    });
    expect(m.kind).toBe('docx');
    expect(m.title).toBe('合同');
    expect(readMaterialText('u1', m.uploadId)).toBe('合同条款正文');
  });

  it('抽取失败(损坏/加密)→ 拒收说明原因,零残留', async () => {
    const bad: MaterialExtractors = {
      pdf: async () => {
        throw new Error('Invalid PDF structure');
      },
      docx: async () => {
        throw new Error('not a zip');
      },
    };
    await expect(
      saveMaterialUpload({ userId: 'u1', fileName: 'broken.pdf', data: buf('%PDF'), extractors: bad })
    ).rejects.toThrow('PDF 解析失败');
    await expect(
      saveMaterialUpload({ userId: 'u1', fileName: 'old.docx', data: buf('PK'), extractors: bad })
    ).rejects.toThrow('Word 解析失败');
    expect(listMaterialUploads('u1')).toEqual([]);
  });

  it('抽不出文本(扫描件/空文档)→ 拒收并给替代路径', async () => {
    await expect(
      saveMaterialUpload({ userId: 'u1', fileName: 'scan.pdf', data: buf('%PDF'), extractors: fakeExtractors('   ') })
    ).rejects.toThrow('扫描件');
    await expect(
      saveMaterialUpload({ userId: 'u1', fileName: 'empty.docx', data: buf('PK'), extractors: fakeExtractors('') })
    ).rejects.toThrow('抽不出文本');
    expect(listMaterialUploads('u1')).toEqual([]);
  });
});

describe('deleteMaterialUpload', () => {
  it('删除后列表/读取/manifest 全空;重复删返回 false', async () => {
    const m = await saveMaterialUpload({
      userId: 'u1',
      fileName: 'a.pdf',
      data: buf('%PDF'),
      extractors: fakeExtractors('text'),
    });
    expect(deleteMaterialUpload('u1', m.uploadId)).toBe(true);
    expect(listMaterialUploads('u1')).toEqual([]);
    expect(readMaterialText('u1', m.uploadId)).toBeNull();
    expect(loadMaterialUploadManifest('u1', m.uploadId)).toBeNull();
    const filePath = resolveMaterialUploadPath('u1', m.uploadId)!;
    expect(fs.existsSync(`${filePath}.txt`)).toBe(false);
    expect(deleteMaterialUpload('u1', m.uploadId)).toBe(false);
  });
  it('id 形态非法 → false', () => {
    expect(deleteMaterialUpload('u1', 'art_m1')).toBe(false);
  });
});
