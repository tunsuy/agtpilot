/**
 * 工坊「参考资料」本地上传文件库(2026-10-20「上传文件」)
 *
 * 参考资料原只支持勾选会话交付物(art_<missionId>,正文在 mission JSON 里);
 * 本库补「本地上传」来源:文件存服务端 getDataDir()/material_uploads/<safeUserId>/,
 * 布局与 artifact_files 同款(文件本体 + 同名 .json manifest,原子写 tmp+rename)。
 *
 * 与交付物同一条读取链路:prompt 里只带引用 id(upl_*)+ 标题,Agent 用
 * read_reference_material 工具按需拉全文(lib/reference-materials.ts 认 upl_ 前缀
 * 落到这里),分段续读/条数上限等语义与 art_* 完全一致。
 *
 * 文件类型三档(白名单外拒收,如实报错):
 * - text:纯文本/代码(md/txt/csv/json/log/yaml/html/sql/常见源码后缀),UTF-8 直存直读;
 * - pdf:上传时经 unpdf 抽取文本层存 `<id>.txt`(扫描件无文本层 → 拒收并说明,不存半残资料);
 * - docx:上传时经 mammoth 抽取纯文本同上(旧 .doc 二进制格式不支持,拒收时说明)。
 *
 * 安全约定(与 artifact-files / user-store 同风格):
 * - userId/uploadId 白名单消毒后才拼路径,双重围栏拒绝穿越;
 * - 原始文件名只做展示(消毒限长),绝不进路径;
 * - 单文件/总量/份数三重上限,超限拒收并回显占用(不自动淘汰,用户自管);
 * - 只按登录用户分区,任何读取都要求 userId 匹配(工具端同源)。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { getDataDir } from './user-store';
import { MATERIAL_TEXT_EXTS } from '../workshops/shared/materials';

/** 上传库根目录名(getDataDir() 下,与 artifact_files 同级) */
export const MATERIAL_UPLOADS_DIRNAME = 'material_uploads';

/** uploadId 形态:upl_<时间36进制>_<随机hex16>;路由与引用解析凭此正则先行校验 */
export const UPLOAD_ID_RE = /^upl_[a-z0-9]+_[a-f0-9]{16}$/;

/** 纯文本类单文件上限 2MB(参考资料的量级是文档,不是数据集) */
export const MAX_TEXT_BYTES = 2 * 1024 * 1024;
/** PDF/Word 单文件上限 20MB(二进制原件 + 抽取文本双份存) */
export const MAX_BINARY_BYTES = 20 * 1024 * 1024;
/** 每用户上传库总预算 100MB(按原件体积计;超限拒收并回显占用) */
export const MAX_TOTAL_BYTES = 100 * 1024 * 1024;
/** 每用户上传份数上限(防选择器被灌爆;超限先删旧) */
export const MAX_FILE_COUNT = 50;

export type MaterialKind = 'text' | 'pdf' | 'docx';

/** 纯文本类扩展名白名单(单一事实源在 workshops/shared/materials.ts,选择器 accept 同源) */
const TEXT_EXTS = new Set<string>(MATERIAL_TEXT_EXTS);

/** 文件名 → 类型档位;不支持的扩展名(含 .doc/.pptx/图片/压缩包等)→ null */
export function classifyMaterialFile(fileName: string): { kind: MaterialKind; ext: string } | null {
  const ext = path.extname(String(fileName || '')).toLowerCase();
  if (ext === '.pdf') return { kind: 'pdf', ext };
  if (ext === '.docx') return { kind: 'docx', ext };
  if (TEXT_EXTS.has(ext)) return { kind: 'text', ext };
  return null;
}

/** 类型上限:文本档 2MB,PDF/Word 档 20MB */
export function maxBytesFor(kind: MaterialKind): number {
  return kind === 'text' ? MAX_TEXT_BYTES : MAX_BINARY_BYTES;
}

export interface MaterialUploadManifest {
  uploadId: string;
  /** 原始文件名(消毒后;展示用,不进路径) */
  fileName: string;
  /** 选择器/引用标题(去扩展名,限长) */
  title: string;
  mime: string;
  kind: MaterialKind;
  /** 原件体积(字节;总预算按此计) */
  sizeBytes: number;
  /** 抽取/直读文本的字符数(选择器展示与工具分页参考) */
  textChars: number;
  createdAt: number;
}

/** 路径分量消毒:只留 [A-Za-z0-9_.-],其余(含 / 与 ..)压成 _(与 artifact-files 同款) */
function sanitizeSegment(input: string): string {
  return String(input || '').replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 120) || 'unknown';
}

