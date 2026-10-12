import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * user-store v2(用户上下文目录)验收测试
 * —— docs/design/context-store-filesystem-paradigm.md P1
 *
 * 覆盖:
 * 1. v2 布局往返(全域 + 未知字段透传 + connectors 落盘加密/读取解密);
 * 2. 旧单文件懒迁移(blob → 目录,旧文件 .bak 归档,审计文件挪进 audit/);
 * 3. 域级脏检查(陈旧对象不回滚并发写入者的其他域 / 其他任务文件);
 * 4. missions 每任务一文件(按 id 寻址、删除回收);
 * 5. 开关回退(AGTPILOT_CONTEXT_STORE_V2=0 → 旧单文件路径);
 * 6. getAllUsersData(v2 目录 + 未迁移旧文件混合,凭证解密,非用户文件不参与)。
 *
 * 环境隔离:USER_DATA_DIR 指向一次性临时目录,必须在动态 import 被测模块之前设置。
 */

let tmpDir: string;
let us: typeof import('@/lib/user-store');
let v2: typeof import('@/lib/user-store-v2');

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agtpilot-usv2-'));
  process.env.USER_DATA_DIR = tmpDir;
  process.env.AGTPILOT_SECRET_KEY = 'usv2-test-key';
  delete process.env.AGTPILOT_CONTEXT_STORE_V2;
  us = await import('@/lib/user-store');
  v2 = await import('@/lib/user-store-v2');
});

afterAll(() => {
  delete process.env.USER_DATA_DIR;
  delete process.env.AGTPILOT_CONTEXT_STORE_V2;
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // 清理失败不影响测试结果
  }
});

beforeEach(() => {
  delete process.env.AGTPILOT_CONTEXT_STORE_V2;
});

/** v2 用户目录 */
const udir = (userId: string) => path.join(tmpDir, 'v2', userId);
const readJson = (p: string) => JSON.parse(fs.readFileSync(p, 'utf-8'));

describe('v2 布局 · 全域往返', () => {
  it('各域分文件落盘;connectors 落盘密文、读取还原明文;未知字段透传', () => {
    const uid = 'rt1';
    us.saveUserConnector(uid, 'RT_API_KEY', 'sk-plaintext-value');
    us.saveUserMemory(uid, { id: 'mem1', text: '记住这条', source: 'manual' });
    us.saveUserMission(uid, { id: 'task-a', goal: '任务A', steps: [] });
    us.saveUserMission(uid, { id: 'task-b', goal: '任务B', steps: [] });
    us.saveUserGoal(uid, { id: 'goal1', title: '长期目标' });
    us.saveUserCronJob(uid, { id: 'cron1', schedule: '0 9 * * *' });

    // 未知字段透传(零迁移承诺)
    const d = us.getUserData(uid);
    (d as any).futureField = { hello: 'world' };
    (d as any).skillCards = [{ id: 'card1', trigger: 't', steps: 's' }];
    us.saveUserData(d);

    // 盘上布局
    expect(fs.existsSync(path.join(udir(uid), 'profile.json'))).toBe(true);
    expect(fs.existsSync(path.join(udir(uid), 'memories.jsonl'))).toBe(true);
    expect(fs.existsSync(path.join(udir(uid), 'skill-cards.jsonl'))).toBe(true);
    expect(fs.existsSync(path.join(udir(uid), 'goals.jsonl'))).toBe(true);
    expect(fs.existsSync(path.join(udir(uid), 'cron-jobs.json'))).toBe(true);
    expect(fs.existsSync(path.join(udir(uid), 'missions', 'task-a.json'))).toBe(true);
    expect(fs.existsSync(path.join(udir(uid), 'missions', 'task-b.json'))).toBe(true);
    expect(readJson(path.join(udir(uid), 'missions', 'index.json'))).toEqual(['task-b', 'task-a']); // unshift 新在前

    // connectors 落盘加密
    const profileRaw = readJson(path.join(udir(uid), 'profile.json'));
    expect(String(profileRaw.connectors.RT_API_KEY)).toMatch(/^enc:v1:/);
    expect(profileRaw.futureField).toEqual({ hello: 'world' });

    // jsonl 一行一条
    const memLines = fs.readFileSync(path.join(udir(uid), 'memories.jsonl'), 'utf-8').trim().split('\n');
    expect(memLines).toHaveLength(1);
    expect(JSON.parse(memLines[0]).id).toBe('mem1');

    // 读取往返:明文还原、任务顺序、透传字段
    const back = us.getUserData(uid);
    expect(back.connectors.RT_API_KEY).toBe('sk-plaintext-value');
    expect(back.memories.map((m: any) => m.id)).toEqual(['mem1']);
    expect(back.missions.map((m: any) => m.id)).toEqual(['task-b', 'task-a']);
    expect((back.goals || []).map((g: any) => g.id)).toEqual(['goal1']);
    expect(back.cronJobs.map((j: any) => j.id)).toEqual(['cron1']);
    expect((back as any).futureField).toEqual({ hello: 'world' });
    expect((back as any).skillCards[0].id).toBe('card1');
  });

  it('browserAudit 走 audit/browser.jsonl;记忆/沙箱审计路径在 v2 目录内', () => {
    const uid = 'rt2';
    us.appendBrowserAudit(uid, { at: Date.now(), tool: 't', action: 'save_draft', result: 'success' });
    expect(fs.existsSync(path.join(udir(uid), 'audit', 'browser.jsonl'))).toBe(true);
    expect(us.getBrowserAudit(uid)).toHaveLength(1);

    us.appendMemoryAudit(uid, { at: Date.now(), actor: 'user', op: 'add', memoryId: 'm1' });
    expect(fs.existsSync(path.join(udir(uid), 'audit', 'memory.jsonl'))).toBe(true);
    expect(us.readMemoryAudit(uid)[0].memoryId).toBe('m1');

    us.appendSandboxAudit(uid, { userId: uid, tool: 'sandbox_http_request', reason: 'private_host_blocked' });
    expect(fs.existsSync(path.join(udir(uid), 'audit', 'sandbox.jsonl'))).toBe(true);
    expect(us.readSandboxAudit(uid)).toHaveLength(1);
  });
});

