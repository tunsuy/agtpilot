import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  createPairCode,
  redeemPairCode,
  enqueueTask,
  claimNextTask,
  recordRunnerEvents,
  getRunnerTask,
  createPublishApproval,
  runnerApprovalToRequest,
  resolvePublishApproval,
  getDeviceActions,
  listPendingRunnerApprovalRequests,
} from '../runner-bridge';
import { RUNNER_PROTOCOL_VERSION, type RunnerDeviceMeta } from '@agtpilot/protocol';

/**
 * Phase 2 审批闭环测试(M3,§6.2):awaiting_approval → 审批单创建(快照)→
 * 裁决(批准固化命令集 / 拒绝)→ 设备动作下行 → runner 事件回流终态。
 * 底座与 runner-bridge.test.ts 同款:USER_DATA_DIR 临时目录 + 固定密钥。
 */
process.env.AGTPILOT_SECRET_KEY = 'runner-bridge-test-key';

const USER = 'usr_pppp';
const T0 = 1760000000000;

const meta: RunnerDeviceMeta = {
  hostname: 'test-mac',
  platform: 'darwin',
  runnerVersion: '0.0.1',
  protocolVersion: RUNNER_PROTOCOL_VERSION,
};

const validPack = {
  taskId: 'rtask_p1',
  kind: 'oss_contribution',
  repo: 'owner/repo',
  issueUrl: 'https://github.com/owner/repo/issues/9',
  baseBranch: 'main',
  workBranch: 'contrib/fix-9',
  constraints: ['只修这个 Issue'],
  acceptance: { testCommand: 'pnpm test' },
  claimDraft: '我想认领这个 Issue(#9)。',
  prDraft: { title: 'fix: 派发草稿标题', bodyTemplate: '关联 #9(模板)' },
  executor: { name: 'claude-code' },
};

let tmp: string;
let deviceId: string;

/** 配对设备 → 入队 → 领取 → 事件推进到 awaiting_approval(带 phase1_result 快照) */
function setupAwaitingTask(opts: { prFinal?: { title: string; body: string } | null } = {}) {
  const { code } = createPairCode(USER, T0);
  const r = redeemPairCode(code, meta, T0);
  if (!r.ok) throw new Error(`pair failed: ${r.error}`);
  deviceId = r.deviceId;

  enqueueTask(USER, validPack, T0);
  claimNextTask(USER, deviceId, T0 + 1);

  const ev = (n: number, type: string, payload?: Record<string, unknown>) => ({
    eventId: `ev_${n}`,
    taskId: validPack.taskId,
    deviceId,
    at: T0 + 10 + n,
    type,
    payload,
  });
  const prFinal =
    opts.prFinal === undefined ? { title: 'fix: agent 终稿标题', body: '关联 #9\n\nagent 写的正文' } : opts.prFinal;
  recordRunnerEvents(
    USER,
    deviceId,
    [
      ev(1, 'state', { state: 'running' }),
      ev(2, 'phase1_result', {
        commitHash: 'abc123def456',
        diffstat: ' src/a.py | 4 ++--\n 1 file changed',
        testTail: 'PASSED 12 tests',
        prFinal: prFinal ?? undefined,
      }),
      ev(3, 'state', { state: 'awaiting_approval' }),
    ],
    T0 + 20
  );
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-approval-'));
  process.env.USER_DATA_DIR = tmp;
});

