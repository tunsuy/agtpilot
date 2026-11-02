import { describe, it, expect } from 'vitest';
import { aggregateOps, opsDayKey } from '../ops-aggregate';
import type { OpsEvent } from '../ops-ledger';

/**
 * 聚合纯函数测试:全部用「本地时区构造」的固定日期(new Date(y, m, d) 无
 * 时区歧义),防跑测试的机器时区不同导致日分桶抖动。
 */
const NOW = new Date(2026, 10, 15, 12, 0, 0).getTime(); // 2026-11-15 正午(本地)
const DAY = 24 * 60 * 60 * 1000;

function localTs(daysAgo: number, hour = 10): number {
  const d = new Date(2026, 10, 15 - daysAgo, hour, 0, 0);
  return d.getTime();
}

function started(missionId: string, userId: string, at: number, source = 'chat'): OpsEvent {
  return { t: 'mission_started', at, missionId, userId, source } as OpsEvent;
}
function finished(missionId: string, userId: string, at: number, outcome: 'done' | 'failed' | 'aborted' | 'interrupted'): OpsEvent {
  return { t: 'mission_finished', at, missionId, userId, outcome, durationMs: 1000, stepCount: 2 } as OpsEvent;
}
function usage(missionId: string, userId: string, at: number, p: number, c: number): OpsEvent {
  return { t: 'usage', at, missionId, userId, promptTokens: p, completionTokens: c } as OpsEvent;
}
function login(userId: string, at: number, name?: string, email?: string): OpsEvent {
  return { t: 'user_login', at, userId, name, email } as OpsEvent;
}

describe('opsDayKey', () => {
  it('本地时区 YYYY-MM-DD,补零', () => {
    expect(opsDayKey(new Date(2026, 0, 5, 23, 59).getTime())).toBe('2026-01-05');
    expect(opsDayKey(NOW)).toBe('2026-11-15');
  });
});

