import { describe, it, expect } from 'vitest';
import { pollTick, runHeartbeatLoop, isCancelForTask, extractInterjectActions, type TickOutcome } from './heartbeat';
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
  it('targetDeviceId(派发时指定设备):待领只算本机可领(无绑定或绑定本机);在飞不受影响', async () => {
    const logs: string[] = [];
    const client = fakeClient({
      serverTime: 1,
      claimed: null,
      queue: [
        { taskId: 'a', state: 'queued' }, // 无绑定 → 可领
        { taskId: 'b', state: 'queued', targetDeviceId: 'dev_me' }, // 绑定本机 → 可领
        { taskId: 'c', state: 'queued', targetDeviceId: 'dev_other' }, // 绑定他机 → 不计待领
        { taskId: 'd', state: 'running', targetDeviceId: 'dev_other' },
      ],
    });
    await pollTick(client, (l) => logs.push(l), { deviceId: 'dev_me' });
    expect(logs[0]).toContain('待领 2');
    expect(logs[0]).toContain('在飞 4'); // 在飞 = 全部非终态(含 queued),与定向无关
    // 不传 deviceId:只有无绑定任务计入待领
    const logs2: string[] = [];
    await pollTick(client, (l) => logs2.push(l));
    expect(logs2[0]).toContain('待领 1');
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

describe('isCancelForTask(保活轮询终止指令检测)', () => {
  const cancel = (taskId: string, approvalId?: string) => ({
    taskId,
    ...(approvalId ? { approvalId } : {}),
    kind: 'cancel',
    repo: 'o/r',
    workBranch: 'b',
  });

  it('命中:cancel 动作 taskId = 当前任务(用户终止,无 approvalId)', () => {
    expect(isCancelForTask([cancel('rtask_1')], 'rtask_1')).toBe(true);
  });

  it('审批拒绝的 cancel(带 approvalId)同样命中 —— 同一形状,同一处置', () => {
    expect(isCancelForTask([cancel('rtask_1', 'appr_1')], 'rtask_1')).toBe(true);
  });

  it('不命中:publish 动作、别的任务的 cancel、畸形输入、空 actions', () => {
    expect(isCancelForTask([{ taskId: 'rtask_1', approvalId: 'a', kind: 'publish', repo: 'o/r', workBranch: 'b', commands: [] }], 'rtask_1')).toBe(false);
    expect(isCancelForTask([cancel('rtask_2')], 'rtask_1')).toBe(false);
    expect(isCancelForTask(['garbage', null, {}], 'rtask_1')).toBe(false);
    expect(isCancelForTask(undefined, 'rtask_1')).toBe(false);
    expect(isCancelForTask([cancel('rtask_1')], '')).toBe(false);
  });
});

describe('extractInterjectActions(保活轮询插话指令提取)', () => {
  const interject = (taskId: string, interjectId: string, text: string) => ({
    taskId,
    kind: 'interject',
    repo: 'o/r',
    workBranch: 'b',
    interjectId,
    text,
  });

  it('命中:当前任务的合法 interject 按到达顺序返回(幂等键 + 正文)', () => {
    const out = extractInterjectActions(
      [interject('rtask_1', 'intj_b', '第二条'), interject('rtask_1', 'intj_a', '第一条')],
      'rtask_1'
    );
    expect(out).toEqual([
      { interjectId: 'intj_b', text: '第二条' },
      { interjectId: 'intj_a', text: '第一条' },
    ]);
  });

  it('过滤:别的任务 / cancel / publish / 畸形条目(缺键、空文、超 2000 字、控制字符)全部不进列表', () => {
    const actions = [
      interject('rtask_2', 'intj_x', '别的任务'),
      { taskId: 'rtask_1', kind: 'cancel', repo: 'o/r', workBranch: 'b' },
      { taskId: 'rtask_1', kind: 'interject', repo: 'o/r', workBranch: 'b', text: '缺幂等键' },
      { taskId: 'rtask_1', kind: 'interject', repo: 'o/r', workBranch: 'b', interjectId: 'intj_y' },
      { taskId: 'rtask_1', kind: 'interject', repo: 'o/r', workBranch: 'b', interjectId: 'intj_z', text: '   ' },
      { taskId: 'rtask_1', kind: 'interject', repo: 'o/r', workBranch: 'b', interjectId: 'intj_w', text: 'a'.repeat(2001) },
      { taskId: 'rtask_1', kind: 'interject', repo: 'o/r', workBranch: 'b', interjectId: 'intj_v', text: '坏\u001b字' },
      'garbage',
      null,
      interject('rtask_1', 'intj_ok', '合法的一条'),
    ];
    expect(extractInterjectActions(actions, 'rtask_1')).toEqual([{ interjectId: 'intj_ok', text: '合法的一条' }]);
  });

  it('畸形输入安全降级:非数组 / 空 taskId → 空列表', () => {
    expect(extractInterjectActions(undefined, 'rtask_1')).toEqual([]);
    expect(extractInterjectActions([interject('rtask_1', 'intj_a', 'x')], '')).toEqual([]);
  });
});
