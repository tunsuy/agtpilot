import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
// 纯类型导入(编译期擦除,不影响「先设环境变量再动态 import」的运行时顺序)
import type { XhsManagedRecord, BrowserAuditEntry } from '@/lib/user-store';
import type { XhsBrowserService } from '@/lib/xhs-managed';

/**
 * 小红书托管模式单元测试(scenario-loop P2 模块 2)。
 * 纯决策函数(限频/注入门槛/路径围栏)+ 审计落盘 + 写工具 execute 全链路(fake browser)。
 *
 * 环境隔离:USER_DATA_DIR 指向一次性临时目录(与 governance.spec.ts 同模式),
 * 必须在动态 import 被测模块之前设置。
 */
let tmpDir: string;
let xm: typeof import('@/lib/xhs-managed');
let us: typeof import('@/lib/user-store');

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agtpilot-xhs-'));
  process.env.USER_DATA_DIR = tmpDir;
  process.env.AGTPILOT_SECRET_KEY = 'xhs-managed-test-key';
  delete process.env.AGTPILOT_XHS_DRAFT_DAILY_LIMIT;
  us = await import('@/lib/user-store');
  xm = await import('@/lib/xhs-managed');
});

afterAll(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {}
});

const UID = 'xhs-gate-user';

/** 每个用例独立 userId:审计/托管记录都落盘,共享 uid 会互相串数 */
function writeRecord(uid: string, over: Partial<XhsManagedRecord>) {
  us.saveXhsManaged(uid, { enabled: false, ...over });
  return us.getXhsManaged(uid);
}

/** 发布页假 Page:覆盖 xhs_save_note_draft 全链路所需的面 */
function fakePublishPage(opts: { tagInputFails?: boolean } = {}) {
  return {
    goto: vi.fn(async () => {}),
    fill: vi.fn(async () => {}),
    click: vi.fn(async (sel: string) => {
      if (opts.tagInputFails && String(sel).includes('标签')) throw new Error('no tag input');
    }),
    locator: vi.fn(() => ({ first: () => ({ focus: vi.fn(async () => {}) }) })),
    keyboard: { insertText: vi.fn(async () => {}), press: vi.fn(async () => {}) },
    waitForTimeout: vi.fn(async () => {}),
    getByText: vi.fn(() => ({ first: () => ({ waitFor: vi.fn(async () => {}) }) })),
    setInputFiles: vi.fn(async () => {}),
    screenshot: vi.fn(async () => Buffer.from('jpeg-bytes')),
  };
}

function fakeBrowser(page: any, opts: { hasCookies?: boolean } = {}): XhsBrowserService {
  return {
    acquirePage: vi.fn(async () => page),
    navigateAndDistill: vi.fn(async (_u: string | undefined, url: string) => ({
      url,
      title: '创作中心',
      content: '昨日浏览 1234',
      totalLength: 100,
    })),
    hasCookies: vi.fn(async () => opts.hasCookies ?? true),
  };
}

describe('dailyDraftLimit', () => {
  it('缺省/非法 env → 3', () => {
    expect(xm.dailyDraftLimit()).toBe(3);
    process.env.AGTPILOT_XHS_DRAFT_DAILY_LIMIT = 'abc';
    expect(xm.dailyDraftLimit()).toBe(3);
    process.env.AGTPILOT_XHS_DRAFT_DAILY_LIMIT = '-2';
    expect(xm.dailyDraftLimit()).toBe(3);
    delete process.env.AGTPILOT_XHS_DRAFT_DAILY_LIMIT;
  });

  it('env 可调', () => {
    process.env.AGTPILOT_XHS_DRAFT_DAILY_LIMIT = '5';
    expect(xm.dailyDraftLimit()).toBe(5);
    delete process.env.AGTPILOT_XHS_DRAFT_DAILY_LIMIT;
  });
});

