import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  startTakeover,
  sendTakeoverInput,
  subscribeTakeoverEvents,
  stopTakeover,
  getTakeoverSession,
  resetTakeoverSessionsForTest,
  type TakeoverPageLike,
  type TakeoverDeps,
  type CdpSessionLike,
  type TakeoverEvent,
  type TakeoverInput,
} from '@/lib/browser-takeover';

/**
 * 浏览器接管会话单测:同用户 409、CDP 帧合并上屏、晚连补发、
 * 输入映射与白名单、初始导航、停止与空闲看门狗 —— 全部用 fake
 * browser/CDP,真实 Playwright 行为已另行实测(2026-10-11 无头探针)。
 */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** fake Page:记录所有输入转发调用 + 按事件名留存处理器(供 dialog/framenavigated 测试触发) */
function fakePage(opts: { gotoFail?: boolean } = {}): TakeoverPageLike & {
  calls: { method: string; args: any[] }[];
  navigatedTo: string | null;
  mainFrameObj: {};
  handlers: Map<string, ((arg: any) => void)[]>;
} {
  const calls: { method: string; args: any[] }[] = [];
  const handlers = new Map<string, ((arg: any) => void)[]>();
  let currentUrl = 'https://creator.xiaohongshu.com/publish/publish';
  const rec = (method: string, ...args: any[]) => {
    calls.push({ method, args });
    return Promise.resolve();
  };
  const mainFrameObj = {};
  return {
    calls,
    navigatedTo: null,
    mainFrameObj,
    handlers,
    url: () => currentUrl,
    goto: (url: string) => {
      if (opts.gotoFail) return Promise.reject(new Error('nav blocked'));
      rec('goto', url);
      currentUrl = url;
      return Promise.resolve();
    },
    title: () => Promise.resolve('发布'),
    on: (event: string, cb: (arg: any) => void) => {
      (fakePage as any).__cb = cb;
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event)!.push(cb);
    },
    mainFrame: () => mainFrameObj,
    keyboard: {
      press: (key: string, o?: any) => rec('key', key, o),
      type: (text: string, o?: any) => rec('type', text, o),
      insertText: (text: string) => rec('insert', text),
    },
    mouse: {
      click: (x: number, y: number, o?: any) => rec('click', x, y, o),
      move: (x: number, y: number, o?: any) => rec('move', x, y, o),
      wheel: (dx: number, dy: number) => rec('wheel', dx, dy),
    },
    goBack: (o?: any) => rec('back', o),
    goForward: (o?: any) => rec('forward', o),
    reload: (o?: any) => rec('reload', o),
  };
}

/** fake CDP:捕获 screencast 启停与帧 ack;可手动注帧 */
function fakeCdp() {
  const listeners = new Map<string, ((p: any) => void)[]>();
  const sent: { method: string; params?: any }[] = [];
  const cdp: CdpSessionLike = {
    on: (event: string, cb: (p: any) => void) => {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event)!.push(cb);
    },
    send: (method: string, params?: any) => {
      sent.push({ method, params });
      return Promise.resolve();
    },
    detach: () => Promise.resolve(),
  };
  return {
    cdp,
    sent,
    emitFrame: (n = 1) => {
      for (const cb of listeners.get('Page.screencastFrame') || []) {
        cb({
          data: `jpeg${n}`,
          sessionId: 's1',
          metadata: { deviceWidth: 1280, deviceHeight: 800 },
        });
      }
    },
  };
}

/** fake BrowserContext:可注册 'page' 监听并手动模拟新标签打开(测跟随重定向) */
function fakeContext() {
  const pageHandlers: ((p: any) => void)[] = [];
  return {
    on: (event: string, cb: any) => {
      if (event === 'page') pageHandlers.push(cb);
    },
    off: (event: string, cb: any) => {
      if (event !== 'page') return;
      const i = pageHandlers.indexOf(cb);
      if (i >= 0) pageHandlers.splice(i, 1);
    },
    emitPage: (p: any) => {
      for (const cb of [...pageHandlers]) cb(p);
    },
    handlerCount: () => pageHandlers.length,
  };
}

/** 带 context()/bringToFront 的 fake Page(用于新标签跟随测试) */
function fakePageWithCtx(ctx: ReturnType<typeof fakeContext>) {
  const p = fakePage() as any;
  p.context = () => ctx;
  p.bringToFront = () => {
    p.calls.push({ method: 'bringToFront', args: [] });
    return Promise.resolve();
  };
  return p as ReturnType<typeof fakePage>;
}

