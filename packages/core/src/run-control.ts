/**
 * Agent 运行控制机制：墙钟、模型重试、token 预算中间件。
 *
 * 这些是父子 agent 可以共享的「机制」，不包含任何策略判断：
 * - 什么时候算超时、怎么释放定时器；
 * - 重试延迟期间如何响应 abort；
 * - 如何估算消息 token、超预算时如何收工具 + 注入提示。
 *
 * 是否启用、预算多大、重试几次、提示文案，全部由调用方 spec 决定。
 */
import type { PrepareMiddleware } from './prepare-pipeline';
import { messageText } from './text';
import { estimateTextTokens } from './routing';

export interface Deadline {
  signal: AbortSignal;
  readonly timedOut: boolean;
  dispose(): void;
}

/**
 * 创建墙钟 deadline：超时后 abort，dispose 清理定时器与父 signal 监听。
 * timeoutMs <= 0 表示不设墙钟。
 */
export function createDeadline(options: {
  timeoutMs: number;
  parentSignal?: AbortSignal;
}): Deadline {
  const controller = new AbortController();
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const onParentAbort = () => controller.abort();
  if (options.parentSignal?.aborted) {
    controller.abort();
  } else {
    options.parentSignal?.addEventListener('abort', onParentAbort, { once: true });
  }

  if (options.timeoutMs > 0) {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, options.timeoutMs);
  }

  return {
    signal: controller.signal,
    get timedOut() {
      return timedOut;
    },
    dispose() {
      if (timer) clearTimeout(timer);
      options.parentSignal?.removeEventListener('abort', onParentAbort);
    },
  };
}

/** 消息列表 token 估算（与 compaction/预算护栏同一口径）。 */
export function estimateMessagesTokens(messages: any[]): number {
  return messages.reduce(
    (acc, m) => acc + estimateTextTokens(messageText(m?.content)),
    0,
  );
}

async function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return;
  await new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    if (signal?.aborted) {
      done();
      return;
    }
    signal?.addEventListener('abort', done, { once: true });
  });
}

export interface RetryOptions {
  /** 重试前等待毫秒数；abort 会提前结束等待 */
  delayMs?: number;
  signal?: AbortSignal;
  /** 返回 false 时不重试，原错误直接上抛 */
  shouldRetry?: (error: unknown, attempt: number) => boolean;
  /** 每次重试前调用；可在此检查 deadline 或记录状态 */
  onBeforeRetry?: (error: unknown) => void;
}

export interface RetryResult<T> {
  value: T;
  retried: boolean;
}

/** 只重试一次的执行包装：首轮失败 → 等待 → 再跑一次；第二次失败原样上抛。 */
export async function runWithRetry<T>(
  run: () => Promise<T>,
  options: RetryOptions = {},
): Promise<RetryResult<T>> {
  try {
    return { value: await run(), retried: false };
  } catch (error) {
    if (options.shouldRetry && !options.shouldRetry(error, 0)) throw error;
    await abortableDelay(Math.max(0, options.delayMs ?? 0), options.signal);
    options.onBeforeRetry?.(error);
    return { value: await run(), retried: true };
  }
}

export interface TokenBudgetMiddlewareOptions {
  maxTokens: number;
  /** 超限后追加给模型的收敛提示 */
  notice: string;
  /** 可选启用条件（如预算已触发过就不再重复注入） */
  shouldApply?: () => boolean;
  /** 超限时的宿主回调（用于设置 budgetHit 等状态） */
  onExceeded?: () => void;
}

/**
 * token 预算中间件：超限时下一步收掉全部工具，并追加一条收敛提示。
 * 只做机制；预算大小、提示文案、是否启用由调用方决定。
 */
export function createTokenBudgetMiddleware(
  options: TokenBudgetMiddlewareOptions,
): PrepareMiddleware {
  return (ctx) => {
    if (options.maxTokens <= 0) return;
    if (options.shouldApply && !options.shouldApply()) return;
    if (estimateMessagesTokens(ctx.messages) <= options.maxTokens) return;
    options.onExceeded?.();
    ctx.adjust.activeTools = [];
    ctx.messages = [
      ...ctx.messages,
      { role: 'user', content: options.notice },
    ];
  };
}
