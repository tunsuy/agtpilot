import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  startBrowserLogin,
  cancelBrowserLogin,
  getLoginSession,
  subscribeLoginEvents,
  checkLoginState,
  ensureQrLoginMode,
  resetLoginSessionsForTest,
  XHS_CREATOR_HOME,
  XHS_LOGIN_COOKIE_NAMES,
  XHS_SMS_INPUT_SELECTOR,
  XHS_QR_SWITCH_SELECTOR,
  type LoginBrowserDeps,
  type LoginEvent,
  type LoginDeps,
  type PageLike,
} from '../browser-login';

/** 自旋等待条件成立(轮询 5ms,默认 2s 上限) */
async function waitUntil(fn: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  if (!fn()) throw new Error('waitUntil 超时');
}

interface MockPage extends PageLike {
  gotoCalls: string[];
  clickCalls: string[];
}

/** loginMode:模拟登录卡形态 —— sms 短信表单 / qr 扫码视图 / none 卡未挂载或改版 */
function makeMockPage(url: string, loginMode: 'sms' | 'qr' | 'none' = 'none'): MockPage {
  let current = url;
  let mode = loginMode;
  const gotoCalls: string[] = [];
  const clickCalls: string[] = [];
  const page: MockPage = {
    gotoCalls,
    clickCalls,
    goto: vi.fn(async (u: string) => {
      gotoCalls.push(u);
      current = u;
    }),
    url: () => current,
    isVisible: vi.fn(async (sel: string) => {
      if (mode === 'none') return false;
      if (sel === XHS_SMS_INPUT_SELECTOR) return mode === 'sms';
      if (sel.startsWith('text=')) return mode === 'qr';
      return false;
    }),
    click: vi.fn(async (sel: string) => {
      clickCalls.push(sel);
      // 点角标 = 切到扫码视图(与真实站点行为一致)
      if (sel === XHS_QR_SWITCH_SELECTOR && mode === 'sms') mode = 'qr';
    }),
  };
  return page;
}

function makeMockBrowser(
  opts: { cookiesAfter?: number; frameUrl?: string; throwFirstFrame?: boolean; loginMode?: 'sms' | 'qr' | 'none' } = {}
) {
  const page = makeMockPage(XHS_CREATOR_HOME, opts.loginMode ?? 'none');
  let cookieCalls = 0;
  let frameCalls = 0;
  const acquirePage = vi.fn(async () => page);
  const captureFrame = vi.fn(async () => {
    frameCalls += 1;
    if (opts.throwFirstFrame && frameCalls === 1) throw new Error('页面跳转瞬间截图失败');
    return {
      screenshotBase64: `shot-${frameCalls}`,
      url: opts.frameUrl ?? XHS_CREATOR_HOME,
    };
  });
  const hasCookies = vi.fn(async (_userId?: string, _domain?: string, _names?: string[]) => {
    cookieCalls += 1;
    return cookieCalls >= (opts.cookiesAfter ?? Infinity);
  });
  const pageUrl = vi.fn(() => null);
  const browser: LoginBrowserDeps = { acquirePage, captureFrame, hasCookies, pageUrl };
  return { browser, page, mocks: { acquirePage, captureFrame, hasCookies, pageUrl } };
}

/** 测试基线:让出事件循环的瞬时 sleep + 固定时钟 + 长 retention(会话终态后仍可回放) */
function baseDeps(browser: LoginBrowserDeps, overrides: Partial<LoginDeps> = {}): LoginDeps {
  return {
    browser,
    // 必须走真实 setTimeout:纯微任务 sleep 会让轮询循环饿死事件循环
    sleep: async () => {
      await new Promise((r) => setTimeout(r, 0));
    },
    pollIntervalMs: 1,
    settleMs: 0,
    retentionMs: 100_000,
    // 扫码态切换的等待上限置小:mock sleep 瞬时,避免 'none' 形态用例空转真实 8s
    qrMountWaitMs: 20,
    qrSwitchWaitMs: 20,
    ...overrides,
  };
}

beforeEach(() => {
  resetLoginSessionsForTest();
});

describe('checkLoginState', () => {
  it('cookie 命中 + 已离开登录页 → true', () => {
    expect(checkLoginState(true, 'https://creator.xiaohongshu.com/')).toBe(true);
  });

  it('URL 仍在登录流程(如重定向回 login)→ false', () => {
    expect(checkLoginState(true, 'https://creator.xiaohongshu.com/login/index')).toBe(false);
  });

  it('无 cookie → false;空 URL 不崩溃', () => {
    expect(checkLoginState(false, 'https://creator.xiaohongshu.com/')).toBe(false);
    expect(checkLoginState(true, '')).toBe(true);
  });
});

