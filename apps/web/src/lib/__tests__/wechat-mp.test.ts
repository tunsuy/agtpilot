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

  it('成功链路:四段 fetch(token→commons检索→add_material→draft/add)→ 审计 success + missionId + 今日用量', async () => {
    const uid = 'wechat-t2';
    saveCred(uid, CRED);
    const fetchMock = stubWechatFetch({
      '/cgi-bin/stable_token': okToken,
      // commons 无可用图 → 回退纯排版封面(无浏览器环境再回退渐变)
      'commons.wikimedia.org': () => ({ query: { pages: {} } }),
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
    // 四段调用顺序:stable_token → commons(主题图检索)→ add_material → draft/add
    const urls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(urls).toHaveLength(4);
    expect(urls[0]).toContain('stable_token');
    expect(urls[1]).toContain('commons.wikimedia.org');
    expect(urls[2]).toContain('add_material');
    expect(urls[3]).toContain('draft/add');
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
      'commons.wikimedia.org': () => ({ query: { pages: {} } }),
      '/cgi-bin/material/add_material': okMaterial,
      '/cgi-bin/draft/add': okDraft,
    });
    const draft = wm.buildWechatMpTools(uid)[1];
    const longTitle = '标'.repeat(70);

    const r = await draft.execute({ title: longTitle, markdown: BODY }, { taskId: 'm', step: 1 });
    expect(r.success).toBe(true);
    expect((r.title as string).length).toBeLessThanOrEqual(64);
    // 请求体里的 digest 来自正文兜底(deriveDigest)
    const body = JSON.parse(fetchMock.mock.calls[3][1].body);
    expect(body.articles[0].digest.length).toBeGreaterThan(0);
    expect(body.articles[0].digest.length).toBeLessThanOrEqual(120);
  });
});

/** fake 浏览器:acquirePage → 共享页(只许 context(),碰其他方法即记为污染);context().newPage() → 临时页 */
function fakeCoverBrowser(opts: { failScreenshot?: boolean } = {}) {
  let acquired = 0;
  const tempCalls: Array<{ m: string; a?: any }> = [];
  let closed = false;
  const temp = {
    setViewportSize: async (v: any) => tempCalls.push({ m: 'setViewportSize', a: v }),
    setContent: async (html: string, o?: any) => tempCalls.push({ m: 'setContent', a: html }),
    waitForTimeout: async (ms: number) => tempCalls.push({ m: 'waitForTimeout', a: ms }),
    screenshot: async (o: any) => {
      tempCalls.push({ m: 'screenshot', a: o });
      if (opts.failScreenshot) throw new Error('shot fail');
      return Buffer.from('PNGCOVER_BYTES');
    },
    close: async () => {
      closed = true;
    },
  };
  const shared = {
    // 共享页被导航/操作即污染(封面渲染只许开临时标签页)
    polluted: 0,
    goto: async () => {
      shared.polluted++;
    },
    context: () => ({ newPage: async () => temp }),
  };
  const svc = {
    acquirePage: async () => {
      acquired++;
      return shared;
    },
  };
  return { svc, shared, temp, tempCalls, acquired: () => acquired, isClosed: () => closed };
}


