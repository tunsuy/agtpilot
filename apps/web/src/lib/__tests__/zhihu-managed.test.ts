import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { vi } from 'vitest';
// 纯类型导入(编译期擦除,不影响「先设环境变量再动态 import」的运行时顺序)
import type { ZhihuManagedRecord, BrowserAuditEntry } from '@/lib/user-store';
import type { ZhihuBrowserService } from '@/lib/zhihu-managed';

/**
 * 知乎托管模式单元测试(与 xhs-managed.test.ts 同构)。
 * 纯决策函数(限频/注入门槛)+ 审计落盘 + 写工具 execute 全链路(fake browser)。
 *
 * 环境隔离:USER_DATA_DIR 指向一次性临时目录,必须在动态 import 被测模块之前设置。
 */
let tmpDir: string;
let zm: typeof import('@/lib/zhihu-managed');
let us: typeof import('@/lib/user-store');

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agtpilot-zhihu-'));
  process.env.USER_DATA_DIR = tmpDir;
  process.env.AGTPILOT_SECRET_KEY = 'zhihu-managed-test-key';
  delete process.env.AGTPILOT_ZHIHU_DRAFT_DAILY_LIMIT;
  us = await import('@/lib/user-store');
  zm = await import('@/lib/zhihu-managed');
});

afterAll(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {}
});

/** 每个用例独立 userId:审计/托管记录都落盘,共享 uid 会互相串数 */
function writeRecord(uid: string, over: Partial<ZhihuManagedRecord>) {
  us.saveZhihuManaged(uid, { enabled: false, ...over });
  return us.getZhihuManaged(uid);
}

/**
 * 知乎专栏编辑器假 Page:覆盖 zhihu_save_article_draft 全链路所需的面。
 * redirectLogin = goto 后被重定向回 signin(登录态在导航后失效);
 * autosaveFails = 自动保存指示永远不出现(等不到也放行,只作附注)。
 */
function fakeZhihuPage(opts: { autosaveFails?: boolean; redirectLogin?: boolean } = {}) {
  const state = { url: 'about:blank' };
  return {
    goto: vi.fn(async (url: string) => {
      state.url = opts.redirectLogin ? 'https://www.zhihu.com/signin?next=%2Fwrite' : url;
    }),
    url: vi.fn(() => state.url),
    fill: vi.fn(async () => {}),
    click: vi.fn(async () => {}),
    locator: vi.fn((sel: string) => {
      const isTitle = String(sel).includes('标题');
      return {
        count: vi.fn(async () => (isTitle && !opts.redirectLogin ? 1 : 0)),
        first: () => ({ focus: vi.fn(async () => {}) }),
      };
    }),
    keyboard: {
      insertText: vi.fn(async () => {}),
      press: vi.fn(async () => {}),
    },
    getByText: vi.fn(() => ({
      first: () => ({
        waitFor: vi.fn(async () => {
          if (opts.autosaveFails) throw new Error('timeout');
        }),
      }),
    })),
    screenshot: vi.fn(async () => Buffer.from('jpeg-bytes')),
  };
}

function fakeBrowser(page: any, opts: { hasCookies?: boolean } = {}): ZhihuBrowserService {
  return {
    acquirePage: vi.fn(async () => page),
    hasCookies: vi.fn(async () => opts.hasCookies ?? true),
  };
}

describe('dailyDraftLimit(知乎)', () => {
  it('缺省/非法 env → 3', () => {
    expect(zm.dailyDraftLimit()).toBe(3);
    process.env.AGTPILOT_ZHIHU_DRAFT_DAILY_LIMIT = 'abc';
    expect(zm.dailyDraftLimit()).toBe(3);
    process.env.AGTPILOT_ZHIHU_DRAFT_DAILY_LIMIT = '-2';
    expect(zm.dailyDraftLimit()).toBe(3);
    delete process.env.AGTPILOT_ZHIHU_DRAFT_DAILY_LIMIT;
  });

  it('env 可调', () => {
    process.env.AGTPILOT_ZHIHU_DRAFT_DAILY_LIMIT = '5';
    expect(zm.dailyDraftLimit()).toBe(5);
    delete process.env.AGTPILOT_ZHIHU_DRAFT_DAILY_LIMIT;
  });
});

