import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  readOutbox,
  writeOutbox,
  clearOutbox,
  compactEvents,
  ReliableEventPoster,
  OUTBOX_TTL_MS,
} from './event-queue';

/**
 * 离线事件队列测试(M4,§3.1):真临时文件(缓冲文件语义走真实 fs),
 * 假内层 post(可控成功/失败)。核心断言:失败缓冲、成功补发、
 * eventId 去重、TTL 淘汰、容量保新、损坏缓冲自愈。
 */

let tmp: string;
let file: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-outbox-'));
  file = path.join(tmp, 'outbox.json');
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

const ev = (id: string, at = 1000) => ({ eventId: id, taskId: 't1', deviceId: 'd1', at, type: 'progress', payload: { n: id } });

describe('缓冲文件读写', () => {
  it('write → read 往返;文件 0600;缺失/损坏 → []', () => {
    writeOutbox(file, [ev('a'), ev('b')]);
    expect(readOutbox(file)).toHaveLength(2);
    const mode = fs.statSync(file).mode & 0o777;
    expect(mode).toBe(0o600);

    fs.writeFileSync(file, '{{{损坏');
    expect(readOutbox(file)).toEqual([]);
    expect(readOutbox(path.join(tmp, '不存在.json'))).toEqual([]);
    // 数组里混入非对象项 → 过滤
    fs.writeFileSync(file, JSON.stringify([ev('a'), null, 'x', 42]));
    expect(readOutbox(file)).toHaveLength(1);
  });

  it('clearOutbox 幂等(不存在等同成功)', () => {
    expect(() => clearOutbox(path.join(tmp, 'nope.json'))).not.toThrow();
    writeOutbox(file, [ev('a')]);
    clearOutbox(file);
    expect(readOutbox(file)).toEqual([]);
  });
});

describe('compactEvents(去重/TTL/容量)', () => {
  it('eventId 去重保序(首见为准)', () => {
    const out = compactEvents([ev('a'), ev('b'), ev('a')], 2000);
    expect(out.map((e) => e.eventId)).toEqual(['a', 'b']);
  });

  it('TTL 过期丢弃(与云端任务 TTL 对齐);无 at 的畸形事件不误杀', () => {
    const old = ev('old', 1000);
    const fresh = ev('fresh', 1000 + OUTBOX_TTL_MS - 1);
    const noAt = { eventId: 'noat', taskId: 't', type: 'progress' } as any;
    const out = compactEvents([old, fresh, noAt], 1000 + OUTBOX_TTL_MS);
    expect(out.map((e) => e.eventId)).toEqual(['fresh', 'noat']);
  });

  it('容量上限保最新(丢最旧)', () => {
    const many = Array.from({ length: 10 }, (_, i) => ev(`e${i}`, 1000 + i));
    const out = compactEvents(many, 5000, OUTBOX_TTL_MS, 4);
    expect(out.map((e) => e.eventId)).toEqual(['e6', 'e7', 'e8', 'e9']);
  });
});

describe('ReliableEventPoster(断网缓冲 / 恢复补发)', () => {
  function makePoster(opts: { failTimes?: number; inner?: (events: unknown[]) => Promise<{ accepted: number; rejected: number }> } = {}) {
    const sent: unknown[][] = [];
    let failures = opts.failTimes ?? 0;
    const logs: string[] = [];
    const inner =
      opts.inner ??
      (async (events: unknown[]) => {
        if (failures > 0) {
          failures--;
          throw new Error('ECONNREFUSED');
        }
        sent.push(events);
        return { accepted: events.length, rejected: 0 };
      });
    const poster = new ReliableEventPoster({ post: inner, file, log: (l) => logs.push(l), now: () => 2000 });
    return { poster, sent, logs };
  }

  it('成功直发:不产生缓冲文件', async () => {
    const { poster, sent } = makePoster();
    const r = await poster.post([ev('a')]);
    expect(r.accepted).toBe(1);
    expect(sent[0]).toHaveLength(1);
    expect(fs.existsSync(file)).toBe(false);
  });

  it('失败 → 缓冲落盘并抛错(文案含已缓冲条数,调用方按既有 catch 记日志)', async () => {
    const { poster, sent } = makePoster({ failTimes: 1 });
    await expect(poster.post([ev('a'), ev('b')])).rejects.toThrow('已缓冲 2 条');
    expect(sent).toHaveLength(0);
    expect(readOutbox(file).map((e) => e.eventId)).toEqual(['a', 'b']);
  });

  it('恢复后补发:缓冲在前、新事件在后,一次上行后缓冲清空', async () => {
    const { poster, sent, logs } = makePoster({ failTimes: 1 });
    await expect(poster.post([ev('a')])).rejects.toThrow();
    const r = await poster.post([ev('b')]);
    expect(r.accepted).toBe(2);
    expect((sent[0] as any[]).map((e) => e.eventId)).toEqual(['a', 'b']); // 顺序:先补发
    expect(readOutbox(file)).toEqual([]);
    expect(logs.some((l) => l.includes('补发成功'))).toBe(true);
  });

  it('重复失败:缓冲合并去重(eventId 幂等,重发窗口安全),不无限增长', async () => {
    const { poster } = makePoster({ failTimes: 3 });
    await expect(poster.post([ev('a')])).rejects.toThrow();
    await expect(poster.post([ev('a'), ev('b')])).rejects.toThrow(); // a 重入
    expect(readOutbox(file).map((e) => e.eventId)).toEqual(['a', 'b']);
  });

  it('缓冲中的过期事件在下次失败重写时被 TTL 淘汰', async () => {
    writeOutbox(file, [ev('old', 2000 - OUTBOX_TTL_MS - 1)]);
    const { poster } = makePoster({ failTimes: 1 });
    await expect(poster.post([ev('new', 2000)])).rejects.toThrow();
    expect(readOutbox(file).map((e) => e.eventId)).toEqual(['new']);
  });

  it('缓冲文件损坏 → 视为空,新事件照常上行(自愈)', async () => {
    fs.writeFileSync(file, 'not json{{{');
    const { poster, sent } = makePoster();
    const r = await poster.post([ev('a')]);
    expect(r.accepted).toBe(1);
    expect(sent[0]).toHaveLength(1);
  });
});
