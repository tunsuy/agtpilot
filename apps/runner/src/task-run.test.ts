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
  /** 顺序返回(自动重试测试:第一次失败、第二次成功等);用尽后停在最后一项 */
  results?: Phase1Result[];
  progress?: ParsedStreamEvent[];
  onRun?: () => void;
}): ExecutorAdapter & { runCalled: number; runOpts: Array<{ baseBranch?: string; continuation?: boolean }> } {
  const a = {
    name: 'claude-code',
    runCalled: 0,
    runOpts: [] as Array<{ baseBranch?: string; continuation?: boolean }>,
    detect: async () => (opts.installed === false ? { installed: false } : { installed: true, version: 'fake' }),
    run: async (
      _p: RunnerTaskPack,
      _dir: string,
      onProgress?: (e: ParsedStreamEvent) => void,
      runOpts?: { baseBranch?: string; continuation?: boolean }
    ) => {
      const idx = a.runCalled;
      a.runCalled++;
      a.runOpts.push(runOpts ?? {});
      opts.onRun?.();
      for (const e of opts.progress ?? []) onProgress?.(e);
      if (opts.results && opts.results.length > 0) {
        return opts.results[Math.min(idx, opts.results.length - 1)];
      }
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
    prepare: async () => ({ repoDir: '/ws/vllm-project/vllm', mode: 'cloned', baseBranch: 'main' }),
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
    const { deps, flat } = makeDeps({ adapter, prepare: async () => { prepared = true; return { repoDir: '/x', mode: 'cloned', baseBranch: 'main' }; } });
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

  it('事件上行失败不阻塞执行(bin 侧离线队列缓冲补发,task-run 只记日志)', async () => {
    const { deps, logs } = makeDeps({
      postEvents: async () => { throw new Error('ECONNREFUSED'); },
    });
    expect(await runTask({ taskId: 'rtask_1', pack: validPack }, deps)).toBe('awaiting_approval');
    expect(logs.some((l) => l.includes('事件上行失败'))).toBe(true);
  });

  it('M4 审计钩子:task_claimed 开始留痕,task_result 记录结局', async () => {
    const audited: Record<string, unknown>[] = [];
    const { deps } = makeDeps({ audit: (e) => audited.push(e) });
    await runTask({ taskId: 'rtask_1', pack: validPack }, deps);
    expect(audited.map((e) => e.kind)).toEqual(['task_claimed', 'task_result']);
    expect(audited[0]).toMatchObject({ taskId: 'rtask_1', repo: 'vllm-project/vllm', workBranch: 'contrib/fix-1' });
    expect(audited[1]).toMatchObject({ outcome: 'awaiting_approval', commitHash: 'abc123' });
  });

  it('M4 审计钩子:失败路径记录 failed 与原因', async () => {
    const audited: Record<string, unknown>[] = [];
    const { deps } = makeDeps({ adapter: fakeAdapter({ installed: false }), audit: (e) => audited.push(e) });
    await runTask({ taskId: 'rtask_1', pack: validPack }, deps);
    const last = audited.at(-1)!;
    expect(last.kind).toBe('task_result');
    expect(last.outcome).toBe('failed');
    expect(String(last.message)).toContain('claude');
  });
});

describe('runTask · 经 fork 派发(viaFork)', () => {
  it('phase1_result 携带 forkRepo(runner 实探账号 = 云端固化 head 的唯一事实源)', async () => {
    const { deps, flat } = makeDeps({
      prepare: async () => ({ repoDir: '/ws/tunsuy/vllm', mode: 'cloned', baseBranch: 'main', forkRepo: 'tunsuy/vllm' }),
    });
    expect(await runTask({ taskId: 'rtask_1', pack: { ...validPack, viaFork: true } }, deps)).toBe('awaiting_approval');
    expect(flat()[1].payload).toMatchObject({ forkRepo: 'tunsuy/vllm', commitHash: 'abc123' });
  });

  it('直连派发:phase1_result 不带 forkRepo(缺省即直连语义)', async () => {
    const { deps, flat } = makeDeps();
    await runTask({ taskId: 'rtask_1', pack: validPack }, deps);
    expect((flat()[1].payload as any).forkRepo).toBeUndefined();
  });
});

describe('runTask · 实探基线分支回流(master 默认仓库)', () => {
  it('prepareRepo 回落 master → phase1_result 携带 baseBranch,云端 PR --base 以此为准', async () => {
    const { deps, flat } = makeDeps({
      prepare: async () => ({ repoDir: '/ws/milvus-io/milvus', mode: 'cloned', baseBranch: 'master' }),
    });
    expect(await runTask({ taskId: 'rtask_1', pack: validPack }, deps)).toBe('awaiting_approval');
    expect(flat()[1].payload).toMatchObject({ baseBranch: 'master', commitHash: 'abc123' });
  });

  it('派发包显式 baseBranch 时回流该值(透传不丢)', async () => {
    const { deps, flat } = makeDeps({
      prepare: async () => ({ repoDir: '/ws/a/b', mode: 'updated', baseBranch: 'release-1.x' }),
    });
    await runTask({ taskId: 'rtask_1', pack: { ...validPack, baseBranch: 'release-1.x' } }, deps);
    expect(flat()[1].payload).toMatchObject({ baseBranch: 'release-1.x' });
  });
});

describe('runTask · 瞬时 API 错误自动重试(加固 ① + 续跑模式)', () => {
  const transientFail: Phase1Result = {
    ok: false,
    error: 'claude 退出码 1 · [claude-code:unrecognized_model] {"query_source":"sdk"}',
    retryable: true,
  };
  const success: Phase1Result = {
    ok: true,
    commitHash: 'abc123',
    diffstat: '1 file',
    testTail: 'ok',
    prFinal: { title: 'T', body: 'B' },
  };

  it('retryable 失败 + 现场干净 → 从头自动重跑一次(不带续跑指令),第二次成功 → awaiting_approval', async () => {
    const adapter = fakeAdapter({ results: [transientFail, success] });
    const { deps, flat } = makeDeps({ adapter, checkPristine: async () => true, retryDelayMs: 0 });
    expect(await runTask({ taskId: 'rtask_1', pack: validPack }, deps)).toBe('awaiting_approval');
    expect(adapter.runCalled).toBe(2);
    // 什么都没干就挂了 → 重跑 = 从头,无续跑指令
    expect(adapter.runOpts[1]?.continuation).toBeUndefined();
    // 重试进度事件上行(云端时间线可见)
    const summaries = flat().filter((e) => e.type === 'progress').map((e) => String((e.payload as any).summary));
    expect(summaries.some((s) => s.includes('自动重试'))).toBe(true);
    // 成功事件链完整:phase1_result + awaiting_approval
    expect(flat().map((e) => e.type)).toContain('phase1_result');
    expect(flat().at(-1)!.payload).toEqual({ state: 'awaiting_approval' });
  });

  it('retryable 失败 + 现场干净 → 重试仍失败 → failed,error 带 retryable:true,审计 task_retry mode=fresh', async () => {
    const adapter = fakeAdapter({ results: [transientFail, transientFail] });
    const audited: Record<string, unknown>[] = [];
    const { deps, flat } = makeDeps({ adapter, checkPristine: async () => true, retryDelayMs: 0, audit: (e) => audited.push(e) });
    expect(await runTask({ taskId: 'rtask_1', pack: validPack }, deps)).toBe('failed');
    expect(adapter.runCalled).toBe(2);
    const errEv = flat().find((e) => e.type === 'error');
    expect((errEv!.payload as any).retryable).toBe(true);
    expect(audited.some((e) => e.kind === 'task_retry' && e.mode === 'fresh')).toBe(true);
  });

  it('retryable 失败 + 现场非干净(已有产出)→ 不再跳过:续跑模式自动重试(第二次带 continuation),审计 mode=continue', async () => {
    const adapter = fakeAdapter({ results: [transientFail, transientFail] });
    const audited: Record<string, unknown>[] = [];
    const { deps, flat } = makeDeps({ adapter, checkPristine: async () => false, retryDelayMs: 0, audit: (e) => audited.push(e) });
    expect(await runTask({ taskId: 'rtask_1', pack: validPack }, deps)).toBe('failed');
    expect(adapter.runCalled).toBe(2); // 关键:半路失败不再放弃,带着现场接着试
    expect(adapter.runOpts[0]?.continuation).toBeUndefined(); // 首跑常规
    expect(adapter.runOpts[1]?.continuation).toBe(true); // 重试注入续跑指令
    expect(audited.some((e) => e.kind === 'task_retry' && e.mode === 'continue')).toBe(true);
    expect(audited.some((e) => e.kind === 'task_retry_skipped')).toBe(false); // 该审计类型已退役
    const errEv = flat().find((e) => e.type === 'error');
    expect((errEv!.payload as any).retryable).toBe(true); // 最终失败仍标可重试上行
    const summaries = flat().filter((e) => e.type === 'progress').map((e) => String((e.payload as any).summary));
    expect(summaries.some((s) => s.includes('续跑模式自动重试'))).toBe(true);
  });

  it('非瞬时失败(验收未过,retryable:false)→ 不重试,error 不带 retryable', async () => {
    const adapter = fakeAdapter({ results: [{ ok: false, error: '验收命令未通过', testTail: 'FAILED', retryable: false }] });
    const { deps, flat } = makeDeps({ adapter, checkPristine: async () => true, retryDelayMs: 0 });
    expect(await runTask({ taskId: 'rtask_1', pack: validPack }, deps)).toBe('failed');
    expect(adapter.runCalled).toBe(1);
    const errEv = flat().find((e) => e.type === 'error');
    expect((errEv!.payload as any).retryable).toBeUndefined();
  });

  it('成功路径不触发现场检查(checkPristine 仅在 retryable 失败时调用)', async () => {
    let pristineCalled = 0;
    const { deps } = makeDeps({ adapter: fakeAdapter({ result: success }), checkPristine: async () => { pristineCalled++; return true; }, retryDelayMs: 0 });
    expect(await runTask({ taskId: 'rtask_1', pack: validPack }, deps)).toBe('awaiting_approval');
    expect(pristineCalled).toBe(0);
  });
});

describe('runTask · 续跑模式(prepare mode=resumed:重派/重领保留上次现场)', () => {
  const transientFail: Phase1Result = {
    ok: false,
    error: 'claude 退出码 1 · overloaded',
    retryable: true,
  };
  const success: Phase1Result = { ok: true, commitHash: 'abc123', prFinal: { title: 'T', body: 'B' } };
  const resumedPrepare = async () => ({ repoDir: '/ws/vllm-project/vllm', mode: 'resumed' as const, baseBranch: 'main' });

  it('首跑即注入续跑指令 + task_continuation 审计 + 续跑进度事件上行', async () => {
    const adapter = fakeAdapter({ result: success });
    const audited: Record<string, unknown>[] = [];
    const { deps, flat } = makeDeps({ adapter, prepare: resumedPrepare, audit: (e) => audited.push(e) });
    expect(await runTask({ taskId: 'rtask_1', pack: validPack }, deps)).toBe('awaiting_approval');
    expect(adapter.runCalled).toBe(1);
    expect(adapter.runOpts[0]?.continuation).toBe(true);
    expect(audited.some((e) => e.kind === 'task_continuation')).toBe(true);
    const summaries = flat().filter((e) => e.type === 'progress').map((e) => String((e.payload as any).summary));
    expect(summaries.some((s) => s.includes('续跑模式') && s.includes('git 记录为恢复点'))).toBe(true);
  });

  it('续跑首跑又遇瞬时错误 → 重试仍带 continuation(已有产出全程不丢)', async () => {
    const adapter = fakeAdapter({ results: [transientFail, success] });
    const { deps } = makeDeps({ adapter, prepare: resumedPrepare, checkPristine: async () => false, retryDelayMs: 0 });
    expect(await runTask({ taskId: 'rtask_1', pack: validPack }, deps)).toBe('awaiting_approval');
    expect(adapter.runCalled).toBe(2);
    expect(adapter.runOpts.map((o) => o.continuation)).toEqual([true, true]);
  });

  it('cloned/updated 常规路径 → 首跑不带 continuation(向后兼容)', async () => {
    const adapter = fakeAdapter({ result: success });
    const { deps } = makeDeps({ adapter });
    await runTask({ taskId: 'rtask_1', pack: validPack }, deps);
    expect(adapter.runOpts[0]?.continuation).toBeUndefined();
  });
});