describe('startBrowserLogin 状态机', () => {
  it('已登录短路:profile 里本有登录态 → 不轮询直接 success,并回调 onLoginSuccess', async () => {
    const { browser, page, mocks } = makeMockBrowser({ cookiesAfter: 1 });
    const onLoginSuccess = vi.fn();
    const { sessionId } = startBrowserLogin('u1', baseDeps(browser, { onLoginSuccess }));

    await waitUntil(() => !!getLoginSession(sessionId)?.final);
    const session = getLoginSession(sessionId)!;
    expect(session.final?.outcome).toBe('success');
    expect(onLoginSuccess).toHaveBeenCalledWith('u1');
    // 帧轮询从未发生(captureFrame 未被调用)
    expect(mocks.captureFrame).not.toHaveBeenCalled();
    // 终态收尾:Page 导航回 about:blank 释放单 Page 占用
    expect(page.gotoCalls).toContain('about:blank');
  });

  it('扫码命中:轮询中 cookie 出现 → success,帧事件已推送', async () => {
    // cookiesAfter 3 = 短路检查一次 false + 轮询一轮 false + 轮询二轮 true
    const { browser } = makeMockBrowser({ cookiesAfter: 3 });
    const events: LoginEvent[] = [];
    const { sessionId } = startBrowserLogin('u2', baseDeps(browser));
    const unsub = subscribeLoginEvents(sessionId, (e) => events.push(e))!;

    await waitUntil(() => !!getLoginSession(sessionId)?.final);
    unsub();
    expect(getLoginSession(sessionId)!.final?.outcome).toBe('success');
    // 帧确实推过(用户端看到过二维码)
    expect(events.some((e) => e.type === 'frame')).toBe(true);
    // 状态机走完 waiting → confirming → success
    const phases = events.filter((e) => e.type === 'status').map((e) => (e as any).phase);
    expect(phases).toContain('waiting');
    expect(phases).toContain('confirming');
    expect(phases).toContain('success');
  });

  it('截图偶发失败不终止:抛一次后下一轮重试继续轮询', async () => {
    const { browser, mocks } = makeMockBrowser({ cookiesAfter: 4, throwFirstFrame: true });
    const { sessionId } = startBrowserLogin('u3', baseDeps(browser));

    await waitUntil(() => !!getLoginSession(sessionId)?.final);
    expect(getLoginSession(sessionId)!.final?.outcome).toBe('success');
    expect(mocks.captureFrame.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it('超时:注入时钟越过 timeoutMs → done timeout', async () => {
    const { browser } = makeMockBrowser(); // 永不命中 cookie
    let t = 0;
    const { sessionId } = startBrowserLogin(
      'u4',
      baseDeps(browser, { now: () => (t += 50), timeoutMs: 200 })
    );

    await waitUntil(() => !!getLoginSession(sessionId)?.final);
    const final = getLoginSession(sessionId)!.final!;
    expect(final.outcome).toBe('timeout');
    expect(final.detail).toContain('超时');
  });

  it('取消:进行中 cancel → done cancelled', async () => {
    const { browser } = makeMockBrowser(); // 永不命中,停在 waiting
    const { sessionId } = startBrowserLogin('u5', baseDeps(browser));
    // 状态机停在第一个 await(acquirePage)前同步置取消
    expect(cancelBrowserLogin(sessionId)).toBe(true);

    await waitUntil(() => !!getLoginSession(sessionId)?.final);
    expect(getLoginSession(sessionId)!.final?.outcome).toBe('cancelled');
    // 终态后再取消 → false
    expect(cancelBrowserLogin(sessionId)).toBe(false);
  });

  it('同用户已有进行中会话 → conflict 并带回原 sessionId', async () => {
    const { browser } = makeMockBrowser(); // 永不命中 cookie
    // 推进时钟 + 短超时,保证后台循环很快自行终止(不留永转的循环)
    let t = 0;
    const deps = baseDeps(browser, { now: () => (t += 50), timeoutMs: 200 });
    const first = startBrowserLogin('u6', deps);
    const second = startBrowserLogin('u6', deps);

    expect((second as any).conflict).toBe(true);
    expect((second as any).sessionId).toBe(first.sessionId);
    // 等第一个会话超时收尾,避免后台循环泄漏到后续用例
    await waitUntil(() => !!getLoginSession(first.sessionId)?.final);
    expect(getLoginSession(first.sessionId)!.final?.outcome).toBe('timeout');
  });

  it('晚连补发:结束后才订阅也能回放 status 历史 + lastFrame + done', async () => {
    const { browser } = makeMockBrowser({ cookiesAfter: 3 });
    const { sessionId } = startBrowserLogin('u7', baseDeps(browser));
    await waitUntil(() => !!getLoginSession(sessionId)?.final);

    const replayed: LoginEvent[] = [];
    const unsub = subscribeLoginEvents(sessionId, (e) => replayed.push(e))!;
    unsub();
    // status 历史(终态 done 在内)与最近一帧都补发了
    const types = replayed.map((e) => e.type);
    expect(types).toContain('status');
    expect(types).toContain('frame');
    expect(types).toContain('done');
    const doneEvent = replayed.find((e) => e.type === 'done') as any;
    expect(doneEvent.outcome).toBe('success');
    // lastFrame 是最近一帧
    const frame = replayed.find((e) => e.type === 'frame') as any;
    expect(frame.screenshotBase64).toBe(getLoginSession(sessionId)!.lastFrame!.screenshotBase64);
  });

  it('浏览器服务抛错 → 收敛为 error 终态,不向上抛', async () => {
    const broken: LoginBrowserDeps = {
      acquirePage: async () => {
        throw new Error('浏览器启动失败');
      },
      captureFrame: async () => ({ screenshotBase64: '', url: '' }),
      hasCookies: async () => false,
      pageUrl: () => null,
    };
    const { sessionId } = startBrowserLogin('u8', baseDeps(broken));

    await waitUntil(() => !!getLoginSession(sessionId)?.final);
    const final = getLoginSession(sessionId)!.final!;
    expect(final.outcome).toBe('error');
    expect(final.detail).toContain('浏览器启动失败');
  });

  it('登录判定使用约定常量:域名 + cookie 名单', async () => {
    const { browser, mocks } = makeMockBrowser({ cookiesAfter: 1 });
    startBrowserLogin('u9', baseDeps(browser));
    await waitUntil(() => mocks.hasCookies.mock.calls.length >= 1);
    const [, domain, names] = mocks.hasCookies.mock.calls[0];
    expect(domain).toBe(XHS_CREATOR_HOME);
    expect(names).toEqual(XHS_LOGIN_COOKIE_NAMES);
  });

  it('短信态登录页:状态机自动点角标切到扫码视图', async () => {
    const { browser, page } = makeMockBrowser({ cookiesAfter: 3, loginMode: 'sms' });
    const { sessionId } = startBrowserLogin('u10', baseDeps(browser));

    await waitUntil(() => !!getLoginSession(sessionId)?.final);
    expect(getLoginSession(sessionId)!.final?.outcome).toBe('success');
    expect(page.clickCalls).toContain(XHS_QR_SWITCH_SELECTOR);
  });

  it('已是扫码态:不重复点角标', async () => {
    const { browser, page } = makeMockBrowser({ cookiesAfter: 3, loginMode: 'qr' });
    const { sessionId } = startBrowserLogin('u11', baseDeps(browser));

    await waitUntil(() => !!getLoginSession(sessionId)?.final);
    expect(getLoginSession(sessionId)!.final?.outcome).toBe('success');
    expect(page.clickCalls).toEqual([]);
  });
});

describe('ensureQrLoginMode', () => {
  const noopSleep = async () => {};

  it('短信态 → 点角标 → 确认扫码态 true', async () => {
    const page = makeMockPage(XHS_CREATOR_HOME, 'sms');
    await expect(ensureQrLoginMode(page, noopSleep)).resolves.toBe(true);
    expect(page.clickCalls).toEqual([XHS_QR_SWITCH_SELECTOR]);
  });

  it('站方本就扫码态 → 不点击直接 true', async () => {
    const page = makeMockPage(XHS_CREATOR_HOME, 'qr');
    await expect(ensureQrLoginMode(page, noopSleep)).resolves.toBe(true);
    expect(page.clickCalls).toEqual([]);
  });

  it('登录卡未挂载/改版 → 等挂载超时后 false,不抛错', async () => {
    const page = makeMockPage(XHS_CREATOR_HOME, 'none');
    await expect(ensureQrLoginMode(page, noopSleep, { mountWaitMs: 30 })).resolves.toBe(false);
    expect(page.clickCalls).toEqual([]);
  });

  it('Page 缺 isVisible/click 能力 → 降级 false,不干预页面', async () => {
    const bare: PageLike = makeMockPage(XHS_CREATOR_HOME, 'sms');
    delete bare.isVisible;
    delete bare.click;
    await expect(ensureQrLoginMode(bare, noopSleep)).resolves.toBe(false);
  });

  it('角标点击抛错(站方改版)→ 收敛 false', async () => {
    const page = makeMockPage(XHS_CREATOR_HOME, 'sms');
    page.click = vi.fn(async () => {
      throw new Error('selector 失配');
    });
    await expect(ensureQrLoginMode(page, noopSleep)).resolves.toBe(false);
  });
});
