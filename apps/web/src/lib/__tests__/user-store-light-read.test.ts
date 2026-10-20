import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * user-store 轻读路径(热路径)验收测试
 * —— 第二轮性能优化:页面加载/切页签/周期扫描/推送查询只要 profile 或单个
 * 数组域时,走 readProfileV2 / readArrayDomainV2 轻读,不拖着 missions 全量读。
 *
 * 覆盖:
 * 1. profile 轻读各字段与全量读一致(托管开关/场景档案/推送订阅/沙箱/纪元/提案);
 * 2. 数组域轻读与全量读一致(memories/cronJobs/goals/deletionLedger/browserAudit);
 * 3. connectors 轻读解密:密文还原明文;明文历史 → 回退全量路径(顺带补加密回写);
 * 4. v2 目录不存在 → 轻读返回 null,调用方回退全量路径(不漏数据);
 * 5. listUserProfilesLight 全员档案轻扫描:返回真实 userId + profile,可按开关过滤;
 * 6. 轻读结果是只读投影(无 __v2Baseline),纪律上不交给 saveUserData。
 *
 * 环境隔离:USER_DATA_DIR 指向一次性临时目录,必须在动态 import 被测模块之前设置。
 */

let tmpDir: string;
let us: typeof import('@/lib/user-store');
let v2: typeof import('@/lib/user-store-v2');

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agtpilot-uslight-'));
  process.env.USER_DATA_DIR = tmpDir;
  process.env.AGTPILOT_SECRET_KEY = 'uslight-test-key';
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

const readJson = (p: string) => JSON.parse(fs.readFileSync(p, 'utf-8'));

describe('profile 轻读 · 与全量读逐域一致', () => {
  const uid = 'light_profile';

  it('托管开关/场景档案/推送订阅/沙箱/纪元/提案:轻读结果 == 全量读', () => {
    us.saveXhsManaged(uid, { enabled: true, riskAckAt: 100 });
    us.saveZhihuManaged(uid, { enabled: true, riskAckAt: 200 });
    us.saveFanqieManaged(uid, { enabled: false });
    us.saveUserScenarioProfile(uid, { scenarioKey: 'xhs', version: 1 } as any);
    us.addUserPushSubscription(uid, { endpoint: 'https://push/a', keys: { p256dh: 'k', auth: 's' } } as any);
    us.saveSandboxConfig(uid, { exposeAllowlist: ['FOO'], fence: 'best_effort' });
    us.addPolicyProposal(uid, { kind: 'expose-env', detail: { envVar: 'BAR' } });
    us.bumpAuthorityEpoch(uid, 'SOME_KEY');

    // 全量读(经 getUserData 收口)作为真值基准
    const full = us.getUserData(uid);

    expect(us.getXhsManaged(uid)).toEqual(full.xhsManaged);
    expect(us.getZhihuManaged(uid)).toEqual(full.zhihuManaged);
    expect(us.getFanqieManaged(uid)).toEqual(full.fanqieManaged);
    expect(us.getUserScenarioProfiles(uid)).toEqual(full.scenarioProfiles);
    expect(us.getUserPushSubscriptions(uid)).toEqual(full.pushSubscriptions);
    expect(us.getSandboxConfig(uid)).toEqual(full.sandbox);
    expect(us.getPolicyProposals(uid)).toEqual(full.policyProposals);
    expect(us.getAuthorityEpoch(uid, 'SOME_KEY')).toBe(1);
  });

  it('getPolicyProposals 按 status 过滤(轻读侧同样生效)', () => {
    const pending = us.getPolicyProposals(uid, 'pending');
    expect(pending.every((p) => p.status === 'pending')).toBe(true);
    expect(pending.length).toBeGreaterThan(0);
  });
});

describe('数组域轻读 · 与全量读逐域一致', () => {
  const uid = 'light_array';

  it('memories/cronJobs/goals/deletionLedger/browserAudit:轻读结果 == 全量读', () => {
    us.saveUserMemory(uid, { id: 'm1', text: '记忆一', source: 'manual' });
    us.saveUserMemory(uid, { id: 'm2', text: '记忆二', source: 'manual' });
    us.saveUserCronJob(uid, { id: 'c1', name: '巡航', pattern: '0 9 * * *', status: 'active' });
    us.saveUserGoal(uid, { id: 'g1', title: '长期目标' });
    us.appendDeletionLedger(uid, { id: 'd1', kind: 'memory', at: Date.now() } as any);
    us.appendBrowserAudit(uid, { at: Date.now(), tool: 'browser', action: 'click', result: 'success' });

    const full = us.getUserData(uid);
    expect(us.getUserMemories(uid)).toEqual(full.memories);
    expect(us.getUserCronJobs(uid)).toEqual(full.cronJobs);
    expect(us.getUserGoals(uid)).toEqual(full.goals);
    expect(us.getDeletionLedger(uid)).toEqual(full.deletionLedger);
    expect(us.getBrowserAudit(uid)).toEqual(full.browserAudit);
  });

  it('getBrowserAudit limit 截断(轻读 + slice)', () => {
    for (let i = 0; i < 5; i++) {
      us.appendBrowserAudit(uid, { at: Date.now(), tool: 'browser', action: `a${i}`, result: 'success' });
    }
    expect(us.getBrowserAudit(uid, 3)).toHaveLength(3);
  });
});

