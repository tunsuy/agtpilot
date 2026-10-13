import * as fs from 'fs';
import * as path from 'path';
import { credentialsDir } from './credentials';

/**
 * 离线事件队列(§3.1「断网本地缓冲重发,幂等 eventId 去重」,M4):
 * 上行失败的事件缓冲到 `~/.agtpilot/runner/outbox.json`(0600),
 * 下次上行成功时先补发缓冲再发新事件;云端按 eventId 幂等去重,
 * 重发窗口内的重复投递天然安全(runner-bridge recordRunnerEvents)。
 *
 * 约束:
 * - TTL:超过 7 天(与云端任务 TTL 对齐)的事件直接丢弃——对应任务早已
 *   expired,补发无意义;
 * - 容量:上限 2000 条,超限丢最旧(保新事件);
 * - 缓冲文件损坏 → 视为空(丢缓冲好过卡死上行)。
 */

/** 与云端 RUNNER_TASK_TTL 对齐:任务过期后事件没有补发价值 */
export const OUTBOX_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const OUTBOX_MAX_EVENTS = 2000;

export function outboxFile(): string {
  return path.join(credentialsDir(), 'outbox.json');
}

export interface OutboxEvent {
  eventId?: unknown;
  at?: unknown;
  [k: string]: unknown;
}

/** 读缓冲(损坏/缺失 → [];只认对象数组) */
export function readOutbox(file: string): OutboxEvent[] {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
    if (!Array.isArray(raw)) return [];
    return raw.filter((e): e is OutboxEvent => Boolean(e) && typeof e === 'object' && !Array.isArray(e));
  } catch {
    return [];
  }
}

/** 写缓冲(原子:tmp+rename,0600;目录不存在则建 0700) */
export function writeOutbox(file: string, events: OutboxEvent[]): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(events), { encoding: 'utf-8', mode: 0o600 });
  fs.renameSync(tmp, file);
}

export function clearOutbox(file: string): void {
  try {
    fs.rmSync(file, { force: true });
  } catch {
    /* 已不存在等同成功 */
  }
}

/** eventId 去重(保序,首见为准)+ TTL 淘汰 + 容量截断(保最新) */
export function compactEvents(events: OutboxEvent[], now: number, ttlMs = OUTBOX_TTL_MS, maxEvents = OUTBOX_MAX_EVENTS): OutboxEvent[] {
  const seen = new Set<string>();
  const out: OutboxEvent[] = [];
  for (const e of events) {
    const id = typeof e.eventId === 'string' ? e.eventId : null;
    if (id) {
      if (seen.has(id)) continue;
      seen.add(id);
    }
    const at = typeof e.at === 'number' ? e.at : now; // 无 at 的畸形事件按现在算(不误杀)
    if (now - at >= ttlMs) continue; // 到达 TTL 即丢弃(与云端任务过期同步)
    out.push(e);
  }
  return out.length > maxEvents ? out.slice(out.length - maxEvents) : out;
}

export interface ReliablePosterOpts {
  /** 内层真实上行(client.postEvents) */
  post: (events: unknown[]) => Promise<{ accepted: number; rejected: number }>;
  file?: string;
  log?: (line: string) => void;
  now?: () => number;
  ttlMs?: number;
  maxEvents?: number;
}

/**
 * 包在 client.postEvents 外面的可靠上行器:
 * - 成功:若本次带了离线缓冲,先补发并清空缓冲;
 * - 失败:全量(缓冲+本次)compact 后写缓冲,再抛错(调用方按既有
 *   catch 路径记日志;错误文案已注明「已缓冲」)。
 * 对调用方保持与 postEvents 相同的签名/抛错语义,task-run/publish 零改动接入。
 */
export class ReliableEventPoster {
  private file: string;
  private log: (line: string) => void;
  private now: () => number;
  private ttlMs: number;
  private maxEvents: number;

  constructor(private opts: ReliablePosterOpts) {
    this.file = opts.file ?? outboxFile();
    this.log = opts.log ?? (() => {});
    this.now = opts.now ?? Date.now;
    this.ttlMs = opts.ttlMs ?? OUTBOX_TTL_MS;
    this.maxEvents = opts.maxEvents ?? OUTBOX_MAX_EVENTS;
  }

  async post(events: unknown[]): Promise<{ accepted: number; rejected: number }> {
    const buffered = readOutbox(this.file);
    const combined = [...buffered, ...(events as OutboxEvent[])];
    try {
      const r = await this.opts.post(combined);
      if (buffered.length > 0) {
        clearOutbox(this.file);
        this.log(`离线队列补发成功:${buffered.length} 条缓冲事件已上行并清空`);
      }
      return r;
    } catch (e) {
      const compacted = compactEvents(combined, this.now(), this.ttlMs, this.maxEvents);
      try {
        writeOutbox(this.file, compacted);
        this.log(`事件上行失败,已缓冲 ${compacted.length} 条到离线队列(${this.file}),恢复后自动补发`);
      } catch (we) {
        this.log(`事件上行失败且离线队列写入失败(事件将丢失):${(we as Error)?.message || we}`);
      }
      throw new Error(`网络错误(已缓冲 ${compacted.length} 条待重发):${(e as Error)?.message || e}`);
    }
  }
}