describe('createPublishApproval(审批单创建)', () => {
  it('awaiting_approval 任务 → pending 审批单,PR 终稿优先于派发草稿,快照落盘', () => {
    setupAwaitingTask();
    const r = createPublishApproval(USER, validPack.taskId, T0 + 100);
    expect(r).not.toBeNull();
    expect(r!.approval.status).toBe('pending');
    expect(r!.approval.approvalId).toMatch(/^rappr_/);
    expect(r!.approval.prTitle).toBe('fix: agent 终稿标题');
    expect(r!.approval.prBody).toContain('agent 写的正文');
    expect(r!.approval.commitHash).toBe('abc123def456');
    expect(r!.approval.diffstat).toContain('1 file changed');
    expect(r!.approval.testTail).toBe('PASSED 12 tests');
    // 任务记录冗余 approvalId 便于检索
    expect(getRunnerTask(USER, validPack.taskId, T0 + 100)!.approvalId).toBe(r!.approval.approvalId);
  });

  it('无 prFinal(agent 没产终稿)→ 回落派发草稿', () => {
    setupAwaitingTask({ prFinal: null });
    const r = createPublishApproval(USER, validPack.taskId, T0 + 100);
    expect(r!.approval.prTitle).toBe('fix: 派发草稿标题');
    expect(r!.approval.prBody).toBe('关联 #9(模板)');
  });

  it('幂等:重复调用复用同一 pending 单(事件重发/多路由并发安全)', () => {
    setupAwaitingTask();
    const a = createPublishApproval(USER, validPack.taskId, T0 + 100)!;
    const b = createPublishApproval(USER, validPack.taskId, T0 + 200)!;
    expect(b.approval.approvalId).toBe(a.approval.approvalId);
  });

  it('非 awaiting_approval / 任务不存在 → null', () => {
    setupAwaitingTask();
    expect(createPublishApproval(USER, 'rtask_nope', T0)).toBeNull();
    const { code } = createPairCode(USER, T0);
    redeemPairCode(code, meta, T0);
    enqueueTask(USER, { ...validPack, taskId: 'rtask_queued' }, T0);
    expect(createPublishApproval(USER, 'rtask_queued', T0)).toBeNull();
  });
});

describe('runnerApprovalToRequest(复用既有审批卡链路)', () => {
  it('action=runner_publish,dangerLevel=high,归属 userId,params 带命令预览与认领留言', () => {
    setupAwaitingTask();
    const { task } = createPublishApproval(USER, validPack.taskId, T0 + 100)!;
    const req = runnerApprovalToRequest(task, USER);
    expect(req).not.toBeNull();
    expect(req!.action).toBe('runner_publish');
    expect(req!.dangerLevel).toBe('high');
    expect(req!.userId).toBe(USER);
    // 不设 taskId:runner 任务不是 Mission(submitApproval 不误定位)
    expect(req!.taskId).toBeUndefined();
    const p = req!.params as Record<string, any>;
    expect(p.repo).toBe('owner/repo');
    expect(p.workBranch).toBe('contrib/fix-9');
    expect(p.commands).toHaveLength(2); // 预览:push + pr create(认领留言按勾选追加)
    expect(p.claimCommand.args[0]).toBe('issue');
    expect(p.claimDraft).toContain('#9');
    expect(p.prTitle).toBe('fix: agent 终稿标题');
  });

  it('带来源会话 missionId(审批卡归回该会话展示);任务无 missionId → 不设,回落全局可见', () => {
    setupAwaitingTask();
    const { task } = createPublishApproval(USER, validPack.taskId, T0 + 100)!;
    // missionId 由派发时写入任务记录,审批单从记录透传(不改写、不派生)
    expect(runnerApprovalToRequest({ ...task, missionId: 'msn_abc' }, USER)!.missionId).toBe('msn_abc');
    expect(runnerApprovalToRequest(task, USER)!.missionId).toBeUndefined();
  });

  it('非 pending 单 → null', () => {
    setupAwaitingTask();
    const { task } = createPublishApproval(USER, validPack.taskId, T0 + 100)!;
    resolvePublishApproval(USER, task.approvalId!, true, {}, T0 + 200);
    const after = getRunnerTask(USER, validPack.taskId, T0 + 200)!;
    expect(runnerApprovalToRequest(after, USER)).toBeNull();
  });
});

