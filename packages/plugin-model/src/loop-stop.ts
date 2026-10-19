/**
 * agent loop 停机判定(纯函数,vitest 直测)。
 *
 * 三道闸门,任一触达即停:
 * 1. 步数上限(steps.length >= maxSteps)
 * 2. 本次调用 token 预算(tokenBudget > 0 且循环内累计已触顶)—— 每调用独立
 *    记账,并发任务互不串账;策略(额度)归应用层,这里只执行判定
 * 3. 进程级遗留预算(legacyExceeded,setBudget 通道;保留兼容)
 */
export interface LoopStopInput {
  stepsCount: number;
  maxSteps: number;
  /** 本次调用累计 prompt+completion tokens */
  loopTokens: number;
  /** 本次调用预算;0/undefined = 不设限 */
  tokenBudget?: number;
  /** 进程级遗留预算是否已触顶 */
  legacyExceeded?: boolean;
}

export function shouldStopAgentLoop(input: LoopStopInput): boolean {
  if (input.stepsCount >= input.maxSteps) return true;
  if (isPerCallBudgetHit(input)) return true;
  return Boolean(input.legacyExceeded);
}

/** 本次调用的预算是否触顶(供 finishReason 改写为 'budget-exceeded') */
export function isPerCallBudgetHit(input: {
  loopTokens: number;
  tokenBudget?: number;
}): boolean {
  return (
    typeof input.tokenBudget === 'number' &&
    input.tokenBudget > 0 &&
    input.loopTokens >= input.tokenBudget
  );
}
