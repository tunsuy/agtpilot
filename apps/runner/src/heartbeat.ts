import { RunnerAuthError, RunnerUpgradeError, type RunnerClient, type PollResult } from './client';

/**
 * 心跳循环(轮询 → 可选领取)。M2 起 claim=true 时云端 FIFO 派发任务包,
 * pollTick 把领到的任务返回给调用方(bin 接 runTask 执行,串行单任务)。
 * 循环逻辑拆成可注入的 tick/sleep/shouldStop,vitest 用假 client 直测,不起真定时器网络。
 */

export type TickOutcome = 'ok' | 'auth' | 'upgrade';

export interface TickResult {
  outcome: TickOutcome;
  claimed: { taskId: string; pack: unknown } | null;
  /** M3:审批结果动作(publish/cancel),由 bin 交 handleDeviceActions 处理 */
  actions: unknown[];
}

/** 单次轮询:成功打印队列概览并返回领取结果;401/426 返回专属结果由调用方处置 */
export async function pollTick(
  client: Pick<RunnerClient, 'poll'>,
  log: (line: string) => void,
  opts: { claim?: boolean } = {}
): Promise<TickResult> {
  try {
    const result: PollResult = await client.poll({ claim: opts.claim });
    const queued = result.queue.filter((t) => t.state === 'queued').length;
    const active = result.queue.filter((t) => !['done', 'failed', 'cancelled', 'expired'].includes(t.state)).length;
    log(`心跳 ok · 队列 ${result.queue.length}(待领 ${queued} / 在飞 ${active})`);
    const actions = Array.isArray(result.actions) ? result.actions : [];
    if (actions.length > 0) log(`收到 ${actions.length} 条审批指令`);
    if (result.claimed) log(`领取任务 ${result.claimed.taskId},开始本地执行…`);
    return { outcome: 'ok', claimed: result.claimed ?? null, actions };
  } catch (e) {
    if (e instanceof RunnerAuthError) {
      log(`认证失败:${e.message} —— 本地凭据已不可用,请重新配对`);
      return { outcome: 'auth', claimed: null, actions: [] };
    }
    if (e instanceof RunnerUpgradeError) {
      log(`版本不兼容:${e.message}`);
      return { outcome: 'upgrade', claimed: null, actions: [] };
    }
    // 网络抖动/云端 5xx:不退出,下个周期重试(断网本地缓冲在 M4 事件队列做)
    log(`心跳失败(将重试):${(e as Error)?.message || e}`);
    return { outcome: 'ok', claimed: null, actions: [] };
  }
}

export interface LoopDeps {
  tick: () => Promise<TickResult | TickOutcome>;
  sleep: (ms: number) => Promise<void>;
  shouldStop: () => boolean;
  /** 认证失败回调(自毁凭据);返回后循环退出 */
  onAuthLost?: () => void;
  intervalMs: number;
}

export async function runHeartbeatLoop(deps: LoopDeps): Promise<'stopped' | 'auth_lost' | 'upgrade_needed'> {
  while (!deps.shouldStop()) {
    const r = await deps.tick();
    // tick 可返回纯 outcome 或 {outcome, claimed}(后者由调用方在 tick 内自行消化 claimed)
    const outcome = typeof r === 'string' ? r : r.outcome;
    if (outcome === 'auth') {
      deps.onAuthLost?.();
      return 'auth_lost';
    }
    if (outcome === 'upgrade') return 'upgrade_needed';
    await deps.sleep(deps.intervalMs);
  }
  return 'stopped';
}
