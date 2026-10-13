import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { appendAudit, readAudit, rotateAuditIfNeeded } from './audit';
import { readPid, writePid, clearPid, isPidAlive, stopByPidfile } from './pidfile';

/** M4:本地审计 JSONL + pidfile/stop 逻辑(真临时文件,假 kill/alive) */

let tmp: string;
let file: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-audit-'));
  file = path.join(tmp, 'audit.jsonl');
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('appendAudit / readAudit(append-only JSONL)', () => {
  it('逐条追加,自动补 at;文件 0600', () => {
    appendAudit({ kind: 'paired', deviceId: 'dev_1' }, { file, now: () => 1000 });
    appendAudit({ kind: 'task_claimed', taskId: 't1', repo: 'o/r' }, { file, now: () => 2000 });
    const entries = readAudit({ file });
    expect(entries).toHaveLength(2);
    expect(entries[0]).toEqual({ at: 1000, kind: 'paired', deviceId: 'dev_1' });
    expect(entries[1].at).toBe(2000);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it('readAudit 取尾部 limit 条;文件缺失 → [];损坏行跳过', () => {
    for (let i = 0; i < 5; i++) appendAudit({ kind: 'k', i }, { file, now: () => i });
    expect(readAudit({ file, limit: 2 }).map((e) => e.i)).toEqual([3, 4]);
    expect(readAudit({ file: path.join(tmp, 'nope.jsonl') })).toEqual([]);
    fs.appendFileSync(file, '{{{坏行\n');
    expect(readAudit({ file })).toHaveLength(5); // 坏行被跳过,好行不受影响
  });

  it('审计写失败静默(路径不可写不抛错,不阻塞任务)', () => {
    // ENOTDIR:父路径是普通文件,mkdir/写入必然快速失败(不依赖 /proc 等平台特异路径)
    const blocker = path.join(tmp, 'blocker');
    fs.writeFileSync(blocker, 'x');
    expect(() => appendAudit({ kind: 'x' }, { file: path.join(blocker, 'audit.jsonl') })).not.toThrow();
  });

  it('rotateAuditIfNeeded:超限截断保留后半;未超限不动', () => {
    for (let i = 0; i < 10; i++) appendAudit({ kind: 'k', i }, { file, now: () => i });
    rotateAuditIfNeeded(10 ** 9, { file }); // 巨大上限 → 不动
    expect(readAudit({ file, limit: 100 })).toHaveLength(10);
    rotateAuditIfNeeded(1, { file }); // 1 字节上限 → 保留后 5 条
    const after = readAudit({ file, limit: 100 });
    expect(after).toHaveLength(5);
    expect(after[0].i).toBe(5);
  });
});

describe('pidfile + stopByPidfile', () => {
  const pf = () => path.join(tmp, 'runner.pid');

  it('write/read/clear 往返;缺失/损坏 → null', () => {
    writePid(pf(), 4242);
    expect(readPid(pf())).toBe(4242);
    clearPid(pf());
    expect(readPid(pf())).toBeNull();
    fs.writeFileSync(pf(), 'abc');
    expect(readPid(pf())).toBeNull();
    clearPid(pf()); // 幂等
  });

  it('isPidAlive:本进程存活;极大 pid 不存在', () => {
    expect(isPidAlive(process.pid)).toBe(true);
    expect(isPidAlive(2 ** 31 - 2)).toBe(false);
  });

  it('stop:存活 pid → SIGTERM,退出后清 pidfile', async () => {
    writePid(pf(), 999);
    const kills: Array<[number, string]> = [];
    let alive = true;
    const r = await stopByPidfile({
      file: pf(),
      kill: (pid, sig) => {
        kills.push([pid, sig]);
        alive = false; // 收到 TERM 即退出
      },
      alive: () => alive,
      sleep: async () => {},
    });
    expect(r).toEqual({ ok: true, stopped: 999 });
    expect(kills).toEqual([[999, 'SIGTERM']]);
    expect(readPid(pf())).toBeNull(); // pidfile 已清理
  });

  it('stop:进程不退 → 轮询有限次后仍清 pidfile(不无限等)', async () => {
    writePid(pf(), 999);
    let sleeps = 0;
    const r = await stopByPidfile({
      file: pf(),
      kill: () => {},
      alive: () => true,
      sleep: async () => {
        sleeps++;
      },
      tries: 5,
    });
    expect(r.ok).toBe(true);
    expect(sleeps).toBe(5); // 有界等待
  });

  it('stop:无 pidfile → not_running;死 pid → stale 且清理;kill 抛错 → kill_failed', async () => {
    expect(await stopByPidfile({ file: pf() })).toEqual({ ok: false, error: 'not_running' });

    writePid(pf(), 2 ** 31 - 2); // 不存在的 pid
    const stale = await stopByPidfile({ file: pf() });
    expect(stale).toEqual({ ok: false, error: 'stale', detail: String(2 ** 31 - 2) });
    expect(readPid(pf())).toBeNull(); // 陈旧 pidfile 已清理

    writePid(pf(), 999);
    const r = await stopByPidfile({
      file: pf(),
      kill: () => {
        throw new Error('EPERM');
      },
      alive: () => true,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('kill_failed');
  });
});
