import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  recordMissionStarted,
  recordMissionFinished,
  recordUsage,
  recordUserLogin,
  readOpsEvents,
  backfillOpsFromMissions,
  deriveOpsSource,
  __resetOpsLedgerForTests,
  __flushOpsWrites,
} from '../ops-ledger';

/**
 * 运营流水测试:USER_DATA_DIR 指向临时目录(与 artifact-files.test.ts 同款
 * 模式),用完即删,不碰真实用户数据。每个用例前后重置模块级状态
 * (路径缓存/降级标记/终态去重 Set)。
 */
let dataDir: string;
let savedEnv: string | undefined;

beforeEach(async () => {
  dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ops-ledger-test-'));
  savedEnv = process.env.USER_DATA_DIR;
  process.env.USER_DATA_DIR = dataDir;
  await __resetOpsLedgerForTests();
});

afterEach(async () => {
  await __resetOpsLedgerForTests();
  if (savedEnv === undefined) delete process.env.USER_DATA_DIR;
  else process.env.USER_DATA_DIR = savedEnv;
  await fsp.rm(dataDir, { recursive: true, force: true });
});

const ledgerFile = () => path.join(dataDir, 'ops', 'events.jsonl');

describe('deriveOpsSource(纯函数)', () => {
  it('显式 channel 优先于其他标记', () => {
    expect(deriveOpsSource({ source: 'channel', cronJobId: 'c1', workshopId: 'w1' })).toBe('channel');
  });
  it('cronJobId → cron', () => {
    expect(deriveOpsSource({ cronJobId: 'c1' })).toBe('cron');
  });
  it('parentMissionId → background', () => {
    expect(deriveOpsSource({ parentMissionId: 'm1' })).toBe('background');
  });
  it('workshopId → workshop', () => {
    expect(deriveOpsSource({ workshopId: 'w1' })).toBe('workshop');
  });
  it('无标记 → chat', () => {
    expect(deriveOpsSource({})).toBe('chat');
  });
  it('优先级:cron > background > workshop', () => {
    expect(deriveOpsSource({ cronJobId: 'c1', parentMissionId: 'm1', workshopId: 'w1' })).toBe('cron');
    expect(deriveOpsSource({ parentMissionId: 'm1', workshopId: 'w1' })).toBe('background');
  });
});

describe('追加与读取', () => {
  it('四类事件写入后 readOpsEvents 按时间升序返回', async () => {
    const t0 = 1_700_000_000_000;
    recordUserLogin({ userId: 'usr_a', name: 'Alice', email: 'Alice@Example.com', provider: 'google' });
    recordMissionStarted({ missionId: 'm1', userId: 'usr_a', source: 'chat', at: t0 });
    recordUsage({ missionId: 'm1', userId: 'usr_a', promptTokens: 100, completionTokens: 50, at: t0 + 1000 });
    recordMissionFinished({ missionId: 'm1', userId: 'usr_a', outcome: 'done', durationMs: 5000, stepCount: 3, at: t0 + 2000 });
    await __flushOpsWrites();

    const events = readOpsEvents();
    expect(events.length).toBe(4);
    // 排序稳定:at 升序(login 无显式 at = Date.now(),远大于 t0,排最后)
    expect(events[0]).toMatchObject({ t: 'mission_started', missionId: 'm1', source: 'chat', at: t0 });
    expect(events[1]).toMatchObject({ t: 'usage', promptTokens: 100, completionTokens: 50 });
    expect(events[2]).toMatchObject({ t: 'mission_finished', outcome: 'done', durationMs: 5000, stepCount: 3 });
    expect(events[3]).toMatchObject({ t: 'user_login', userId: 'usr_a', name: 'Alice', email: 'alice@example.com' });
  });

  it('缺 userId/missionId 的事件被拒绝(不入账)', async () => {
    recordMissionStarted({ missionId: '', userId: 'usr_a', source: 'chat' });
    recordMissionStarted({ missionId: 'm1', userId: undefined, source: 'chat' });
    recordUsage({ missionId: 'm1', userId: 'usr_a', promptTokens: 0, completionTokens: 0 });
    await __flushOpsWrites();
    expect(readOpsEvents()).toEqual([]);
  });

  it('usage 负数/NaN 归零,全零跳过', async () => {
    recordUsage({ missionId: 'm1', userId: 'usr_a', promptTokens: NaN, completionTokens: 30 });
    await __flushOpsWrites();
    const events = readOpsEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ t: 'usage', promptTokens: 0, completionTokens: 30 });
  });

  it('同一 mission 多次 finished 只记第一条(进程级去重)', async () => {
    recordMissionFinished({ missionId: 'm1', userId: 'usr_a', outcome: 'aborted', durationMs: 1, stepCount: 1 });
    recordMissionFinished({ missionId: 'm1', userId: 'usr_a', outcome: 'failed', durationMs: 1, stepCount: 1 });
    await __flushOpsWrites();
    const finished = readOpsEvents().filter((e) => e.t === 'mission_finished');
    expect(finished).toHaveLength(1);
    expect(finished[0]).toMatchObject({ outcome: 'aborted' });
  });

  it('读取时跳过损坏行', async () => {
    recordMissionStarted({ missionId: 'm1', userId: 'usr_a', source: 'chat' });
    await __flushOpsWrites();
    fs.appendFileSync(ledgerFile(), 'not-json{{{\n', 'utf-8');
    recordMissionStarted({ missionId: 'm2', userId: 'usr_a', source: 'chat' });
    await __flushOpsWrites();
    const events = readOpsEvents();
    expect(events.map((e: any) => e.missionId)).toEqual(['m1', 'm2']);
  });
});

