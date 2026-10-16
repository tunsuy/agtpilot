import { RunnerAuthError, RunnerUpgradeError, type RunnerClient, type PollResult } from './client';
import { normalizeDeviceAction } from '@agtpilot/protocol';

/**
 * 心跳循环(轮询 → 可选领取)。M2 起 claim=true 时云端 FIFO 派发任务包,
 * pollTick 把领到的任务返回给调用方(bin 接 runTask 执行,串行单任务)。
 * 循环逻辑拆成可注入的 tick/sleep/shouldStop,vitest 用假 client 直测,不起真定时器网络。
 */

/**
 * 检测「终止当前执行任务」指令(用户止损)。
 * 任务执行期间主心跳循环被占用,只有 bin 的保活轮询在跑 —— 它的 poll
 * 响应里同样带 actions(云端由 cancelRequested 标记派生 cancel 动作);
 * 此函数供保活轮询判定是否要杀当前任务(协议形状与审批链路完全一致)。
 */
export function isCancelForTask(actions: unknown, taskId: string): boolean {
  if (!Array.isArray(actions) || !taskId) return false;
  return actions.some((raw) => {
    const a = normalizeDeviceAction(raw);
    return a !== null && a.kind === 'cancel' && a.taskId === taskId;
  });
}

/**
 * 提取「当前执行任务的插话指令」(用户中途纠偏,与 cancel 同一条保活轮询通道)。
 * 清洗走 normalizeDeviceAction(interject 必带 interjectId + text,畸形条目静默
 * 丢弃);按到达顺序返回列表。下行是 at-least-once(云端重发直到收到 ack),
 * 调用方按 interjectId 去重后注入会话并回执 interject_ack 事件。
 */
export function extractInterjectActions(
  actions: unknown,
  taskId: string
): { interjectId: string; text: string }[] {
  if (!Array.isArray(actions) || !taskId) return [];
  const out: { interjectId: string; text: string }[] = [];
  for (const raw of actions) {
    const a = normalizeDeviceAction(raw);
    if (a !== null && a.kind === 'interject' && a.taskId === taskId && a.interjectId && a.text) {
      out.push({ interjectId: a.interjectId, text: a.text });
    }
  }
  return out;
}

export type TickOutcome = 'ok' | 'auth' | 'upgrade';

export interface TickResult {
  outcome: TickOutcome;
  claimed: { taskId: string; pack: unknown } | null;
  /** M3:审批结果动作(publish/cancel),由 bin 交 handleDeviceActions 处理 */
  actions: unknown[];
}

/** 单次轮询:成功打印队列概览并返回领取结果;401/426 返回专属结果由调用方处置。
 *  opts.deviceId:待领计数只算本机可领的 queued(无绑定 或 绑定到本设备;
 *  派发时可指定目标设备,§4)——不传则绑定到其它设备的任务不计入。 */
export async function pollTick(
  client: Pick<RunnerClient, 'poll'>,
  log: (line: string) => void,
  opts: { claim?: boolean; deviceId?: string } = {}
): Promise<TickResult> {
  try {
    const result: PollResult = await client.poll({ claim: opts.claim });
    const queued = result.queue.filter(
      (t) => t.state === 'queued' && (!t.targetDeviceId || t.targetDeviceId === opts.deviceId)
    ).length;
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
