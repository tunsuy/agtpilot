import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  createPairCode,
  redeemPairCode,
  authenticateRunner,
  listDevices,
  revokeDevice,
  updateDeviceMeta,
  enqueueTask,
  claimNextTask,
  recordRunnerEvents,
  getRunnerTasks,
  getRunnerTask,
} from '../runner-bridge';
import { PAIR_CODE_ALPHABET, RUNNER_TASK_TTL_MS, RUNNER_PROTOCOL_VERSION, type RunnerDeviceMeta } from '@agtpilot/protocol';

/**
 * runner-bridge 云端侧测试:USER_DATA_DIR 指向临时目录(getDataDir 每次调用动态读),
 * AGTPILOT_SECRET_KEY 固定值(secret-box 首次使用时解析,模块求值期设好即可)。
 */
process.env.AGTPILOT_SECRET_KEY = 'runner-bridge-test-key';

const USER_A = 'usr_aaaa';
const USER_B = 'usr_bbbb';
const T0 = 1760000000000;

const meta: RunnerDeviceMeta = {
  hostname: 'test-mac',
  platform: 'darwin',
  runnerVersion: '0.0.1',
  protocolVersion: RUNNER_PROTOCOL_VERSION,
};

const validPack = {
  taskId: 'rtask_0001',
  kind: 'oss_contribution',
  repo: 'owner/repo',
  issueUrl: 'https://github.com/owner/repo/issues/1',
  workBranch: 'contrib/fix-1',
  constraints: ['只修这个 Issue'],
  acceptance: { testCommand: 'pnpm test' },
  prDraft: { title: 'fix: 修一个东西', bodyTemplate: '关联 #1' },
  executor: { name: 'claude-code' },
};

/** 配对一台设备并返回认证材料 */
function pairDevice(userId: string, now = T0) {
  const { code } = createPairCode(userId, now);
  const r = redeemPairCode(code, meta, now);
  if (!r.ok) throw new Error(`pair failed: ${r.error}`);
  return r;
}

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-bridge-'));
  process.env.USER_DATA_DIR = tmp;
});

describe('配对与设备管理', () => {
  it('配对码:8 位、限字符集、5 分钟过期', () => {
    const { code, expiresAt } = createPairCode(USER_A, T0);
    expect(code).toHaveLength(8);
    expect([...code].every((ch) => PAIR_CODE_ALPHABET.includes(ch))).toBe(true);
    expect(expiresAt).toBe(T0 + 5 * 60 * 1000);
  });

  it('核销成功:产出 deviceId/deviceSecret,设备上线且出口不含密文', () => {
    const r = pairDevice(USER_A);
    expect(r.deviceId).toMatch(/^dev_[0-9a-f]{16}$/);
    expect(r.deviceSecret).toHaveLength(43); // 256-bit base64url

    const devices = listDevices(USER_A, T0 + 1000);
    expect(devices).toHaveLength(1);
    expect(devices[0].online).toBe(true);
    expect(devices[0].hostname).toBe('test-mac');
    expect(JSON.stringify(devices[0])).not.toContain('secretEnc');
    expect(JSON.stringify(devices[0])).not.toContain(r.deviceSecret);
  });

  it('一次性:同码二次核销 → already_redeemed', () => {
    const { code } = createPairCode(USER_A, T0);
    expect(redeemPairCode(code, meta, T0).ok).toBe(true);
    const second = redeemPairCode(code, meta, T0 + 1000);
    expect(second).toEqual({ ok: false, error: 'already_redeemed' });
  });

  it('过期码拒绝;未知码拒绝;协议版本不符拒绝', () => {
    const { code } = createPairCode(USER_A, T0);
    expect(redeemPairCode(code, meta, T0 + 6 * 60 * 1000)).toEqual({ ok: false, error: 'expired' });
    expect(redeemPairCode('ZZZZZZZZ', meta, T0)).toEqual({ ok: false, error: 'invalid_code' });
    const c2 = createPairCode(USER_A, T0);
    expect(redeemPairCode(c2.code, { ...meta, protocolVersion: 99 }, T0)).toEqual({
      ok: false,
      error: 'protocol_unsupported',
    });
  });

  it('配对码绑定创建者:核销产出的设备归属发码用户', () => {
    const { code } = createPairCode(USER_B, T0);
    const r = redeemPairCode(code, meta, T0);
    expect(r.ok && r.userId).toBe(USER_B);
    expect(listDevices(USER_A, T0)).toHaveLength(0);
    expect(listDevices(USER_B, T0)).toHaveLength(1);
  });

  it('设备认证:正确密钥通过;错密钥/缺头/未知设备/吊销后一律 null', () => {
    const r = pairDevice(USER_A);
    expect(authenticateRunner(r.deviceId, r.deviceSecret, T0 + 5000)?.userId).toBe(USER_A);
    expect(authenticateRunner(r.deviceId, 'wrong-secret', T0)).toBeNull();
    expect(authenticateRunner(r.deviceId, null, T0)).toBeNull();
    expect(authenticateRunner('dev_unknown', r.deviceSecret, T0)).toBeNull();

    expect(revokeDevice(USER_A, r.deviceId)).toBe(true);
    expect(authenticateRunner(r.deviceId, r.deviceSecret, T0)).toBeNull();
    // 二次吊销幂等 false;列表保留 revoked 状态供 UI 展示
    expect(revokeDevice(USER_A, r.deviceId)).toBe(false);
    const devices = listDevices(USER_A, T0);
    expect(devices[0].revoked).toBe(true);
    expect(devices[0].online).toBe(false);
  });

  it('离线判定:超过 60s 心跳窗口 → online=false', () => {
    const r = pairDevice(USER_A);
    expect(listDevices(USER_A, T0 + 59_000)[0].online).toBe(true);
    expect(listDevices(USER_A, T0 + 61_000)[0].online).toBe(false);
    // 心跳节流落盘:认证一次后 lastSeenAt 前进
    authenticateRunner(r.deviceId, r.deviceSecret, T0 + 120_000);
    expect(listDevices(USER_A, T0 + 121_000)[0].online).toBe(true);
  });

  it('心跳元信息更新(runner 升级换版本)', () => {
    const r = pairDevice(USER_A);
    expect(updateDeviceMeta(USER_A, r.deviceId, { ...meta, runnerVersion: '0.0.2' })).toBe(true);
    expect(listDevices(USER_A, T0)[0].runnerVersion).toBe('0.0.2');
  });
});