describe('connectors 轻读 · 加解密', () => {
  it('密文落盘 → 轻读侧解密还原明文(不回退全量路径)', () => {
    const uid = 'light_conn_enc';
    us.saveUserConnector(uid, 'API_KEY', 'sk-secret-value');
    us.setUserActiveModel(uid, 'gpt-x');

    // 盘上是密文
    const profileRaw = readJson(path.join(tmpDir, 'v2', uid, 'profile.json'));
    expect(String(profileRaw.connectors.API_KEY)).toMatch(/^enc:v1:/);

    // 轻读解密后 == 明文
    const got = us.getUserConnectors(uid);
    expect(got.configs.API_KEY).toBe('sk-secret-value');
    expect(got.activeModelId).toBe('gpt-x');
  });

  it('明文历史 → 轻读发现明文回退全量路径(顺带补加密回写)', () => {
    const uid = 'light_conn_plain';
    // 直接落一份明文 profile(模拟未迁移的历史数据)
    const dir = path.join(tmpDir, 'v2', uid);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'profile.json'),
      JSON.stringify({ userId: uid, connectors: { PLAIN_KEY: 'plaintext-val' }, activeModelId: 'deepseek' })
    );

    const got = us.getUserConnectors(uid);
    expect(got.configs.PLAIN_KEY).toBe('plaintext-val');
    // 全量路径已补加密回写:盘上不再是明文
    const after = readJson(path.join(dir, 'profile.json'));
    expect(String(after.connectors.PLAIN_KEY)).toMatch(/^enc:v1:/);
  });
});

describe('v2 目录不存在 · 轻读回退全量路径', () => {
  it('readProfileV2 返回 null(不存在),getter 回退 getUserData 不漏数据', () => {
    const uid = 'no_v2_dir';
    // 无任何 v2 目录:轻读返回 null
    expect(v2.readProfileV2(tmpDir, uid)).toBeNull();
    expect(v2.readArrayDomainV2(tmpDir, uid, 'memories')).toBeNull();
    // getter 回退全量路径 → 空默认值,不抛
    expect(us.getUserMemories(uid)).toEqual([]);
    expect(us.getXhsManaged(uid)).toBeUndefined();
    expect(us.getUserConnectors(uid).configs).toEqual({});
  });

  it('readArrayDomainV2 missions 域不走轻读(强制回退全量路径)', () => {
    const uid = 'light_profile';
    expect(v2.readArrayDomainV2(tmpDir, uid, 'missions')).toBeNull();
  });
});

describe('listUserProfilesLight · 全员档案轻扫描', () => {
  it('返回真实 userId + profile,可按 fanqieManaged 开关过滤(sweeper 用法)', () => {
    // 复用前面已建的用户;再补一个开启番茄托管的
    us.saveFanqieManaged('fanqie_on', { enabled: true, riskAckAt: 1 });

    const all = us.listUserProfilesLight();
    expect(all.length).toBeGreaterThan(0);
    // userId 来自 profile.userId(不是目录名)
    for (const { userId, profile } of all) {
      expect(typeof userId).toBe('string');
      expect(profile).toBeTruthy();
    }
    // sweeper 过滤条件:enabled && riskAckAt
    const managed = all.filter((u) => u.profile.fanqieManaged?.enabled && u.profile.fanqieManaged?.riskAckAt);
    expect(managed.some((u) => u.userId === 'fanqie_on')).toBe(true);
  });

  it('v2 关闭 → 回退 getAllUsersData 映射(旧布局没有更轻的读法)', () => {
    process.env.AGTPILOT_CONTEXT_STORE_V2 = '0';
    const list = us.listUserProfilesLight();
    expect(Array.isArray(list)).toBe(true);
    for (const { userId, profile } of list) {
      expect(typeof userId).toBe('string');
      expect(profile).toBeTruthy();
    }
    delete process.env.AGTPILOT_CONTEXT_STORE_V2;
  });
});

describe('轻读投影纪律 · 只读,不带写回基线', () => {
  it('轻读结果无 __v2Baseline(区别于全量读对象);全量读对象带基线', () => {
    const uid = 'light_profile';
    const profileLight = v2.readProfileV2(tmpDir, uid);
    expect((profileLight as any).__v2Baseline).toBeUndefined();
    // 全量读挂基线(供脏检查)
    const full = us.getUserData(uid);
    expect((full as any).__v2Baseline).toBeDefined();
  });
});