describe('countTodayDraftSaves(本地日界 + 成败都计)', () => {
  const now = new Date('2026-10-10T10:00:00');
  const todayTs = now.getTime();
  const yesterdayTs = todayTs - 24 * 3600 * 1000;

  const entry = (at: number, result: 'success' | 'failure'): BrowserAuditEntry => ({
    at,
    tool: 'xhs_save_note_draft',
    action: 'save_note_draft',
    result,
  });

  it('只统计今天的 xhs_save_note_draft(含失败),其他工具不计', () => {
    const audit = [
      entry(todayTs - 3600_000, 'success'),
      entry(todayTs, 'failure'),
      entry(yesterdayTs, 'success'),
      { at: todayTs, tool: 'xhs_read_creator_data', action: 'read', result: 'success' },
    ] as BrowserAuditEntry[];
    expect(xm.countTodayDraftSaves(audit, now)).toBe(2);
  });

  it('空审计 → 0', () => {
    expect(xm.countTodayDraftSaves([], now)).toBe(0);
  });
});

describe('注入门槛', () => {
  it('读工具:登录过即注入(无需 opt-in)', () => {
    expect(xm.shouldInjectReadTool(undefined)).toBe(false);
    expect(xm.shouldInjectReadTool({ enabled: false, lastLoginAt: Date.now() })).toBe(true);
  });

  it('写工具:enabled + riskAckAt 缺一不可(没读风险明示就不给写权)', () => {
    expect(xm.shouldInjectWriteTool(undefined)).toBe(false);
    expect(xm.shouldInjectWriteTool({ enabled: true, lastLoginAt: Date.now() })).toBe(false);
    expect(
      xm.shouldInjectWriteTool({ enabled: true, riskAckAt: Date.now(), lastLoginAt: Date.now() })
    ).toBe(true);
    expect(xm.shouldInjectWriteTool({ enabled: false, riskAckAt: Date.now() })).toBe(false);
  });

  it('buildXhsManagedTools:按 record 注入对应面;写工具 dangerLevel high / 读工具 low', () => {
    // 无记录 → 空
    us.saveXhsManaged(UID, { enabled: false });
    expect(xm.buildXhsManagedTools(UID, fakeBrowser(fakePublishPage())).length).toBe(0);

    // 只登录过 → 仅读工具
    writeRecord(UID, { lastLoginAt: Date.now() });
    let tools = xm.buildXhsManagedTools(UID, fakeBrowser(fakePublishPage()));
    expect(tools.map((t) => t.name)).toEqual(['xhs_read_creator_data']);
    expect(tools[0].dangerLevel).toBe('low');

    // opt-in + 风险已读 + browser 在场 → 读写齐注入
    writeRecord(UID, { enabled: true, riskAckAt: Date.now(), lastLoginAt: Date.now() });
    tools = xm.buildXhsManagedTools(UID, fakeBrowser(fakePublishPage()));
    expect(tools.map((t) => t.name)).toEqual(['xhs_read_creator_data', 'xhs_save_note_draft']);
    expect(tools[1].dangerLevel).toBe('high');
    expect(tools[1].compensation?.kind).toBe('partially-reversible');

    // browser 服务缺失 → 写工具不注入(读工具注入但执行时报未就绪)
    tools = xm.buildXhsManagedTools(UID, undefined);
    expect(tools.map((t) => t.name)).toEqual(['xhs_read_creator_data']);
  });
});

