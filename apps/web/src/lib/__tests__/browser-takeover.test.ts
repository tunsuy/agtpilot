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

/** fake Page:记录所有输入转发调用 */
function fakePage(opts: { gotoFail?: boolean } = {}): TakeoverPageLike & {
  calls: { method: string; args: any[] }[];
  navigatedTo: string | null;
  mainFrameObj: {};
} {
  const calls: { method: string; args: any[] }[] = [];
  let currentUrl = 'https://creator.xiaohongshu.com/publish/publish';
  const rec = (method: string, ...args: any[]) => {
    calls.push({ method, args });
    return Promise.resolve();
  };
  return {
    calls,
    navigatedTo: null,
    mainFrameObj: {},
    url: () => currentUrl,
    goto: (url: string) => {
      if (opts.gotoFail) return Promise.reject(new Error('nav blocked'));
      rec('goto', url);
      currentUrl = url;
      return Promise.resolve();
    },
    title: () => Promise.resolve('发布'),
    on: (event: string, cb: (frame: any) => void) => {
      (fakePage as any).__cb = cb;
    },
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