/** 多页 deps:cdpFactory 按 Page 分配独立 fakeCdp(验证旧页停流、新页起流) */
function makeDepsMulti(firstPage: TakeoverPageLike) {
  const cdpByPage = new Map<any, ReturnType<typeof fakeCdp>>();
  const deps: TakeoverDeps = {
    browser: { acquirePage: () => Promise.resolve(firstPage) },
    cdpFactory: (p: any) => {
      if (!cdpByPage.has(p)) cdpByPage.set(p, fakeCdp());
      return Promise.resolve(cdpByPage.get(p)!.cdp);
    },
    flushMs: 10,
    idleMs: 5000,
    retentionMs: 30,
  };
  return { deps, cdpByPage };
}

function makeDeps(page: ReturnType<typeof fakePage>, cdpTool = fakeCdp()): TakeoverDeps {
  return {
    browser: { acquirePage: () => Promise.resolve(page) },
    cdpFactory: () => Promise.resolve(cdpTool.cdp),
    // 小间隔让真实定时器在测试时限内跑完
    flushMs: 10,
    idleMs: 80,
    retentionMs: 30,
  };
}

describe('startTakeover 会话管理', () => {
  beforeEach(() => resetTakeoverSessionsForTest());
  afterEach(() => resetTakeoverSessionsForTest());

  it('启动 → 返回 sessionId;screencast 已开 + 初始 nav 事件', async () => {
    const page = fakePage();
    const cdpTool = fakeCdp();
    const r = startTakeover('u1', makeDeps(page, cdpTool));
    expect('sessionId' in r).toBe(true);
    await sleep(60);
    expect(cdpTool.sent.some((s) => s.method === 'Page.startScreencast')).toBe(true);

    const events: TakeoverEvent[] = [];
    subscribeTakeoverEvents((r as any).sessionId, (e) => events.push(e));
    // 晚连补发:初始 nav(带 title)
    expect(events.some((e) => e.type === 'nav' && e.url.includes('publish/publish'))).toBe(true);
  });

  it('同用户已有进行中会话 → conflict(路由层转 409)', () => {
    const page = fakePage();
    startTakeover('u1', makeDeps(page));
    const r2 = startTakeover('u1', makeDeps(fakePage()));
    expect('conflict' in r2).toBe(true);
    // 其他用户不受影响
    const r3 = startTakeover('u2', makeDeps(fakePage()));
    expect('sessionId' in r3).toBe(true);
  });

  it('初始导航:合法 http url → goto;javascript: 伪装 → 不导航', async () => {
    const page = fakePage();
    const deps = makeDeps(page);
    startTakeover('u1', deps, { url: 'https://creator.xiaohongshu.com/publish/publish' });
    await sleep(30);
    const gotoCalls = page.calls.filter((c) => c.method === 'goto');
    expect(gotoCalls.length).toBeGreaterThanOrEqual(1);

    const page2 = fakePage();
    startTakeover('u1b', makeDeps(page2), { url: 'javascript:alert(1)' });
    await sleep(30);
    expect(page2.calls.filter((c) => c.method === 'goto')).toHaveLength(0);
  });
});

describe('CDP 帧流', () => {
  beforeEach(() => resetTakeoverSessionsForTest());
  afterEach(() => resetTakeoverSessionsForTest());

  it('screencastFrame → ack 回执 + 合并 flush 后上屏(带视口尺寸)', async () => {
    const page = fakePage();
    const cdpTool = fakeCdp();
    const r = startTakeover('u1', makeDeps(page, cdpTool));
    await sleep(20);

    const events: TakeoverEvent[] = [];
    subscribeTakeoverEvents((r as any).sessionId, (e) => events.push(e));

    cdpTool.emitFrame(1);
    cdpTool.emitFrame(2); // burst:合并只发最新
    cdpTool.emitFrame(3);
    await sleep(40);

    const frames = events.filter((e) => e.type === 'frame');
    expect(frames.length).toBe(1); // 一轮 flush 只发一次
    expect((frames[0] as any).data).toBe('jpeg3');
    expect((frames[0] as any).w).toBe(1280);
    expect((frames[0] as any).h).toBe(800);
    // 每帧都 ack(否则后续帧停发)
    expect(cdpTool.sent.filter((s) => s.method === 'Page.screencastFrameAck').length).toBe(3);
  });

  it('晚连订阅 → 补发最近一帧,不黑屏', async () => {
    const page = fakePage();
    const cdpTool = fakeCdp();
    const r = startTakeover('u1', makeDeps(page, cdpTool));
    await sleep(20);
    cdpTool.emitFrame(7);
    await sleep(40);

    const events: TakeoverEvent[] = [];
    subscribeTakeoverEvents((r as any).sessionId, (e) => events.push(e));
    const frames = events.filter((e) => e.type === 'frame');
    expect(frames.length).toBe(1);
    expect((frames[0] as any).data).toBe('jpeg7');
  });
});

