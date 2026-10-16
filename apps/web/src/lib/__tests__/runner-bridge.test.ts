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
  findDispatchConflict,
  getRunnerTasks,
  getRunnerTask,
  cancelRunnerTask,
  interjectRunnerTask,
  getDeviceActions,
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

  it('来源 IP:配对时记录,心跳随 lastSeenAt 节流刷新,listDevices 出口暴露', () => {
    const { code } = createPairCode(USER_A, T0);
    const r = redeemPairCode(code, meta, T0, '203.0.113.7');
    if (!r.ok) throw new Error('pair failed');
    expect(listDevices(USER_A, T0)[0].lastSeenIp).toBe('203.0.113.7');

    // 节流窗口内不落盘:IP 与 lastSeenAt 同批更新(30s)
    authenticateRunner(r.deviceId, r.deviceSecret, T0 + 5000, '203.0.113.8');
    expect(listDevices(USER_A, T0)[0].lastSeenIp).toBe('203.0.113.7');
    authenticateRunner(r.deviceId, r.deviceSecret, T0 + 60_000, '203.0.113.9');
    expect(listDevices(USER_A, T0)[0].lastSeenIp).toBe('203.0.113.9');

    // 拿不到 IP(直连无头)→ 不覆盖存量值
    authenticateRunner(r.deviceId, r.deviceSecret, T0 + 120_000, null);
    expect(listDevices(USER_A, T0)[0].lastSeenIp).toBe('203.0.113.9');
  });

  it('来源 IP 可缺省:配对/心跳都不带 → 出口无 lastSeenIp 字段', () => {
    const r = pairDevice(USER_A);
    expect(listDevices(USER_A, T0)[0].lastSeenIp).toBeUndefined();
    expect('lastSeenIp' in listDevices(USER_A, T0)[0]).toBe(false);
    authenticateRunner(r.deviceId, r.deviceSecret, T0 + 60_000);
    expect(listDevices(USER_A, T0)[0].lastSeenIp).toBeUndefined();
  });
});