describe('countTodayDraftSaves(本地日界 + 成败都计,按知乎工具名过滤)', () => {
  const now = new Date('2026-10-10T10:00:00');
  const todayTs = now.getTime();
  const yesterdayTs = todayTs - 24 * 3600 * 1000;

  const entry = (at: number, result: 'success' | 'failure'): BrowserAuditEntry => ({
    at,
    tool: 'zhihu_save_article_draft',
    action: 'save_article_draft',
    result,
  });

  it('只统计今天的 zhihu_save_article_draft(含失败),其他工具不计', () => {
    const audit = [
      entry(todayTs - 3600_000, 'success'),
      entry(todayTs, 'failure'),
      entry(yesterdayTs, 'success'),
      { at: todayTs, tool: 'xhs_save_note_draft', action: 'save_note_draft', result: 'success' },
    ] as BrowserAuditEntry[];
    expect(zm.countTodayDraftSaves(audit, now)).toBe(2);
  });

  it('空审计 → 0', () => {
    expect(zm.countTodayDraftSaves([], now)).toBe(0);
  });
});

describe('注入门槛与红线(知乎)', () => {
  it('写工具:enabled + riskAckAt 缺一不可', () => {
    expect(zm.shouldInjectWriteTool(undefined)).toBe(false);
    expect(zm.shouldInjectWriteTool({ enabled: true, lastLoginAt: Date.now() })).toBe(false);
    expect(
      zm.shouldInjectWriteTool({ enabled: true, riskAckAt: Date.now(), lastLoginAt: Date.now() })
    ).toBe(true);
    expect(zm.shouldInjectWriteTool({ enabled: false, riskAckAt: Date.now() })).toBe(false);
  });

  it('buildZhihuManagedTools:opt-in + browser 在场才注入;dangerLevel high', () => {
    const uid = 'zhihu-gate-user';
    // 无记录 → 空
    us.saveZhihuManaged(uid, { enabled: false });
    expect(zm.buildZhihuManagedTools(uid, fakeBrowser(fakeZhihuPage())).length).toBe(0);

    // opt-in + 风险已读 + browser 在场 → 写工具注入
    writeRecord(uid, { enabled: true, riskAckAt: Date.now(), lastLoginAt: Date.now() });
    const tools = zm.buildZhihuManagedTools(uid, fakeBrowser(fakeZhihuPage()));
    expect(tools.map((t) => t.name)).toEqual(['zhihu_save_article_draft']);
    expect(tools[0].dangerLevel).toBe('high');
    expect(tools[0].compensation?.kind).toBe('partially-reversible');

    // browser 服务缺失 → 不注入
    expect(zm.buildZhihuManagedTools(uid, undefined).length).toBe(0);
  });

  it('选择器配置表里不存在发布按钮(三层红线之二)', () => {
    const dumped = JSON.stringify(zm.ZHIHU_EDITOR_SELECTORS, (_k, v) =>
      v instanceof RegExp ? String(v) : v
    );
    expect(dumped).not.toMatch(/发布/);
    expect(dumped).not.toMatch(/publish|submit/i);
  });
});