describe('任务队列', () => {
  it('入队:畸形任务包拒绝;合法包 queued + 7 天 TTL;taskId 冲突幂等拒绝', () => {
    expect(enqueueTask(USER_A, { ...validPack, repo: 'bad repo!' }, T0)).toBeNull();
    const t = enqueueTask(USER_A, validPack, T0)!;
    expect(t.state).toBe('queued');
    expect(t.expiresAt).toBe(T0 + RUNNER_TASK_TTL_MS);
    expect(enqueueTask(USER_A, validPack, T0)).toBeNull();
  });

  it('领取 FIFO:先入先领,领后 dispatched 绑定设备,队列空返回 null', () => {
    const r = pairDevice(USER_A);
    enqueueTask(USER_A, validPack, T0);
    enqueueTask(USER_A, { ...validPack, taskId: 'rtask_0002' }, T0 + 1000);

    const first = claimNextTask(USER_A, r.deviceId, T0 + 2000)!;
    expect(first.taskId).toBe('rtask_0001');
    expect(first.state).toBe('dispatched');
    expect(first.deviceId).toBe(r.deviceId);
    expect(claimNextTask(USER_A, r.deviceId, T0 + 3000)!.taskId).toBe('rtask_0002');
    expect(claimNextTask(USER_A, r.deviceId, T0 + 4000)).toBeNull();
  });

  it('用户隔离:B 的设备领不到 A 的任务', () => {
    const rb = pairDevice(USER_B);
    enqueueTask(USER_A, validPack, T0);
    expect(claimNextTask(USER_B, rb.deviceId, T0 + 10)).toBeNull();
    expect(getRunnerTasks(USER_B, T0)).toHaveLength(0);
  });

  it('TTL 懒过期:8 天后读取 → expired(终态)', () => {
    enqueueTask(USER_A, validPack, T0);
    const later = T0 + 8 * 24 * 60 * 60 * 1000;
    const tasks = getRunnerTasks(USER_A, later);
    expect(tasks[0].state).toBe('expired');
    const r = pairDevice(USER_A, later);
    expect(claimNextTask(USER_A, r.deviceId, later)).toBeNull();
  });
});

