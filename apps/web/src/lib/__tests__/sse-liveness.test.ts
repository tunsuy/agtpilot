import { describe, it, expect } from 'vitest';
import { isZombieSse, SSE_HEARTBEAT_MS, SSE_STALE_MS } from '../sse-liveness';

const OPEN = 1;
const CONNECTING = 0;
const CLOSED = 2;

describe('SSE 心跳阈值常量', () => {
  it('静默阈值 ≥ 2 个心跳周期(太紧会把正常的调度抖动误判成假死)', () => {
    expect(SSE_STALE_MS).toBeGreaterThanOrEqual(SSE_HEARTBEAT_MS * 2);
  });
});

describe('isZombieSse 假死判定', () => {
  it('OPEN 且超过静默阈值 → 假死(生产实测:连接半死不触发 onerror,必须自愈)', () => {
    expect(
      isZombieSse({ readyState: OPEN, lastAliveAt: 1_000_000, now: 1_000_000 + SSE_STALE_MS + 1 })
    ).toBe(true);
  });

  it('OPEN 但静默未超阈值 → 不动(正常心跳节奏内的安静不是假死)', () => {
    expect(
      isZombieSse({ readyState: OPEN, lastAliveAt: 1_000_000, now: 1_000_000 + SSE_STALE_MS })
    ).toBe(false);
    expect(
      isZombieSse({ readyState: OPEN, lastAliveAt: 1_000_000, now: 1_000_000 + 30_000 })
    ).toBe(false);
  });

  it('CONNECTING → 不判假死(EventSource 自带退避重试,看门狗不掺和)', () => {
    expect(
      isZombieSse({ readyState: CONNECTING, lastAliveAt: 1_000_000, now: 1_000_000 + SSE_STALE_MS * 3 })
    ).toBe(false);
  });

  it('CLOSED → 不判假死(主动关闭的连接无需自愈)', () => {
    expect(
      isZombieSse({ readyState: CLOSED, lastAliveAt: 1_000_000, now: 1_000_000 + SSE_STALE_MS * 3 })
    ).toBe(false);
  });

  it('支持自定义阈值(事件频繁的长连接可以配更宽的窗口)', () => {
    expect(
      isZombieSse({ readyState: OPEN, lastAliveAt: 1_000_000, now: 1_000_000 + 5_000, staleMs: 4_000 })
    ).toBe(true);
  });
});