describe('zhihu_save_article_draft execute 全链路', () => {
  const okArgs = { title: '测试文章标题', body: '这是一段足够长的正文内容,用于通过最少 20 字的校验门槛。' };

  function buildTool(uid: string, page: any, browser?: ZhihuBrowserService) {
    writeRecord(uid, { enabled: true, riskAckAt: Date.now(), lastLoginAt: Date.now() });
    const b = browser || fakeBrowser(page);
    const tools = zm.buildZhihuManagedTools(uid, b);
    return { tool: tools[0], browser: b };
  }

  it('参数缺失 → 直接拒绝,不开浏览器不落审计', async () => {
    const uid = 'zhihu-t1';
    const page = fakeZhihuPage();
    const { tool, browser } = buildTool(uid, page);
    const res: any = await (tool.execute as any)({ title: '', body: '' }, { taskId: 'm1' });
    expect(res.success).toBe(false);
    expect(res.error).toContain('必填');
    expect((browser.acquirePage as any).mock.calls.length).toBe(0);
    expect(us.getBrowserAudit(uid).length).toBe(0);
  });

  it('限频前置:今日已满 3 次 → rejected,不开浏览器不落审计', async () => {
    const uid = 'zhihu-t2';
    const page = fakeZhihuPage();
    const { tool, browser } = buildTool(uid, page);
    for (let i = 0; i < 3; i++) {
      us.appendBrowserAudit(uid, {
        at: Date.now(),
        tool: 'zhihu_save_article_draft',
        action: 'save_article_draft',
        result: i === 2 ? 'failure' : 'success',
      });
    }
    const before = us.getBrowserAudit(uid).length;
    const res: any = await (tool.execute as any)(okArgs, { taskId: 'm2' });
    expect(res.success).toBe(false);
    expect(res.rejected).toBe(true);
    expect(res.error).toContain('上限');
    expect((browser.acquirePage as any).mock.calls.length).toBe(0);
    expect(us.getBrowserAudit(uid).length).toBe(before);
  });

  it('未登录(cookie 缺失)→ not_logged_in,不开浏览器,审计落 failure', async () => {
    const uid = 'zhihu-t3';
    const page = fakeZhihuPage();
    const browser = fakeBrowser(page, { hasCookies: false });
    const { tool } = buildTool(uid, page, browser);
    const res: any = await (tool.execute as any)(okArgs, { taskId: 'm3' });
    expect(res.success).toBe(false);
    expect(res.error).toContain('扫码');
    expect((browser.acquirePage as any).mock.calls.length).toBe(0);
    const audit = us.getBrowserAudit(uid);
    expect(audit[0].result).toBe('failure');
    expect(audit[0].error).toBe('not_logged_in');
    expect(audit[0].missionId).toBe('m3');
  });

  it('goto 后被重定向回 signin → not_logged_in(登录态导航后失效)', async () => {
    const uid = 'zhihu-t4';
    const page = fakeZhihuPage({ redirectLogin: true });
    const { tool } = buildTool(uid, page);
    const res: any = await (tool.execute as any)(okArgs, { taskId: 'm4' });
    expect(res.success).toBe(false);
    expect(res.error).toContain('扫码');
    const audit = us.getBrowserAudit(uid);
    expect(audit[0].result).toBe('failure');
    expect(audit[0].error).toBe('not_logged_in');
  }, 30000);

  it('成功链路:填标题正文 → 审计 success → 消息含用量与发布围栏话术', async () => {
    const uid = 'zhihu-t5';
    const page = fakeZhihuPage();
    const { tool } = buildTool(uid, page);
    const res: any = await (tool.execute as any)(okArgs, { taskId: 'm5' });
    expect(res.success).toBe(true);
    expect(res.title).toBe(okArgs.title);
    expect(res.message).toContain('今日已用 1/3');
    expect(res.message).toContain('发布由你本人完成');
    expect(res.message).toContain('平台已自动保存进草稿箱');
    expect(res.screenshotBase64).toContain('data:image/jpeg;base64,');
    expect(page.fill).toHaveBeenCalledWith(zm.ZHIHU_EDITOR_SELECTORS.titleInput, okArgs.title, expect.anything());
    expect(page.keyboard.press).toHaveBeenCalledWith('Control+a');
    expect(page.keyboard.insertText).toHaveBeenCalledWith(okArgs.body);
    const audit = us.getBrowserAudit(uid);
    expect(audit[0].result).toBe('success');
    expect(audit[0].tool).toBe('zhihu_save_article_draft');
    expect(audit[0].title).toBe(okArgs.title);
    expect(audit[0].missionId).toBe('m5');
  }, 30000);

  it('自动保存指示未出现 → 仍算成功,消息如实告知未确认', async () => {
    const uid = 'zhihu-t6';
    const page = fakeZhihuPage({ autosaveFails: true });
    const { tool } = buildTool(uid, page);
    const res: any = await (tool.execute as any)(okArgs, { taskId: 'm6' });
    expect(res.success).toBe(true);
    expect(res.message).toContain('自动保存未确认');
    const audit = us.getBrowserAudit(uid);
    expect(audit[0].result).toBe('success');
    expect(audit[0].error).toContain('未等到自动保存指示');
  }, 30000);
});