describe('validateImagePaths(路径围栏)', () => {
  const root = path.join(os.tmpdir(), 'agtpilot-upload-root');
  beforeAll(() => fs.mkdirSync(root, { recursive: true }));
  const img = (name: string) => path.join(root, `${name}.jpg`);

  it('空列表通过', () => {
    expect(xm.validateImagePaths([], root)).toEqual({ ok: true, paths: [] });
  });

  it('工作区内图片通过', () => {
    expect(xm.validateImagePaths([img('a'), img('b')], root).ok).toBe(true);
  });

  it('越界路径拒绝(工作区外不允许)', () => {
    const r = xm.validateImagePaths(['/etc/passwd', img('a')], root);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('越界');
  });

  it('非图片扩展名拒绝', () => {
    const r = xm.validateImagePaths([path.join(root, 'a.txt')], root);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('仅支持图片');
  });

  it('超过 9 张拒绝', () => {
    const r = xm.validateImagePaths(Array.from({ length: 10 }, (_, i) => img(`x${i}`)), root);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('9');
  });
});

describe('xhs_save_note_draft execute 全链路(fake browser)', () => {
  it('参数校验:title/body 必填,正文至少 20 字', async () => {
    const uid = 'xhs-t1';
    writeRecord(uid, { enabled: true, riskAckAt: Date.now(), lastLoginAt: Date.now() });
    const browser = fakeBrowser(fakePublishPage());
    const writeTool = xm.buildXhsManagedTools(uid, browser).find((t) => t.name === 'xhs_save_note_draft')!;
    const r1 = await writeTool.execute({ title: '', body: 'x'.repeat(30) }, { taskId: 'm1', step: 1 });
    expect(r1.success).toBe(false);
    const r2 = await writeTool.execute({ title: 't', body: 'short' }, { taskId: 'm1', step: 1 });
    expect(r2.success).toBe(false);
    // 参数不过 → 不开浏览器
    expect((browser.acquirePage as any).mock.calls.length).toBe(0);
    // 也不产生审计(压根没到写边界)
    expect(us.getBrowserAudit(uid)).toHaveLength(0);
  });

  it('成功链路:填页 + 等自动保存 + 落审计,missionId 入审计', async () => {
    const uid = 'xhs-t2';
    writeRecord(uid, { enabled: true, riskAckAt: Date.now(), lastLoginAt: Date.now() });
    const page = fakePublishPage();
    const writeTool = xm
      .buildXhsManagedTools(uid, fakeBrowser(page))
      .find((t) => t.name === 'xhs_save_note_draft')!;

    const r = await writeTool.execute(
      { title: '通勤穿搭', body: 'x'.repeat(50), tags: ['穿搭'] },
      { taskId: 'mission-42', step: 1 }
    );
    expect(r.success).toBe(true);
    expect(r.message).toContain('今日已用 1/3');
    expect(r.message).toContain('发布由你本人完成');
    // 标题/正文都填了
    expect(page.fill).toHaveBeenCalled();
    expect(page.keyboard.insertText).toHaveBeenCalled();
    // 审计落盘且带 missionId
    const audit = us.getBrowserAudit(uid);
    expect(audit).toHaveLength(1);
    expect(audit[0].result).toBe('success');
    expect(audit[0].missionId).toBe('mission-42');
    expect(audit[0].title).toBe('通勤穿搭');
  });

  it('限频前置:今日已用满 → 不开浏览器直接 rejected', async () => {
    const uid = 'xhs-t3';
    for (let i = 0; i < 3; i++) {
      us.appendBrowserAudit(uid, {
        at: Date.now(),
        tool: 'xhs_save_note_draft',
        action: 'save_note_draft',
        result: 'success',
      });
    }
    writeRecord(uid, { enabled: true, riskAckAt: Date.now(), lastLoginAt: Date.now() });
    const browser = fakeBrowser(fakePublishPage());
    const writeTool = xm
      .buildXhsManagedTools(uid, browser)
      .find((t) => t.name === 'xhs_save_note_draft')!;

    const r = await writeTool.execute({ title: 't', body: 'x'.repeat(30) }, { taskId: 'm', step: 1 });
    expect(r.success).toBe(false);
    expect(r.rejected).toBe(true);
    expect(r.error).toContain('上限');
    expect((browser.acquirePage as any).mock.calls.length).toBe(0);
    // 拒绝不产生新审计(上限即上限,拒绝不计数)
    expect(us.getBrowserAudit(uid)).toHaveLength(3);
  });

  it('未登录:返回扫码引导,审计落 failure/not_logged_in', async () => {
    const uid = 'xhs-t4';
    writeRecord(uid, { enabled: true, riskAckAt: Date.now(), lastLoginAt: Date.now() });
    const page = fakePublishPage();
    const writeTool = xm
      .buildXhsManagedTools(uid, fakeBrowser(page, { hasCookies: false }))
      .find((t) => t.name === 'xhs_save_note_draft')!;

    const r = await writeTool.execute({ title: 't', body: 'x'.repeat(30) }, { taskId: 'm', step: 1 });
    expect(r.success).toBe(false);
    expect(r.error).toContain('扫码');
    const audit = us.getBrowserAudit(uid);
    expect(audit).toHaveLength(1);
    expect(audit[0].result).toBe('failure');
    expect(audit[0].error).toBe('not_logged_in');
  });

  it('标签输入失败 → 降级:tagsFallback 拼入正文并如实返回', async () => {
    const uid = 'xhs-t5';
    writeRecord(uid, { enabled: true, riskAckAt: Date.now(), lastLoginAt: Date.now() });
    const page = fakePublishPage({ tagInputFails: true });
    const writeTool = xm
      .buildXhsManagedTools(uid, fakeBrowser(page))
      .find((t) => t.name === 'xhs_save_note_draft')!;

    const r = await writeTool.execute(
      { title: 't', body: 'x'.repeat(30), tags: ['穿搭', '通勤'] },
      { taskId: 'm', step: 1 }
    );
    expect(r.success).toBe(true);
    expect(r.tagsFallback).toBeDefined();
    expect((r.tagsFallback as string[])[0]).toContain('#穿搭');
    expect((r.tagsFallback as string[])[0]).toContain('#通勤');
  });
});