describe('taskBaseBranch(实探基线回流 → PR --base 固化,milvus 类 master 默认仓库)', () => {
  it('phase1_result 回流 baseBranch=master → 审批展示与固化命令的 --base 都用实探值', () => {
    setupAwaitingTask();
    // runner 在仓库准备阶段回落实探基线(派发包 baseBranch: main 在 milvus 上不存在)
    recordRunnerEvents(
      USER,
      deviceId,
      [
        {
          eventId: 'ev_base',
          taskId: validPack.taskId,
          deviceId,
          at: T0 + 30,
          type: 'phase1_result',
          payload: { baseBranch: 'master' },
        },
      ],
      T0 + 31
    );
    const { task } = createPublishApproval(USER, validPack.taskId, T0 + 100)!;
    const req = runnerApprovalToRequest(task, USER)!;
    expect((req.params as Record<string, any>).baseBranch).toBe('master');

    const r = resolvePublishApproval(USER, task.approvalId!, true, {}, T0 + 200);
    const cmds = (r as any).task.approval.commands as Array<{ cmd: string; args: string[] }>;
    const i = cmds[1].args.indexOf('--base');
    expect(i).toBeGreaterThan(-1);
    expect(cmds[1].args[i + 1]).toBe('master');
  });

  it('无回流(旧版 runner)→ 维持 pack.baseBranch(向后兼容,缺省 main)', () => {
    setupAwaitingTask();
    const { task } = createPublishApproval(USER, validPack.taskId, T0 + 100)!;
    const req = runnerApprovalToRequest(task, USER)!;
    expect((req.params as Record<string, any>).baseBranch).toBe('main');
  });

  it('回流畸形值(注入防御)→ 忽略,退 pack.baseBranch', () => {
    setupAwaitingTask();
    recordRunnerEvents(
      USER,
      deviceId,
      [
        {
          eventId: 'ev_bad',
          taskId: validPack.taskId,
          deviceId,
          at: T0 + 30,
          type: 'phase1_result',
          payload: { baseBranch: 'main; rm -rf /' },
        },
      ],
      T0 + 31
    );
    const { task } = createPublishApproval(USER, validPack.taskId, T0 + 100)!;
    const req = runnerApprovalToRequest(task, USER)!;
    expect((req.params as Record<string, any>).baseBranch).toBe('main');
  });
});

