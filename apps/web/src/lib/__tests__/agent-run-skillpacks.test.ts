import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * /api/agent/run 的显式技能包引用收敛契约:
 * - 合法引用 → 白名单收敛为 canonical name 后透传 runMission
 * - 未安装名/非字符串/超上限 → 过滤/截断(永不信任客户端)
 * - 缺省 → options 无 skillPacks 键(续聊继承任务记录语义)
 * - 显式 [] → options.skillPacks = [](续聊清空语义)
 * - workshop 载荷在场 → skillPacks 被丢弃(工坊 = 内置 SOP,永不携带)
 *
 * 路由是薄胶水(mock auth/backend/server-render),收敛规则本体在
 * lib/skill-center(sanitizeSkillPackRefs,skill-center.test.ts 钉死);
 * 这里钉的是「路由怎么接线它们」。
 */

vi.mock('@/auth', () => ({ auth: vi.fn() }));
vi.mock('@/lib/agent-backend', () => ({ getAgentBackend: vi.fn() }));
vi.mock('@/workshops/server-render', () => ({ renderWorkshopRunServer: vi.fn() }));
vi.mock('@/workshops/shared/materials', () => ({ parseMaterials: vi.fn(() => []) }));

import { auth } from '@/auth';
import { getAgentBackend } from '@/lib/agent-backend';
import { renderWorkshopRunServer } from '@/workshops/server-render';
import { POST } from '@/app/api/agent/run/route';
import { userSkillPacksDir, REFERENCED_PACK_MAX } from '@/lib/skill-center';

// USER_DATA_DIR 指向临时目录(getDataDir 每次调用时读 env;skill-center 走真实现)
let tmpRoot: string;
let prevUserDataDir: string | undefined;

function seedInstalledPack(userId: string, dirName: string, fmName: string) {
  const dir = path.join(userSkillPacksDir(userId), dirName);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${fmName}\ndescription: 测试包\n---\nbody`);
  return dir;
}

let runMissionSpy: ReturnType<typeof vi.fn>;

const call = async (body: any) => {
  const req = new Request('http://test/api/agent/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const res = await POST(req as any);
  return { status: res.status, json: await res.json() };
};

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-run-packs-'));
  prevUserDataDir = process.env.USER_DATA_DIR;
  process.env.USER_DATA_DIR = tmpRoot;
  vi.mocked(auth).mockResolvedValue({ user: { id: 'u_a' } } as any);
  runMissionSpy = vi.fn(async () => ({ id: 'm1', title: 't', status: 'ACTIVE', progress: 5, startedAt: 1, steps: [] }));
  vi.mocked(getAgentBackend).mockReturnValue({ runMission: runMissionSpy } as any);
});

afterEach(() => {
  if (prevUserDataDir === undefined) delete process.env.USER_DATA_DIR;
  else process.env.USER_DATA_DIR = prevUserDataDir;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  vi.clearAllMocks();
});

const sentOptions = () => runMissionSpy.mock.calls[0][1];

describe('/api/agent/run 技能包引用收敛', () => {
  it('合法引用(含 dirName 寻址)→ 归一 canonical name 透传', async () => {
    seedInstalledPack('u_a', 'pack-dir', '包名甲');
    seedInstalledPack('u_a', 'other', 'other');
    const { status } = await call({ prompt: '做点事', skillPacks: ['包名甲', 'pack-dir', 'other'] });
    expect(status).toBe(200);
    expect(sentOptions().skillPacks).toEqual(['包名甲', 'other']);
  });

  it('未安装名/非字符串/空串过滤,超上限截断', async () => {
    for (let i = 0; i < REFERENCED_PACK_MAX + 2; i++) seedInstalledPack('u_a', `pack-${i}`, `pack-${i}`);
    const names = ['pack-0', 42, '', '没装的', ...Array.from({ length: REFERENCED_PACK_MAX + 1 }, (_, i) => `pack-${i + 1}`)];
    await call({ prompt: '做点事', skillPacks: names });
    const packs = sentOptions().skillPacks;
    expect(packs).toHaveLength(REFERENCED_PACK_MAX);
    expect(packs[0]).toBe('pack-0');
  });

  it('缺省 → options 无 skillPacks 键(继承语义)', async () => {
    await call({ prompt: '做点事' });
    expect('skillPacks' in sentOptions()).toBe(false);
  });

  it('显式 [] → options.skillPacks = [](清空语义)', async () => {
    await call({ prompt: '做点事', skillPacks: [] });
    expect(sentOptions().skillPacks).toEqual([]);
  });

  it('非数组(字符串/对象)→ 视为缺省,不透传', async () => {
    await call({ prompt: '做点事', skillPacks: 'pack-0' });
    expect('skillPacks' in sentOptions()).toBe(false);
  });

  it('workshop 载荷在场 → skillPacks 被丢弃(工坊永不携带)', async () => {
    seedInstalledPack('u_a', 'pack-dir', '包名甲');
    vi.mocked(renderWorkshopRunServer).mockReturnValue({ prompt: '工坊渲染 prompt', title: '工坊任务' } as any);
    await call({ prompt: '忽略我', workshop: { id: 'novel', params: {} }, skillPacks: ['包名甲'] });
    expect('skillPacks' in sentOptions()).toBe(false);
    expect(sentOptions().workshopId).toBe('novel');
  });

  it('未登录 → 401,不触达 backend', async () => {
    vi.mocked(auth).mockResolvedValue(null as any);
    const { status } = await call({ prompt: '做点事', skillPacks: ['x'] });
    expect(status).toBe(401);
    expect(runMissionSpy).not.toHaveBeenCalled();
  });
});
