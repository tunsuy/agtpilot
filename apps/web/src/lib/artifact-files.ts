/**
 * 产物文件库(S2 · 二进制交付件,如 ppt-master 产出的真 .pptx)
 *
 * ArtifactData.content 是字符串且随 mission JSON 落盘,不能塞二进制;
 * 文件本体存这里:getDataDir()/artifact_files/<safeUserId>/<fileId>,
 * 每个文件带同名 .json manifest(原始文件名/MIME/体积/时间),
 * 下载路由 /api/artifacts/file 按登录用户 + fileId 定位并回源。
 *
 * 安全约定(与 user-store 同风格):
 * - userId/fileId 全部白名单字符消毒后才拼路径,拒绝任何路径穿越;
 * - 原子写(tmp + rename),避免半截文件被下载;
 * - 单文件体积上限,超限拒收。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { getDataDir } from './user-store';

/** 单文件体积上限:.pptx 常规交付件远小于此;超限拒收防止磁盘被撑爆 */
export const MAX_ARTIFACT_FILE_BYTES = 32 * 1024 * 1024;

/** 文件库根目录名(getDataDir() 下,与 *.json 用户数据文件同级) */
export const ARTIFACT_FILES_DIRNAME = 'artifact_files';

/** fileId 形态:af_<时间36进制>_<随机hex><扩展名>;下载路由凭此正则先行校验 */
export const FILE_ID_RE = /^af_[a-z0-9]+_[a-f0-9]{16}(\.[a-z0-9]{1,10})?$/;

export interface ArtifactFileManifest {
  fileId: string;
  /** 原始文件名(含扩展名,下载时经 Content-Disposition 还原) */
  fileName: string;
  mime: string;
  sizeBytes: number;
  createdAt: number;
}

/** 路径分量消毒:只留 [A-Za-z0-9_.-],其余(含 / 与 ..)压成 _ */
function sanitizeSegment(input: string): string {
  return String(input || '').replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 120) || 'unknown';
}

/** 从文件名提取小写扩展名(含点);无扩展名返回空串 */
function extOf(fileName: string): string {
  const ext = path.extname(String(fileName || '')).toLowerCase();
  return /^\.[a-z0-9]{1,10}$/.test(ext) ? ext : '';
}

function storeRoot(): string {
  return path.join(getDataDir(), ARTIFACT_FILES_DIRNAME);
}

function userDir(userId: string): string {
  return path.join(storeRoot(), sanitizeSegment(userId));
}

/**
 * 下载/展示用文件名消毒:去掉路径分量与控制字符,保留中文与常见符号,限长。
 * 导出供单测覆盖。
 */
export function sanitizeFileName(input: string, fallback = 'deliverable'): string {
  const base = path.basename(String(input || '').replace(/\\/g, '/')).trim();
  const cleaned = base.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 180);
  return cleaned || fallback;
}

/**
 * 收下一份二进制产物文件,返回 fileId 与体积。
 * 超限抛错(调用方工具层转成 {success:false,error});原子写。
 */
export function saveArtifactFile(input: {
  userId: string;
  fileName: string;
  mime: string;
  data: Buffer;
}): { fileId: string; sizeBytes: number } {
  const { userId, mime } = input;
  const fileName = sanitizeFileName(input.fileName);
  if (!Buffer.isBuffer(input.data) || input.data.length === 0) {
    throw new Error('文件内容为空,拒绝入库');
  }
  if (input.data.length > MAX_ARTIFACT_FILE_BYTES) {
    throw new Error(
      `文件过大(${(input.data.length / 1024 / 1024).toFixed(1)}MB > ${
        MAX_ARTIFACT_FILE_BYTES / 1024 / 1024
      }MB),拒绝入库`
    );
  }
  const dir = userDir(userId);
  fs.mkdirSync(dir, { recursive: true });
  const fileId = `af_${Date.now().toString(36)}_${crypto.randomBytes(8).toString('hex')}${extOf(fileName)}`;
  const filePath = path.join(dir, fileId);
  const tmpPath = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(tmpPath, input.data);
  fs.renameSync(tmpPath, filePath);
  const manifest: ArtifactFileManifest = {
    fileId,
    fileName,
    mime: String(mime || 'application/octet-stream'),
    sizeBytes: input.data.length,
    createdAt: Date.now(),
  };
  const tmpManifest = `${filePath}.json.tmp-${process.pid}`;
  fs.writeFileSync(tmpManifest, JSON.stringify(manifest, null, 2), 'utf8');
  fs.renameSync(tmpManifest, `${filePath}.json`);
  return { fileId, sizeBytes: manifest.sizeBytes };
}

/**
 * 解析文件库内绝对路径(围栏在 storeRoot() 内);fileId/userId 形态非法返回 null。
 * 导出供单测与下载路由复用。
 */
export function resolveArtifactFilePath(userId: string, fileId: string): string | null {
  const id = String(fileId || '').trim();
  if (!FILE_ID_RE.test(id)) return null;
  const root = storeRoot();
  const resolved = path.resolve(root, sanitizeSegment(userId), id);
  if (!resolved.startsWith(root + path.sep)) return null;
  return resolved;
}

/** 读 manifest;不存在/损坏返回 null */
export function loadArtifactFileManifest(
  userId: string,
  fileId: string
): ArtifactFileManifest | null {
  const filePath = resolveArtifactFilePath(userId, fileId);
  if (!filePath) return null;
  try {
    const raw = fs.readFileSync(`${filePath}.json`, 'utf8');
    const parsed = JSON.parse(raw);
    if (typeof parsed?.fileId !== 'string' || typeof parsed?.fileName !== 'string') return null;
    return parsed as ArtifactFileManifest;
  } catch {
    return null;
  }
}

/** 文件本体是否存在(manifest 在但文件被清理时下载路由回 404) */
export function artifactFileExists(userId: string, fileId: string): boolean {
  const filePath = resolveArtifactFilePath(userId, fileId);
  if (!filePath) return false;
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}
