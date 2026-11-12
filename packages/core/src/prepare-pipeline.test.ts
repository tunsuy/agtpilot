import { describe, expect, it } from 'vitest';
import { runPreparePipeline } from './prepare-pipeline';
import type { PrepareStepContext } from './prepare-pipeline';

function ctx(messages: any[] = [{ role: 'user', content: 'q' }]): PrepareStepContext {
  return { stepNumber: 1, messages, originalMessages: messages, adjust: {} };
}

describe('runPreparePipeline', () => {
  it('无中间件改写时返回 undefined', () => {
    expect(runPreparePipeline(ctx(), [])).toBeUndefined();
  });

  it('按声明顺序执行,消息引用变化才回写 messages', () => {
    const c = ctx();
    const result = runPreparePipeline(c, [
      (x) => {
        x.messages = [...x.messages, { role: 'user', content: 'a' }];
      },
      (x) => {
        x.messages = [...x.messages, { role: 'user', content: 'b' }];
      },
    ]);
    expect((result as any).messages.map((m: any) => m.content)).toEqual(['q', 'a', 'b']);
  });

  it('只改 activeTools 时保留 activeTools,不额外写 messages', () => {
    const result = runPreparePipeline(ctx(), [
      (x) => {
        x.adjust.activeTools = ['search'];
      },
    ]);
    expect(result).toEqual({ activeTools: ['search'] });
  });

  it('异步中间件按序 await', async () => {
    const c = ctx();
    const result = await runPreparePipeline(c, [
      async (x) => {
        await Promise.resolve();
        x.messages = [...x.messages, { role: 'user', content: 'async' }];
      },
      (x) => {
        x.adjust.activeTools = ['a'];
      },
    ]);
    expect((result as any).messages.at(-1).content).toBe('async');
    expect((result as any).activeTools).toEqual(['a']);
  });

  it('同步链保持同步返回(子 agent 单测直接读返回值)', () => {
    const result = runPreparePipeline(ctx(), [
      (x) => {
        x.messages = [...x.messages, { role: 'user', content: 'sync' }];
      },
    ]);
    expect(result).not.toBeInstanceOf(Promise);
    expect((result as any).messages.at(-1).content).toBe('sync');
  });
});
