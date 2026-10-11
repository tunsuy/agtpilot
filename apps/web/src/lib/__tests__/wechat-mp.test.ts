import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
// 纯类型导入(编译期擦除,不影响「先设环境变量再动态 import」的运行时顺序)
import type { BrowserAuditEntry } from '@/lib/user-store';

/**
 * 微信公众号草稿箱直连单元测试(scenario-loop:工坊凭证 + 审批门 + 限频 + 审计)。
 * 纯决策函数(限频/凭证解析)+ create_draft execute 全链路(vi.stubGlobal('fetch') 打桩,
 * 不需要真实微信接口)。环境隔离:USER_DATA_DIR 指向一次性临时目录(与 xhs-managed.test 同模式),
 * 必须在动态 import 被测模块之前设置。
 */
let tmpDir: string;
let wm: typeof import('@/lib/wechat-mp');
let us: typeof import('@/lib/user-store');

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agtpilot-wechat-'));
  process.env.USER_DATA_DIR = tmpDir;
  process.env.AGTPILOT_SECRET_KEY = 'wechat-mp-test-key';
  delete process.env.AGTPILOT_WECHAT_DRAFT_DAILY_LIMIT;
  us = await import('@/lib/user-store');
  wm = await import('@/lib/wechat-mp');
});

afterAll(() => {
  vi.unstubAllGlobals();
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {}
});

const CRED = 'wx1234abcd:secret5678efgh';

/** 每个用例独立 userId:凭证/审计都落盘,共享 uid 会互相串数 */
function saveCred(uid: string, cred: string) {
  us.saveUserConnector(uid, wm.WECHAT_MP_CRED_KEY, cred);
  wm.resetWechatMpTokenCache(uid);
}

type RouteHandler = (url: string, init?: any) => Record<string, unknown>;