describe('任务队列', () => {
  it('入队:畸形任务包拒绝;合法包 queued + 7 天 TTL;taskId 冲突幂等拒绝', () => {
    expect(enqueueTask(USER_A, { ...validPack, repo: 'bad repo!' }, T0)).toBeNull();
    const t = enqueueTask(USER_A, validPack, T0)!;
    expect(t.state).toBe('queued');
    expect(t.expiresAt).toBe(T0 + RUNNER_TASK_TTL_MS);
    // 换 issueUrl 只留 taskId 冲突一个变量(同 Issue 防重是另一条拒绝路径,专测见下)
    expect(enqueueTask(USER_A, { ...validPack, issueUrl: 'https://github.com/owner/repo/issues/2' }, T0)).toBeNull();
  });

  it('关联会话(missionId):合法字符串落记录;畸形/超长拒绝入队', () => {
    const t = enqueueTask(USER_A, { ...validPack, taskId: 'rtask_m1' }, T0, { missionId: 'mission-abc' })!;
    expect(t.missionId).toBe('mission-abc');
    // 缺省不落字段(工坊外派发/旧客户端语义);issueUrl 各异,避开同 Issue 派发防重
    const t2 = enqueueTask(USER_A, { ...validPack, taskId: 'rtask_m2', issueUrl: 'https://github.com/owner/repo/issues/2' }, T0)!;
    expect('missionId' in t2).toBe(false);
    expect(enqueueTask(USER_A, { ...validPack, taskId: 'rtask_m3', issueUrl: 'https://github.com/owner/repo/issues/3' }, T0, { missionId: '' })).toBeNull();
    expect(enqueueTask(USER_A, { ...validPack, taskId: 'rtask_m4', issueUrl: 'https://github.com/owner/repo/issues/4' }, T0, { missionId: 'x'.repeat(129) })).toBeNull();
    expect(enqueueTask(USER_A, { ...validPack, taskId: 'rtask_m5', issueUrl: 'https://github.com/owner/repo/issues/5' }, T0, { missionId: 42 as unknown as string })).toBeNull();
  });

  it('领取 FIFO:先入先领,领后 dispatched 绑定设备,队列空返回 null', () => {
    const r = pairDevice(USER_A);
    enqueueTask(USER_A, validPack, T0);
    enqueueTask(USER_A, { ...validPack, taskId: 'rtask_0002', issueUrl: 'https://github.com/owner/repo/issues/2' }, T0 + 1000);

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

  it('error 事件带 retryable:true → 任务记录可重试标记(加固 ②:云端 UI 据此打「可重试」)', () => {
    const r = setup();
    recordRunnerEvents(USER_A, r.deviceId, [ev({ deviceId: r.deviceId, type: 'state', payload: { state: 'running' } })], T0 + 30);
    recordRunnerEvents(USER_A, r.deviceId, [
      ev({ deviceId: r.deviceId, type: 'error', payload: { message: 'claude 退出码 1 · [claude-code:unrecognized_model]', retryable: true } }),
    ], T0 + 40);
    const t = getRunnerTask(USER_A, 'rtask_0001', T0 + 40)!;
    expect(t.error).toContain('unrecognized_model');
    expect(t.retryable).toBe(true);
  });

  it('error 不带 retryable / retryable 非 true → 字段不写入(旧版 runner 与确定性失败保持原语义)', () => {
    const r = setup();
    recordRunnerEvents(USER_A, r.deviceId, [ev({ deviceId: r.deviceId, type: 'error', payload: { message: '验收命令未通过' } })], T0 + 30);
    let t = getRunnerTask(USER_A, 'rtask_0001', T0 + 30)!;
    expect(t.error).toBe('验收命令未通过');
    expect(t.retryable).toBeUndefined();

    recordRunnerEvents(USER_A, r.deviceId, [ev({ deviceId: r.deviceId, type: 'error', payload: { message: 'x', retryable: 'yes' } })], T0 + 40);
    t = getRunnerTask(USER_A, 'rtask_0001', T0 + 40)!;
    expect(t.retryable).toBeUndefined(); // 严格 === true 才认
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

describe('设备 ghLogin(公开登录名:配对/心跳上报,列表透出)', () => {
  it('配对携带 ghLogin → 列表透出;缺省 → 视图不含字段(旧版 runner 语义)', () => {
    const { code } = createPairCode(USER_A, T0);
    const r = redeemPairCode(code, { ...meta, ghLogin: 'tunsuy' }, T0);
    expect(r.ok).toBe(true);
    expect(listDevices(USER_A, T0)[0].ghLogin).toBe('tunsuy');

    const r2 = pairDevice(USER_A);
    const d2 = listDevices(USER_A, T0).find((d) => d.deviceId === r2.deviceId)!;
    expect('ghLogin' in d2).toBe(false);
  });

  it('心跳更新:字符串与 null(明确未登录)覆盖存量;undefined 不覆盖(沿用存量值)', () => {
    const { code } = createPairCode(USER_A, T0);
    const r = redeemPairCode(code, { ...meta, ghLogin: 'tunsuy' }, T0);
    if (!r.ok) throw new Error('pair failed');
    expect(updateDeviceMeta(USER_A, r.deviceId, { ...meta, ghLogin: null })).toBe(true);
    expect(listDevices(USER_A, T0)[0].ghLogin).toBeNull();
    expect(updateDeviceMeta(USER_A, r.deviceId, { ...meta, ghLogin: 'other-acct' })).toBe(true);
    expect(listDevices(USER_A, T0)[0].ghLogin).toBe('other-acct');
    expect(updateDeviceMeta(USER_A, r.deviceId, meta)).toBe(true); // 无 ghLogin 字段
    expect(listDevices(USER_A, T0)[0].ghLogin).toBe('other-acct');
  });
});

describe('派发时指定设备(targetDeviceId:任务绑定,仅该设备可领取)', () => {
  it('绑定设备 A:A 可领取;设备 B 轮询拿不到', () => {
    const a = pairDevice(USER_A);
    const b = pairDevice(USER_A);
    const rec = enqueueTask(USER_A, validPack, T0, { targetDeviceId: a.deviceId });
    expect(rec!.targetDeviceId).toBe(a.deviceId);
    expect(claimNextTask(USER_A, b.deviceId, T0 + 1)).toBeNull();
    const claimed = claimNextTask(USER_A, a.deviceId, T0 + 2);
    expect(claimed!.taskId).toBe(validPack.taskId);
    expect(claimed!.deviceId).toBe(a.deviceId); // 领取后照旧绑定执行设备
  });

  it('FIFO 与定向共存:跳过绑定给他机的更老任务,领取本机可领的', () => {
    const a = pairDevice(USER_A);
    const b = pairDevice(USER_A);
    enqueueTask(USER_A, { ...validPack, taskId: 'rtask_t_b', issueUrl: 'https://github.com/owner/repo/issues/2' }, T0, { targetDeviceId: b.deviceId });
    enqueueTask(USER_A, { ...validPack, taskId: 'rtask_t_a', issueUrl: 'https://github.com/owner/repo/issues/3' }, T0 + 1, { targetDeviceId: a.deviceId });
    expect(claimNextTask(USER_A, a.deviceId, T0 + 2)!.taskId).toBe('rtask_t_a');
    expect(claimNextTask(USER_A, b.deviceId, T0 + 3)!.taskId).toBe('rtask_t_b');
  });

  it('非法目标拒绝入队:畸形 id / 不存在 / 他人设备 / 已吊销 → null(不静默降级 FIFO)', () => {
    const a = pairDevice(USER_A);
    expect(enqueueTask(USER_A, { ...validPack, taskId: 'rtask_x1' }, T0, { targetDeviceId: 'dev_nope' })).toBeNull();
    expect(enqueueTask(USER_A, { ...validPack, taskId: 'rtask_x2' }, T0, { targetDeviceId: 'dev_0123456789abcdef' })).toBeNull();
    expect(enqueueTask(USER_B, { ...validPack, taskId: 'rtask_x3' }, T0, { targetDeviceId: a.deviceId })).toBeNull();
    revokeDevice(USER_A, a.deviceId);
    expect(enqueueTask(USER_A, { ...validPack, taskId: 'rtask_x4' }, T0, { targetDeviceId: a.deviceId })).toBeNull();
    // 拒绝入队是真的没入库,不是只返回值难看
    expect(getRunnerTasks(USER_A).some((t) => t.taskId.startsWith('rtask_x'))).toBe(false);
  });

  it('无绑定任务保持存量 FIFO 语义:任意设备可领', () => {
    const a = pairDevice(USER_A);
    enqueueTask(USER_A, validPack, T0);
    expect(claimNextTask(USER_A, a.deviceId, T0 + 1)!.taskId).toBe(validPack.taskId);
  });
});

describe('no-action 例外终态(ingest:error 事件识别 noAction 标记 → failed 升级 no_action)', () => {
  function setupRunning() {
    const r = pairDevice(USER_A);
    enqueueTask(USER_A, validPack, T0)!;
    claimNextTask(USER_A, r.deviceId, T0 + 10)!;
    recordRunnerEvents(USER_A, r.deviceId, [
      { eventId: 'ev_na_run', taskId: 'rtask_0001', deviceId: r.deviceId, at: T0 + 20, type: 'state', payload: { state: 'running' } },
    ], T0 + 20);
    return r;
  }
  const naEvidence = '修复 commit d9bef57b8f(PR #52261)经 git merge-base 验证已在当前基线,复现矩阵全过。';

  it('同批 error(noAction 标记)+ state failed → 升级 no_action 终态,标记与消息落库', () => {
    const r = setupRunning();
    // runner 单次 flush 的事件序:progress → error(标记)→ state(failed),批内顺序处理
    const res = recordRunnerEvents(
      USER_A,
      r.deviceId,
      [
        { eventId: 'ev_na_err', taskId: 'rtask_0001', deviceId: r.deviceId, at: T0 + 30, type: 'error', payload: { message: 'agent 核实无需改动:上游已修复。证据:' + naEvidence.slice(0, 50), noAction: { reason: 'already_fixed', evidence: naEvidence } } },
        { eventId: 'ev_na_state', taskId: 'rtask_0001', deviceId: r.deviceId, at: T0 + 30, type: 'state', payload: { state: 'failed' } },
      ],
      T0 + 30
    );
    expect(res.accepted).toBe(2);
    expect(res.stateChanges).toEqual([{ taskId: 'rtask_0001', from: 'running', to: 'no_action' }]);
    const t = getRunnerTask(USER_A, 'rtask_0001', T0 + 31)!;
    expect(t.state).toBe('no_action');
    expect(t.noAction).toEqual({ reason: 'already_fixed', evidence: naEvidence });
    expect(t.error).toContain('无需改动'); // error 消息照常落库(时间线人可读)
    expect(t.retryable).toBeUndefined(); // 不是失败,不标可重试
  });

  it('无标记的 state failed → 普通 failed(旧版 runner 语义不变)', () => {
    const r = setupRunning();
    recordRunnerEvents(USER_A, r.deviceId, [
      { eventId: 'ev_na_f1', taskId: 'rtask_0001', deviceId: r.deviceId, at: T0 + 30, type: 'error', payload: { message: '验收命令未通过' } },
      { eventId: 'ev_na_f2', taskId: 'rtask_0001', deviceId: r.deviceId, at: T0 + 30, type: 'state', payload: { state: 'failed' } },
    ], T0 + 30);
    const t = getRunnerTask(USER_A, 'rtask_0001', T0 + 31)!;
    expect(t.state).toBe('failed');
    expect(t.noAction).toBeUndefined();
  });

  it('畸形标记(evidence 缺失/空白、非对象)不落库 → 仍 failed(证据强制)', () => {
    for (const [i, bad] of [{ reason: 'already_fixed' }, { reason: 'already_fixed', evidence: '   ' }, 'yes', 42].entries()) {
      const r = setupRunning();
      recordRunnerEvents(USER_A, r.deviceId, [
        { eventId: `ev_na_bad${i}_e`, taskId: 'rtask_0001', deviceId: r.deviceId, at: T0 + 30, type: 'error', payload: { message: 'm', noAction: bad } },
        { eventId: `ev_na_bad${i}_s`, taskId: 'rtask_0001', deviceId: r.deviceId, at: T0 + 30, type: 'state', payload: { state: 'failed' } },
      ], T0 + 30);
      const t = getRunnerTask(USER_A, 'rtask_0001', T0 + 31)!;
      expect(t.state, `case ${i}`).toBe('failed');
      expect(t.noAction, `case ${i}`).toBeUndefined();
    }
  });

  it('标记迟到(failed 已落终态后才到)→ 不追溯升级状态;no_action 后其它迁移一律拒绝', () => {
    const r = setupRunning();
    recordRunnerEvents(USER_A, r.deviceId, [
      { eventId: 'ev_na_late_s', taskId: 'rtask_0001', deviceId: r.deviceId, at: T0 + 30, type: 'state', payload: { state: 'failed' } },
    ], T0 + 30);
    recordRunnerEvents(USER_A, r.deviceId, [
      { eventId: 'ev_na_late_e', taskId: 'rtask_0001', deviceId: r.deviceId, at: T0 + 40, type: 'error', payload: { message: 'm', noAction: { reason: 'other', evidence: 'e' } } },
    ], T0 + 40);
    expect(getRunnerTask(USER_A, 'rtask_0001', T0 + 41)!.state).toBe('failed'); // 终态不可逆
  });

  it('no_action 是终态:后续 state 事件拒绝,不悬挂', () => {
    const r = setupRunning();
    recordRunnerEvents(USER_A, r.deviceId, [
      { eventId: 'ev_na_t_e', taskId: 'rtask_0001', deviceId: r.deviceId, at: T0 + 30, type: 'error', payload: { message: 'm', noAction: { reason: 'not_reproducible', evidence: '按 Issue 步骤在当前基线复现 3 次全部通过' } } },
      { eventId: 'ev_na_t_s', taskId: 'rtask_0001', deviceId: r.deviceId, at: T0 + 30, type: 'state', payload: { state: 'failed' } },
      { eventId: 'ev_na_t_s2', taskId: 'rtask_0001', deviceId: r.deviceId, at: T0 + 31, type: 'state', payload: { state: 'running' } },
    ], T0 + 30);
    const t = getRunnerTask(USER_A, 'rtask_0001', T0 + 32)!;
    expect(t.state).toBe('no_action');
    expect(t.noAction!.reason).toBe('not_reproducible');
  });
});

describe('派发防重(findDispatchConflict + enqueueTask 权威闸 + force 明示旁路)', () => {
  function driveToNoAction(taskId: string, issueUrl: string) {
    const r = pairDevice(USER_A);
    enqueueTask(USER_A, { ...validPack, taskId, issueUrl }, T0)!;
    claimNextTask(USER_A, r.deviceId, T0 + 10)!;
    recordRunnerEvents(
      USER_A,
      r.deviceId,
      [
        { eventId: `${taskId}_run`, taskId, deviceId: r.deviceId, at: T0 + 20, type: 'state', payload: { state: 'running' } },
        { eventId: `${taskId}_err`, taskId, deviceId: r.deviceId, at: T0 + 21, type: 'error', payload: { message: 'm', noAction: { reason: 'already_fixed', evidence: 'commit d9bef57b8f 已在基线' } } },
        { eventId: `${taskId}_fail`, taskId, deviceId: r.deviceId, at: T0 + 22, type: 'state', payload: { state: 'failed' } },
      ],
      T0 + 22
    );
    expect(getRunnerTask(USER_A, taskId, T0 + 23)!.state).toBe('no_action');
  }

  it('同 issueUrl 已有 no_action 结论 → 重复派发拒绝;force:true 明示旁路后可入队', () => {
    driveToNoAction('rtask_na1', validPack.issueUrl);
    expect(enqueueTask(USER_A, { ...validPack, taskId: 'rtask_na2' }, T0 + 100)).toBeNull();
    const forced = enqueueTask(USER_A, { ...validPack, taskId: 'rtask_na2' }, T0 + 100, { force: true });
    expect(forced!.taskId).toBe('rtask_na2');
    expect(forced!.state).toBe('queued');
  });

  it('同 issueUrl 有在途任务(queued)→ 拒绝;落终态(cancelled)后不再挡,人工重派合法', () => {
    enqueueTask(USER_A, validPack, T0)!;
    expect(enqueueTask(USER_A, { ...validPack, taskId: 'rtask_d2' }, T0 + 1)).toBeNull();
    cancelRunnerTask(USER_A, 'rtask_0001', T0 + 2);
    const again = enqueueTask(USER_A, { ...validPack, taskId: 'rtask_d2' }, T0 + 3);
    expect(again!.taskId).toBe('rtask_d2');
  });

  it('failed/done 终态不算冲突:同 Issue 修复失败后允许直接重派(不带 force)', () => {
    const r = pairDevice(USER_A);
    enqueueTask(USER_A, validPack, T0)!;
    claimNextTask(USER_A, r.deviceId, T0 + 10)!;
    recordRunnerEvents(USER_A, r.deviceId, [
      { eventId: 'ev_dd_r', taskId: 'rtask_0001', deviceId: r.deviceId, at: T0 + 20, type: 'state', payload: { state: 'running' } },
      { eventId: 'ev_dd_f', taskId: 'rtask_0001', deviceId: r.deviceId, at: T0 + 21, type: 'state', payload: { state: 'failed' } },
    ], T0 + 21);
    const retry = enqueueTask(USER_A, { ...validPack, taskId: 'rtask_retry' }, T0 + 30);
    expect(retry!.taskId).toBe('rtask_retry');
  });

  it('findDispatchConflict:no_action 结论优先于在途;不同 issueUrl / 空串 → null', () => {
    driveToNoAction('rtask_fc1', validPack.issueUrl);
    // force 再派一条在途同 Issue 任务:no_action 结论优先(它才是用户该先看到的)
    enqueueTask(USER_A, { ...validPack, taskId: 'rtask_fc2' }, T0 + 100, { force: true })!;
    const c = findDispatchConflict(getRunnerTasks(USER_A, T0 + 101), validPack.issueUrl);
    expect(c!.kind).toBe('no_action');
    expect(c!.taskId).toBe('rtask_fc1');
    expect(c!.noAction).toEqual({ reason: 'already_fixed', evidence: 'commit d9bef57b8f 已在基线' });

    expect(findDispatchConflict(getRunnerTasks(USER_A, T0 + 101), 'https://github.com/owner/repo/issues/999')).toBeNull();
    expect(findDispatchConflict(getRunnerTasks(USER_A, T0 + 101), '')).toBeNull();
    expect(findDispatchConflict([], validPack.issueUrl)).toBeNull();
  });

  it('findDispatchConflict:仅在途任务 → kind active(带状态供话术)', () => {
    enqueueTask(USER_A, validPack, T0)!;
    const c = findDispatchConflict(getRunnerTasks(USER_A, T0 + 1), validPack.issueUrl);
    expect(c).toEqual({ kind: 'active', taskId: 'rtask_0001', state: 'queued' });
  });
});

describe('用户终止任务(执行中止损,两阶段)', () => {
  it('queued → 云端直接落 cancelled(runner 永远领不到)', () => {
    pairDevice(USER_A);
    enqueueTask(USER_A, { ...validPack, taskId: 'rtask_c1' }, T0);
    const r = cancelRunnerTask(USER_A, 'rtask_c1', T0 + 5);
    expect(r.ok).toBe(true);
    expect(getRunnerTask(USER_A, 'rtask_c1', T0 + 5)!.state).toBe('cancelled');
    const a = pairDevice(USER_A);
    expect(claimNextTask(USER_A, a.deviceId, T0 + 6)).toBeNull(); // 不再可领
  });

  it('running → 置 cancelRequested(状态不动),getDeviceActions 派生 cancel 动作下发给归属设备', () => {
    const r = pairDevice(USER_A);
    enqueueTask(USER_A, { ...validPack, taskId: 'rtask_c2' }, T0);
    claimNextTask(USER_A, r.deviceId, T0 + 10);
    recordRunnerEvents(USER_A, r.deviceId, [
      { eventId: 'ev_r1', taskId: 'rtask_c2', deviceId: r.deviceId, at: T0 + 20, type: 'state', payload: { state: 'running' } },
    ], T0 + 20);

    const c = cancelRunnerTask(USER_A, 'rtask_c2', T0 + 30);
    expect(c.ok).toBe(true);
    const t = getRunnerTask(USER_A, 'rtask_c2', T0 + 30)!;
    expect(t.state).toBe('running'); // 状态不动,等 runner 确认
    expect(t.cancelRequested).toBe(true);

    const actions = getDeviceActions(USER_A, r.deviceId);
    expect(actions).toEqual([
      { taskId: 'rtask_c2', kind: 'cancel', repo: 'owner/repo', workBranch: 'contrib/fix-1' }, // 无 approvalId(无审批单)
    ]);
  });

  it('runner 上报 cancelled → 合法迁移落终态并清标志,动作不再派生(幂等闭环)', () => {
    const r = pairDevice(USER_A);
    enqueueTask(USER_A, { ...validPack, taskId: 'rtask_c3' }, T0);
    claimNextTask(USER_A, r.deviceId, T0 + 10);
    recordRunnerEvents(USER_A, r.deviceId, [
      { eventId: 'ev_r2', taskId: 'rtask_c3', deviceId: r.deviceId, at: T0 + 20, type: 'state', payload: { state: 'running' } },
    ], T0 + 20);
    cancelRunnerTask(USER_A, 'rtask_c3', T0 + 30);

    const res = recordRunnerEvents(USER_A, r.deviceId, [
      { eventId: 'ev_r3', taskId: 'rtask_c3', deviceId: r.deviceId, at: T0 + 40, type: 'state', payload: { state: 'cancelled' } },
    ], T0 + 40);
    expect(res.stateChanges[0]).toEqual({ taskId: 'rtask_c3', from: 'running', to: 'cancelled' });
    const t = getRunnerTask(USER_A, 'rtask_c3', T0 + 40)!;
    expect(t.state).toBe('cancelled');
    expect(t.cancelRequested).toBeUndefined();
    expect(getDeviceActions(USER_A, r.deviceId)).toEqual([]);
  });

  it('终止中任务跑到自然终态(awaiting_approval/failed)→ 标志一并清,不悬挂「终止中…」(旧 runner 不识别 cancel 的兜底)', () => {
    const r = pairDevice(USER_A);
    enqueueTask(USER_A, { ...validPack, taskId: 'rtask_c6' }, T0);
    claimNextTask(USER_A, r.deviceId, T0 + 10);
    recordRunnerEvents(USER_A, r.deviceId, [
      { eventId: 'ev_r5', taskId: 'rtask_c6', deviceId: r.deviceId, at: T0 + 20, type: 'state', payload: { state: 'running' } },
    ], T0 + 20);
    cancelRunnerTask(USER_A, 'rtask_c6', T0 + 30); // 旧 runner 不识别 cancel 动作

    // 任务自己跑完进审批卡:dispatched/running 之外的迁移即清标志
    recordRunnerEvents(USER_A, r.deviceId, [
      { eventId: 'ev_r6', taskId: 'rtask_c6', deviceId: r.deviceId, at: T0 + 50, type: 'state', payload: { state: 'awaiting_approval' } },
    ], T0 + 50);
    const t = getRunnerTask(USER_A, 'rtask_c6', T0 + 50)!;
    expect(t.state).toBe('awaiting_approval');
    expect(t.cancelRequested).toBeUndefined();
    expect(getDeviceActions(USER_A, r.deviceId)).toEqual([]); // 不再派生 cancel
  });

  it('终止中任务被懒过期清扫 → expired 时标志一并清', () => {
    const r = pairDevice(USER_A);
    enqueueTask(USER_A, { ...validPack, taskId: 'rtask_c7' }, T0);
    claimNextTask(USER_A, r.deviceId, T0 + 10);
    recordRunnerEvents(USER_A, r.deviceId, [
      { eventId: 'ev_r7', taskId: 'rtask_c7', deviceId: r.deviceId, at: T0 + 20, type: 'state', payload: { state: 'running' } },
    ], T0 + 20);
    cancelRunnerTask(USER_A, 'rtask_c7', T0 + 30);

    // 越过 expiresAt 读取(任意读取路径都会带清扫;TTL 7 天)
    const t = getRunnerTask(USER_A, 'rtask_c7', T0 + 8 * 24 * 60 * 60 * 1000)!;
    expect(t.state).toBe('expired');
    expect(t.cancelRequested).toBeUndefined();
    expect(getDeviceActions(USER_A, r.deviceId)).toEqual([]);
  });

  it('不可终止:不存在 / 终态 / awaiting_approval(审批卡拒绝才是其终止路径)', () => {
    pairDevice(USER_A);
    expect(cancelRunnerTask(USER_A, 'rtask_nope', T0).error).toBe('not_found');
    enqueueTask(USER_A, { ...validPack, taskId: 'rtask_c4' }, T0);
    // queued 直接取消落终态,再取消应拒绝
    cancelRunnerTask(USER_A, 'rtask_c4', T0 + 1);
    expect(cancelRunnerTask(USER_A, 'rtask_c4', T0 + 2).error).toBe('not_cancellable');
  });

  it('重复请求幂等(已 cancelRequested 时再点不再改时间戳/状态)', () => {
    const r = pairDevice(USER_A);
    enqueueTask(USER_A, { ...validPack, taskId: 'rtask_c5' }, T0);
    claimNextTask(USER_A, r.deviceId, T0 + 10);
    recordRunnerEvents(USER_A, r.deviceId, [
      { eventId: 'ev_r4', taskId: 'rtask_c5', deviceId: r.deviceId, at: T0 + 20, type: 'state', payload: { state: 'running' } },
    ], T0 + 20);
    cancelRunnerTask(USER_A, 'rtask_c5', T0 + 30);
    const r2 = cancelRunnerTask(USER_A, 'rtask_c5', T0 + 99);
    expect(r2.ok).toBe(true);
    expect(getRunnerTask(USER_A, 'rtask_c5', T0 + 99)!.updatedAt).toBe(T0 + 30); // 未被二次改写
  });
});

describe('中途插话(执行中纠偏,pendingInterjects 队列 + interject_ack 闭环)', () => {
  /** 配对设备 + 任务入队 + 领取 + 上报 running(插话受理前置态);issueNo 区分同测试内多任务(派发防重按 issueUrl) */
  function runningTask(taskId: string, issueNo = 1) {
    const r = pairDevice(USER_A);
    enqueueTask(USER_A, { ...validPack, taskId, issueUrl: `https://github.com/owner/repo/issues/${issueNo}` }, T0);
    claimNextTask(USER_A, r.deviceId, T0 + 10);
    recordRunnerEvents(USER_A, r.deviceId, [
      { eventId: `ev_i_${taskId}_run`, taskId, deviceId: r.deviceId, at: T0 + 20, type: 'state', payload: { state: 'running' } },
    ], T0 + 20);
    return r;
  }

  it('running → 插话入队(状态不动),getDeviceActions 派生 interject 动作下发给归属设备', () => {
    const r = runningTask('rtask_i1');
    const res = interjectRunnerTask(USER_A, 'rtask_i1', '  git 用户名邮箱写错了,用 foobar 重新 commit  ', T0 + 30);
    expect(res.ok).toBe(true);
    const t = getRunnerTask(USER_A, 'rtask_i1', T0 + 30)!;
    expect(t.state).toBe('running'); // 状态不动,等 runner 注入 + ack
    expect(t.pendingInterjects).toHaveLength(1);
    expect(t.pendingInterjects![0].id).toMatch(/^intj_/);
    expect(t.pendingInterjects![0].text).toBe('git 用户名邮箱写错了,用 foobar 重新 commit'); // trim 后入库

    const actions = getDeviceActions(USER_A, r.deviceId);
    expect(actions).toEqual([
      {
        taskId: 'rtask_i1',
        kind: 'interject',
        repo: 'owner/repo',
        workBranch: 'contrib/fix-1',
        interjectId: t.pendingInterjects![0].id,
        text: 'git 用户名邮箱写错了,用 foobar 重新 commit',
      },
    ]);
    // 多行插话合法(注入的是会话 user 消息,换行不是控制字符)
    expect(interjectRunnerTask(USER_A, 'rtask_i1', '第一行\n第二行', T0 + 31).ok).toBe(true);
  });

  it('at-least-once:ack 到达前每次轮询持续派生同一动作(runner 按 id 去重)', () => {
    const r = runningTask('rtask_i2');
    interjectRunnerTask(USER_A, 'rtask_i2', '纠正一下', T0 + 30);
    const a1 = getDeviceActions(USER_A, r.deviceId);
    const a2 = getDeviceActions(USER_A, r.deviceId);
    expect(a1).toEqual(a2); // 幂等重发,interjectId 不变
    expect(a1[0].kind).toBe('interject');
  });

  it('interject_ack → 按 id 清队,动作不再派生;delivered=false(finishing)同样清', () => {
    const r = runningTask('rtask_i3');
    interjectRunnerTask(USER_A, 'rtask_i3', '改一下', T0 + 30);
    const id = getRunnerTask(USER_A, 'rtask_i3', T0 + 30)!.pendingInterjects![0].id;

    recordRunnerEvents(USER_A, r.deviceId, [
      { eventId: 'ev_ack1', taskId: 'rtask_i3', deviceId: r.deviceId, at: T0 + 40, type: 'interject_ack', payload: { interjectId: id, delivered: true } },
    ], T0 + 40);
    const t = getRunnerTask(USER_A, 'rtask_i3', T0 + 40)!;
    expect(t.pendingInterjects).toBeUndefined();
    expect(getDeviceActions(USER_A, r.deviceId)).toEqual([]);

    // delivered=false(会话已收尾等):送达不可能了,同样清队 —— reason 已随事件入时间线
    interjectRunnerTask(USER_A, 'rtask_i3', '再说一句', T0 + 50);
    const id2 = getRunnerTask(USER_A, 'rtask_i3', T0 + 50)!.pendingInterjects![0].id;
    recordRunnerEvents(USER_A, r.deviceId, [
      { eventId: 'ev_ack2', taskId: 'rtask_i3', deviceId: r.deviceId, at: T0 + 60, type: 'interject_ack', payload: { interjectId: id2, delivered: false, reason: 'finishing' } },
    ], T0 + 60);
    expect(getRunnerTask(USER_A, 'rtask_i3', T0 + 60)!.pendingInterjects).toBeUndefined();
    expect(getDeviceActions(USER_A, r.deviceId)).toEqual([]);
  });

  it('多条插话:按队列序派生;ack 只清对应 id,其余继续重发;未知 id 的 ack 不动队列', () => {
    const r = runningTask('rtask_i4');
    interjectRunnerTask(USER_A, 'rtask_i4', '第一条', T0 + 30);
    interjectRunnerTask(USER_A, 'rtask_i4', '第二条', T0 + 31);
    const t = getRunnerTask(USER_A, 'rtask_i4', T0 + 31)!;
    const [id1, id2] = t.pendingInterjects!.map((p) => p.id);
    const actions = getDeviceActions(USER_A, r.deviceId);
    expect(actions.map((a) => a.interjectId)).toEqual([id1, id2]);

    // 未知 id 的 ack(伪造/错乱)不误清
    recordRunnerEvents(USER_A, r.deviceId, [
      { eventId: 'ev_ack3', taskId: 'rtask_i4', deviceId: r.deviceId, at: T0 + 40, type: 'interject_ack', payload: { interjectId: 'intj_nope', delivered: true } },
    ], T0 + 40);
    expect(getRunnerTask(USER_A, 'rtask_i4', T0 + 40)!.pendingInterjects).toHaveLength(2);

    // ack 第一条 → 只剩第二条继续派生
    recordRunnerEvents(USER_A, r.deviceId, [
      { eventId: 'ev_ack4', taskId: 'rtask_i4', deviceId: r.deviceId, at: T0 + 50, type: 'interject_ack', payload: { interjectId: id1, delivered: true } },
    ], T0 + 50);
    const rest = getRunnerTask(USER_A, 'rtask_i4', T0 + 50)!.pendingInterjects!;
    expect(rest.map((p) => p.id)).toEqual([id2]);
    expect(getDeviceActions(USER_A, r.deviceId).map((a) => a.interjectId)).toEqual([id2]);
  });

  it('离开在飞状态即清队:跑到 awaiting_approval(老 runner 不识别 interject 的兜底)与懒过期清扫', () => {
    const r = runningTask('rtask_i5');
    interjectRunnerTask(USER_A, 'rtask_i5', '插一句', T0 + 30);
    recordRunnerEvents(USER_A, r.deviceId, [
      { eventId: 'ev_i5_appr', taskId: 'rtask_i5', deviceId: r.deviceId, at: T0 + 50, type: 'state', payload: { state: 'awaiting_approval' } },
    ], T0 + 50);
    const t = getRunnerTask(USER_A, 'rtask_i5', T0 + 50)!;
    expect(t.pendingInterjects).toBeUndefined();
    expect(getDeviceActions(USER_A, r.deviceId)).toEqual([]); // 不再重发

    const r2 = runningTask('rtask_i6', 2);
    interjectRunnerTask(USER_A, 'rtask_i6', '插一句', T0 + 30);
    const expired = getRunnerTask(USER_A, 'rtask_i6', T0 + 8 * 24 * 60 * 60 * 1000)!; // 越过 TTL,读取即清扫
    expect(expired.state).toBe('expired');
    expect(expired.pendingInterjects).toBeUndefined();
    expect(getDeviceActions(USER_A, r2.deviceId)).toEqual([]);
  });

  it('拒绝路径:不存在 / queued(没人执行)/ 终态 / 审批中 —— 没有会话可注入', () => {
    const r = pairDevice(USER_A);
    expect(interjectRunnerTask(USER_A, 'rtask_nope', 'x', T0).error).toBe('not_found');
    enqueueTask(USER_A, { ...validPack, taskId: 'rtask_i7' }, T0);
    expect(interjectRunnerTask(USER_A, 'rtask_i7', 'x', T0 + 1).error).toBe('not_interjectable'); // queued
    cancelRunnerTask(USER_A, 'rtask_i7', T0 + 2); // queued → cancelled 终态
    expect(interjectRunnerTask(USER_A, 'rtask_i7', 'x', T0 + 3).error).toBe('not_interjectable');
    // dispatched(已领取未上报 running)也可插话:runner 领取即起会话
    claimNextTask(USER_A, r.deviceId, T0 + 4);
    enqueueTask(USER_A, { ...validPack, taskId: 'rtask_i8' }, T0 + 5);
    claimNextTask(USER_A, r.deviceId, T0 + 6);
    expect(interjectRunnerTask(USER_A, 'rtask_i8', 'dispatched 也能插', T0 + 7).ok).toBe(true);
  });

  it('正文防线(与协议 normalize 同源):空/纯空白/超 2000 字/控制字符拒绝,恰好 2000 字合法', () => {
    runningTask('rtask_i9');
    expect(interjectRunnerTask(USER_A, 'rtask_i9', '   ', T0 + 30).error).toBe('invalid_text');
    expect(interjectRunnerTask(USER_A, 'rtask_i9', 'x'.repeat(2001), T0 + 30).error).toBe('invalid_text');
    expect(interjectRunnerTask(USER_A, 'rtask_i9', '带\u0000空字符', T0 + 30).error).toBe('invalid_text');
    expect(interjectRunnerTask(USER_A, 'rtask_i9', '带\u001b转义', T0 + 30).error).toBe('invalid_text');
    const ok = interjectRunnerTask(USER_A, 'rtask_i9', 'y'.repeat(2000), T0 + 30);
    expect(ok.ok).toBe(true);
    expect(getRunnerTask(USER_A, 'rtask_i9', T0 + 30)!.pendingInterjects![0].text).toHaveLength(2000);
  });

  it('队列上限 10 条:第 11 条 queue_full(ack 清出一条后可再插)', () => {
    const r = runningTask('rtask_i10');
    for (let i = 0; i < 10; i++) {
      expect(interjectRunnerTask(USER_A, 'rtask_i10', `第${i + 1}条`, T0 + 30 + i).ok).toBe(true);
    }
    expect(interjectRunnerTask(USER_A, 'rtask_i10', '第11条', T0 + 50).error).toBe('queue_full');

    const first = getRunnerTask(USER_A, 'rtask_i10', T0 + 50)!.pendingInterjects![0].id;
    recordRunnerEvents(USER_A, r.deviceId, [
      { eventId: 'ev_ack5', taskId: 'rtask_i10', deviceId: r.deviceId, at: T0 + 60, type: 'interject_ack', payload: { interjectId: first, delivered: true } },
    ], T0 + 60);
    expect(interjectRunnerTask(USER_A, 'rtask_i10', '第11条', T0 + 70).ok).toBe(true);
  });
});