/** 展示文件名消毒:去路径分量与控制字符,保留中文,限长 */
export function sanitizeUploadName(input: string): string {
  const base = path.basename(String(input || '').replace(/\\/g, '/')).trim();
  const cleaned = base.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 180);
  return cleaned || '未命名文件';
}

/** 引用标题:文件名去扩展名,限 120 字符;去完为空(如 '.md')→ 兜底话术 */
export function titleOfFileName(fileName: string): string {
  const base = fileName.replace(/\.[a-z0-9]{1,10}$/i, '').trim();
  return base.slice(0, 120) || '上传资料';
}

function storeRoot(): string {
  return path.join(getDataDir(), MATERIAL_UPLOADS_DIRNAME);
}

/** 解析上传库内绝对路径(围栏在 storeRoot() 内);id/userId 形态非法返回 null */
export function resolveMaterialUploadPath(userId: string, uploadId: string): string | null {
  const id = String(uploadId || '').trim();
  if (!UPLOAD_ID_RE.test(id)) return null;
  const root = storeRoot();
  const resolved = path.resolve(root, sanitizeSegment(userId), id);
  if (!resolved.startsWith(root + path.sep)) return null;
  return resolved;
}

export function loadMaterialUploadManifest(userId: string, uploadId: string): MaterialUploadManifest | null {
  const filePath = resolveMaterialUploadPath(userId, uploadId);
  if (!filePath) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(`${filePath}.json`, 'utf8'));
    if (typeof parsed?.uploadId !== 'string' || typeof parsed?.fileName !== 'string') return null;
    return parsed as MaterialUploadManifest;
  } catch {
    return null;
  }
}

/** 列出某用户全部上传(新→旧);目录不存在 → 空表 */
export function listMaterialUploads(userId: string): MaterialUploadManifest[] {
  const dir = path.join(storeRoot(), sanitizeSegment(userId));
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out: MaterialUploadManifest[] = [];
  for (const n of names) {
    if (!n.endsWith('.json')) continue;
    const m = loadMaterialUploadManifest(userId, n.slice(0, -'.json'.length));
    if (m && m.uploadId === n.slice(0, -'.json'.length)) out.push(m);
  }
  return out.sort((a, b) => b.createdAt - a.createdAt);
}

/**
 * 读上传资料的文本正文(text 直读原件;pdf/docx 读抽取出的 .txt)。
 * 不存在/IO 失败 → null(工具端转成「引用解析失败」降级话术)。
 */
export function readMaterialText(userId: string, uploadId: string): string | null {
  const filePath = resolveMaterialUploadPath(userId, uploadId);
  if (!filePath) return null;
  const manifest = loadMaterialUploadManifest(userId, uploadId);
  if (!manifest) return null;
  try {
    const target = manifest.kind === 'text' ? filePath : `${filePath}.txt`;
    if (!fs.existsSync(target)) return null;
    return fs.readFileSync(target, 'utf8');
  } catch {
    return null;
  }
}

/** 删除上传(原件 + manifest + .txt);成功/本就不存在都返回 true 语义由 ok 区分 */
export function deleteMaterialUpload(userId: string, uploadId: string): boolean {
  const filePath = resolveMaterialUploadPath(userId, uploadId);
  if (!filePath) return false;
  let any = false;
  for (const p of [filePath, `${filePath}.json`, `${filePath}.txt`]) {
    try {
      if (fs.existsSync(p)) {
        fs.unlinkSync(p);
        any = true;
      }
    } catch {
      // 单文件删除失败继续删其余(残留可重试)
    }
  }
  return any;
}

/** PDF/Word 文本抽取器(默认实现懒加载 unpdf/mammoth;测试可注入替身) */
export interface MaterialExtractors {
  pdf: (data: Buffer) => Promise<string>;
  docx: (data: Buffer) => Promise<string>;
}

export const defaultExtractors: MaterialExtractors = {
  pdf: async (data) => {
    const { getDocumentProxy, extractText } = await import('unpdf');
    const doc = await getDocumentProxy(new Uint8Array(data));
    const { text } = await extractText(doc, { mergePages: true });
    return String(text ?? '');
  },
  docx: async (data) => {
    const mammoth = await import('mammoth');
    const r = await (mammoth.default ?? mammoth).extractRawText({ buffer: data });
    return String(r?.value ?? '');
  },
};

