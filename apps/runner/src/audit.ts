import * as fs from 'fs';
import * as path from 'path';
import { credentialsDir } from './credentials';

/**
 * 本地审计日志(§7,M4):append-only JSONL,`~/.agtpilot/runner/audit.jsonl`(0600)。
 * 记录任务生命周期与固化命令执行结果(本地文件,不上行);
 * `agtpilot-runner logs` 查看。写失败静默(审计不阻塞任务执行)。
 *
 * kind 约定:paired / start / stop / task_claimed / task_result /
 * publish_cmd / publish_result / action_cancel / event_buffered。
 */

export interface AuditEntry {
  at: number;
  kind: string;
  [k: string]: unknown;
}

export function auditFile(): string {
  return path.join(credentialsDir(), 'audit.jsonl');
}

export interface AuditOpts {
  file?: string;
  now?: () => number;
}

/** 追加一条审计(JSONL;目录 0700 / 文件 0600;失败静默) */
export function appendAudit(entry: Omit<AuditEntry, 'at'> & { at?: number }, opts: AuditOpts = {}): void {
  const file = opts.file ?? auditFile();
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const line = JSON.stringify({ at: entry.at ?? (opts.now ?? Date.now)(), ...entry });
    fs.appendFileSync(file, line + '\n', { encoding: 'utf-8', mode: 0o600 });
  } catch {
    /* 审计失败不影响主流程 */
  }
}

/** 读最近 limit 条(尾部;损坏行跳过;文件缺失 → []) */
export function readAudit(opts: AuditOpts & { limit?: number } = {}): AuditEntry[] {
  const file = opts.file ?? auditFile();
  const limit = Math.max(1, opts.limit ?? 50);
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf-8');
  } catch {
    return [];
  }
  const lines = raw.split('\n').filter((l) => l.trim());
  const out: AuditEntry[] = [];
  for (const line of lines.slice(-limit)) {
    try {
      const o = JSON.parse(line);
      if (o && typeof o === 'object') out.push(o as AuditEntry);
    } catch {
      /* 损坏行跳过 */
    }
  }
  return out;
}

/** 审计文件超过 maxBytes 时截断保留后半(防无限增长;append-only 语义按会话保留) */
export function rotateAuditIfNeeded(maxBytes = 5 * 1024 * 1024, opts: AuditOpts = {}): void {
  const file = opts.file ?? auditFile();
  try {
    const st = fs.statSync(file);
    if (st.size <= maxBytes) return;
    const raw = fs.readFileSync(file, 'utf-8');
    const lines = raw.split('\n').filter((l) => l.trim());
    fs.writeFileSync(file, lines.slice(Math.floor(lines.length / 2)).join('\n') + '\n', {
      encoding: 'utf-8',
      mode: 0o600,
    });
  } catch {
    /* 无文件/无权限:无需轮转 */
  }
}