describe('xhs_read_creator_data execute', () => {
  it('读蒸馏内容;页面白名单外回落 overview', async () => {
    const uid = 'xhs-r1';
    writeRecord(uid, { lastLoginAt: Date.now() });
    const browser = fakeBrowser(fakePublishPage());
    const readTool = xm.buildXhsManagedTools(uid, browser).find((t) => t.name === 'xhs_read_creator_data')!;

    const r = await readTool.execute({ page: 'notes', offset: 0 }, { taskId: 'm', step: 1 });
    expect(r.success).toBe(true);
    expect(r.page).toBe('notes');
    expect(r.content).toContain('昨日浏览');
    expect((browser.navigateAndDistill as any).mock.calls[0][1]).toContain('note-manager');

    const r2 = await readTool.execute({ page: 'hacked' }, { taskId: 'm', step: 1 });
    expect(r2.page).toBe('overview');
  });

  it('登录态失效:返回引导文案,不导航', async () => {
    const uid = 'xhs-r2';
    writeRecord(uid, { lastLoginAt: Date.now() });
    const browser = fakeBrowser(fakePublishPage(), { hasCookies: false });
    const readTool = xm.buildXhsManagedTools(uid, browser).find((t) => t.name === 'xhs_read_creator_data')!;

    const r = await readTool.execute({ page: 'overview' }, { taskId: 'm', step: 1 });
    expect(r.success).toBe(false);
    expect(r.error).toContain('扫码');
    expect((browser.navigateAndDistill as any).mock.calls.length).toBe(0);
  });
});

describe('审计滚动上限', () => {
  it('appendBrowserAudit 超过 200 条滚动裁剪', () => {
    const uid = 'xhs-audit-user';
    for (let i = 0; i < 230; i++) {
      us.appendBrowserAudit(uid, {
        at: Date.now(),
        tool: 'xhs_read_creator_data',
        action: 'read',
        result: 'success',
      });
    }
    expect(us.getBrowserAudit(uid)).toHaveLength(200);
  });
});
