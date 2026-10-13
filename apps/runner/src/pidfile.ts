import * as fs from 'fs';
import * as path from 'path';
import { credentialsDir } from './credentials';

/**
 * pidfile(M4):`start` 写 `~/.agtpilot/runner/runner.pid`,
 * `stop` 据此发 SIGTERM(前台进程 Ctrl+C 之外的后台/nohup 场景),
 * 退出时清理;残留死 pid 视为陈旧自动覆盖。
 */

export function pidFile(): string {
  return path.join(credentialsDir(), 'runner.pid');
}

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e?.code === 'EPERM'; // 存在但不属于本用户
  }
}

/** 读 pidfile(缺失/损坏 → null) */
export function readPid(file: string): number | null {
  try {
    const pid = Number(fs.readFileSync(file, 'utf-8').trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

export function writePid(file: string, pid: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, String(pid), { encoding: 'utf-8', mode: 0o600 });
}

/**
 * 删 pidfile。带 expectedPid 时做归属检查:文件内容不是自己的 pid
 * 就不删——防「旧实例慢退出,把新实例刚写的 pidfile 删了」的交接竞态
 * (真机 systemd 接管时实际发生:stop 后立刻 start,旧进程 5s 睡眠
 * 走完才退,finally 无条件 clearPid 删掉了新 pid)。
 */
export function clearPid(file: string, expectedPid?: number): void {
  try {
    if (expectedPid !== undefined && readPid(file) !== expectedPid) return;
    fs.rmSync(file, { force: true });
  } catch {
    /* 已不存在等同成功 */
  }
}

export type StopOutcome =
  | { ok: true; stopped: number }
  | { ok: false; error: 'not_running' | 'stale' | 'kill_failed'; detail?: string };

export interface StopDeps {
  file?: string;
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  alive?: (pid: number) => boolean;
  sleep?: (ms: number) => Promise<void>;
  /** 等待进程退出的轮询次数(默认 30 × 100ms = 3s) */
  tries?: number;
}

/**
 * stop 子命令核心(纯逻辑,测试注入 kill/alive):
 * SIGTERM → 轮询等待退出(最多 ~3s)→ 清理 pidfile。
 * 死 pid → 清理陈旧 pidfile 并报 stale(不算失败退出)。
 */
export async function stopByPidfile(deps: StopDeps = {}): Promise<StopOutcome> {
  const file = deps.file ?? pidFile();
  const kill = deps.kill ?? ((pid, sig) => void process.kill(pid, sig));
  const alive = deps.alive ?? isPidAlive;
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const tries = deps.tries ?? 30;

  const pid = readPid(file);
  if (pid === null) return { ok: false, error: 'not_running' };
  if (!alive(pid)) {
    clearPid(file, pid);
    return { ok: false, error: 'stale', detail: String(pid) };
  }
  try {
    kill(pid, 'SIGTERM');
  } catch (e) {
    return { ok: false, error: 'kill_failed', detail: (e as Error)?.message || String(e) };
  }
  for (let i = 0; i < tries && alive(pid); i++) {
    await sleep(100);
  }
  // 窗口内没退出 → 如实报失败,且不删 pidfile(进程还活着,文件是它的)
  if (alive(pid)) {
    return { ok: false, error: 'kill_failed', detail: `pid ${pid} 在 ${tries * 100}ms 内未退出` };
  }
  clearPid(file, pid);
  return { ok: true, stopped: pid };
}