describe('aggregateOps', () => {
  it('空流水:30 个补零日桶 + 空用户表 + 零 totals', () => {
    const r = aggregateOps([], NOW, 30);
    expect(r.daily).toHaveLength(30);
    expect(r.daily[29].date).toBe('2026-11-15');
    expect(r.daily[0].date).toBe('2026-10-17');
    expect(r.daily.every((d) => d.missions === 0 && d.activeUsers === 0 && d.tokens === 0 && d.failures === 0)).toBe(true);
    expect(r.users).toEqual([]);
    expect(r.totals).toMatchObject({ users: 0, windowMissions: 0, windowTokens: 0, windowFailures: 0, todayMissions: 0, todayActiveUsers: 0, todayTokens: 0, todayFailures: 0 });
    expect(r.bySource).toEqual({ chat: 0, workshop: 0, cron: 0, channel: 0, background: 0 });
    expect(r.byOutcome).toEqual({ done: 0, failed: 0, aborted: 0, interrupted: 0 });
  });

  it('日分桶:事件落进正确的日期桶,窗口外事件不进 daily', () => {
    const events: OpsEvent[] = [
      started('m1', 'usr_a', localTs(2), 'chat'),
      started('m2', 'usr_a', localTs(0), 'workshop'),
      started('old', 'usr_a', localTs(40), 'chat'), // 窗口外(>30 天)
    ];
    const r = aggregateOps(events, NOW, 30);
    const today = r.daily.find((d) => d.date === '2026-11-15')!;
    const twoDaysAgo = r.daily.find((d) => d.date === '2026-11-13')!;
    expect(today.missions).toBe(1);
    expect(twoDaysAgo.missions).toBe(1);
    expect(r.totals.windowMissions).toBe(2); // 窗口外不计
    // 但用户表按全量流水:usr_a 累计 3 个任务,firstSeen 是窗口外那条
    expect(r.users[0]).toMatchObject({ userId: 'usr_a', missions: 3, firstSeen: localTs(40) });
  });

  it('DAU:当日有 started/usage 的去重用户数;user_login 不计', () => {
    const at = localTs(0);
    const events: OpsEvent[] = [
      started('m1', 'usr_a', at),
      started('m2', 'usr_a', at + 1000), // 同用户同日多任务 → 仍 1
      usage('m3', 'usr_b', at + 2000, 10, 5), // usr_b 只有 usage 也算活跃
      login('usr_c', at + 3000), // 只登录 → 不算活跃,但计入总用户
    ];
    const r = aggregateOps(events, NOW, 30);
    expect(r.daily[29].activeUsers).toBe(2);
    expect(r.totals.todayActiveUsers).toBe(2);
    expect(r.totals.users).toBe(3);
    expect(r.totals.windowActiveUsers).toBe(2);
  });

  it('tokens 汇总(窗口/今日/用户级)', () => {
    const events: OpsEvent[] = [
      usage('m1', 'usr_a', localTs(0), 100, 50),
      usage('m1', 'usr_a', localTs(0), 200, 0, ),
      usage('m2', 'usr_a', localTs(31), 999, 999), // 窗口外
    ];
    const r = aggregateOps(events, NOW, 30);
    expect(r.daily[29].tokens).toBe(350);
    expect(r.totals.todayTokens).toBe(350);
    expect(r.totals.windowTokens).toBe(350);
    expect(r.users[0].tokens).toBe(350 + 1998); // 用户表全量
  });

  it('失败率口径:只有 failed 计失败,byOutcome 全结局分列(窗口内)', () => {
    const at = localTs(0);
    const events: OpsEvent[] = [
      started('m1', 'usr_a', at), finished('m1', 'usr_a', at + 1, 'done'),
      started('m2', 'usr_a', at + 2), finished('m2', 'usr_a', at + 3, 'failed'),
      started('m3', 'usr_a', at + 4), finished('m3', 'usr_a', at + 5, 'aborted'),
      started('m4', 'usr_a', at + 6), finished('m4', 'usr_a', at + 7, 'interrupted'),
    ];
    const r = aggregateOps(events, NOW, 30);
    expect(r.daily[29].failures).toBe(1);
    expect(r.totals.windowFailures).toBe(1);
    expect(r.totals.todayFailures).toBe(1);
    expect(r.byOutcome).toEqual({ done: 1, failed: 1, aborted: 1, interrupted: 1 });
    expect(r.users[0].failed).toBe(1);
  });

  it('bySource 窗口内计数,来源全枚举', () => {
    const at = localTs(1);
    const events: OpsEvent[] = [
      started('m1', 'usr_a', at, 'chat'),
      started('m2', 'usr_a', at, 'cron'),
      started('m3', 'usr_b', at, 'channel'),
      started('m4', 'usr_b', localTs(40), 'workshop'), // 窗口外
    ];
    const r = aggregateOps(events, NOW, 30);
    expect(r.bySource).toMatchObject({ chat: 1, cron: 1, channel: 1, workshop: 0 });
  });

  it('用户表:name/email 取最近一次登录,按 lastActive 降序', () => {
    const events: OpsEvent[] = [
      login('usr_a', localTs(5), 'OldName', 'old@a.com'),
      login('usr_a', localTs(0), 'NewName', 'new@a.com'),
      started('m1', 'usr_b', localTs(2)),
      login('usr_b', localTs(2), 'B'),
    ];
    const r = aggregateOps(events, NOW, 30);
    expect(r.users.map((u) => u.userId)).toEqual(['usr_a', 'usr_b']); // a 最近活跃=今天
    expect(r.users[0]).toMatchObject({ name: 'NewName', email: 'new@a.com' });
    expect(r.users[1].name).toBe('B');
    expect(r.users[1].email).toBeUndefined();
  });

  it('mission_started 去重:同 missionId 双记只算一次', () => {
    const at = localTs(0);
    const events: OpsEvent[] = [
      started('m1', 'usr_a', at),
      started('m1', 'usr_a', at + 1),
    ];
    const r = aggregateOps(events, NOW, 30);
    expect(r.totals.windowMissions).toBe(1);
    expect(r.daily[29].missions).toBe(1);
    expect(r.users[0].missions).toBe(1);
  });

  it('days 参数:窗口长度;非法值(0)回退缺省 30', () => {
    const r7 = aggregateOps([], NOW, 7);
    expect(r7.daily).toHaveLength(7);
    expect(r7.daily[0].date).toBe('2026-11-09');
    // 实现口径:Math.round(days) || 30 → 0 回退 30(与路由侧缺省一致)
    const rZero = aggregateOps([], NOW, 0);
    expect(rZero.daily).toHaveLength(30);
  });

  it('未来时间戳事件(at > nowMs)不进窗口', () => {
    const events: OpsEvent[] = [started('m1', 'usr_a', NOW + DAY)];
    const r = aggregateOps(events, NOW, 30);
    expect(r.totals.windowMissions).toBe(0);
    expect(r.users[0].missions).toBe(1); // 用户表仍如实记录
  });
});
