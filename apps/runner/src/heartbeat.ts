import { RunnerAuthError, RunnerUpgradeError, type RunnerClient, type PollResult } from './client';

/**
 * 心跳循环(M1 骨架:只轮询不领取 —— claim 自 M2 接 ClaudeCodeAdapter 后启用)。
 * 循环逻辑拆成可注入的 tick/sleep/shouldStop,vitest 用假 client 直测,不起真定时器网络。
 */

export type TickOutcome = 'ok' | 'auth' | 'upgrade';

/** 单次轮询:成功打印队列概览;401/426 返回专属结果由调用方处置 */
export async function pollTick(
  client: Pick<RunnerClient, 'poll'>,
  log: (line: string) => void,
  opts: { claim?: boolean } = {}
): Promise<TickOutcome> {
  try {
    const result: PollResult = await client.poll({ claim: opts.claim });
    const queued = result.queue.filter((t) => t.state === 'queued').length;
    const active = result.queue.filter((t) => !['done', 'failed', 'cancelled', 'expired'].includes(t.state)).length;
    log(`心跳 ok · 队列 ${result.queue.length}(待领 ${queued} / 在飞 ${active})`);
    if (result.claimed) {
      // M2 接执行器后这里派发任务;骨架阶段不领取(claim=false),防御性提示
      log(`收到任务 ${result.claimed.taskId}(M2 起接入本地执行器)`);
    }
    return 'ok';
  } catch (e) {
    if (e instanceof RunnerAuthError) {
      log(`认证失败:${e.message} —— 本地凭据已不可用,请重新配对`);
      return 'auth';
    }
    if (e instanceof RunnerUpgradeError) {
      log(`版本不兼容:${e.message}`);
      return 'upgrade';
    }
    // 网络抖动/云端 5xx:不退出,下个周期重试(断网本地缓冲在 M4 事件队列做)
    log(`心跳失败(将重试):${(e as Error)?.message || e}`);
    return 'ok';
  }
}

export interface LoopDeps {
  tick: () => Promise<TickOutcome>;
  sleep: (ms: number) => Promise<void>;
  shouldStop: () => boolean;
  /** 认证失败回调(自毁凭据);返回后循环退出 */
  onAuthLost?: () => void;
  intervalMs: number;
}

export async function runHeartbeatLoop(deps: LoopDeps): Promise<'stopped' | 'auth_lost' | 'upgrade_needed'> {
  while (!deps.shouldStop()) {
    const outcome = await deps.tick();
    if (outcome === 'auth') {
      deps.onAuthLost?.();
      return 'auth_lost';
    }
    if (outcome === 'upgrade') return 'upgrade_needed';
    await deps.sleep(deps.intervalMs);
  }
  return 'stopped';
}
