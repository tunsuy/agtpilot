import { describe, expect, it, vi } from 'vitest';
import { createDeadline, createTokenBudgetMiddleware, runWithRetry } from './run-control';
import type { PrepareStepContext } from './prepare-pipeline';

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('createDeadline', () => {
  it('超时后 abort 并标记 timedOut;dispose 不抛错', async () => {
    const d = createDeadline({ timeoutMs: 10 });
    expect(d.signal.aborted).toBe(false);
    expect(d.timedOut).toBe(false);
    await tick(25);
    expect(d.timedOut).toBe(true);
    expect(d.signal.aborted).toBe(true);
    d.dispose();
  });

  it('父 signal abort 会传播,但不标记为墙钟超时', () => {
    const parent = new AbortController();
    const d = createDeadline({ timeoutMs: 0, parentSignal: parent.signal });
    parent.abort();
    expect(d.signal.aborted).toBe(true);
    expect(d.timedOut).toBe(false);
    d.dispose();
  });

  it('timeoutMs=0 不设墙钟', async () => {
    const d = createDeadline({ timeoutMs: 0 });
    await tick(20);
    expect(d.timedOut).toBe(false);
    expect(d.signal.aborted).toBe(false);
    d.dispose();
  });
});

describe('runWithRetry', () => {
  it('首轮失败后等待并重试一次', async () => {
    let calls = 0;
    const result = await runWithRetry(
      async () => {
        calls += 1;
        if (calls === 1) throw new Error('overloaded');
        return 42;
      },
      { delayMs: 1 },
    );
    expect(result).toEqual({ value: 42, retried: true });
    expect(calls).toBe(2);
  });

  it('shouldRetry=false 时不重试,原错误上抛', async () => {
    const run = vi.fn(async () => {
      throw new Error('content-filter');
    });
    await expect(
      runWithRetry(run, { shouldRetry: () => false }),
    ).rejects.toThrow('content-filter');
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('onBeforeRetry 在第二次执行前触发', async () => {
    const order: string[] = [];
    let calls = 0;
    await runWithRetry(
      async () => {
        calls += 1;
        order.push(`run-${calls}`);
        if (calls === 1) throw new Error('x');
        return 'ok';
      },
      {
        delayMs: 0,
        onBeforeRetry: () => order.push('before-retry'),
      },
    );
    expect(order).toEqual(['run-1', 'before-retry', 'run-2']);
  });

  it('第二次仍失败时原样上抛', async () => {
    let calls = 0;
    await expect(
      runWithRetry(
        async () => {
          calls += 1;
          throw new Error(`fail-${calls}`);
        },
        { delayMs: 0 },
      ),
    ).rejects.toThrow('fail-2');
    expect(calls).toBe(2);
  });
});

describe('createTokenBudgetMiddleware', () => {
  function ctx(content: string): PrepareStepContext {
    const messages = [{ role: 'user', content }];
    return { stepNumber: 1, messages, originalMessages: messages, adjust: {} };
  }

  it('超预算时收工具并追加收敛提示', () => {
    let exceeded = false;
    const mw = createTokenBudgetMiddleware({
      maxTokens: 5,
      notice: 'STOP',
      onExceeded: () => {
        exceeded = true;
      },
    });
    const c = ctx('x'.repeat(200));
    mw(c);
    expect(c.adjust.activeTools).toEqual([]);
    expect(c.messages.at(-1)).toEqual({ role: 'user', content: 'STOP' });
    expect(exceeded).toBe(true);
  });

  it('未超预算或 shouldApply=false 时不动作', () => {
    const mw = createTokenBudgetMiddleware({ maxTokens: 10000, notice: 'STOP' });
    const c = ctx('short');
    mw(c);
    expect(c.adjust.activeTools).toBeUndefined();
    expect(c.messages).toHaveLength(1);

    const skip = createTokenBudgetMiddleware({
      maxTokens: 5,
      notice: 'STOP',
      shouldApply: () => false,
    });
    const c2 = ctx('x'.repeat(200));
    skip(c2);
    expect(c2.adjust.activeTools).toBeUndefined();
  });
});