export interface SaveMaterialUploadInput {
  userId: string;
  fileName: string;
  mime?: string;
  data: Buffer;
  extractors?: MaterialExtractors;
  now?: number;
}

/**
 * 收下一份上传资料:类型/体积/份数/总预算四道闸全过才落盘。
 * 失败一律抛 Error(路由层转 400 文案,用户可见,不静默);
 * pdf/docx 在上传时即抽取文本(一次性成本;抽取失败/无文本层拒收,
 * 宁可让用户当场知道,也不存一份 Agent 读不出正文的半残资料)。
 */
export async function saveMaterialUpload(input: SaveMaterialUploadInput): Promise<MaterialUploadManifest> {
  const { userId, mime } = input;
  const fileName = sanitizeUploadName(input.fileName);
  if (!Buffer.isBuffer(input.data) || input.data.length === 0) {
    throw new Error('文件内容为空,拒绝入库');
  }
  const cls = classifyMaterialFile(fileName);
  if (!cls) {
    throw new Error(
      `不支持的文件类型(${path.extname(fileName) || '无扩展名'}):支持纯文本/代码(md、txt、csv、json、log、yaml、html、sql 及常见源码)、PDF、Word(.docx;.doc 旧格式请先另存为 .docx)`
    );
  }
  const limit = maxBytesFor(cls.kind);
  if (input.data.length > limit) {
    throw new Error(
      `文件过大(${(input.data.length / 1024 / 1024).toFixed(1)}MB > ${limit / 1024 / 1024}MB),拒绝入库`
    );
  }
  const existing = listMaterialUploads(userId);
  if (existing.length >= MAX_FILE_COUNT) {
    throw new Error(`上传份数超限(${existing.length}/${MAX_FILE_COUNT}),请先删除不再需要的资料`);
  }
  const used = existing.reduce((s, m) => s + (Number(m.sizeBytes) || 0), 0);
  if (used + input.data.length > MAX_TOTAL_BYTES) {
    throw new Error(
      `上传库总预算超限:现有 ${(used / 1024 / 1024).toFixed(1)}MB + 本次 ${(input.data.length / 1024 / 1024).toFixed(1)}MB > ${MAX_TOTAL_BYTES / 1024 / 1024}MB,请先删除不再需要的资料`
    );
  }

  // 文本抽取(pdf/docx 先抽后存:抽取失败不落任何文件)
  let text: string | null = null;
  if (cls.kind !== 'text') {
    const ex = input.extractors ?? defaultExtractors;
    try {
      text = await (cls.kind === 'pdf' ? ex.pdf(input.data) : ex.docx(input.data));
    } catch (e: any) {
      throw new Error(
        cls.kind === 'pdf'
          ? `PDF 解析失败(文件损坏或加密):${String(e?.message || e).slice(0, 200)}`
          : `Word 解析失败(文件损坏或实为旧 .doc 格式):${String(e?.message || e).slice(0, 200)}`
      );
    }
    if (!text || !text.trim()) {
      throw new Error(
        cls.kind === 'pdf'
          ? '该 PDF 抽不出文本(可能是扫描件/纯图片):请改用带文本层的文件,或把关键内容粘贴成 txt/md 再传'
          : '该 Word 文档抽不出文本(可能是空文档或纯图片):请检查后重传'
      );
    }
  } else {
    text = input.data.toString('utf8');
  }

  const dir = path.join(storeRoot(), sanitizeSegment(userId));
  fs.mkdirSync(dir, { recursive: true });
  const now = input.now ?? Date.now();
  const uploadId = `upl_${now.toString(36)}_${crypto.randomBytes(8).toString('hex')}`;
  const filePath = path.join(dir, uploadId);

  // 原子写:原件 → 抽取文本(pdf/docx)→ manifest(manifest 最后落,半途失败不会留下「可见但读不出」的条目)
  const writeAtomic = (target: string, data: Buffer | string) => {
    const tmp = `${target}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, target);
  };
  writeAtomic(filePath, input.data);
  if (cls.kind !== 'text' && text !== null) writeAtomic(`${filePath}.txt`, text);
  const manifest: MaterialUploadManifest = {
    uploadId,
    fileName,
    title: titleOfFileName(fileName),
    mime: String(mime || 'application/octet-stream'),
    kind: cls.kind,
    sizeBytes: input.data.length,
    textChars: text ? text.length : input.data.toString('utf8').length,
    createdAt: now,
  };
  writeAtomic(`${filePath}.json`, JSON.stringify(manifest, null, 2));
  return manifest;
}