describe('resolvePublishApproval(裁决 → 固化 / 拒绝)', () => {
  it('批准:命令集固化落盘(git push + gh pr create),任务 → finishing', () => {
    setupAwaitingTask();
    const { approval } = createPublishApproval(USER, validPack.taskId, T0 + 100)!;
    const r = resolvePublishApproval(USER, approval.approvalId, true, {}, T0 + 200);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.task.state).toBe('finishing');
    const cmds = r.task.approval!.commands!;
    expect(cmds).toHaveLength(2);
    expect(cmds[0]).toEqual({ cmd: 'git', args: ['push', '-u', 'origin', 'contrib/fix-9'] });
    expect(cmds[1].args.slice(0, 2)).toEqual(['pr', 'create']);
    expect(r.task.approval!.status).toBe('approved');
    expect(r.task.approval!.decidedAt).toBe(T0 + 200);
  });

  it('批准 + includeClaim(决策项 6):gh issue comment 追加进固化命令集', () => {
    setupAwaitingTask();
    const { approval } = createPublishApproval(USER, validPack.taskId, T0 + 100)!;
    const r = resolvePublishApproval(USER, approval.approvalId, true, { includeClaim: true }, T0 + 200);
    expect(r.ok).toBe(true);
    const cmds = (r as any).task.approval.commands;
    expect(cmds).toHaveLength(3);
    expect(cmds[2]).toEqual({
      cmd: 'gh',
      args: ['issue', 'comment', 'https://github.com/owner/repo/issues/9', '--body', '我想认领这个 Issue(#9)。'],
    });
  });

  it('includeClaim 但任务包无 claimDraft → 不追加(不凭空造留言)', () => {
    const { code } = createPairCode(USER, T0);
    const r0 = redeemPairCode(code, meta, T0);
    if (!r0.ok) throw new Error('pair');
    enqueueTask(USER, { ...validPack, taskId: 'rtask_nc', claimDraft: undefined }, T0);
    claimNextTask(USER, r0.deviceId, T0 + 1);
    const ev = (n: number, type: string, payload?: Record<string, unknown>) => ({
      eventId: `e_${n}`, taskId: 'rtask_nc', deviceId: r0.deviceId, at: T0 + n, type, payload,
    });
    recordRunnerEvents(USER, r0.deviceId, [ev(1, 'state', { state: 'running' }), ev(2, 'state', { state: 'awaiting_approval' })], T0 + 5);
    const { approval } = createPublishApproval(USER, 'rtask_nc', T0 + 10)!;
    const r = resolvePublishApproval(USER, approval.approvalId, true, { includeClaim: true }, T0 + 20);
    expect((r as any).task.approval.commands).toHaveLength(2);
    expect((r as any).task.approval.includeClaim).toBe(false);
  });

  it('拒绝:审批单 rejected,任务留在 awaiting_approval(等 runner 上报 cancelled 确认)', () => {
    setupAwaitingTask();
    const { approval } = createPublishApproval(USER, validPack.taskId, T0 + 100)!;
    const r = resolvePublishApproval(USER, approval.approvalId, false, {}, T0 + 200);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.task.state).toBe('awaiting_approval');
    expect(r.task.approval!.status).toBe('rejected');
    expect(r.task.approval!.commands).toBeUndefined(); // 拒绝不固化任何命令
  });

  it('已裁决再裁决 → not_pending;未知 id → not_found(死卡不可复活)', () => {
    setupAwaitingTask();
    const { approval } = createPublishApproval(USER, validPack.taskId, T0 + 100)!;
    resolvePublishApproval(USER, approval.approvalId, true, {}, T0 + 200);
    expect(resolvePublishApproval(USER, approval.approvalId, false, {}, T0 + 300)).toEqual({ ok: false, error: 'not_pending' });
    expect(resolvePublishApproval(USER, 'rappr_nope', true, {}, T0)).toEqual({ ok: false, error: 'not_found' });
  });
});

describe('getDeviceActions(审批结果下行,状态推导幂等)', () => {
  it('finishing + approved → publish 动作(携带固化命令集);仅本设备', () => {
    setupAwaitingTask();
    const { approval } = createPublishApproval(USER, validPack.taskId, T0 + 100)!;
    resolvePublishApproval(USER, approval.approvalId, true, {}, T0 + 200);
    const actions = getDeviceActions(USER, deviceId);
    expect(actions).toHaveLength(1);
    expect(actions[0].kind).toBe('publish');
    expect(actions[0].taskId).toBe('rtask_p1');
    expect(actions[0].approvalId).toBe(approval.approvalId);
    expect(actions[0].commands).toHaveLength(2);
    expect(actions[0].repo).toBe('owner/repo');
    // 别的设备看不到(动作只下发给执行任务的那台)
    expect(getDeviceActions(USER, 'dev_other')).toHaveLength(0);
    // 状态未推进前,重复轮询幂等重发同一动作
    expect(getDeviceActions(USER, deviceId)).toHaveLength(1);
  });

  it('awaiting_approval + rejected → cancel 动作', () => {
    setupAwaitingTask();
    const { approval } = createPublishApproval(USER, validPack.taskId, T0 + 100)!;
    resolvePublishApproval(USER, approval.approvalId, false, {}, T0 + 200);
    const actions = getDeviceActions(USER, deviceId);
    expect(actions).toHaveLength(1);
    expect(actions[0].kind).toBe('cancel');
    expect(actions[0].commands).toBeUndefined();
  });

  it('runner 回流 done(prUrl)后动作清空;拒绝确认 cancelled 后同样清空', () => {
    setupAwaitingTask();
    const { approval } = createPublishApproval(USER, validPack.taskId, T0 + 100)!;
    resolvePublishApproval(USER, approval.approvalId, true, {}, T0 + 200);
    recordRunnerEvents(
      USER,
      deviceId,
      [
        { eventId: 'ev_p2', taskId: 'rtask_p1', deviceId, at: T0 + 300, type: 'phase2_result', payload: { prUrl: 'https://github.com/owner/repo/pull/7' } },
        { eventId: 'ev_done', taskId: 'rtask_p1', deviceId, at: T0 + 301, type: 'state', payload: { state: 'done' } },
      ],
      T0 + 300
    );
    const done = getRunnerTask(USER, 'rtask_p1', T0 + 400)!;
    expect(done.state).toBe('done');
    expect(done.prUrl).toBe('https://github.com/owner/repo/pull/7');
    expect(getDeviceActions(USER, deviceId)).toHaveLength(0);
  });
});