describe('上行事件记录', () => {
  function setup() {
    const r = pairDevice(USER_A);
    enqueueTask(USER_A, validPack, T0)!;
    claimNextTask(USER_A, r.deviceId, T0 + 10)!;
    return r;
  }

  const ev = (over: Record<string, unknown> = {}) => ({
    eventId: `ev_${Math.random().toString(36).slice(2)}`,
    taskId: 'rtask_0001',
    deviceId: 'dev_x',
    at: T0 + 20,
    type: 'progress',
    payload: { tool: 'Bash', summary: 'pytest 通过' },
    ...over,
  });

  it('合法 state 事件推进状态机(dispatched→running→awaiting_approval)', () => {
    const r = setup();
    const res1 = recordRunnerEvents(USER_A, r.deviceId, [ev({ deviceId: r.deviceId, type: 'state', payload: { state: 'running' } })], T0 + 30);
    expect(res1.accepted).toBe(1);
    expect(res1.stateChanges).toEqual([{ taskId: 'rtask_0001', from: 'dispatched', to: 'running' }]);
    expect(getRunnerTask(USER_A, 'rtask_0001', T0 + 30)!.state).toBe('running');

    const res2 = recordRunnerEvents(USER_A, r.deviceId, [ev({ deviceId: r.deviceId, type: 'state', payload: { state: 'awaiting_approval' } })], T0 + 40);
    expect(res2.stateChanges[0].to).toBe('awaiting_approval');
  });

  it('非法迁移拒绝且不改状态(dispatched 直达 done)', () => {
    const r = setup();
    const res = recordRunnerEvents(USER_A, r.deviceId, [ev({ deviceId: r.deviceId, type: 'state', payload: { state: 'done' } })], T0 + 30);
    expect(res.accepted).toBe(0);
    expect(res.rejected).toBe(1);
    expect(getRunnerTask(USER_A, 'rtask_0001', T0 + 30)!.state).toBe('dispatched');
  });

  it('冒名事件拒绝(event.deviceId ≠ 认证设备);畸形事件拒绝;未知任务拒绝', () => {
    const r = setup();
    const res = recordRunnerEvents(
      USER_A,
      r.deviceId,
      [
        ev({ deviceId: 'dev_someone_else' }), // 冒名
        { garbage: true }, // 畸形
        ev({ deviceId: r.deviceId, taskId: 'rtask_nonexistent' }), // 未知任务
      ],
      T0 + 30
    );
    expect(res).toMatchObject({ accepted: 0, rejected: 3 });
  });

  it('eventId 幂等:同批/跨批重发不重复入列', () => {
    const r = setup();
    const e = ev({ deviceId: r.deviceId });
    const first = recordRunnerEvents(USER_A, r.deviceId, [e, e], T0 + 30);
    expect(first.accepted).toBe(2); // 重发计已收
    const again = recordRunnerEvents(USER_A, r.deviceId, [e], T0 + 40);
    expect(again.accepted).toBe(1);
    expect(getRunnerTask(USER_A, 'rtask_0001', T0 + 40)!.events).toHaveLength(1);
  });

  it('phase2_result 回流 prUrl;error 记录诊断', () => {
    const r = setup();
    recordRunnerEvents(USER_A, r.deviceId, [ev({ deviceId: r.deviceId, type: 'state', payload: { state: 'running' } })], T0 + 30);
    recordRunnerEvents(USER_A, r.deviceId, [
      ev({ deviceId: r.deviceId, type: 'phase2_result', payload: { prUrl: 'https://github.com/owner/repo/pull/9' } }),
    ], T0 + 40);
    const t = getRunnerTask(USER_A, 'rtask_0001', T0 + 40)!;
    expect(t.prUrl).toBe('https://github.com/owner/repo/pull/9');

    recordRunnerEvents(USER_A, r.deviceId, [ev({ deviceId: r.deviceId, type: 'error', payload: { message: '超时' } })], T0 + 50);
    expect(getRunnerTask(USER_A, 'rtask_0001', T0 + 50)!.error).toBe('超时');
  });

  it('事件保留上限 200 条(滚动淘汰最老)', () => {
    const r = setup();
    const batch = Array.from({ length: 250 }, (_, i) => ev({ deviceId: r.deviceId, eventId: `ev_${i}` }));
    // 单批上限 100 → 分三批灌
    for (const chunk of [batch.slice(0, 100), batch.slice(100, 200), batch.slice(200)]) {
      recordRunnerEvents(USER_A, r.deviceId, chunk, T0 + 30);
    }
    const t = getRunnerTask(USER_A, 'rtask_0001', T0 + 30)!;
    expect(t.events!.length).toBeLessThanOrEqual(200);
    expect(t.events!.at(-1)!.eventId).toBe('ev_249');
  });
});
