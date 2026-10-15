import { randomUUID } from 'node:crypto';
import { normalizeTaskPack, type RunnerEventType, type RunnerTaskPack } from '@agtpilot/protocol';
import type { ExecutorAdapter, ParsedStreamEvent } from './executor';
import { defaultExecAsync, isWorktreePristine, prepareRepo, type PreparedRepo } from './repo';

/**
 * 单个已领取任务的本地执行编排(M2,§6.1):
 * 状态事件(running)→ 仓库准备 → adapter.run(进度事件批量上行)→
 * 成功:phase1_result + awaiting_approval / 失败:error + failed。
 *
 * 设计约束:
 * - 串行单任务(心跳循环在任务执行期间被占用;bin 侧另起保活轮询维持在线状态);
 * - 进度事件按 flushThreshold 批量上行(减少请求数;断网离线缓冲由 bin 侧
 *   ReliableEventPoster 包装承担,task-run 只管调 postEvents,失败记日志不阻塞);
 * - 云端 pack 再过一次 normalizeTaskPack(runner 侧防御性校验,与云端清洗同源);
 * - 瞬时 API/网关错误自动重试一次(加固 ①,§6.1):executor 把 claude 进程级失败
 *   标 retryable(瞬时错误指纹);本层在**现场干净**(无改动、无领先 commit)时原地
 *   重跑一次,全程留审计 + 上行进度事件;超时/max_turns/验收失败/无产出不重试。
 *   现场非干净则不自动重跑(避免在半成品上叠加),但 retryable 仍随失败上行,云端标「可重试」。
 */

export interface TaskRunDeps {
  deviceId: string;
  postEvents: (events: unknown[]) => Promise<{ accepted: number; rejected: number }>;
  adapter: ExecutorAdapter;
  workspaceRoot: string;
  /** 测试注入点:仓库准备(默认真 git) */
  prepare?: (pack: RunnerTaskPack, root: string) => Promise<PreparedRepo>;
  log?: (line: string) => void;
  /** M4:本地审计钩子(bin 注入 appendAudit;失败静默由 audit 模块承担) */
  audit?: (entry: Record<string, unknown>) => void;
  now?: () => number;
  newEventId?: () => string;
  /** 进度事件批量上行阈值(默认 10 条) */
  flushThreshold?: number;
  /**
   * 自动重试前的现场检查(加固 ①):默认 isWorktreePristine(真 git)。
   * 返回 true = 干净可安全重跑;测试注入固定值。
   */
  checkPristine?: (repoDir: string, baseBranch: string) => Promise<boolean>;
  /** 自动重试前的退避毫秒(默认 2000,给瞬时网关故障一点恢复窗口;测试注入 0) */
  retryDelayMs?: number;
}

export type TaskRunOutcome = 'awaiting_approval' | 'failed';

