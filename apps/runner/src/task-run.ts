import { randomUUID } from 'node:crypto';
import { normalizeTaskPack, type RunnerEventType, type RunnerTaskPack } from '@agtpilot/protocol';
import type { ExecutorAdapter, ParsedStreamEvent } from './executor';
import { prepareRepo, type PreparedRepo } from './repo';

/**
 * 单个已领取任务的本地执行编排(M2,§6.1):
 * 状态事件(running)→ 仓库准备 → adapter.run(进度事件批量上行)→
 * 成功:phase1_result + awaiting_approval / 失败:error + failed。
 *
 * 设计约束:
 * - 串行单任务(心跳循环在任务执行期间被占用;bin 侧另起保活轮询维持在线状态);
 * - 进度事件按 flushThreshold 批量上行(减少请求数;断网离线队列 M4 交付,
 *   现阶段上行失败只记日志不阻塞执行);
 * - 云端 pack 再过一次 normalizeTaskPack(runner 侧防御性校验,与云端清洗同源)。
 */

export interface TaskRunDeps {
  deviceId: string;
  postEvents: (events: unknown[]) => Promise<{ accepted: number; rejected: number }>;
  adapter: ExecutorAdapter;
  workspaceRoot: string;
  /** 测试注入点:仓库准备(默认真 git) */
  prepare?: (pack: RunnerTaskPack, root: string) => Promise<PreparedRepo>;
  log?: (line: string) => void;
  now?: () => number;
  newEventId?: () => string;
  /** 进度事件批量上行阈值(默认 10 条) */
  flushThreshold?: number;
}

export type TaskRunOutcome = 'awaiting_approval' | 'failed';

export async function runTask(
  claimed: { taskId: string; pack: unknown },
  deps: TaskRunDeps
): Promise<TaskRunOutcome> {
  const log = deps.log ?? (() => {});
  const now = deps.now ?? Date.now;
  const newId = deps.newEventId ?? (() => randomUUID());
  const threshold = Math.max(1, deps.flushThreshold ?? 10);
  const taskId = claimed.taskId;

  const queue: Record<string, unknown>[] = [];
  const flush = async () => {
    if (queue.length === 0) return;
    const batch = queue.splice(0, queue.length);
    try {
      const r = await deps.postEvents(batch);
      log(`事件上行:${r.accepted} 接受 / ${r.rejected} 拒绝`);
    } catch (e) {
      // M4 离线事件队列会本地缓冲重发;现阶段只记日志,不阻塞任务执行
      log(`事件上行失败(M4 离线队列将补发):${(e as Error)?.message || e}`);
    }
  };
  const push = (type: RunnerEventType, payload?: Record<string, unknown>) => {
    queue.push({ eventId: newId(), taskId, deviceId: deps.deviceId, at: now(), type, payload });
  };
  const fail = async (message: string, extra?: Record<string, unknown>): Promise<TaskRunOutcome> => {
    push('error', { message, ...extra });
    push('state', { state: 'failed' });
    await flush();
    log(`任务 ${taskId} 失败:${message}`);
    return 'failed';
  };

  // 防御性清洗:云端 pack 畸形或与 taskId 不一致 → 直接 failed(不碰文件系统)
  const pack = normalizeTaskPack(claimed.pack);
  if (!pack || pack.taskId !== taskId) {
    return fail('任务包清洗失败(pack 畸形或与 taskId 不一致)');
  }

  log(`任务 ${taskId} 开始 · ${pack.repo} · 分支 ${pack.workBranch} · 执行器 ${deps.adapter.name}`);
  push('state', { state: 'running' });
  await flush(); // 状态事件立即上行,云端设备页/任务卡即时可见

  const det = await deps.adapter.detect();
  if (!det.installed) {
    return fail(
      `本机未检测到 ${deps.adapter.name}(claude CLI):请先安装并登录 https://claude.com/claude-code,然后重新派发`
    );
  }
  if (det.version) log(`执行器就绪:${det.version}`);

  const prepare = deps.prepare ?? ((p: RunnerTaskPack, root: string) => prepareRepo(p, root));
  let repo: PreparedRepo;
  try {
    repo = await prepare(pack, deps.workspaceRoot);
    log(`仓库就绪(${repo.mode === 'cloned' ? '新克隆' : '增量更新'}):${repo.repoDir}`);
  } catch (e) {
    return fail(`仓库准备失败:${(e as Error)?.message || e}`);
  }

  const onProgress = (ev: ParsedStreamEvent) => {
    if (ev.kind === 'tool') {
      push('progress', { kind: 'tool', tool: ev.tool, summary: ev.summary });
      log(`· ${ev.tool} ${ev.summary}`);
    } else {
      push('progress', { kind: ev.kind, summary: ev.summary });
    }
    if (queue.length >= threshold) void flush();
  };

  const result = await deps.adapter.run(pack, repo.repoDir, onProgress);
  if (result.ok) {
    push('phase1_result', {
      commitHash: result.commitHash,
      diffstat: result.diffstat,
      testTail: result.testTail,
      prFinal: result.prFinal ?? undefined,
    });
    push('state', { state: 'awaiting_approval' });
    await flush();
    log(`任务 ${taskId} Phase 1 完成 → 等待云端审批(commit ${String(result.commitHash ?? '').slice(0, 8)})`);
    return 'awaiting_approval';
  }
  return fail(result.error || '执行器返回失败(无错误信息)', {
    commitHash: result.commitHash,
    testTail: result.testTail,
  });
}
