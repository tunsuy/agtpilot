import { describe, it, expect } from 'vitest';
import { runTask, type TaskRunDeps } from './task-run';
import type { ExecutorAdapter, ParsedStreamEvent, Phase1Result } from './executor';
import type { RunnerTaskPack } from '@agtpilot/protocol';

const validPack = {
  taskId: 'rtask_1',
  kind: 'oss_contribution',
  repo: 'vllm-project/vllm',
  issueUrl: 'https://github.com/vllm-project/vllm/issues/1',
  workBranch: 'contrib/fix-1',
  constraints: ['只修这个 Issue'],
  acceptance: { testCommand: 'pytest' },
  prDraft: { title: 't', bodyTemplate: '' },
  executor: { name: 'claude-code', maxTurns: 10, timeoutMinutes: 5 },
};

function fakeAdapter(opts: {
  installed?: boolean;
  result?: Phase1Result;
  progress?: ParsedStreamEvent[];
  onRun?: () => void;
}): ExecutorAdapter & { runCalled: number } {
  const a = {
    name: 'claude-code',
    runCalled: 0,
    detect: async () => (opts.installed === false ? { installed: false } : { installed: true, version: 'fake' }),
    run: async (_p: RunnerTaskPack, _dir: string, onProgress?: (e: ParsedStreamEvent) => void) => {
      a.runCalled++;
      opts.onRun?.();
      for (const e of opts.progress ?? []) onProgress?.(e);
      return opts.result ?? { ok: true, commitHash: 'abc123', diffstat: '1 file', testTail: 'ok', prFinal: { title: 'T', body: 'B' } };
    },
  };
  return a;
}

function makeDeps(over: Partial<TaskRunDeps> = {}) {
  const batches: Record<string, unknown>[][] = [];
  const logs: string[] = [];
  let n = 0;
  const deps: TaskRunDeps = {
    deviceId: 'dev_1',
    postEvents: async (events) => {
      batches.push(events as Record<string, unknown>[]);
      return { accepted: events.length, rejected: 0 };
    },
    adapter: fakeAdapter({}),
    workspaceRoot: '/ws',
    prepare: async () => ({ repoDir: '/ws/vllm-project/vllm', mode: 'cloned' }),
    log: (l) => logs.push(l),
    now: () => 1000,
    newEventId: () => `ev_${n++}`,
    ...over,
  };
  return { deps, batches, logs, flat: () => batches.flat() };
}

describe('runTask(领取任务 → 本地执行 → 事件回流编排)', () => {
  it('成功路径:state running → phase1_result → state awaiting_approval,顺序与内容正确', async () => {
    const { deps, flat } = makeDeps();
    const out = await runTask({ taskId: 'rtask_1', pack: validPack }, deps);
    expect(out).toBe('awaiting_approval');
    const evs = flat();
    expect(evs.map((e) => e.type)).toEqual(['state', 'phase1_result', 'state']);
    expect(evs[0].payload).toEqual({ state: 'running' });
    expect(evs[1].payload).toMatchObject({ commitHash: 'abc123', prFinal: { title: 'T', body: 'B' } });
    expect(evs[2].payload).toEqual({ state: 'awaiting_approval' });
    // 每条事件带幂等键与身份字段
    for (const e of evs) {
      expect(e.taskId).toBe('rtask_1');
      expect(e.deviceId).toBe('dev_1');
      expect(e.at).toBe(1000);
      expect(typeof e.eventId).toBe('string');
    }
  });

  it('pack 畸形或 taskId 不一致 → 直接 failed(不碰文件系统、不调执行器)', async () => {
    const adapter = fakeAdapter({});
    let prepared = false;
    const { deps, flat } = makeDeps({ adapter, prepare: async () => { prepared = true; return { repoDir: '/x', mode: 'cloned' }; } });
    expect(await runTask({ taskId: 'rtask_1', pack: { ...validPack, repo: '../evil' } }, deps)).toBe('failed');
    expect(await runTask({ taskId: 'rtask_X', pack: validPack }, deps)).toBe('failed');
    expect(prepared).toBe(false);
    expect(adapter.runCalled).toBe(0);
    const types = flat().map((e) => e.type);
    expect(types).toEqual(['error', 'state', 'error', 'state']);
    expect(flat()[1].payload).toEqual({ state: 'failed' });
  });

  it('claude CLI 未安装 → failed,错误信息给出安装指引', async () => {
    const { deps, flat } = makeDeps({ adapter: fakeAdapter({ installed: false }) });
    expect(await runTask({ taskId: 'rtask_1', pack: validPack }, deps)).toBe('failed');
    expect(String((flat()[1].payload as any).message)).toContain('未检测到');
    expect(String((flat()[1].payload as any).message)).toContain('claude.com/claude-code');
  });

  it('仓库准备失败(围栏/网络)→ failed,错误透传', async () => {
    const { deps, flat } = makeDeps({ prepare: async () => { throw new Error('clone 失败:仓库不存在'); } });
    expect(await runTask({ taskId: 'rtask_1', pack: validPack }, deps)).toBe('failed');
    expect(String((flat()[1].payload as any).message)).toContain('仓库准备失败:clone 失败');
  });

  it('执行失败 → error 事件带执行器错误与产出线索(commitHash/testTail),终态 failed', async () => {
    const { deps, flat } = makeDeps({
      adapter: fakeAdapter({ result: { ok: false, error: '验收命令未通过', commitHash: 'abc', testTail: 'FAILED' } }),
    });
    expect(await runTask({ taskId: 'rtask_1', pack: validPack }, deps)).toBe('failed');
    expect(flat()[1].payload).toMatchObject({ message: '验收命令未通过', commitHash: 'abc', testTail: 'FAILED' });
    expect(flat()[2].payload).toEqual({ state: 'failed' });
  });

  it('进度事件按阈值批量上行(25 条 / 阈值 10 → 多批,全量到达且有序)', async () => {
    const progress: ParsedStreamEvent[] = Array.from({ length: 25 }, (_, i) => ({ kind: 'tool' as const, tool: 'Read', summary: `f${i}` }));
    const { deps, batches, flat } = makeDeps({ adapter: fakeAdapter({ progress }), flushThreshold: 10 });
    await runTask({ taskId: 'rtask_1', pack: validPack }, deps);
    await new Promise((r) => setTimeout(r, 10)); // 等 fire-and-forget 批次落地
    expect(batches.length).toBeGreaterThanOrEqual(3);
    const summaries = flat().filter((e) => e.type === 'progress').map((e) => (e.payload as any).summary);
    expect(summaries).toEqual(progress.map((p) => (p as any).summary));
  });

  it('事件上行失败不阻塞执行(M4 离线队列兜底,当前只记日志)', async () => {
    const { deps, logs } = makeDeps({
      postEvents: async () => { throw new Error('ECONNREFUSED'); },
    });
    expect(await runTask({ taskId: 'rtask_1', pack: validPack }, deps)).toBe('awaiting_approval');
    expect(logs.some((l) => l.includes('事件上行失败'))).toBe(true);
  });
});
