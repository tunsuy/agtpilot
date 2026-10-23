import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * /api/cron/jobs 的显式技能包引用契约(普通任务限定):
 * - create:合法引用白名单收敛落库;scenario 订阅任务丢弃(内置 SOP 永不携带);
 *   缺省/全非法 → 无 skillPacks 键
 * - update:显式数组 = 覆盖(收敛后落库);[] = 清空(赋 undefined,merge-spread
 *   缺键不清旧值);scenario 任务忽略该字段;缺省 = 继承原值不动
 *
 * 路由是薄胶水(mock auth/backend),收敛规则本体在 lib/skill-center
 * (sanitizeSkillPackRefs,skill-center.test.ts 钉死);user-store 走真实现
 * (tmp USER_DATA_DIR,仿 mission-parts-route.test.ts)。
 */

vi.mock('@/auth', () => ({ auth: vi.fn() }));
vi.mock('@/lib/agent-backend', () => ({ getAgentBackend: vi.fn() }));

import { auth } from '@/auth';
import { getAgentBackend } from '@/lib/agent-backend';
import { POST } from '@/app/api/cron/jobs/route';
import { getUserCronJobs, saveUserCronJob } from '@/lib/user-store';
import { userSkillPacksDir, REFERENCED_PACK_MAX } from '@/lib/skill-center';

let tmpRoot: string;
let prevUserDataDir: string | undefined;

