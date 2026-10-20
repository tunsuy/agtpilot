import { randomUUID } from 'node:crypto';
import {
  NO_ACTION_REASON_LABELS,
  addRunnerUsage,
  normalizeTaskPack,
  type RunnerEventType,
  type RunnerLocalUsage,
  type RunnerTaskPack,
} from '@agtpilot/protocol';
import type { ExecutorAdapter, InterjectHandle, ParsedStreamEvent } from './executor';
import { defaultExecAsync, isWorktreePristine, prepareRepo, type PreparedRepo } from './repo';

/**
 * 单个已领取任务的本地执行编排(M2,§6.1):
 * 状态事件(running)→ 仓库准备 → adapter.run(进度事件批量上行)→
 * 成功:phase1_result + awaiting_approval / 失败:error + failed /
 * no-action(agent 带证据核实无需改动):error 带 noAction 标记 + failed(线上),
 * 新云端识别标记升级 no_action 终态 /
 * 云端终止(用户止损,deps.abortSignal):杀进程后上报 cancelled(本地分支保留)。
 *
 * 设计约束:
 * - 串行单任务(心跳循环在任务执行期间被占用;bin 侧另起保活轮询维持在线状态,
 *   并检测终止指令触发 abort);
 * - 进度事件按 flushThreshold 批量上行(减少请求数;断网离线缓冲由 bin 侧
 *   ReliableEventPoster 包装承担,task-run 只管调 postEvents,失败记日志不阻塞);
 * - 云端 pack 再过一次 normalizeTaskPack(runner 侧防御性校验,与云端清洗同源);
 * - 瞬时 API/网关错误自动重试一次(加固 ① + 续跑模式,§6.1):executor 把 claude
 *   进程级失败标 retryable(瞬时错误指纹);本层原地重跑一次,现场检查只决定重试
 *   姿势 —— 干净(什么都没干就挂了)从头重跑;已有产出(WIP commit/未提交改动)
 *   带【续跑模式】指令重跑,agent 先看 git 记录认清现场再接着做(git 记录 =
 *   中断后续作的恢复点,负责人方案)。超时/max_turns/验收失败/无产出不重试;
 *   retryable 仍随最终失败上行,云端标「可重试」。人工重派同样保留分支现场续跑
 *   (prepareRepo mode='resumed' → 首跑即注入续跑指令)。
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
   * 不再是重试闸,而是重试模式选择器:true = 干净从头重跑;
   * false = 已有产出,带续跑模式指令重跑。测试注入固定值。
   */
  checkPristine?: (repoDir: string, baseBranch: string) => Promise<boolean>;
  /** 自动重试前的退避毫秒(默认 2000,给瞬时网关故障一点恢复窗口;测试注入 0) */
  retryDelayMs?: number;
  /** 云端终止指令(用户止损;bin 侧保活轮询检测到 cancel 动作时触发) */
  abortSignal?: AbortSignal;
  /** 云端插话注入手柄(用户中途纠偏;bin 侧保活轮询检测到 interject 动作时写入会话) */
  interjectHandle?: InterjectHandle;
}

