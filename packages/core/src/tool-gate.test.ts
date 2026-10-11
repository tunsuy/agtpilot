import { describe, it, expect } from 'vitest';
import { ToolGate } from './tool-gate';

/** 手动控制的 promise:测试里精确决定每个调用的完成时刻 */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: any) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** 宏任务冲刷:让所有已就绪的微任务(含 await 恢复)跑完 */
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('ToolGate · 只读并行', () => {
  it('多个只读调用彼此并行:都在途时互不阻塞', async () => {
    const gate = new ToolGate();
    const events: string[] = [];
    const d1 = deferred<string>();
    const d2 = deferred<string>();
    const p1 = gate.runReadonly(async () => {
      events.push('R1.start');
      return d1.promise;
    });
    const p2 = gate.runReadonly(async () => {
      events.push('R2.start');
      return d2.promise;
    });
    await flush();
    // R1 未结束,R2 也已开始 —— 并行成立
    expect(events).toEqual(['R1.start', 'R2.start']);
    d1.resolve('a');
    d2.resolve('b');
    expect(await p1).toBe('a');
    expect(await p2).toBe('b');
  });

  it('只读调用的错误原样抛给调用方,不污染门控', async () => {
    const gate = new ToolGate();
    await expect(
      gate.runReadonly(async () => {
        throw new Error('read boom');
      })
    ).rejects.toThrow('read boom');
    // 后续调用照常
    expect(await gate.runReadonly(async () => 'ok')).toBe('ok');
  });
});

describe('ToolGate · 独占串行', () => {
  it('独占调用等在途只读结束后才开始;期间新只读排队在其后', async () => {
    const gate = new ToolGate();
    const events: string[] = [];
    const dRead = deferred<void>();
    const dWrite = deferred<void>();
    const pR1 = gate.runReadonly(async () => {
      events.push('R1.start');
      await dRead.promise;
      events.push('R1.end');
    });
    await flush();
    const pW = gate.runExclusive(async () => {
      events.push('W.start');
      await dWrite.promise;
      events.push('W.end');
    });
    const pR2 = gate.runReadonly(async () => {
      events.push('R2.start');
    });
    await flush();
    // W 被在途的 R1 挡住,R2 被 W 挡住
    expect(events).toEqual(['R1.start']);
    dRead.resolve();
    await flush();
    expect(events).toEqual(['R1.start', 'R1.end', 'W.start']);
    dWrite.resolve();
    await Promise.all([pR1, pW, pR2]);
    expect(events).toEqual(['R1.start', 'R1.end', 'W.start', 'W.end', 'R2.start']);
  });

  it('两个独占调用互相串行,按到达顺序执行', async () => {
    const gate = new ToolGate();
    const events: string[] = [];
    const d1 = deferred<void>();
    const p1 = gate.runExclusive(async () => {
      events.push('W1.start');
      await d1.promise;
      events.push('W1.end');
    });
    const p2 = gate.runExclusive(async () => {
      events.push('W2.start');
    });
    await flush();
    expect(events).toEqual(['W1.start']);
    d1.resolve();
    await Promise.all([p1, p2]);
    expect(events).toEqual(['W1.start', 'W1.end', 'W2.start']);
  });

  it('独占调用抛错也释放队列,后续读写照常', async () => {
    const gate = new ToolGate();
    await expect(
      gate.runExclusive(async () => {
        throw new Error('write boom');
      })
    ).rejects.toThrow('write boom');
    const events: string[] = [];
    await Promise.all([
      gate.runReadonly(async () => events.push('R')),
      gate.runExclusive(async () => events.push('W')),
    ]);
    expect(events).toContain('R');
    expect(events).toContain('W');
  });
});

describe('ToolGate · 混合压力', () => {
  it('30 个读写混合并发:全程不出现「独占与他者重叠」或「只读与独占重叠」', async () => {
    const gate = new ToolGate();
    let activeReads = 0;
    let activeWrites = 0;
    let violation = '';
    const ops: Array<Promise<unknown>> = [];
    for (let i = 0; i < 30; i++) {
      const isWrite = i % 3 === 0;
      const body = async (tag: string) => {
        // 真实异步重叠:不同 op 让出不同的时长
        await new Promise((r) => setTimeout(r, i % 4));
        if (isWrite) {
          activeWrites++;
          if (activeWrites !== 1 || activeReads !== 0) violation = `${tag} 独占被重叠`;
          await new Promise((r) => setTimeout(r, 1));
          activeWrites--;
        } else {
          activeReads++;
          if (activeWrites !== 0) violation = `${tag} 只读撞上独占`;
          await new Promise((r) => setTimeout(r, 1));
          activeReads--;
        }
      };
      ops.push(
        isWrite
          ? gate.runExclusive(() => body(`W${i}`))
          : gate.runReadonly(() => body(`R${i}`))
      );
    }
    await Promise.all(ops);
    expect(violation).toBe('');
  });
});