describe('懒迁移 · 旧单文件 → v2 目录', () => {
  it('首访迁移:blob 转目录、旧文件 .bak 归档、审计文件挪位,数据无损', () => {
    const uid = 'mg1';
    // 直接铺旧格式(模拟存量部署)
    fs.writeFileSync(
      path.join(tmpDir, `${uid}.json`),
      JSON.stringify({
        userId: uid,
        connectors: {},
        memories: [{ id: 'old-mem', text: '旧记忆', source: 'manual' }],
        missions: [{ id: 'old-task', goal: '旧任务' }],
        cronJobs: [],
        goals: [],
        legacyOnlyField: 'keep-me',
        updatedAt: Date.now(),
      }),
      'utf-8'
    );
    fs.writeFileSync(path.join(tmpDir, `${uid}.audit.jsonl`), `${JSON.stringify({ at: 1, actor: 'user', op: 'add', memoryId: 'x' })}\n`, 'utf-8');
    fs.writeFileSync(path.join(tmpDir, `${uid}.sandbox-audit.jsonl`), `${JSON.stringify({ at: 1, userId: uid, tool: 't', reason: 'r' })}\n`, 'utf-8');

    const data = us.getUserData(uid); // 触发懒迁移
    expect(data.memories.map((m: any) => m.id)).toEqual(['old-mem']);
    expect((data as any).legacyOnlyField).toBe('keep-me');

    // 旧 blob 归档,原路径不再存在(.bak 不以 .json 结尾,不会被再次扫描)
    expect(fs.existsSync(path.join(tmpDir, `${uid}.json`))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, `${uid}.json.bak`))).toBe(true);
    // 目录已建,审计挪位
    expect(fs.existsSync(path.join(udir(uid), 'memories.jsonl'))).toBe(true);
    expect(fs.existsSync(path.join(udir(uid), 'audit', 'memory.jsonl'))).toBe(true);
    expect(fs.existsSync(path.join(udir(uid), 'audit', 'sandbox.jsonl'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, `${uid}.audit.jsonl`))).toBe(false);
    expect(us.readMemoryAudit(uid)[0].memoryId).toBe('x');
    expect(us.readSandboxAudit(uid)).toHaveLength(1);

    // 二次读取走 v2,数据一致
    expect(us.getUserData(uid).missions.map((m: any) => m.id)).toEqual(['old-task']);
  });

  it('_vapid.json / 隐藏文件不参与迁移(非用户文件)', () => {
    fs.writeFileSync(path.join(tmpDir, '_vapid.json'), JSON.stringify({ publicKey: 'pk' }), 'utf-8');
    us.getAllUsersData();
    expect(fs.existsSync(path.join(tmpDir, '_vapid.json'))).toBe(true); // 未被挪走/改名
    expect(fs.existsSync(path.join(tmpDir, 'v2', '_vapid'))).toBe(false);
  });
});

describe('域级脏检查 · 并发保护', () => {
  it('陈旧对象只覆盖调用方自己改过的域,不回滚他人变更', () => {
    const uid = 'cc1';
    us.getUserData(uid); // 确保 v2 就绪
    const a = us.getUserData(uid);
    const b = us.getUserData(uid); // 与 a 同基线

    a.goals = [{ id: 'g-a', title: 'A 的目标' }] as any;
    us.saveUserData(a);

    // b 是陈旧快照(goals 还是旧值),只改 memories
    b.memories = [{ id: 'm-b', text: 'B 的记忆' }] as any;
    us.saveUserData(b);

    const merged = us.getUserData(uid);
    expect((merged.goals || []).map((g: any) => g.id)).toEqual(['g-a']); // A 的目标未被 B 回滚
    expect(merged.memories.map((m: any) => m.id)).toEqual(['m-b']); // B 的记忆生效
  });

  it('missions 逐任务脏检查:两个写者各改一个任务,互不覆盖', () => {
    const uid = 'cc2';
    const base = us.getUserData(uid);
    base.missions = [
      { id: 't1', goal: 'g1', status: 'NEW' },
      { id: 't2', goal: 'g2', status: 'NEW' },
    ] as any;
    us.saveUserData(base);

    const w1 = us.getUserData(uid);
    const w2 = us.getUserData(uid);
    (w1.missions[0] as any).status = 'DONE-w1';
    us.saveUserData(w1);
    (w2.missions[1] as any).status = 'DONE-w2'; // w2 的 t1 是旧值,但与其基线一致 → 不碰盘
    us.saveUserData(w2);

    const fin = us.getUserData(uid);
    expect((fin.missions[0] as any).status).toBe('DONE-w1');
    expect((fin.missions[1] as any).status).toBe('DONE-w2');
  });
});