export async function runTask(
  claimed: { taskId: string; pack: unknown },
  deps: TaskRunDeps
): Promise<TaskRunOutcome> {
  const log = deps.log ?? (() => {});
  const audit = deps.audit ?? (() => {});
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
      // 离线缓冲由 bin 侧 ReliableEventPoster 包装承担(错误文案已含缓冲信息);
      // 这里只记日志,不阻塞任务执行
      log(`事件上行失败:${(e as Error)?.message || e}`);
    }
  };
  const push = (type: RunnerEventType, payload?: Record<string, unknown>) => {
    queue.push({ eventId: newId(), taskId, deviceId: deps.deviceId, at: now(), type, payload });
  };
  const fail = async (message: string, extra?: Record<string, unknown>): Promise<TaskRunOutcome> => {
    push('error', { message, ...extra });
    push('state', { state: 'failed' });
    await flush();
    audit({ kind: 'task_result', taskId, outcome: 'failed', message: message.slice(0, 500) });
    log(`任务 ${taskId} 失败:${message}`);
    return 'failed';
  };

  // 防御性清洗:云端 pack 畸形或与 taskId 不一致 → 直接 failed(不碰文件系统)
  const pack = normalizeTaskPack(claimed.pack);
  if (!pack || pack.taskId !== taskId) {
    return fail('任务包清洗失败(pack 畸形或与 taskId 不一致)');
  }

  log(`任务 ${taskId} 开始 · ${pack.repo} · 分支 ${pack.workBranch} · 执行器 ${deps.adapter.name}`);
  audit({ kind: 'task_claimed', taskId, repo: pack.repo, workBranch: pack.workBranch });
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
    } else if (ev.kind === 'result') {
      // result 事件无 summary 字段(终稿正文不进事件流,数据最小化);只报成败标志
      push('progress', { kind: 'result', isError: ev.isError });
    } else {
      push('progress', { kind: ev.kind, summary: ev.summary });
    }
    if (queue.length >= threshold) void flush();
  };

  const runOnce = () =>
    deps.adapter.run(pack, repo.repoDir, onProgress, { baseBranch: repo.baseBranch });
  const checkPristine =
    deps.checkPristine ?? ((dir: string, base: string) => isWorktreePristine(dir, base, defaultExecAsync));
  const retryDelayMs = deps.retryDelayMs ?? 2000;

  let result = await runOnce();

  // 加固 ①:claude 因瞬时 API/网关错误退出(executor 标 retryable)且**现场干净**
  // (无未提交改动、相对基线零领先 commit)时,原地自动重试一次。现场非干净则不重跑
  // (避免在半成品上叠加改动),但 retryable 仍随最终失败上行,云端标「可重试」交人工重派。
  if (!result.ok && result.retryable) {
    const pristine = await checkPristine(repo.repoDir, repo.baseBranch);
    if (pristine) {
      log(`任务 ${taskId} 瞬时 API/网关错误 · 现场干净,自动重试一次:${result.error}`);
      audit({ kind: 'task_retry', taskId, attempt: 1, reason: (result.error || '').slice(0, 500) });
      push('progress', { kind: 'system', summary: '瞬时 API/网关错误 · 现场干净,自动重试一次' });
      await flush();
      if (retryDelayMs > 0) await new Promise((r) => setTimeout(r, retryDelayMs));
      result = await runOnce();
    } else {
      log(`任务 ${taskId} 瞬时 API 错误但现场非干净(有改动/领先 commit),跳过自动重试(留人工重派)`);
      audit({ kind: 'task_retry_skipped', taskId, reason: 'worktree_not_pristine' });
    }
  }

  if (result.ok) {
    push('phase1_result', {
      commitHash: result.commitHash,
      diffstat: result.diffstat,
      testTail: result.testTail,
      prFinal: result.prFinal ?? undefined,
      // 经 fork 派发:实际克隆的 fork 全名回流,云端固化 PR head(owner:branch)与
      // Phase 2 发布目录以此为准(runner 实探的 gh 账号是唯一事实源)
      forkRepo: repo.forkRepo,
      // 实探基线分支回流(master 默认仓库回落结果):云端固化 PR --base 以此为准,
      // 派发包里没写 baseBranch 时不能拿缺省 'main' 去开 PR(上游根本没有该分支)
      baseBranch: repo.baseBranch,
    });
    push('state', { state: 'awaiting_approval' });
    await flush();
    audit({ kind: 'task_result', taskId, outcome: 'awaiting_approval', commitHash: result.commitHash });
    log(`任务 ${taskId} Phase 1 完成 → 等待云端审批(commit ${String(result.commitHash ?? '').slice(0, 8)})`);
    return 'awaiting_approval';
  }
  return fail(result.error || '执行器返回失败(无错误信息)', {
    commitHash: result.commitHash,
    testTail: result.testTail,
    // 加固 ②:瞬时 API/网关失败 → error 事件带 retryable,云端落任务记录、UI 标「可重试」
    ...(result.retryable ? { retryable: true } : {}),
  });
}