describe('sendTakeoverInput 输入映射', () => {
  beforeEach(() => resetTakeoverSessionsForTest());
  afterEach(() => resetTakeoverSessionsForTest());

  async function startSession(): Promise<{ page: ReturnType<typeof fakePage>; id: string }> {
    const page = fakePage();
    const r = startTakeover('u1', makeDeps(page));
    await sleep(30);
    return { page, id: (r as any).sessionId };
  }

  it('click → mouse.click(坐标+按钮+双击计数)', async () => {
    const { page, id } = await startSession();
    const r = await sendTakeoverInput(id, { type: 'click', x: 100, y: 200, button: 'right', clickCount: 2 });
    expect(r.ok).toBe(true);
    const c = page.calls.find((x) => x.method === 'click')!;
    expect(c.args[0]).toBe(100);
    expect(c.args[1]).toBe(200);
    expect(c.args[2].button).toBe('right');
    expect(c.args[2].clickCount).toBe(2);
  });

  it('scroll → move + wheel;key/type/insert 正确转发', async () => {
    const { page, id } = await startSession();
    await sendTakeoverInput(id, { type: 'scroll', x: 5, y: 5, deltaX: 0, deltaY: 300 });
    expect(page.calls.find((x) => x.method === 'wheel')!.args).toEqual([0, 300]);

    await sendTakeoverInput(id, { type: 'key', key: 'Control+a' });
    expect(page.calls.find((x) => x.method === 'key')!.args[0]).toBe('Control+a');

    await sendTakeoverInput(id, { type: 'insert', text: '中文正文' });
    expect(page.calls.find((x) => x.method === 'insert')!.args[0]).toBe('中文正文');
  });

  it('白名单拒绝:坐标越界/坏键名/非 http url/超长文本', async () => {
    const { page, id } = await startSession();
    const bad: TakeoverInput[] = [
      { type: 'click', x: 99999, y: 0 },
      { type: 'key', key: 'Foo Bar!' },
      { type: 'goto', url: 'javascript:alert(1)' },
      { type: 'insert', text: 'x'.repeat(5001) },
    ];
    for (const input of bad) {
      const r = await sendTakeoverInput(id, input);
      expect(r.ok).toBe(false);
    }
    // 拒绝的输入不落到页面
    expect(page.calls.filter((x) => x.method === 'click' || x.method === 'key')).toHaveLength(0);
  });
});

describe('会话终态', () => {
  beforeEach(() => resetTakeoverSessionsForTest());
  afterEach(() => resetTakeoverSessionsForTest());

  it('stopTakeover → done(stopped) + stopScreencast;Page 保留不关闭', async () => {
    const page = fakePage();
    const cdpTool = fakeCdp();
    const r = startTakeover('u1', makeDeps(page, cdpTool));
    await sleep(20);

    const events: TakeoverEvent[] = [];
    subscribeTakeoverEvents((r as any).sessionId, (e) => events.push(e));

    expect(stopTakeover((r as any).sessionId)).toBe(true);
    expect(events.some((e) => e.type === 'done' && e.outcome === 'stopped')).toBe(true);
    expect(cdpTool.sent.some((s) => s.method === 'Page.stopScreencast')).toBe(true);
    // 输入在终态后被拒
    const rr = await sendTakeoverInput((r as any).sessionId, { type: 'click', x: 1, y: 1 });
    expect(rr.ok).toBe(false);
  });

  it('空闲看门狗:无输入且无订阅者 → idle 收摊', async () => {
    const page = fakePage();
    // retentionMs 拉长:final 之后保留会话,才能从 getTakeoverSession 观测终态
    const r = startTakeover('u1', { ...makeDeps(page), idleMs: 60, retentionMs: 5000 });
    const id = (r as any).sessionId;
    const unsub = subscribeTakeoverEvents(id, () => {});
    await sleep(30); // 等看门狗首拍
    unsub?.(); // 模拟用户关页(订阅清零)
    await sleep(200);
    const info = getTakeoverSession(id);
    expect(info?.final?.outcome).toBe('idle');
  });
});