export type TaskRunOutcome = 'awaiting_approval' | 'no_action' | 'failed' | 'cancelled';

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
    const modeLabel = repo.mode === 'cloned' ? '新克隆' : repo.mode === 'resumed' ? '保留上次现场' : '增量更新';
    log(`仓库就绪(${modeLabel}):${repo.repoDir}`);
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

  const runOnce = (continuation: boolean) =>
    deps.adapter.run(pack, repo.repoDir, onProgress, {
      baseBranch: repo.baseBranch,
      ...(continuation ? { continuation: true } : {}),
      ...(deps.abortSignal ? { abortSignal: deps.abortSignal } : {}),
      ...(deps.interjectHandle ? { interjectHandle: deps.interjectHandle } : {}),
    });
  const checkPristine =
    deps.checkPristine ?? ((dir: string, base: string) => isWorktreePristine(dir, base, defaultExecAsync));
  const retryDelayMs = deps.retryDelayMs ?? 2000;

  // 续跑模式入口一:人工重派/重领时 prepareRepo 发现工作分支已有上次成果
  // (mode='resumed')→ 首跑即注入续跑指令,agent 看 git 记录接着做,不从头再来。
  const resumed = repo.mode === 'resumed';
  if (resumed) {
    log(`任务 ${taskId} · 工作分支 ${pack.workBranch} 已有上次尝试的成果 → 续跑模式(git 记录为恢复点)`);
    audit({ kind: 'task_continuation', taskId, workBranch: pack.workBranch });
    push('progress', { kind: 'system', summary: '工作分支已有上次尝试的成果 · 续跑模式(git 记录为恢复点)' });
    await flush();
  }

  let result = await runOnce(resumed);
  // 本地 CLI 用量补账(2026-10-20):按轮累计(首跑 + 自动重试轮),终局随
  // phase1_result/error 事件上行。云端跨重派轮次再累加,任务详情展示。
  let localUsage: RunnerLocalUsage | undefined = result.usage;

  // 用户止损(aborted 优先于一切重试):上报 cancelled(云端合法迁移落终态),
  // 本地分支保留(与审批拒绝一致)—— 终止就是终止,不进瞬时错误自动重试。
  if (result.aborted) {
    push('state', { state: 'cancelled' });
    await flush();
    audit({ kind: 'task_result', taskId, outcome: 'cancelled', message: '云端终止指令' });
    log(`任务 ${taskId} 被终止(用户止损),已上报 cancelled`);
    return 'cancelled';
  }

  // 加固 ①(续跑模式升级):claude 因瞬时 API/网关错误退出(executor 标 retryable)
  // → 原地自动重试一次。现场检查不再是重试闸,只选重试姿势:干净(什么都没干
  // 就挂了)从头重跑;已有产出(WIP commit/未提交改动)带续跑指令重跑 ——
  // agent 先看 git log/status/diff 认清现场,接着上次断点做,已完成的不重做。
  if (!result.ok && result.retryable) {
    const pristine = await checkPristine(repo.repoDir, repo.baseBranch);
    const continuation = !pristine;
    log(
      `任务 ${taskId} 瞬时 API/网关错误 · ${continuation ? '保留现场续跑重试一次' : '现场干净,从头自动重试一次'}:${result.error}`
    );
    audit({
      kind: 'task_retry',
      taskId,
      attempt: 1,
      mode: continuation ? 'continue' : 'fresh',
      reason: (result.error || '').slice(0, 500),
    });
    push('progress', {
      kind: 'system',
      summary: continuation ? '瞬时 API/网关错误 · 保留已有产出,续跑模式自动重试一次' : '瞬时 API/网关错误 · 现场干净,自动重试一次',
    });
    await flush();
    if (retryDelayMs > 0) await new Promise((r) => setTimeout(r, retryDelayMs));
    result = await runOnce(continuation);
    localUsage = addRunnerUsage(localUsage, result.usage);
    // 重试途中也可能被终止:同样落 cancelled,不当失败上报
    if (result.aborted) {
      push('state', { state: 'cancelled' });
      await flush();
      audit({ kind: 'task_result', taskId, outcome: 'cancelled', message: '云端终止指令(重试期间)' });
      log(`任务 ${taskId} 被终止(用户止损,重试期间),已上报 cancelled`);
      return 'cancelled';
    }
  }

  // no-action 例外终态:agent 核实该 Issue 无需改动(上游已修复/无法复现/超出范围)
  // 且带确凿证据(围栏 evidence 必填)。线上兼容(v1 字段只增期):state 仍上报
  // failed + error 事件带 noAction 标记 —— 老云端按普通失败展示(消息文案含结论
  // 与证据,人可读);新云端识别标记升级落 no_action 终态入库(雷达不重复推荐、
  // 派发防重以此为准)。非失败:不标 retryable、不进审批、不自动重试。
  if (result.ok && result.noAction) {
    const { reason, evidence } = result.noAction;
    const label = NO_ACTION_REASON_LABELS[reason] ?? '无需改动';
    const message = `agent 核实无需改动:${label}。证据:${evidence.slice(0, 500)}`;
    push('progress', { kind: 'system', summary: `no-action · ${label}(证据已回流云端)` });
    push('error', { message, noAction: { reason, evidence }, ...(localUsage ? { usage: localUsage } : {}) });
    push('state', { state: 'failed' });
    await flush();
    audit({ kind: 'task_result', taskId, outcome: 'no_action', reason, evidence: evidence.slice(0, 500) });
    log(`任务 ${taskId} no-action:${label}(证据 ${evidence.length} 字已上行,云端升级 no_action 终态)`);
    if (localUsage) log(`任务 ${taskId} 本地 claude 用量已上行:${JSON.stringify(localUsage)}`);
    return 'no_action';
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
      // 本地 CLI 用量补账(含自动重试轮累计):云端落任务记录,任务详情展示
      ...(localUsage ? { usage: localUsage } : {}),
    });
    push('state', { state: 'awaiting_approval' });
    await flush();
    audit({ kind: 'task_result', taskId, outcome: 'awaiting_approval', commitHash: result.commitHash });
    log(`任务 ${taskId} Phase 1 完成 → 等待云端审批(commit ${String(result.commitHash ?? '').slice(0, 8)})`);
    if (localUsage) log(`任务 ${taskId} 本地 claude 用量已上行:${JSON.stringify(localUsage)}`);
    return 'awaiting_approval';
  }
  return fail(result.error || '执行器返回失败(无错误信息)', {
    commitHash: result.commitHash,
    testTail: result.testTail,
    // 加固 ②:瞬时 API/网关失败 → error 事件带 retryable,云端落任务记录、UI 标「可重试」
    ...(result.retryable ? { retryable: true } : {}),
    // 失败轮消耗也已发生:usage 照常上行(含自动重试轮累计)
    ...(localUsage ? { usage: localUsage } : {}),
  });
}