describe('滚动(10MB 保留一代)', () => {
  it('超限后旧内容滚到 .jsonl.1,新事件写当前文件,读取合并两代', async () => {
    fs.mkdirSync(path.join(dataDir, 'ops'), { recursive: true });
    // 预置一个略超 10MB 的旧文件(直接写盘,不经 writeChain)
    const filler = JSON.stringify({ t: 'usage', at: 1, missionId: 'old', userId: 'usr_old', promptTokens: 1, completionTokens: 1 }) + '\n';
    const lines = Math.ceil((10 * 1024 * 1024 + 1) / filler.length);
    fs.writeFileSync(ledgerFile(), filler.repeat(lines), 'utf-8');

    recordMissionStarted({ missionId: 'new1', userId: 'usr_a', source: 'chat' });
    await __flushOpsWrites();

    expect(fs.existsSync(`${ledgerFile()}.1`)).toBe(true);
    const current = fs.readFileSync(ledgerFile(), 'utf-8').trim().split('\n');
    expect(current).toHaveLength(1);
    expect(JSON.parse(current[0])).toMatchObject({ t: 'mission_started', missionId: 'new1' });

    // readOpsEvents 合并两代(旧代 at=1 排最前)
    const events = readOpsEvents();
    expect(events.length).toBe(lines + 1);
    expect(events[0].at).toBe(1);
    expect(events[events.length - 1]).toMatchObject({ missionId: 'new1' });
  });
});

describe('历史回灌 backfillOpsFromMissions', () => {
  const users = () => [
    {
      userId: 'usr_a',
      missions: [
        {
          id: 'm1',
          status: 'DONE',
          startedAt: 1_700_000_000_000,
          steps: [{ id: 's1' }, { id: 's2' }],
          usage: { promptTokens: 120, completionTokens: 30 },
          cronJobId: 'cron_1',
        },
        { id: 'm2', status: 'ACTIVE', startedAt: 1_700_000_100_000, steps: [] },
      ],
    },
    { userId: 'usr_b', missions: [{ id: 'm3', status: 'INTERRUPTED', startedAt: 1_700_000_200_000, stepCount: 5 }] },
  ];

  it('按 mission 状态补写 started/usage/finished,cron 来源正确', async () => {
    const written = backfillOpsFromMissions({ getAllUsersData: users as any });
    await __flushOpsWrites();
    // m1: started+usage+finished=3;m2: started=1(ACTIVE 无终态);m3: started+finished=2
    expect(written).toBe(6);
    const events = readOpsEvents();
    expect(events).toHaveLength(6);

    const m1Started = events.find((e: any) => e.t === 'mission_started' && e.missionId === 'm1') as any;
    expect(m1Started).toMatchObject({ source: 'cron', cronJobId: 'cron_1', at: 1_700_000_000_000 });
    const m1Finished = events.find((e: any) => e.t === 'mission_finished' && e.missionId === 'm1') as any;
    expect(m1Finished).toMatchObject({ outcome: 'done', stepCount: 2, durationMs: 0 });
    const m2Events = events.filter((e: any) => e.missionId === 'm2');
    expect(m2Events).toHaveLength(1); // ACTIVE 只补 started
    const m3Finished = events.find((e: any) => e.t === 'mission_finished' && e.missionId === 'm3') as any;
    expect(m3Finished).toMatchObject({ outcome: 'interrupted', stepCount: 5 });
  });

  it('标记文件防重入:第二次回灌返回 0', async () => {
    backfillOpsFromMissions({ getAllUsersData: users as any });
    await __flushOpsWrites();
    expect(fs.existsSync(path.join(dataDir, 'ops', '.backfilled'))).toBe(true);
    const second = backfillOpsFromMissions({ getAllUsersData: users as any });
    await __flushOpsWrites();
    expect(second).toBe(0);
    expect(readOpsEvents()).toHaveLength(6);
  });

  it('与启动清扫去重:同 mission 已记终态则回灌不双记', async () => {
    // 模拟 sweepInterruptedMissions 先入账(重启清扫)
    recordMissionFinished({ missionId: 'm3', userId: 'usr_b', outcome: 'interrupted', durationMs: 0, stepCount: 4 });
    await __flushOpsWrites();
    backfillOpsFromMissions({ getAllUsersData: users as any });
    await __flushOpsWrites();
    const m3Finished = readOpsEvents().filter((e: any) => e.t === 'mission_finished' && e.missionId === 'm3');
    expect(m3Finished).toHaveLength(1);
    expect(m3Finished[0]).toMatchObject({ stepCount: 4 }); // 先到的 sweep 版本胜出
  });
});
