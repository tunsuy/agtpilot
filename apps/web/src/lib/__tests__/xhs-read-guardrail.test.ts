import { describe, it, expect, afterEach } from 'vitest';
import {
  ReadGuardrail,
  buildXhsReadGuardrail,
  computeReadWaitMs,
  readGuardrailLimits,
} from '../xhs-read-guardrail';

afterEach(() => {
  buildXhsReadGuardrail().reset();
  delete process.env.AGTPILOT_XHS_READ_PER_MISSION;
  delete process.env.AGTPILOT_XHS_READ_MIN_INTERVAL_MS;
});

describe('readGuardrailLimits · env 配置', () => {
  it('缺省:每任务 8 次、最小间隔 3s', () => {
    const limits = readGuardrailLimits();
    expect(limits.perMission).toBe(8);
    expect(limits.minIntervalMs).toBe(3000);
  });

  it('env 可调(AGTPILOT_XHS_READ_PER_MISSION / MIN_INTERVAL_MS)', () => {
    process.env.AGTPILOT_XHS_READ_PER_MISSION = '3';
    process.env.AGTPILOT_XHS_READ_MIN_INTERVAL_MS = '500';
    const limits = readGuardrailLimits();
    expect(limits.perMission).toBe(3);
    expect(limits.minIntervalMs).toBe(500);
  });

  it('非法 env 值回退缺省', () => {
    process.env.AGTPILOT_XHS_READ_PER_MISSION = 'abc';
    process.env.AGTPILOT_XHS_READ_MIN_INTERVAL_MS = '-1';
    const limits = readGuardrailLimits();
    expect(limits.perMission).toBe(8);
    expect(limits.minIntervalMs).toBe(3000);
  });
});

describe('computeReadWaitMs · 纯函数三态', () => {
  it('从未读过 → 0', () => {
    expect(computeReadWaitMs(undefined, 1000, 3000)).toBe(0);
  });

  it('间隔已满足 → 0', () => {
    expect(computeReadWaitMs(1000, 4000, 3000)).toBe(0);
  });

  it('间隔未满足 → 剩余毫秒', () => {
    expect(computeReadWaitMs(1000, 2000, 3000)).toBe(2000);
  });
});

describe('ReadGuardrail · 每任务上限', () => {
  it('默认上限 8:第 9 次拒绝,拒绝理由要求基于已有资料继续', () => {
    const g = new ReadGuardrail({ perMission: 8, minIntervalMs: 0 });
    for (let i = 0; i < 8; i++) {
      const check = g.check('m1', 'u1', 1000 + i);
      expect(check.allowed).toBe(true);
      g.record('m1', 'u1', 1000 + i);
    }
    const ninth = g.check('m1', 'u1', 9999);
    expect(ninth.allowed).toBe(false);
    if (!ninth.allowed) {
      expect(ninth.used).toBe(8);
      expect(ninth.cap).toBe(8);
      expect(ninth.reason).toContain('基于已读取的资料');
      expect(ninth.reason).toContain('不要');
    }
  });

  it('上限按任务隔离:m1 烧完不影响 m2', () => {
    const g = new ReadGuardrail({ perMission: 1, minIntervalMs: 0 });
    g.record('m1', 'u1', 1000);
    expect(g.check('m1', 'u1', 2000).allowed).toBe(false);
    expect(g.check('m2', 'u1', 2000).allowed).toBe(true);
  });

  it('check 不记账(被拒不烧上限;登录门在 check 与 record 之间同样不烧)', () => {
    const g = new ReadGuardrail({ perMission: 2, minIntervalMs: 0 });
    // 连续 check 10 次不 record,计数应仍为 0
    for (let i = 0; i < 10; i++) g.check('m1', 'u1', i);
    expect(g.check('m1', 'u1', 999).used).toBe(0);
  });

  it('taskId 缺失归并到 adhoc 桶', () => {
    const g = new ReadGuardrail({ perMission: 1, minIntervalMs: 0 });
    g.record(undefined, 'u1', 1000);
    expect(g.check(undefined, 'u1', 2000).allowed).toBe(false);
    expect(g.check(undefined, 'u1', 2000).used).toBe(1);
  });
});

describe('ReadGuardrail · 同用户节流', () => {
  it('间隔内再读 → waitMs>0 但仍 allowed(节流不拒绝)', () => {
    const g = new ReadGuardrail({ perMission: 8, minIntervalMs: 3000 });
    g.record('m1', 'u1', 1000);
    const check = g.check('m2', 'u1', 2000);
    expect(check.allowed).toBe(true);
    if (check.allowed) expect(check.waitMs).toBe(2000);
  });

  it('节流按用户隔离:另一用户不受影响', () => {
    const g = new ReadGuardrail({ perMission: 8, minIntervalMs: 3000 });
    g.record('m1', 'u1', 1000);
    const check = g.check('m2', 'u2', 2000);
    expect(check.allowed).toBe(true);
    if (check.allowed) expect(check.waitMs).toBe(0);
  });
});

describe('ReadGuardrail · Map 滚动清理', () => {
  it('超过 64 个任务键后逐出最旧(不无限增长)', () => {
    const g = new ReadGuardrail({ perMission: 100, minIntervalMs: 0 });
    for (let i = 0; i < 70; i++) g.record(`m${i}`, `u${i}`, 1000 + i);
    // m0..m5 应被逐出(used 回到 0),m69 仍在
    expect(g.check('m0', 'x', 9999).used).toBe(0);
    expect(g.check('m69', 'x', 9999).used).toBe(1);
  });
});

describe('buildXhsReadGuardrail · 单例', () => {
  it('同进程返回同一实例(reset 可清)', () => {
    const a = buildXhsReadGuardrail();
    const b = buildXhsReadGuardrail();
    expect(a).toBe(b);
    a.record('solo', 'solo-user', 1000);
    expect(buildXhsReadGuardrail().check('solo', 'x', 9999).used).toBe(1);
    a.reset();
    expect(buildXhsReadGuardrail().check('solo', 'x', 9999).used).toBe(0);
  });
});