describe('missions 每任务一文件', () => {
  it('按 id 寻址;删除任务回收对应文件', () => {
    const uid = 'ms1';
    us.saveUserMission(uid, { id: 'keep-me', goal: 'g' });
    us.saveUserMission(uid, { id: 'drop-me', goal: 'g' });
    expect(fs.existsSync(path.join(udir(uid), 'missions', 'keep-me.json'))).toBe(true);
    expect(fs.existsSync(path.join(udir(uid), 'missions', 'drop-me.json'))).toBe(true);

    us.deleteUserMission(uid, 'drop-me');
    expect(fs.existsSync(path.join(udir(uid), 'missions', 'drop-me.json'))).toBe(false);
    expect(us.getUserMissions(uid).map((m: any) => m.id)).toEqual(['keep-me']);
  });
});

describe('开关回退 · AGTPILOT_CONTEXT_STORE_V2=0', () => {
  it('关闭 → 走旧单文件路径;重新打开 → 懒迁移接管', () => {
    process.env.AGTPILOT_CONTEXT_STORE_V2 = '0';
    const uid = 'ks1';
    const d = us.getUserData(uid);
    d.memories = [{ id: 'legacy-mem', text: '旧路径' }] as any;
    us.saveUserData(d);
    expect(fs.existsSync(path.join(tmpDir, `${uid}.json`))).toBe(true);
    expect(fs.existsSync(udir(uid))).toBe(false);

    // 审计也回旧平铺路径
    us.appendMemoryAudit(uid, { at: Date.now(), actor: 'user', op: 'add', memoryId: 'lm' });
    expect(fs.existsSync(path.join(tmpDir, `${uid}.audit.jsonl`))).toBe(true);

    delete process.env.AGTPILOT_CONTEXT_STORE_V2;
    const back = us.getUserData(uid); // 懒迁移
    expect(back.memories.map((m: any) => m.id)).toEqual(['legacy-mem']);
    expect(fs.existsSync(path.join(tmpDir, `${uid}.json.bak`))).toBe(true);
    expect(fs.existsSync(path.join(udir(uid), 'audit', 'memory.jsonl'))).toBe(true);
    expect(us.readMemoryAudit(uid)[0].memoryId).toBe('lm');
  });
});

describe('getAllUsersData · 混合形态枚举', () => {
  it('v2 目录 + 未迁移旧文件都能列出;凭证解密;迁移顺带完成', () => {
    // v2 用户
    us.saveUserConnector('au1', 'AU_KEY', 'sk-au1-secret');
    // 未迁移旧文件用户
    fs.writeFileSync(
      path.join(tmpDir, 'au2.json'),
      JSON.stringify({ userId: 'au2', connectors: {}, memories: [], cronJobs: [{ id: 'cron-au2' }], missions: [], goals: [] }),
      'utf-8'
    );

    const all = us.getAllUsersData();
    const ids = all.map((u) => u.userId);
    expect(ids).toContain('au1');
    expect(ids).toContain('au2');
    expect(ids).not.toContain('_vapid');
    const au1 = all.find((u) => u.userId === 'au1')!;
    expect(au1.connectors.AU_KEY).toBe('sk-au1-secret'); // 解密还原
    const au2 = all.find((u) => u.userId === 'au2')!;
    expect(au2.cronJobs.map((j: any) => j.id)).toEqual(['cron-au2']);
    // 枚举顺带完成懒迁移(启动路径不漏 cron)
    expect(fs.existsSync(path.join(tmpDir, 'au2.json.bak'))).toBe(true);
  });
});

describe('v2 模块纯函数', () => {
  it('safeName 转义与旧单文件一致;isV2Enabled 跟随开关', () => {
    expect(v2.safeName('o9cq@im.wechat')).toBe('o9cq_im_wechat');
    expect(v2.isV2Enabled()).toBe(true);
    process.env.AGTPILOT_CONTEXT_STORE_V2 = '0';
    try {
      expect(v2.isV2Enabled()).toBe(false);
    } finally {
      delete process.env.AGTPILOT_CONTEXT_STORE_V2;
    }
  });
});