describe('listPendingRunnerApprovalRequests(服务重启后卡片重灌)', () => {
  it('pending 单在列;裁决后不在列', () => {
    setupAwaitingTask();
    createPublishApproval(USER, validPack.taskId, T0 + 100);
    const list = listPendingRunnerApprovalRequests(USER);
    expect(list).toHaveLength(1);
    expect(list[0].action).toBe('runner_publish');
    expect(list[0].userId).toBe(USER);
    resolvePublishApproval(USER, list[0].id, true, {}, T0 + 200);
    expect(listPendingRunnerApprovalRequests(USER)).toHaveLength(0);
  });
});

describe('经 fork 派发(viaFork):head 固化为 owner:branch + forkRepo 下行', () => {
  /** 配对(可带 ghLogin)→ 入队 viaFork 任务 → 领取 → 推进到 awaiting_approval(可带 phase1 forkRepo) */
  function setupForkTask(opts: { phase1ForkRepo?: string; deviceGhLogin?: string | null } = {}) {
    const devMeta: RunnerDeviceMeta = {
      ...meta,
      ...(opts.deviceGhLogin !== undefined ? { ghLogin: opts.deviceGhLogin } : {}),
    };
    const { code } = createPairCode(USER, T0);
    const r = redeemPairCode(code, devMeta, T0);
    if (!r.ok) throw new Error(`pair failed: ${r.error}`);
    const dev = r.deviceId;
    enqueueTask(USER, { ...validPack, viaFork: true }, T0);
    claimNextTask(USER, dev, T0 + 1);
    const ev = (n: number, type: string, payload?: Record<string, unknown>) => ({
      eventId: `ev_${n}`,
      taskId: validPack.taskId,
      deviceId: dev,
      at: T0 + 10 + n,
      type,
      payload,
    });
    recordRunnerEvents(
      USER,
      dev,
      [
        ev(1, 'state', { state: 'running' }),
        ev(2, 'phase1_result', {
          commitHash: 'abc123def456',
          prFinal: { title: 'fix: agent 终稿标题', body: '正文' },
          ...(opts.phase1ForkRepo !== undefined ? { forkRepo: opts.phase1ForkRepo } : {}),
        }),
        ev(3, 'state', { state: 'awaiting_approval' }),
      ],
      T0 + 20
    );
    return dev;
  }

  it('phase1_result 的 forkRepo 是事实源:审批卡带 fork 语境,批准后 push 形状不变、head=owner:branch,动作携 forkRepo', () => {
    const dev = setupForkTask({ phase1ForkRepo: 'tunsuy/repo' });
    const { approval, task } = createPublishApproval(USER, validPack.taskId, T0 + 100)!;
    const req = runnerApprovalToRequest(task, USER)!;
    const p = req.params as Record<string, any>;
    expect(p.forkRepo).toBe('tunsuy/repo');
    expect(req.description).toContain('经 fork tunsuy/repo');
    const previewPr = p.commands.find((c: any) => c.cmd === 'gh' && c.args[0] === 'pr');
    expect(previewPr.args[previewPr.args.indexOf('--head') + 1]).toBe('tunsuy:contrib/fix-9');
    // 显式 --repo 钉住上游:发布命令在 fork 克隆内执行(origin=fork),缺了它
    // gh 按 origin 解析缺省 base 仓,PR 会落进 fork 自己(线上真实踩过的坑)
    expect(previewPr.args.slice(0, 4)).toEqual(['pr', 'create', '--repo', 'owner/repo']);

    const r = resolvePublishApproval(USER, approval.approvalId, true, {}, T0 + 200);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const cmds = r.task.approval!.commands!;
    expect(cmds[0]).toEqual({ cmd: 'git', args: ['push', '-u', 'origin', 'contrib/fix-9'] }); // origin=fork 克隆,形状不变
    const prCmd = cmds.find((c) => c.cmd === 'gh' && c.args[0] === 'pr')!;
    expect(prCmd.args.slice(0, 4)).toEqual(['pr', 'create', '--repo', 'owner/repo']); // 固化同带 --repo 上游
    expect(prCmd.args[prCmd.args.indexOf('--head') + 1]).toBe('tunsuy:contrib/fix-9');
    expect(prCmd.args[prCmd.args.indexOf('--base') + 1]).toBe('main'); // base 仍是上游分支
    const actions = getDeviceActions(USER, dev);
    expect(actions[0].kind).toBe('publish');
    expect(actions[0].forkRepo).toBe('tunsuy/repo');
  });

  it('phase1 缺 forkRepo → 回退绑定设备 ghLogin 推算 fork 全名', () => {
    const dev = setupForkTask({ deviceGhLogin: 'tunsuy' });
    const { approval } = createPublishApproval(USER, validPack.taskId, T0 + 100)!;
    const r = resolvePublishApproval(USER, approval.approvalId, true, {}, T0 + 200);
    expect(r.ok).toBe(true);
    const cmds = (r as any).task.approval.commands as Array<{ cmd: string; args: string[] }>;
    const prCmd = cmds.find((c) => c.cmd === 'gh' && c.args[0] === 'pr')!;
    expect(prCmd.args[prCmd.args.indexOf('--head') + 1]).toBe('tunsuy:contrib/fix-9');
    expect(getDeviceActions(USER, dev)[0].forkRepo).toBe('tunsuy/repo');
  });

  it('两头都拿不到 fork 名 → head 退回裸分支、动作不带 forkRepo(gh 仍可从 fork 克隆的 origin 推断)', () => {
    const dev = setupForkTask({});
    const { approval, task } = createPublishApproval(USER, validPack.taskId, T0 + 100)!;
    const p = runnerApprovalToRequest(task, USER)!.params as Record<string, any>;
    expect(p.forkRepo).toBeUndefined();
    const r = resolvePublishApproval(USER, approval.approvalId, true, {}, T0 + 200);
    expect(r.ok).toBe(true);
    const cmds = (r as any).task.approval.commands as Array<{ cmd: string; args: string[] }>;
    const prCmd = cmds.find((c) => c.cmd === 'gh' && c.args[0] === 'pr')!;
    expect(prCmd.args[prCmd.args.indexOf('--head') + 1]).toBe('contrib/fix-9');
    // 拿不到 fork 名 → 无跨仓 head 可构造,保持 10 元直连旧形状(不带 --repo)
    expect(prCmd.args).not.toContain('--repo');
    expect(prCmd.args).toHaveLength(10);
    expect(getDeviceActions(USER, dev)[0].forkRepo).toBeUndefined();
  });
});

