import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * runner 本地凭据存取(§4):
 * `~/.agtpilot/runner/credentials.json`(目录 0700 / 文件 0600),
 * 含配对时固定的 server URL(防任务来源漂移)+ deviceId + deviceSecret。
 * 测试可用 AGTPILOT_RUNNER_HOME 指到临时目录。
 */

export interface RunnerCredentials {
  /** 配对时固定,之后所有请求只发往它 */
  serverUrl: string;
  deviceId: string;
  deviceSecret: string;
  pairedAt: number;
  hostname: string;
}

export function credentialsDir(): string {
  return process.env.AGTPILOT_RUNNER_HOME || path.join(os.homedir(), '.agtpilot', 'runner');
}

export function credentialsFile(): string {
  return path.join(credentialsDir(), 'credentials.json');
}

export function loadCredentials(): RunnerCredentials | null {
  try {
    const raw = JSON.parse(fs.readFileSync(credentialsFile(), 'utf-8'));
    if (
      typeof raw?.serverUrl === 'string' &&
      typeof raw?.deviceId === 'string' &&
      typeof raw?.deviceSecret === 'string'
    ) {
      return raw as RunnerCredentials;
    }
    return null;
  } catch {
    return null;
  }
}

export function saveCredentials(creds: RunnerCredentials): void {
  const dir = credentialsDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = credentialsFile();
  fs.writeFileSync(file, JSON.stringify(creds, null, 2), { encoding: 'utf-8', mode: 0o600 });
  fs.chmodSync(file, 0o600);
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    /* 目录权限尽力而为 */
  }
}

/** 401/吊销后本地自毁凭据(§4:runner 收到 401 → 自毁并提示重新配对) */
export function clearCredentials(): void {
  try {
    fs.rmSync(credentialsFile(), { force: true });
  } catch {
    /* 已不存在等同成功 */
  }
}