describe('内容排版封面(浏览器临时标签页渲染)', () => {
  it('渲染成功:900×383 临时页渲染 + 截图 + 关页;共享页零污染;标题/摘要/主题色入图', async () => {
    const fb = fakeCoverBrowser();
    const png = await wm.renderContentCoverPng(fb.svc, 'u-cover', {
      title: '大模型落地实践<b>指南</b>',
      digest: '从场景到工程的一揽子路径。',
      author: '老王',
      themeId: 'warm-orange',
    });
    expect(png).not.toBeNull();
    expect(png!.toString()).toBe('PNGCOVER_BYTES');
    // 视口与截图参数
    expect(fb.tempCalls.find((c) => c.m === 'setViewportSize')?.a).toEqual({ width: 900, height: 383 });
    expect(fb.tempCalls.find((c) => c.m === 'screenshot')?.a?.type).toBe('png');
    // HTML 转义 + 摘要 + 作者 + 主题 accent(暖橙)入图
    const html = fb.tempCalls.find((c) => c.m === 'setContent')?.a as string;
    expect(html).toContain('大模型落地实践&lt;b&gt;指南&lt;/b&gt;');
    expect(html).toContain('从场景到工程的一揽子路径。');
    expect(html).toContain('老王');
    expect(html).toContain('#c05a10');
    expect(html).toContain('-webkit-line-clamp: 2');
    // 临时页关闭;共享页未被动过
    expect(fb.isClosed()).toBe(true);
    expect(fb.shared.polluted).toBe(0);
    expect(fb.acquired()).toBe(1);
  });

  it('截图抛错 → 返回 null(调用方回退渐变),临时页仍被关闭', async () => {
    const fb = fakeCoverBrowser({ failScreenshot: true });
    const png = await wm.renderContentCoverPng(fb.svc, 'u-cover2', { title: 't' });
    expect(png).toBeNull();
    expect(fb.isClosed()).toBe(true);
  });

  it('execute 集成:无 cover_url 且图库无可用图 → 浏览器渲染纯排版封面上传;正文主题色一致', async () => {
    const uid = 'wechat-cover1';
    saveCred(uid, CRED);
    const fetchMock = stubWechatFetch({
      '/cgi-bin/stable_token': okToken,
      'commons.wikimedia.org': () => ({ query: { pages: {} } }),
      '/cgi-bin/material/add_material': okMaterial,
      '/cgi-bin/draft/add': okDraft,
    });
    const fb = fakeCoverBrowser();
    const draft = wm.buildWechatMpTools(uid, fb.svc)[1];

    const r = await draft.execute(
      { title: '智能体年度观察', markdown: BODY, digest: '一年内值得记住的变化。', theme: 'classic-green' },
      { taskId: 'm-cover', step: 1 }
    );
    expect(r.success).toBe(true);
    expect(r.cover).toContain('排版封面');
    expect(r.coverImageSource).toBeUndefined();
    // 上传的就是渲染出的字节(FormData 的 media blob;调用序:token→commons→add_material→draft)
    const form = fetchMock.mock.calls[2][1].body as FormData;
    const blob = form.get('media') as Blob;
    expect(Buffer.from(await blob.arrayBuffer()).toString()).toBe('PNGCOVER_BYTES');
    // HTML 用 classic-green 主题色(微信绿),纯排版无照片底
    const html = fb.tempCalls.find((c) => c.m === 'setContent')?.a as string;
    expect(html).toContain('#0a9d4e');
    expect(html).not.toContain('data:image/');
    expect(fb.shared.polluted).toBe(0);
  });

  it('execute 集成:浏览器渲染失败 → 回退渐变占位,不阻塞投草稿', async () => {
    const uid = 'wechat-cover2';
    saveCred(uid, CRED);
    stubWechatFetch({
      '/cgi-bin/stable_token': okToken,
      'commons.wikimedia.org': () => ({ query: { pages: {} } }),
      '/cgi-bin/material/add_material': okMaterial,
      '/cgi-bin/draft/add': okDraft,
    });
    const fb = fakeCoverBrowser({ failScreenshot: true });
    const draft = wm.buildWechatMpTools(uid, fb.svc)[1];

    const r = await draft.execute({ title: 't', markdown: BODY }, { taskId: 'm', step: 1 });
    expect(r.success).toBe(true);
    expect(r.cover).toContain('渐变占位');
  });

  it('execute 集成:指定 cover_url → 完全不碰浏览器', async () => {
    const uid = 'wechat-cover3';
    saveCred(uid, CRED);
    stubWechatFetch({
      '/cgi-bin/stable_token': okToken,
      '/cgi-bin/material/add_material': okMaterial,
      '/cgi-bin/draft/add': okDraft,
    });
    // cover_url 下载走 fetch 桩:额外路由 image.example.com
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: any) => {
        const s = String(url);
        if (s.includes('stable_token')) return { ok: true, json: async () => okToken(''), headers: new Map() };
        if (s.includes('add_material')) return { ok: true, json: async () => okMaterial(''), headers: new Map() };
        if (s.includes('draft/add')) return { ok: true, json: async () => okDraft(''), headers: new Map() };
        if (s.includes('example.com')) {
          return {
            ok: true,
            json: async () => ({}),
            headers: new Map([['content-type', 'image/png']]),
            arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
          };
        }
        throw new Error(`unexpected fetch: ${s}`);
      })
    );
    const fb = fakeCoverBrowser();
    const draft = wm.buildWechatMpTools(uid, fb.svc)[1];

    const r = await draft.execute(
      { title: 't', markdown: BODY, cover_url: 'https://example.com/cover.png' },
      { taskId: 'm', step: 1 }
    );
    expect(r.success).toBe(true);
    expect(r.cover).toBe('使用指定封面图');
    expect(fb.acquired()).toBe(0);
  });
});