describe('PR 跟进任务(prFollowUp):审批卡语义 + push-only 固化命令(2026-10-20「响应 review」)', () => {
  const fuPack = {
    ...validPack,
    taskId: 'rtask_fu',
    prFollowUp: { prUrl: 'https://github.com/owner/repo/pull/77', baseTaskId: 'rtask_p1' },
  };

  function setupFollowUpAwaiting() {
    const { code } = createPairCode(USER, T0);
    const r = redeemPairCode(code, meta, T0);
    if (!r.ok) throw new Error(`pair failed: ${r.error}`);
    const dev = r.deviceId;
    enqueueTask(USER, fuPack, T0);
    claimNextTask(USER, dev, T0 + 1);
    const ev = (n: number, type: string, payload?: Record<string, unknown>) => ({
      eventId: `fu_ev_${n}`,
      taskId: fuPack.taskId,
      deviceId: dev,
      at: T0 + 10 + n,
      type,
      payload,
    });
    recordRunnerEvents(
      USER,
      dev,
      [
        ev(1, 'state', { state: 'running' }),
        ev(2, 'phase1_result', { commitHash: 'fed321', diffstat: ' src/b.py | 2 +-', testTail: 'PASSED' }),
        ev(3, 'state', { state: 'awaiting_approval' }),
      ],
      T0 + 20
    );
    return dev;
  }

  it('审批卡:描述含「PR 跟进…更新既有 PR」,params.followUpPrUrl,命令预览只有一条 git push', () => {
    setupFollowUpAwaiting();
    const { task } = createPublishApproval(USER, fuPack.taskId, T0 + 100)!;
    const req = runnerApprovalToRequest(task, USER)!;
    expect(req.description).toContain('PR 跟进');
    expect(req.description).toContain('更新既有 PR');
    expect((req.params as any).followUpPrUrl).toBe('https://github.com/owner/repo/pull/77');
    const cmds = (req.params as any).commands as Array<{ cmd: string; args: string[] }>;
    expect(cmds).toEqual([{ cmd: 'git', args: ['push', '-u', 'origin', 'contrib/fix-9'] }]);
  });

  it('批准 → 固化命令集仅 git push:不新建 PR,认领留言勾选也不追加', () => {
    setupFollowUpAwaiting();
    const { approval } = createPublishApproval(USER, fuPack.taskId, T0 + 100)!;
    const r = resolvePublishApproval(USER, approval.approvalId, true, { includeClaim: true }, T0 + 200);
    expect(r.ok).toBe(true);
    const t = (r as any).task;
    expect(t.state).toBe('finishing');
    expect(t.approval.commands).toEqual([{ cmd: 'git', args: ['push', '-u', 'origin', 'contrib/fix-9'] }]);
    // 设备动作下行同一份固化命令(runner 侧白名单形状 1 照认)
    const actions = getDeviceActions(USER, t.deviceId!);
    const pub = actions.find((a) => a.taskId === fuPack.taskId && a.kind === 'publish');
    expect(pub?.commands).toHaveLength(1);
  });

  it('phase2_result 无 prUrl(push-only 无 gh pr create 输出)→ 任务 prUrl 兜底任务包里的原 PR', () => {
    const dev = setupFollowUpAwaiting();
    const { approval } = createPublishApproval(USER, fuPack.taskId, T0 + 100)!;
    resolvePublishApproval(USER, approval.approvalId, true, {}, T0 + 200);
    recordRunnerEvents(
      USER,
      dev,
      [
        { eventId: 'fu_ev_9', taskId: fuPack.taskId, deviceId: dev, at: T0 + 300, type: 'phase2_result', payload: { approvalId: approval.approvalId } },
        { eventId: 'fu_ev_10', taskId: fuPack.taskId, deviceId: dev, at: T0 + 301, type: 'state', payload: { state: 'done' } },
      ],
      T0 + 310
    );
    const t = getRunnerTask(USER, fuPack.taskId, T0 + 400)!;
    expect(t.state).toBe('done');
    expect(t.prUrl).toBe('https://github.com/owner/repo/pull/77');
  });

  it('普通任务(无 prFollowUp)审批卡不受影响:描述照旧、无 followUpPrUrl、两条命令起步', () => {
    setupAwaitingTask();
    const { task } = createPublishApproval(USER, validPack.taskId, T0 + 100)!;
    const req = runnerApprovalToRequest(task, USER)!;
    expect(req.description).not.toContain('PR 跟进');
    expect((req.params as any).followUpPrUrl).toBeUndefined();
    expect((req.params as any).commands).toHaveLength(2);
  });
});
