import * as fs from 'fs';
import * as path from 'path';
import webpush from 'web-push';
import { getDataDir } from './user-store';

export interface VapidKeys {
  publicKey: string;
  privateKey: string;
}

const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:agtpilot-push@tunsuy.cn';

let cached: VapidKeys | null = null;

function keyFilePath(): string {
  return path.join(getDataDir(), '_vapid.json');
}

/**
 * 获取 VAPID 密钥对（Web Push 服务端身份）。
 *
 * 优先级：
 * 1. 环境变量 VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY（显式配置，便于多实例一致）；
 * 2. 数据目录下的 _vapid.json 持久化文件；
 * 3. 首次启动自动生成并落盘——零配置即可用，重启后订阅不失效。
 */
export function getVapidKeys(): VapidKeys {
  if (cached) return cached;

  const envPub = process.env.VAPID_PUBLIC_KEY?.trim();
  const envPriv = process.env.VAPID_PRIVATE_KEY?.trim();
  if (envPub && envPriv) {
    cached = { publicKey: envPub, privateKey: envPriv };
    return cached;
  }

  const file = keyFilePath();
  try {
    if (fs.existsSync(file)) {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
      if (parsed?.publicKey && parsed?.privateKey) {
        cached = { publicKey: parsed.publicKey, privateKey: parsed.privateKey };
        return cached;
      }
    }
  } catch (e) {
    console.error('[vapid] failed to read persisted keys, regenerating:', e);
  }

  const generated = webpush.generateVAPIDKeys();
  cached = { publicKey: generated.publicKey, privateKey: generated.privateKey };
  try {
    fs.writeFileSync(file, JSON.stringify(cached, null, 2), 'utf-8');
  } catch (e) {
    console.error('[vapid] failed to persist keys (push will work until restart):', e);
  }
  return cached;
}

export function getVapidSubject(): string {
  return VAPID_SUBJECT;
}