describe('主题配图检索(Wikimedia Commons)', () => {
  const PHOTO = Buffer.from('P'.repeat(6000)); // ≥5KB 才过大小下限
  const PHOTO2 = Buffer.from('Q'.repeat(6000));

  function commonsPage(id: number, o: { w: number; h: number; license: string; mime?: string; thumb?: string }) {
    return {
      pageid: id,
      title: `File:test${id}.jpg`,
      imageinfo: [
        {
          thumburl: o.thumb || `https://commons.example/thumb${id}.jpg`,
          url: `https://commons.example/file${id}.jpg`,
          descriptionurl: `https://commons.example/wiki/File:test${id}.jpg`,
          width: o.w,
          height: o.h,
          mime: o.mime || 'image/jpeg',
          extmetadata: { LicenseShortName: { value: o.license } },
        },
      ],
    };
  }

  /** fetch 桩:api.php 返回 pages;thumbN 下载路由按前缀匹配 */
  function stubCommonsFetch(pages: unknown[], thumbs: Record<string, Buffer>, apiOk = true) {
    const mock = vi.fn(async (url: any) => {
      const s = String(url);
      if (s.includes('api.php')) {
        if (!apiOk) return { ok: false, json: async () => ({}) };
        return { ok: true, json: async () => ({ query: { pages } }) };
      }
      for (const [prefix, buf] of Object.entries(thumbs)) {
        if (s.includes(prefix)) {
          return { ok: true, json: async () => ({}), arrayBuffer: async () => buf };
        }
      }
      throw new Error(`unexpected fetch: ${s}`);
    });
    vi.stubGlobal('fetch', mock);
    return mock;
  }

  it('过滤规则:只要 CC0/公共领域横图(≥800 宽、比例 1.4~3.2),CC BY/竖图/小图全跳过', async () => {
    const pages = [
      commonsPage(1, { w: 1600, h: 800, license: 'CC BY 4.0' }), // 署名义务无法履行 → 跳过
      commonsPage(2, { w: 800, h: 1200, license: 'CC0' }), // 竖图 → 跳过
      commonsPage(3, { w: 600, h: 400, license: 'CC0' }), // 小图 → 跳过
      commonsPage(4, { w: 1200, h: 500, license: 'CC0' }), // ✓
    ];
    stubCommonsFetch(pages, { thumb4: PHOTO });
    const img = await wm.searchCommonsImage('robot technology');
    expect(img).not.toBeNull();
    expect(img!.bytes.equals(PHOTO)).toBe(true);
    expect(img!.mime).toBe('image/jpeg');
    expect(img!.pageUrl).toContain('File:test4');
  });

  it('全部 CC BY → null(宁缺毋滥,不做无法署名的商用封面)', async () => {
    stubCommonsFetch([commonsPage(1, { w: 1600, h: 800, license: 'CC BY-SA 4.0' })], { thumb1: PHOTO });
    const img = await wm.searchCommonsImage('x');
    expect(img).toBeNull();
  });

  it('空关键词 → null 且不发起请求;API 非 200 → null', async () => {
    const mock = stubCommonsFetch([], {});
    expect(await wm.searchCommonsImage('   ')).toBeNull();
    expect(mock.mock.calls.length).toBe(0);

    stubCommonsFetch([commonsPage(1, { w: 1600, h: 800, license: 'CC0' })], {}, false);
    expect(await wm.searchCommonsImage('k')).toBeNull();
  });

  it('execute 集成:检索到主题图 + 浏览器叠加标题排版 → "主题配图+排版"回执带来源', async () => {
    const uid = 'wechat-photo1';
    saveCred(uid, CRED);
    // 两张可用图随机挑,下载路由都命中同一张字节避免随机性
    const pages = [
      commonsPage(1, { w: 1500, h: 700, license: 'CC0', thumb: 'https://commons.example/thumbA' }),
      commonsPage(2, { w: 1300, h: 600, license: 'Public domain', thumb: 'https://commons.example/thumbB' }),
    ];
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: any) => {
        const s = String(url);
        calls.push(s);
        if (s.includes('api.php') && s.includes('commons')) return { ok: true, json: async () => ({ query: { pages } }) };
        if (s.includes('thumbA') || s.includes('thumbB')) {
          return { ok: true, json: async () => ({}), arrayBuffer: async () => PHOTO };
        }
        if (s.includes('stable_token')) return { ok: true, json: async () => okToken(''), headers: new Map() };
        if (s.includes('add_material')) return { ok: true, json: async () => okMaterial(''), headers: new Map() };
        if (s.includes('draft/add')) return { ok: true, json: async () => okDraft(''), headers: new Map() };
        throw new Error(`unexpected fetch: ${s}`);
      })
    );
    const fb = fakeCoverBrowser();
    const draft = wm.buildWechatMpTools(uid, fb.svc)[1];

    const r = await draft.execute(
      { title: '机器人产业年报', markdown: BODY, digest: '产能与人形机器人的拐点。', cover_keywords: 'robot factory' },
      { taskId: 'm-photo', step: 1 }
    );
    expect(r.success).toBe(true);
    expect(r.cover).toContain('主题配图');
    expect(r.cover).toContain('叠加标题排版');
    expect(String(r.coverImageSource)).toContain('wiki/File:test');
    // 渲染 HTML:照片 data URL 打底 + 白字(照片变体)
    const html = fb.tempCalls.find((c) => c.m === 'setContent')?.a as string;
    expect(html).toContain('data:image/jpeg;base64,');
    expect(html).toContain('scrim');
    expect(html).toContain('rgba(13,16,22,0.86)');
    // 上传的是叠加排版后的截图,不是原图
    const fetchMock = (globalThis as any).fetch as any;
    const formBody = fetchMock.mock.calls.find((c: any[]) => String(c[0]).includes('add_material'))[1].body as FormData;
    const blob = formBody.get('media') as Blob;
    expect(Buffer.from(await blob.arrayBuffer()).toString()).toBe('PNGCOVER_BYTES');
    expect(fb.shared.polluted).toBe(0);
  });

  it('execute 集成:无浏览器时检索到主题图 → 原图直接作封面(jpeg)', async () => {
    const uid = 'wechat-photo2';
    saveCred(uid, CRED);
    const pages = [commonsPage(7, { w: 1500, h: 700, license: 'CC0', thumb: 'https://commons.example/thumbC' })];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: any) => {
        const s = String(url);
        if (s.includes('api.php')) return { ok: true, json: async () => ({ query: { pages } }) };
        if (s.includes('thumbC')) return { ok: true, json: async () => ({}), arrayBuffer: async () => PHOTO2 };
        if (s.includes('stable_token')) return { ok: true, json: async () => okToken(''), headers: new Map() };
        if (s.includes('add_material')) return { ok: true, json: async () => okMaterial(''), headers: new Map() };
        if (s.includes('draft/add')) return { ok: true, json: async () => okDraft(''), headers: new Map() };
        throw new Error(`unexpected fetch: ${s}`);
      })
    );
    const draft = wm.buildWechatMpTools(uid)[1]; // 不传 browser

    const r = await draft.execute(
      { title: 't', markdown: BODY, cover_keywords: 'robot' },
      { taskId: 'm', step: 1 }
    );
    expect(r.success).toBe(true);
    expect(r.cover).toContain('直接作封面');
    const fetchMock = (globalThis as any).fetch as any;
    const formBody = fetchMock.mock.calls.find((c: any[]) => String(c[0]).includes('add_material'))[1].body as FormData;
    const blob = formBody.get('media') as Blob;
    expect(Buffer.from(await blob.arrayBuffer()).equals(PHOTO2)).toBe(true);
    expect(blob.type).toBe('image/jpeg');
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
