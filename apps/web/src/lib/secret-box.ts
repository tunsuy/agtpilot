import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
// 循环依赖说明：user-store ⇄ secret-box 互相引用，但双方都只在【函数调用时】
// 使用对方导出（ESM live binding / CJS 延迟属性访问），模块求值期无交叉调用，安全。
import { getDataDir } from './user-store';

/**
 * 凭证静态加密层 (Secret Box)
 *
 * 用户连接器凭证（API Key / OAuth Token / MCP 授权记录）落盘前一律
 * AES-256-GCM 加密，格式：`enc:v1:<iv>:<tag>:<cipher>`（base64url）。
 *
 * 密钥来源（优先级从高到低）：
 * 1. 环境变量 AGTPILOT_SECRET_KEY（任意长度字符串，SHA-256 派生 32 字节）——
 *    生产部署推荐，随容器编排注入；
 * 2. 数据目录下自动生成的 .secret_key 文件（0600 权限，32 字节随机 hex）——
 *    开箱即用，密钥与数据同盘（防"备份文件裸奔"，不防主机沦陷）。
 *
 * 兼容：无 `enc:v1:` 前缀的历史明文值原样返回（读取路径触发自动迁移加密）。
 * 密钥丢失/轮换导致解密失败时返回空串并告警，等效"未配置"，不使进程崩溃。
 */

const PREFIX = 'enc:v1:';

let cachedKey: Buffer | null = null;

function getKeyFile(): string {
  return path.join(getDataDir(), '.secret_key');
}

function resolveKey(): Buffer {
  if (cachedKey) return cachedKey;

  const fromEnv = process.env.AGTPILOT_SECRET_KEY;
  if (fromEnv && fromEnv.trim().length > 0) {
    cachedKey = crypto.createHash('sha256').update(fromEnv.trim()).digest();
    return cachedKey;
  }

  const keyFile = getKeyFile();
  try {
    if (fs.existsSync(keyFile)) {
      const hex = fs.readFileSync(keyFile, 'utf-8').trim();
      if (/^[0-9a-f]{64}$/i.test(hex)) {
        cachedKey = Buffer.from(hex, 'hex');
        return cachedKey;
      }
      console.error('[secret-box] .secret_key 内容损坏，重新生成（旧密文将无法解密）');
    }
    // 'wx'：已存在则抛错 → 并发启动时输家改读赢家的文件
    const hex = crypto.randomBytes(32).toString('hex');
    try {
      fs.writeFileSync(keyFile, hex, { encoding: 'utf-8', mode: 0o600, flag: 'wx' });
    } catch (e: any) {
      if (e?.code !== 'EEXIST') throw e;
    }
    fs.chmodSync(keyFile, 0o600);
    cachedKey = Buffer.from(fs.readFileSync(keyFile, 'utf-8').trim(), 'hex');
    return cachedKey;
  } catch (e) {
    console.error('[secret-box] 密钥文件不可用，回退到进程内临时密钥（重启后密文不可解！）:', e);
    cachedKey = crypto.randomBytes(32);
    return cachedKey;
  }
}

export function isEncrypted(value: string): boolean {
  return typeof value === 'string' && value.startsWith(PREFIX);
}

export function encryptSecret(plain: string): string {
  if (!plain) return plain;
  const key = resolveKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(plain, 'utf-8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${iv.toString('base64url')}:${tag.toString('base64url')}:${data.toString('base64url')}`;
}

export function decryptSecret(value: string): string {
  if (!isEncrypted(value)) return value; // 历史明文，原样返回
  try {
    // `enc:v1:<iv>:<tag>:<data>` —— 前缀自身含冒号，先剥前缀再分段
    const parts = value.slice(PREFIX.length).split(':');
    if (parts.length !== 3) throw new Error('密文格式错误');
    const [ivB64, tagB64, dataB64] = parts;
    const key = resolveKey();
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64url'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));
    const out = Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64url')), decipher.final()]);
    return out.toString('utf-8');
  } catch (e) {
    console.error('[secret-box] 解密失败（密钥变更或数据损坏），该凭证视为未配置:', e);
    return '';
  }
}

/** 测试辅助：清空密钥缓存 */
export function __resetSecretBoxCache() {
  cachedKey = null;
}
