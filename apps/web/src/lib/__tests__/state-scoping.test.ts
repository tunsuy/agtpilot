import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * state-scoping 用例:SSE init / state 兜底接口共用的「按连接用户隔离」投影。
 * 重点钉死跨用户不泄露(terminalLogs/viewport/latestArtifact/建议卡/问题卡)
 * 与 userId 回显(客户端 SSE 挂载即连的对账依据)。
 *
 * 环境隔离:USER_DATA_DIR 指向一次性临时目录(getUserMissions 读盘路径)。
 */

let buildUserScopedState: typeof import('../state-scoping')['buildUserScopedState'];
let tmpDir: string;

const mkMission = (over: any = {}) => ({
  id: 'm1',
  userId: 'u_a',
  title: '任务A',
  status: 'DONE',
  progress: 100,
  startedAt: 1,
  steps: [{ id: 's1', title: '步骤', status: 'DONE' }],
  conversationMessages: [{ role: 'user', content: 'hi' }],
  ...over,
});

const mkState = (over: any = {}) => ({
  missions: [],
  activeMissionId: null,
  viewport: { activeTab: 'browser', url: 'https://secret.example', title: 'S', status: 'idle' },
  terminalLogs: [],
  approvalRequests: [],
  connectorSuggestions: [],
  pendingQuestions: [],
  ...over,
});

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agtpilot-state-scoping-'));
  process.env.USER_DATA_DIR = tmpDir;
  ({ buildUserScopedState } = await import('../state-scoping'));
});

beforeEach(() => {
  // 清掉 user-store 读缓存目录里的持久化任务,避免用例互相污染
  fs.rmSync(path.join(tmpDir, 'v2'), { recursive: true, force: true });
});

describe('buildUserScopedState', () => {
  it('匿名连接:空投影 + userId=null,不带任何用户数据', () => {
    const out = buildUserScopedState(
      mkState({
        missions: [mkMission()],
        terminalLogs: [{ id: 't1', timestamp: 1, type: 'stdout', text: 'secret', userId: 'u_a' }],
        latestArtifact: { taskId: 'm1', content: 'A 的交付物全文' },
      }),
      undefined
    );
    expect(out.userId).toBeNull();
    expect(out.missions).toEqual([]);
    expect(out.terminalLogs).toEqual([]);
    expect(out.approvalRequests).toEqual([]);
    expect(out.connectorSuggestions).toEqual([]);
    expect(out.pendingQuestions).toEqual([]);
    expect(out.latestArtifact).toBeUndefined();
    // 空白视口兜底(不泄露占用者画面)
    expect(out.viewport.url).toBe('about:blank');
    // 内部字段不下发
    expect((out as any).viewportUserId).toBeUndefined();
  });

  it('他人数据全隔离:mission/日志/审批/建议卡/问题卡/产物', () => {
    const out = buildUserScopedState(
      mkState({
        missions: [
          mkMission({ id: 'ma', userId: 'u_a' }),
          mkMission({ id: 'mb', userId: 'u_b', title: 'B 的任务' }),
        ],
        activeMissionId: 'ma',
        terminalLogs: [
          { id: 't1', timestamp: 1, type: 'stdout', text: 'A 的日志', userId: 'u_a' },
          { id: 't2', timestamp: 2, type: 'stdout', text: 'B 的日志', userId: 'u_b' },
          { id: 't3', timestamp: 3, type: 'system', text: '全局系统日志' },
        ],
        approvalRequests: [
          { id: 'ap1', userId: 'u_a' } as any,
          { id: 'ap2', userId: 'u_b' } as any,
        ],
        connectorSuggestions: [{ id: 'u_a::github' } as any, { id: 'u_b::gmail' } as any],
        pendingQuestions: [{ id: 'q0', userId: 'u_a' } as any, { id: 'q1', userId: 'u_b' } as any],
        latestArtifact: { taskId: 'ma', content: 'A 的交付物' },
      }),
      'u_b'
    );
    expect(out.userId).toBe('u_b');
    // 内存 active mission 只留本人(B 的 mb);A 的 ma 不出现
    expect(out.missions.map((m: any) => m.id)).toEqual(['mb']);
    expect(out.activeMissionId).toBe('mb'); // ma 不属于 B,回落到 B 列表头
    // 终端日志:本人(t2 属 u_b) + 未标 userId 的全局系统条目;u_a 的 t1 隔离
    expect(out.terminalLogs.map((l: any) => l.id)).toEqual(['t2', 't3']);
    expect(out.approvalRequests.map((r: any) => r.id)).toEqual(['ap2']);
    expect(out.connectorSuggestions.map((s: any) => s.id)).toEqual(['u_b::gmail']);
    expect(out.pendingQuestions.map((q: any) => q.id)).toEqual(['q1']);
    // latestArtifact 归属 u_a → 不下发给 u_b
    expect(out.latestArtifact).toBeUndefined();
  });

  it('本人产物按 taskId 归属下发;归属不明(孤儿)不下发', () => {
    const owned = buildUserScopedState(
      mkState({
        missions: [mkMission({ id: 'ma', userId: 'u_a' })],
        latestArtifact: { taskId: 'ma', content: 'A 的交付物' },
      }),
      'u_a'
    );
    expect(owned.latestArtifact).toEqual({ taskId: 'ma', content: 'A 的交付物' });

    const orphan = buildUserScopedState(
      mkState({ latestArtifact: { content: '没有 taskId 的孤儿产物' } }),
      'u_a'
    );
    expect(orphan.latestArtifact).toBeUndefined();
  });

  it('视口:本人占用下发真实画面,他人占用给空白默认', () => {
    const realViewport = { activeTab: 'browser' as const, url: 'https://x.example', title: 'X', status: 'idle' as const };
    const mine = buildUserScopedState(
      mkState({ viewport: realViewport, viewportUserId: 'u_a' }),
      'u_a'
    );
    expect(mine.viewport).toEqual(realViewport);

    const others = buildUserScopedState(
      mkState({ viewport: realViewport, viewportUserId: 'u_b' }),
      'u_a'
    );
    expect(others.viewport.url).toBe('about:blank');
  });

  it('终态历史会话进摘要(stripped),conversationMessages 一律不下发', () => {
    const out = buildUserScopedState(
      mkState({ missions: [mkMission({ id: 'ma', userId: 'u_a', status: 'DONE' })] }),
      'u_a'
    );
    // getUserMissions 读盘为空(临时目录),仅内存 mission 参与投影
    const wire = out.missions[0];
    expect(wire.stripped).toBe(true);
    expect(wire.steps).toEqual([]);
    expect((wire as any).conversationMessages).toBeUndefined();
  });
});
