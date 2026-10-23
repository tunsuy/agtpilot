import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * /api/goals 的显式技能包引用契约:
 * - create:合法引用白名单收敛落库(「推进此里程碑」派发时透传);
 *   缺省/全非法 → 无 skillPacks 键
 * - update:显式数组 = 覆盖(收敛后落库);[] = 清空(赋 undefined,
 *   merge-spread 缺键不清旧值);缺省 = 继承原值不动
 *
 * 路由是薄胶水(mock auth),收敛规则本体在 lib/skill-center
 * (sanitizeSkillPackRefs,skill-center.test.ts 钉死);user-store 走真实现
 * (tmp USER_DATA_DIR,仿 cron-jobs-skillpacks.test.ts)。
 */

vi.mock('@/auth', () => ({ auth: vi.fn() }));

import { auth } from '@/auth';
import { POST } from '@/app/api/goals/route';
import { getUserGoals, saveUserGoal } from '@/lib/user-store';
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
  const req = new Request('http://test/api/goals', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const res = await POST(req as any);
  return { status: res.status, json: await res.json() };
};

const createBase = { action: 'create', title: '学 Rust', milestones: [{ title: '阶段 1' }] };

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'goals-packs-'));
  prevUserDataDir = process.env.USER_DATA_DIR;
  process.env.USER_DATA_DIR = tmpRoot;
  vi.mocked(auth).mockResolvedValue({ user: { id: 'u_a' } } as any);
});

afterEach(() => {
  if (prevUserDataDir === undefined) delete process.env.USER_DATA_DIR;
  else process.env.USER_DATA_DIR = prevUserDataDir;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe('/api/goals 技能包引用', () => {
  it('create:合法引用(含 dirName 寻址)→ 收敛 canonical name 落库', async () => {
    seedInstalledPack('u_a', 'pack-dir', '包名甲');
    seedInstalledPack('u_a', 'other', 'other');
    const { status, json } = await call({ ...createBase, skillPacks: ['包名甲', 'pack-dir', 'other'] });
    expect(status).toBe(200);
    expect(json.newGoal.skillPacks).toEqual(['包名甲', 'other']);
    // 落盘可回读(handleAdvanceMilestone 派发时读的就是这份记录)
    const stored = getUserGoals('u_a').find((g: any) => g.id === json.newGoal.id);
    expect(stored.skillPacks).toEqual(['包名甲', 'other']);
  });

  it('create:未安装名/非字符串过滤,全非法或缺省 → 无 skillPacks 键', async () => {
    const { json } = await call({ ...createBase, skillPacks: ['没装的', 42, ''] });
    expect('skillPacks' in json.newGoal).toBe(false);
    const { json: json2 } = await call({ ...createBase });
    expect('skillPacks' in json2.newGoal).toBe(false);
    const { json: json3 } = await call({ ...createBase, skillPacks: 'pack-a' });
    expect('skillPacks' in json3.newGoal).toBe(false);
  });

  it('create:超上限截断到 REFERENCED_PACK_MAX', async () => {
    for (let i = 0; i < REFERENCED_PACK_MAX + 2; i++) seedInstalledPack('u_a', `pack-${i}`, `pack-${i}`);
    const names = Array.from({ length: REFERENCED_PACK_MAX + 2 }, (_, i) => `pack-${i}`);
    const { json } = await call({ ...createBase, skillPacks: names });
    expect(json.newGoal.skillPacks).toHaveLength(REFERENCED_PACK_MAX);
  });

  it('update:显式数组 → 收敛覆盖', async () => {
    seedInstalledPack('u_a', 'pack-a', 'pack-a');
    seedInstalledPack('u_a', 'pack-b', 'pack-b');
    saveUserGoal('u_a', { id: 'goal_x', title: 't', milestones: [], skillPacks: ['pack-a'] });
    const { json } = await call({ action: 'update', id: 'goal_x', skillPacks: ['pack-b', '没装的'] });
    expect(json.updatedGoal.skillPacks).toEqual(['pack-b']);
  });

  it('update:[] → 清空(赋 undefined,merge-spread 不落旧值)', async () => {
    seedInstalledPack('u_a', 'pack-a', 'pack-a');
    saveUserGoal('u_a', { id: 'goal_x', title: 't', milestones: [], skillPacks: ['pack-a'] });
    const { json } = await call({ action: 'update', id: 'goal_x', skillPacks: [] });
    expect(json.updatedGoal.skillPacks).toBeUndefined();
    // 回读持久化记录:键已不在(JSONL 序列化丢 undefined 值)
    const stored = getUserGoals('u_a').find((g: any) => g.id === 'goal_x');
    expect(stored.skillPacks).toBeUndefined();
  });

  it('update:缺省(无 skillPacks 键)→ 继承原值不动', async () => {
    seedInstalledPack('u_a', 'pack-a', 'pack-a');
    saveUserGoal('u_a', { id: 'goal_x', title: 't', milestones: [], skillPacks: ['pack-a'] });
    const { json } = await call({ action: 'update', id: 'goal_x', title: '新标题' });
    expect(json.updatedGoal.skillPacks).toEqual(['pack-a']);
    expect(json.updatedGoal.title).toBe('新标题');
  });

  it('未登录 → 401', async () => {
    vi.mocked(auth).mockResolvedValue(null as any);
    const { status } = await call({ ...createBase, skillPacks: ['x'] });
    expect(status).toBe(401);
  });
});
