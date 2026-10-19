import { describe, it, expect } from 'vitest';
import { shouldStopAgentLoop, isPerCallBudgetHit } from './loop-stop';

describe('shouldStopAgentLoop', () => {
  const base = { stepsCount: 0, maxSteps: 10, loopTokens: 0 };

  it('未触任何闸门 → 继续', () => {
    expect(shouldStopAgentLoop(base)).toBe(false);
    expect(shouldStopAgentLoop({ ...base, tokenBudget: 300_000, loopTokens: 299_999 })).toBe(false);
  });

  it('步数上限触达 → 停', () => {
    expect(shouldStopAgentLoop({ ...base, stepsCount: 10, maxSteps: 10 })).toBe(true);
    expect(shouldStopAgentLoop({ ...base, stepsCount: 11, maxSteps: 10 })).toBe(true);
  });

  it('本次调用 token 预算触顶 → 停', () => {
    expect(shouldStopAgentLoop({ ...base, tokenBudget: 1000, loopTokens: 1000 })).toBe(true);
    expect(shouldStopAgentLoop({ ...base, tokenBudget: 1000, loopTokens: 1500 })).toBe(true);
  });

  it('tokenBudget 0/缺省/负数 = 不设限,永不停', () => {
    expect(shouldStopAgentLoop({ ...base, tokenBudget: 0, loopTokens: 10_000_000 })).toBe(false);
    expect(shouldStopAgentLoop({ ...base, loopTokens: 10_000_000 })).toBe(false);
    expect(shouldStopAgentLoop({ ...base, tokenBudget: -5, loopTokens: 10_000_000 })).toBe(false);
  });

  it('遗留进程级预算触顶 → 停(兼容通道)', () => {
    expect(shouldStopAgentLoop({ ...base, legacyExceeded: true })).toBe(true);
  });

  it('每调用独立记账:loopTokens 是本次调用累计,不受其他任务影响', () => {
    // 同预算下,新调用从 0 起算 → 不停
    expect(shouldStopAgentLoop({ stepsCount: 3, maxSteps: 10, loopTokens: 0, tokenBudget: 1000 })).toBe(false);
  });
});

describe('isPerCallBudgetHit', () => {
  it('触顶判定与停机判定同源', () => {
    expect(isPerCallBudgetHit({ loopTokens: 1000, tokenBudget: 1000 })).toBe(true);
    expect(isPerCallBudgetHit({ loopTokens: 999, tokenBudget: 1000 })).toBe(false);
    expect(isPerCallBudgetHit({ loopTokens: 5000, tokenBudget: 0 })).toBe(false);
    expect(isPerCallBudgetHit({ loopTokens: 5000 })).toBe(false);
  });
});
