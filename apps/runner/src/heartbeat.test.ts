import { describe, it, expect } from 'vitest';
import { pollTick, runHeartbeatLoop, type TickOutcome } from './heartbeat';
import { RunnerAuthError, RunnerUpgradeError } from './client';

function fakeClient(result: unknown) {
  return { poll: async () => result } as any;
}

describe('pollTick', () => {
  it('成功:打印队列概览,outcome=ok,未领取时 claimed=null', async () => {
    const logs: string[] = [];
    const client = fakeClient({ serverTime: 1, claimed: null, queue: [{ taskId: 'a', state: 'queued' }, { taskId: 'b', state: 'done' }] });
    const r = await pollTick(client, (l) => logs.push(l));
    expect(r.outcome).toBe('ok');
    expect(r.claimed).toBeNull();
    expect(logs[0]).toContain('待领 1');
    expect(logs[0]).toContain('在飞 1'); // done 是终态不计在飞
  });

  it('claim 领取:claimed 原样透出给调用方(接 runTask),日志提示开始执行', async () => {
    const logs: string[] = [];
    const claimed = { taskId: 'rtask_9', pack: { repo: 'o/r' } };
    const client = fakeClient({ serverTime: 1, claimed, queue: [] });
    const r = await pollTick(client, (l) => logs.push(l), { claim: true });
    expect(r.outcome).toBe('ok');
    expect(r.claimed).toEqual(claimed);
    expect(logs.some((l) => l.includes('领取任务 rtask_9'))).toBe(true);
  });

  it('401 → auth(调用方自毁凭据);426 → upgrade;网络错误 → ok(下轮重试);claimed 均为 null', async () => {
    const logs: string[] = [];
    const authClient = { poll: async () => { throw new RunnerAuthError('401'); } } as any;
    const authR = await pollTick(authClient, (l) => logs.push(l));
    expect(authR.outcome).toBe('auth');
    expect(authR.claimed).toBeNull();

    const upgradeClient = { poll: async () => { throw new RunnerUpgradeError('426'); } } as any;
    expect((await pollTick(upgradeClient, (l) => logs.push(l))).outcome).toBe('upgrade');

    const flakyClient = { poll: async () => { throw new Error('ECONNREFUSED'); } } as any;
    expect((await pollTick(flakyClient, (l) => logs.push(l))).outcome).toBe('ok');
    expect(logs.at(-1)).toContain('将重试');
  });

  it('M3 审批指令下行:actions 原样透出;缺省/畸形 → []', async () => {
    const logs: string[] = [];
    const action = { taskId: 'rtask_1', approvalId: 'rappr_1', kind: 'publish' };
    const withActions = fakeClient({ serverTime: 1, claimed: null, queue: [], actions: [action] });
    const r = await pollTick(withActions, (l) => logs.push(l));
    expect(r.actions).toEqual([action]);
    expect(logs.some((l) => l.includes('收到 1 条审批指令'))).toBe(true);

    const legacy = fakeClient({ serverTime: 1, claimed: null, queue: [] }); // 旧版云端无 actions 字段
    expect((await pollTick(legacy, () => {})).actions).toEqual([]);
    const malformed = fakeClient({ serverTime: 1, claimed: null, queue: [], actions: 'nope' });
    expect((await pollTick(malformed, () => {})).actions).toEqual([]);
  });
});

describe('runHeartbeatLoop', () => {
  it('shouldStop 生效:tick 3 次后正常退出,sleep 按间隔调用', async () => {
    let ticks = 0;
    const sleeps: number[] = [];
    const outcome = await runHeartbeatLoop({
      intervalMs: 5000,
      shouldStop: () => ticks >= 3,
      tick: async () => { ticks++; return 'ok'; },
      sleep: async (ms) => { sleeps.push(ms); },
    });
    expect(outcome).toBe('stopped');
    expect(ticks).toBe(3);
    expect(sleeps).toEqual([5000, 5000, 5000]);
  });

  it('auth 结局:回调触发(自毁凭据)且循环立即退出', async () => {
    let authLost = false;
    let ticks = 0;
    const outcome = await runHeartbeatLoop({
      intervalMs: 100,
      shouldStop: () => false,
      tick: async (): Promise<TickOutcome> => { ticks++; return 'auth'; },
      sleep: async () => {},
      onAuthLost: () => { authLost = true; },
    });
    expect(outcome).toBe('auth_lost');
    expect(authLost).toBe(true);
    expect(ticks).toBe(1); // 不再重试
  });

  it('upgrade 结局:退出并提示升级', async () => {
    const outcome = await runHeartbeatLoop({
      intervalMs: 100,
      shouldStop: () => false,
      tick: async () => 'upgrade',
      sleep: async () => {},
    });
    expect(outcome).toBe('upgrade_needed');
  });
});