/** 按 URL 前缀路由的 fetch 桩:微信三段接口(stable_token / add_material / draft/add) */
function stubWechatFetch(routes: Record<string, RouteHandler>) {
  const mock = vi.fn(async (url: string, init?: any) => {
    for (const [fragment, handler] of Object.entries(routes)) {
      if (String(url).includes(fragment)) {
        return { ok: true, json: async () => handler(String(url), init), headers: new Map() };
      }
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
  vi.stubGlobal('fetch', mock);
  return mock;
}

const okToken: RouteHandler = () => ({ access_token: 'TOK', expires_in: 7200 });
const okMaterial: RouteHandler = () => ({ media_id: 'COVER_MEDIA_ID' });
const okDraft: RouteHandler = () => ({ media_id: 'DRAFT_MEDIA_ID' });

const BODY = '正文需要足够长以通过工具侧的最小校验,这里用一段有信息量的中文填充。'.repeat(3);

describe('dailyWechatDraftLimit', () => {
  it('缺省/非法 env → 3', () => {
    expect(wm.dailyWechatDraftLimit()).toBe(3);
    process.env.AGTPILOT_WECHAT_DRAFT_DAILY_LIMIT = 'abc';
    expect(wm.dailyWechatDraftLimit()).toBe(3);
    process.env.AGTPILOT_WECHAT_DRAFT_DAILY_LIMIT = '-2';
    expect(wm.dailyWechatDraftLimit()).toBe(3);
    delete process.env.AGTPILOT_WECHAT_DRAFT_DAILY_LIMIT;
  });

  it('env 可调', () => {
    process.env.AGTPILOT_WECHAT_DRAFT_DAILY_LIMIT = '5';
    expect(wm.dailyWechatDraftLimit()).toBe(5);
    delete process.env.AGTPILOT_WECHAT_DRAFT_DAILY_LIMIT;
  });
});

describe('countTodayWechatDrafts(本地日界 + 成败都计)', () => {
  const now = new Date('2026-10-10T10:00:00');
  const todayTs = now.getTime();
  const yesterdayTs = todayTs - 24 * 3600 * 1000;

  const entry = (at: number, result: 'success' | 'failure'): BrowserAuditEntry => ({
    at,
    tool: 'wechat_mp_create_draft',
    action: 'create_draft',
    result,
  });

  it('只统计今天的 wechat_mp_create_draft(含失败),其他工具不计(与 xhs 审计互不干扰)', () => {
    const audit = [
      entry(todayTs - 3600_000, 'success'),
      entry(todayTs, 'failure'),
      entry(yesterdayTs, 'success'),
      { at: todayTs, tool: 'xhs_save_note_draft', action: 'save_note_draft', result: 'success' },
    ] as BrowserAuditEntry[];
    expect(wm.countTodayWechatDrafts(audit, now)).toBe(2);
  });

  it('空审计 → 0', () => {
    expect(wm.countTodayWechatDrafts([], now)).toBe(0);
  });
});

describe('parseWechatMpCredential', () => {
  it('容忍冒号/中文冒号/逗号/竖线/空格分隔', () => {
    expect(wm.parseWechatMpCredential('wx123:sec456')).toEqual({ appId: 'wx123', appSecret: 'sec456' });
    expect(wm.parseWechatMpCredential('wx123：sec456')).toEqual({ appId: 'wx123', appSecret: 'sec456' });
    expect(wm.parseWechatMpCredential('wx123,sec456')).toEqual({ appId: 'wx123', appSecret: 'sec456' });
    expect(wm.parseWechatMpCredential('wx123 | sec456')).toEqual({ appId: 'wx123', appSecret: 'sec456' });
    expect(wm.parseWechatMpCredential('wx123 sec456')).toEqual({ appId: 'wx123', appSecret: 'sec456' });
  });

  it('非法输入 → null', () => {
    expect(wm.parseWechatMpCredential(undefined)).toBeNull();
    expect(wm.parseWechatMpCredential('')).toBeNull();
    expect(wm.parseWechatMpCredential('only-appid')).toBeNull();
    expect(wm.parseWechatMpCredential('a b c')).toBeNull();
  });
});

describe('工具面:审批门与描述契约', () => {
  it('create_draft:dangerLevel high + partially-reversible 补偿说明(编排器审批门的前提)', () => {
    const tools = wm.buildWechatMpTools('wechat-contract-user');
    expect(tools.map((t) => t.name)).toEqual(['wechat_mp_check_setup', 'wechat_mp_create_draft']);
    const draft = tools[1];
    expect(draft.dangerLevel).toBe('high');
    expect(draft.compensation?.kind).toBe('partially-reversible');
    expect(draft.compensation?.undoHint).toContain('草稿箱');
    // 描述写明审批与每日上限(模型可见的契约)
    expect(draft.description).toContain('审批');
    expect(draft.description).toContain('上限');
    expect(draft.description).toContain('连接器页');
  });
});

describe('create_draft execute 全链路(fetch 桩)', () => {
  it('参数校验:title/markdown 必填;不过不 fetch 不落审计', async () => {
    const uid = 'wechat-t1';
    saveCred(uid, CRED);
    const fetchMock = stubWechatFetch({
      '/cgi-bin/stable_token': okToken,
      '/cgi-bin/material/add_material': okMaterial,
      '/cgi-bin/draft/add': okDraft,
    });
    const draft = wm.buildWechatMpTools(uid)[1];
    const r1 = await draft.execute({ title: '', markdown: BODY }, { taskId: 'm1', step: 1 });
    expect(r1.success).toBe(false);
    const r2 = await draft.execute({ title: 't', markdown: '' }, { taskId: 'm1', step: 1 });
    expect(r2.success).toBe(false);
    expect(fetchMock.mock.calls.length).toBe(0);
    expect(us.getBrowserAudit(uid)).toHaveLength(0);
  });

  it('成功链路:三段 fetch(token→add_material→draft/add)→ 审计 success + missionId + 今日用量', async () => {
    const uid = 'wechat-t2';
    saveCred(uid, CRED);
    const fetchMock = stubWechatFetch({
      '/cgi-bin/stable_token': okToken,
      '/cgi-bin/material/add_material': okMaterial,
      '/cgi-bin/draft/add': okDraft,
    });
    const draft = wm.buildWechatMpTools(uid)[1];

    const r = await draft.execute(
      { title: '大模型落地', markdown: BODY, digest: '摘要一句话。' },
      { taskId: 'mission-42', step: 1 }
    );
    expect(r.success).toBe(true);
    expect(r.draft_media_id).toBe('DRAFT_MEDIA_ID');
    expect(r.message).toContain('今日已用 1/3');
    expect(r.message).toContain('人工');
    // 三段调用顺序:stable_token → add_material(占位封面)→ draft/add
    const urls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(urls).toHaveLength(3);
    expect(urls[0]).toContain('stable_token');
    expect(urls[1]).toContain('add_material');
    expect(urls[2]).toContain('draft/add');
    // 审计落盘且带 missionId
    const audit = us.getBrowserAudit(uid);
    expect(audit).toHaveLength(1);
    expect(audit[0].tool).toBe('wechat_mp_create_draft');
    expect(audit[0].action).toBe('create_draft');
    expect(audit[0].result).toBe('success');
    expect(audit[0].missionId).toBe('mission-42');
    expect(audit[0].title).toBe('大模型落地');
  });

  it('限频前置:今日已满 → 不 fetch 不落审计直接 rejected', async () => {
    const uid = 'wechat-t3';
    for (let i = 0; i < 3; i++) {
      us.appendBrowserAudit(uid, {
        at: Date.now(),
        tool: 'wechat_mp_create_draft',
        action: 'create_draft',
        result: 'success',
      });
    }
    saveCred(uid, CRED);
    const fetchMock = stubWechatFetch({
      '/cgi-bin/stable_token': okToken,
      '/cgi-bin/material/add_material': okMaterial,
      '/cgi-bin/draft/add': okDraft,
    });
    const draft = wm.buildWechatMpTools(uid)[1];

    const r = await draft.execute({ title: 't', markdown: BODY }, { taskId: 'm', step: 1 });
    expect(r.success).toBe(false);
    expect(r.rejected).toBe(true);
    expect(r.error).toContain('上限');
    expect(r.error).toContain('明天再试');
    expect(fetchMock.mock.calls.length).toBe(0);
    // 拒绝不产生新审计(拒绝不计数)
    expect(us.getBrowserAudit(uid)).toHaveLength(3);
  });

  it('微信报错 40164:白话错误 + 审计 failure', async () => {
    const uid = 'wechat-t4';
    saveCred(uid, CRED);
    stubWechatFetch({
      '/cgi-bin/stable_token': okToken,
      '/cgi-bin/material/add_material': okMaterial,
      '/cgi-bin/draft/add': () => ({ errcode: 40164, errmsg: 'invalid ip' }),
    });
    const draft = wm.buildWechatMpTools(uid)[1];

    const r = await draft.execute({ title: 't', markdown: BODY }, { taskId: 'm-40164', step: 1 });
    expect(r.success).toBe(false);
    expect(r.error).toContain('IP 白名单');
    const audit = us.getBrowserAudit(uid);
    expect(audit).toHaveLength(1);
    expect(audit[0].result).toBe('failure');
    expect(audit[0].missionId).toBe('m-40164');
    expect(String(audit[0].error)).toContain('IP 白名单');
  });

  it('标题超 64 字截断;digest 缺省从正文提取', async () => {
    const uid = 'wechat-t5';
    saveCred(uid, CRED);
    const fetchMock = stubWechatFetch({
      '/cgi-bin/stable_token': okToken,
      '/cgi-bin/material/add_material': okMaterial,
      '/cgi-bin/draft/add': okDraft,
    });
    const draft = wm.buildWechatMpTools(uid)[1];
    const longTitle = '标'.repeat(70);

    const r = await draft.execute({ title: longTitle, markdown: BODY }, { taskId: 'm', step: 1 });
    expect(r.success).toBe(true);
    expect((r.title as string).length).toBeLessThanOrEqual(64);
    // 请求体里的 digest 来自正文兜底(deriveDigest)
    const body = JSON.parse(fetchMock.mock.calls[2][1].body);
    expect(body.articles[0].digest.length).toBeGreaterThan(0);
    expect(body.articles[0].digest.length).toBeLessThanOrEqual(120);
  });
});

describe('check_setup 与凭证检查', () => {
  it('未配置:返回引导文案,指向连接器页公众号卡片', async () => {
    const uid = 'wechat-t6';
    const check = wm.buildWechatMpTools(uid)[0];
    const r = await check.execute({}, { taskId: 'm', step: 1 });
    expect(r.success).toBe(false);
    expect(r.configured).toBe(false);
    expect(r.message).toContain('连接器页');
    expect(r.message).toContain('微信公众号');
    expect(String(r.message)).toContain('AppID:AppSecret');
  });

  it('checkWechatMpCredential:未配置 → ok:false;配置且 token 可取 → ok:true + appId', async () => {
    const uid = 'wechat-t7';
    const r1 = await wm.checkWechatMpCredential(uid);
    expect(r1.ok).toBe(false);

    saveCred(uid, CRED);
    stubWechatFetch({ '/cgi-bin/stable_token': okToken });
    const r2 = await wm.checkWechatMpCredential(uid);
    expect(r2.ok).toBe(true);
    expect(r2.appId).toBe('wx1234abcd');
  });

  it('checkWechatMpCredential:Secret 错误(40001)→ 白话错误指向连接器页', async () => {
    const uid = 'wechat-t8';
    saveCred(uid, CRED);
    stubWechatFetch({
      '/cgi-bin/stable_token': () => ({ errcode: 40001, errmsg: 'invalid secret' }),
    });
    const r = await wm.checkWechatMpCredential(uid);
    expect(r.ok).toBe(false);
    expect(r.appId).toBe('wx1234abcd');
    expect(r.error).toContain('AppID/AppSecret');
    expect(r.error).toContain('连接器页');
  });

  it('换绑 appId 后旧 token 缓存立即失效(缓存键含 appId,不串号)', async () => {
    const uid = 'wechat-t9';
    saveCred(uid, CRED);
    let tokenCalls = 0;
    stubWechatFetch({
      '/cgi-bin/stable_token': () => {
        tokenCalls += 1;
        return { access_token: `TOK-${tokenCalls}`, expires_in: 7200 };
      },
      '/cgi-bin/material/add_material': okMaterial,
      '/cgi-bin/draft/add': okDraft,
    });
    const draft = wm.buildWechatMpTools(uid)[1];

    const r1 = await draft.execute({ title: 't', markdown: BODY }, { taskId: 'm', step: 1 });
    expect(r1.success).toBe(true);
    expect(tokenCalls).toBe(1);

    // 换绑到另一个 appId(模拟在连接器页改凭证):新 appId 的缓存键不同 → 重新取 token
    saveCred(uid, 'wxyz9999:anothersecret');
    const r2 = await draft.execute({ title: 't', markdown: BODY }, { taskId: 'm', step: 1 });
    expect(r2.success).toBe(true);
    expect(tokenCalls).toBe(2);
  });
});