describe('新标签跟随(popup 重定向)', () => {
  beforeEach(() => resetTakeoverSessionsForTest());
  afterEach(() => resetTakeoverSessionsForTest());

  it('站点开新标签 → 投射与输入重定向到最新页,旧页停投射', async () => {
    const ctx = fakeContext();
    const page1 = fakePageWithCtx(ctx);
    const { deps, cdpByPage } = makeDepsMulti(page1);
    const r = startTakeover('u1', deps);
    await sleep(30);
    // 初始:绑首页起了投射
    expect(cdpByPage.get(page1)!.sent.some((s) => s.method === 'Page.startScreencast')).toBe(true);

    // 站点在流程里开了新标签(如扫码登录弹窗)
    const page2 = fakePageWithCtx(ctx);
    ctx.emitPage(page2);
    await sleep(30);

    const cdp1 = cdpByPage.get(page1)!;
    const cdp2 = cdpByPage.get(page2)!;
    // 旧页停投射 + detach
    expect(cdp1.sent.some((s) => s.method === 'Page.stopScreencast')).toBe(true);
    // 新页起投射
    expect(cdp2.sent.some((s) => s.method === 'Page.startScreencast')).toBe(true);
    // 新页置前
    expect(page2.calls.some((c) => c.method === 'bringToFront')).toBe(true);

    // 输入重定向到新页,不再落到旧页
    const id = (r as any).sessionId;
    const rr = await sendTakeoverInput(id, { type: 'click', x: 10, y: 20 });
    expect(rr.ok).toBe(true);
    expect(page2.calls.some((c) => c.method === 'click')).toBe(true);
    expect(page1.calls.some((c) => c.method === 'click')).toBe(false);
  });

  it('重定向后向客户端发 status(已切换标签)+ nav(新页地址)', async () => {
    const ctx = fakeContext();
    const page1 = fakePageWithCtx(ctx);
    const { deps } = makeDepsMulti(page1);
    const r = startTakeover('u1', deps);
    await sleep(20);
    const events: TakeoverEvent[] = [];
    subscribeTakeoverEvents((r as any).sessionId, (e) => events.push(e));

    ctx.emitPage(fakePageWithCtx(ctx));
    await sleep(30);
    expect(events.some((e) => e.type === 'status' && e.detail.includes('新打开的标签页'))).toBe(true);
  });

  it('会话结束 → 摘掉 context 的新标签监听(共享 context 不残留钩子)', async () => {
    const ctx = fakeContext();
    const page1 = fakePageWithCtx(ctx);
    const { deps } = makeDepsMulti(page1);
    const r = startTakeover('u1', deps);
    await sleep(20);
    expect(ctx.handlerCount()).toBe(1);
    stopTakeover((r as any).sessionId);
    expect(ctx.handlerCount()).toBe(0);
  });

  it('重定向时先摘旧页监听再挂新页(同一 context 上监听数不累积)', async () => {
    const ctx = fakeContext();
    const page1 = fakePageWithCtx(ctx);
    const { deps } = makeDepsMulti(page1);
    startTakeover('u1', deps);
    await sleep(20);
    expect(ctx.handlerCount()).toBe(1);
    ctx.emitPage(fakePageWithCtx(ctx)); // 重定向到 page2
    await sleep(30);
    expect(ctx.handlerCount()).toBe(1); // 旧的已摘、新的已挂,净 1
  });
});

describe('原生对话框兜底', () => {
  beforeEach(() => resetTakeoverSessionsForTest());
  afterEach(() => resetTakeoverSessionsForTest());

  it('dialog → 自动 accept 解阻 + status 留痕', async () => {
    const page = fakePage();
    const r = startTakeover('u1', makeDeps(page));
    await sleep(20);
    const events: TakeoverEvent[] = [];
    subscribeTakeoverEvents((r as any).sessionId, (e) => events.push(e));

    const dialogHandlers = page.handlers.get('dialog') || [];
    expect(dialogHandlers.length).toBe(1);
    let accepted = false;
    dialogHandlers[0]({ accept: () => { accepted = true; return Promise.resolve(); } });
    expect(accepted).toBe(true);
    expect(events.some((e) => e.type === 'status' && e.detail.includes('对话框'))).toBe(true);
  });
});
