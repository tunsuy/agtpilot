import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * mission/[id] 懒回水路由的分片(parts)契约:
 * - core(缺省):终态会话剥右栏重字段(terminalLogs/viewport),长交付物
 *   降级摘要投影,parts 标记声明各分片是否在位;活跃会话仍回全量。
 * - ?parts=…:只回请求的分片 + 就位标记(前端合并进会话对象)。
 * - 归属校验:内存/持久化两路都只回本人会话。
 *
 * 路由是薄胶水(mock auth/backend/store),投影规则本体在 lib/mission-wire
 * (mission-wire.test.ts 钉死);这里钉的是「路由怎么组合它们」。
 */

vi.mock('@/auth', () => ({ auth: vi.fn() }));
vi.mock('@/lib/agent-backend', () => ({ getAgentBackend: vi.fn() }));
vi.mock('@/lib/user-store', () => ({ getUserMissions: vi.fn(() => []) }));

import { auth } from '@/auth';
import { getAgentBackend } from '@/lib/agent-backend';
import { getUserMissions } from '@/lib/user-store';
import { GET } from '@/app/api/agent/mission/[id]/route';
import { ARTIFACT_EXCERPT_CHARS } from '@/lib/mission-wire';

const LONG = '章'.repeat(ARTIFACT_EXCERPT_CHARS + 500);

const mkMission = (over: any = {}) => ({
  id: 'm1',
  userId: 'u_a',
  title: '日更任务',
  status: 'DONE',
  progress: 100,
  startedAt: 1,
  steps: [{ id: 's1', title: '写作', status: 'DONE' }],
  conversationMessages: [{ role: 'user', content: 'hi' }],
  terminalLogs: [{ id: 't1', timestamp: 1, type: 'stdout', text: 'log' }],
  viewport: { activeTab: 'browser', url: 'https://a.b', screenshotBase64: 'AAAA' },
  artifact: { title: '章节', type: 'markdown', content: LONG, taskId: 'm1' },
  ...over,
});

const call = async (id: string, query = '') => {
  const req = new Request(`http://test/api/agent/mission/${id}${query}`);
  const res = await GET(req, { params: Promise.resolve({ id }) } as any);
  return { status: res.status, body: await res.json() };
};

beforeEach(() => {
  vi.mocked(auth).mockResolvedValue({ user: { id: 'u_a' } } as any);
  vi.mocked(getAgentBackend).mockReturnValue({ state: { missions: [] } } as any);
  vi.mocked(getUserMissions).mockReturnValue([]);
});

describe('mission/[id] 鉴权与归属', () => {
  it('未登录 → 401', async () => {
    vi.mocked(auth).mockResolvedValue(null as any);
    expect((await call('m1')).status).toBe(401);
  });

  it('他人会话(内存/持久化都查无本人记录)→ 404', async () => {
    vi.mocked(getAgentBackend).mockReturnValue({
      state: { missions: [mkMission({ userId: 'u_b' })] },
    } as any);
    expect((await call('m1')).status).toBe(404);
  });

  it('持久化库兜底命中本人历史会话', async () => {
    vi.mocked(getUserMissions).mockReturnValue([mkMission()]);
    const { status, body } = await call('m1');
    expect(status).toBe(200);
    expect(body.mission.id).toBe('m1');
  });
});

describe('core 缺省档:终态剥重字段 + 摘要投影 + parts 标记', () => {
  it('终态会话:steps 保留,terminalLogs/viewport/conversationMessages 不下发', async () => {
    vi.mocked(getAgentBackend).mockReturnValue({
      state: { missions: [mkMission()] },
    } as any);
    const { body } = await call('m1');
    const m = body.mission;
    expect(m.steps).toHaveLength(1);
    expect(m.terminalLogs).toBeUndefined();
    expect(m.viewport).toBeUndefined();
    expect(m.conversationMessages).toBeUndefined();
  });

  it('长交付物降级摘要:摘录 + contentTruncated/contentChars,parts.artifact=false', async () => {
    vi.mocked(getAgentBackend).mockReturnValue({
      state: { missions: [mkMission()] },
    } as any);
    const { body } = await call('m1');
    const a = body.mission.artifact;
    expect(a.content).toBe(LONG.slice(0, ARTIFACT_EXCERPT_CHARS));
    expect(a.contentTruncated).toBe(true);
    expect(a.contentChars).toBe(LONG.length);
    expect(body.mission.parts).toEqual({ artifact: false, terminal: false, viewport: false });
  });

  it('短交付物全文随行,parts.artifact=true(无需二次取回)', async () => {
    vi.mocked(getAgentBackend).mockReturnValue({
      state: { missions: [mkMission({ artifact: { title: '短', content: '# 正文' } })] },
    } as any);
    const { body } = await call('m1');
    expect(body.mission.artifact.content).toBe('# 正文');
    expect(body.mission.artifact.contentTruncated).toBeUndefined();
    expect(body.mission.parts.artifact).toBe(true);
  });

  it('活跃会话回全量(实时渲染需要,SSE 增量随时到达):重字段都在、无 parts 标记', async () => {
    vi.mocked(getAgentBackend).mockReturnValue({
      state: { missions: [mkMission({ status: 'ACTIVE' })] },
    } as any);
    const { body } = await call('m1');
    const m = body.mission;
    expect(m.terminalLogs).toHaveLength(1);
    expect(m.viewport).toBeDefined();
    expect(m.artifact.content).toBe(LONG); // 不截断
    expect(m.parts).toBeUndefined();
    expect(m.conversationMessages).toBeUndefined(); // 会话历史任何档都不下发
  });
});

describe('?parts= 按需分片档', () => {
  beforeEach(() => {
    vi.mocked(getAgentBackend).mockReturnValue({
      state: { missions: [mkMission()] },
    } as any);
  });

  it('parts=artifact:只回全文 + 就位标记,不带 steps/日志', async () => {
    const { body } = await call('m1', '?parts=artifact');
    expect(body.mission.id).toBe('m1');
    expect(body.mission.artifact.content).toBe(LONG); // 全文,不截断
    expect(body.mission.artifact.contentTruncated).toBeUndefined();
    expect(body.mission.parts).toEqual({ artifact: true });
    expect(body.mission.steps).toBeUndefined();
    expect(body.mission.terminalLogs).toBeUndefined();
  });

  it('parts=terminal,viewport:多分片一次取回,各自置位', async () => {
    const { body } = await call('m1', '?parts=terminal,viewport');
    expect(body.mission.terminalLogs).toHaveLength(1);
    expect(body.mission.viewport.screenshotBase64).toBe('AAAA');
    expect(body.mission.parts).toEqual({ terminal: true, viewport: true });
    expect(body.mission.artifact).toBeUndefined();
  });

  it('无产物/无日志/无视口的会话:分片照置位(客户端不再空转重取)', async () => {
    vi.mocked(getAgentBackend).mockReturnValue({
      state: {
        missions: [
          mkMission({ artifact: null, terminalLogs: undefined, viewport: undefined }),
        ],
      },
    } as any);
    const { body } = await call('m1', '?parts=artifact,terminal,viewport');
    expect(body.mission.artifact).toBeUndefined();
    expect(body.mission.terminalLogs).toEqual([]);
    expect(body.mission.viewport).toBeNull();
    expect(body.mission.parts).toEqual({ artifact: true, terminal: true, viewport: true });
  });

  it('未知分片名忽略,不 throw', async () => {
    const { body } = await call('m1', '?parts=bogus');
    expect(body.mission.parts).toEqual({});
  });
});