function seedInstalledPack(userId: string, dirName: string, fmName: string) {
  const dir = path.join(userSkillPacksDir(userId), dirName);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${fmName}\ndescription: 测试包\n---\nbody`);
  return dir;
}

const call = async (body: any) => {
  const req = new Request('http://test/api/cron/jobs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const res = await POST(req as any);
  return { status: res.status, json: await res.json() };
};

const createBase = { action: 'create', name: '巡检', pattern: '0 9 * * *', prompt: '做点事' };

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cron-packs-'));
  prevUserDataDir = process.env.USER_DATA_DIR;
  process.env.USER_DATA_DIR = tmpRoot;
  vi.mocked(auth).mockResolvedValue({ user: { id: 'u_a' } } as any);
  // 调度器全桩:create/update/toggle 都会触达 register/unregister
  vi.mocked(getAgentBackend).mockReturnValue({
    initCronScheduler: vi.fn(),
    registerUserCronJob: vi.fn(),
    unregisterUserCronJob: vi.fn(),
    triggerUserCronJob: vi.fn(),
  } as any);
});

afterEach(() => {
  if (prevUserDataDir === undefined) delete process.env.USER_DATA_DIR;
  else process.env.USER_DATA_DIR = prevUserDataDir;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe('/api/cron/jobs 技能包引用', () => {
  it('create:合法引用(含 dirName 寻址)→ 收敛 canonical name 落库', async () => {
    seedInstalledPack('u_a', 'pack-dir', '包名甲');
    seedInstalledPack('u_a', 'other', 'other');
    const { status, json } = await call({ ...createBase, skillPacks: ['包名甲', 'pack-dir', 'other'] });
    expect(status).toBe(200);
    expect(json.newJob.skillPacks).toEqual(['包名甲', 'other']);
    // 落盘可回读(派发时读的就是这份记录)
    expect(getUserCronJobs('u_a').find((j: any) => j.id === json.newJob.id).skillPacks).toEqual([
      '包名甲',
      'other',
    ]);
  });

  it('create:未安装名过滤,全非法 → 无 skillPacks 键', async () => {
    seedInstalledPack('u_a', 'pack-a', 'pack-a');
    const { json } = await call({ ...createBase, skillPacks: ['没装的', 42, ''] });
    expect('skillPacks' in json.newJob).toBe(false);
    const { json: json2 } = await call({ ...createBase, skillPacks: ['pack-a', '没装的'] });
    expect(json2.newJob.skillPacks).toEqual(['pack-a']);
  });

  it('create:超上限截断到 REFERENCED_PACK_MAX', async () => {
    for (let i = 0; i < REFERENCED_PACK_MAX + 2; i++) seedInstalledPack('u_a', `pack-${i}`, `pack-${i}`);
    const names = Array.from({ length: REFERENCED_PACK_MAX + 2 }, (_, i) => `pack-${i}`);
    const { json } = await call({ ...createBase, skillPacks: names });
    expect(json.newJob.skillPacks).toHaveLength(REFERENCED_PACK_MAX);
  });

  it('create:scenario 订阅任务 → packs 被丢弃(内置 SOP 永不携带)', async () => {
    seedInstalledPack('u_a', 'pack-a', 'pack-a');
    const { json } = await call({
      ...createBase,
      scenario: { key: 'xhs_weekly_topics', count: 7 },
      skillPacks: ['pack-a'],
    });
    expect(json.newJob.scenario).toBeTruthy();
    expect('skillPacks' in json.newJob).toBe(false);
  });

  it('create:缺省/非数组 → 无 skillPacks 键', async () => {
    const { json } = await call({ ...createBase });
    expect('skillPacks' in json.newJob).toBe(false);
    const { json: json2 } = await call({ ...createBase, skillPacks: 'pack-a' });
    expect('skillPacks' in json2.newJob).toBe(false);
  });

  it('update:显式数组 → 收敛覆盖', async () => {
    seedInstalledPack('u_a', 'pack-a', 'pack-a');
    seedInstalledPack('u_a', 'pack-b', 'pack-b');
    const seeded: any = { id: 'cron_x', name: 'n', pattern: '0 9 * * *', prompt: 'p', status: 'paused', skillPacks: ['pack-a'] };
    saveUserCronJob('u_a', seeded);
    const { json } = await call({ action: 'update', id: 'cron_x', skillPacks: ['pack-b', '没装的'] });
    expect(json.updatedJob.skillPacks).toEqual(['pack-b']);
  });

  it('update:[] → 清空(赋 undefined,merge-spread 不落旧值)', async () => {
    seedInstalledPack('u_a', 'pack-a', 'pack-a');
    const seeded: any = { id: 'cron_x', name: 'n', pattern: '0 9 * * *', prompt: 'p', status: 'paused', skillPacks: ['pack-a'] };
    saveUserCronJob('u_a', seeded);
    const { json } = await call({ action: 'update', id: 'cron_x', skillPacks: [] });
    expect(json.updatedJob.skillPacks).toBeUndefined();
    // 回读持久化记录:键已不在(JSONL 序列化丢 undefined 值)
    const stored = getUserCronJobs('u_a').find((j: any) => j.id === 'cron_x');
    expect(stored.skillPacks).toBeUndefined();
  });

  it('update:scenario 任务带 packs → 忽略(原值不动)', async () => {
    seedInstalledPack('u_a', 'pack-a', 'pack-a');
    const seeded: any = {
      id: 'cron_s',
      name: 'n',
      pattern: '0 9 * * 1',
      prompt: 'p',
      status: 'paused',
      scenario: { key: 'xhs_weekly_topics', count: 7 },
    };
    saveUserCronJob('u_a', seeded);
    const { json } = await call({ action: 'update', id: 'cron_s', skillPacks: ['pack-a'] });
    expect(json.updatedJob.skillPacks).toBeUndefined();
  });

  it('update:缺省(无 skillPacks 键)→ 继承原值不动', async () => {
    seedInstalledPack('u_a', 'pack-a', 'pack-a');
    const seeded: any = { id: 'cron_x', name: 'n', pattern: '0 9 * * *', prompt: 'p', status: 'paused', skillPacks: ['pack-a'] };
    saveUserCronJob('u_a', seeded);
    const { json } = await call({ action: 'update', id: 'cron_x', name: '新名字' });
    expect(json.updatedJob.skillPacks).toEqual(['pack-a']);
    expect(json.updatedJob.name).toBe('新名字');
  });

  it('未登录 → 401', async () => {
    vi.mocked(auth).mockResolvedValue(null as any);
    const { status } = await call({ ...createBase, skillPacks: ['x'] });
    expect(status).toBe(401);
  });
});
