/**
 * 浏览器接管会话(scenario-loop §6「发布权归人」)。
 *
 * 背景:小红书 2026-10-11 改版后网页草稿只存浏览器本地(IndexedDB),容器里存的
 * 草稿用户在手机 App 看不见 —— 「工具存草稿 → 用户去发布」的闭环被平台掐死。
 * 解法:把容器里这个已登录的持久化浏览器「投射」给用户 —— CDP screencast 推帧,
 * 鼠标/键盘事件回传转发到同一 Page。任务工具填好的发布页原样在屏幕上,
 * 用户亲眼核对、亲自点发布,发布权永远在人手里。
 *
 * 通道选择:不开新公网端口跑 noVNC(VNC 密码太弱,等于裸奔),走 SSE + 受
 * 会话鉴权的 API;帧为 CDP `Page.startScreencast` JPEG,输入走 Playwright
 * page.mouse/page.keyboard(内部即 CDP Input 域,headless 实测可用)。
 *
 * 可测性:浏览器服务/CDP 会话/时钟全部依赖注入,mock 即可覆盖
 * 同用户 409、输入映射、帧合并、空闲超时、终态清理等分支。
 */

/** 接管帧:JPEG base64 + 页面视口尺寸(客户端按此做坐标缩放) */
export interface TakeoverFrameEvent {
  type: 'frame';
  data: string;
  w: number;
  h: number;
  ts: number;
}

export interface TakeoverNavEvent {
  type: 'nav';
  url: string;
  title?: string;
  ts: number;
}

export interface TakeoverStatusEvent {
  type: 'status';
  detail: string;
  ts: number;
}

export interface TakeoverDoneEvent {
  type: 'done';
  outcome: 'stopped' | 'idle' | 'capped' | 'error';
  detail?: string;
  ts: number;
}

export type TakeoverEvent =
  | TakeoverFrameEvent
  | TakeoverNavEvent
  | TakeoverStatusEvent
  | TakeoverDoneEvent;

/** 接管的输入事件(客户端 → 服务器 → Playwright) */
export type TakeoverInput =
  | { type: 'click'; x: number; y: number; button?: 'left' | 'right' | 'middle'; clickCount?: number }
  | { type: 'move'; x: number; y: number }
  | { type: 'scroll'; x: number; y: number; deltaX: number; deltaY: number }
  | { type: 'key'; key: string }
  | { type: 'type'; text: string }
  | { type: 'insert'; text: string }
  | { type: 'back' }
  | { type: 'forward' }
  | { type: 'reload' }
  | { type: 'goto'; url: string };

/** Playwright Page 的最小面(接管只用这些;真 Page 原生具备) */
export interface TakeoverPageLike {
  url(): string;
  goto(url: string, opts?: any): Promise<any>;
  title(): Promise<string>;
  /** 事件订阅(framenavigated / dialog 等;真 Page 有,fake 可省略) */
  on?(event: string, cb: (arg: any) => void): void;
  /** 所属 BrowserContext(真 Page 有;用于 context.on('page') 跟随新标签) */
  context?(): any;
  /** 置前(真 Page 有;确保投射的是前台页而非后台旧标签) */
  bringToFront?(): Promise<void>;
  /** 是否已关闭(真 Page 有) */
  isClosed?(): boolean;
  /** 主框架(framenavigated 过滤用;真 Page 有) */
  mainFrame?(): any;
  keyboard: {
    press(key: string, opts?: any): Promise<void>;
    type(text: string, opts?: any): Promise<void>;
    insertText(text: string): Promise<void>;
  };
  mouse: {
    click(x: number, y: number, opts?: any): Promise<void>;
    move(x: number, y: number, opts?: any): Promise<void>;
    wheel(deltaX: number, deltaY: number): Promise<void>;
  };
  goBack?(opts?: any): Promise<any>;
  goForward?(opts?: any): Promise<any>;
  reload?(opts?: any): Promise<any>;
}

/** CDP 会话最小面(screencast 启停 + 帧事件) */
export interface CdpSessionLike {
  on(event: string, cb: (params: any) => void): void;
  send(method: string, params?: any): Promise<any>;
  detach(): Promise<void>;
}

export interface TakeoverDeps {
  browser: { acquirePage(userId?: string): Promise<TakeoverPageLike> };
  /** CDP 会话工厂;缺省用真 Page 的 context().newCDPSession(page) */
  cdpFactory?: (page: TakeoverPageLike) => Promise<CdpSessionLike>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** 帧合并的刷新间隔(默认 80ms:burst 帧只发最新,防 SSE 洪泛) */
  flushMs?: number;
  /** 空闲超时:无输入且无订阅者(默认 10 分钟)后自动收摊 */
  idleMs?: number;
  /** 单会话硬上限(默认 60 分钟) */
  capMs?: number;
  /** 终态后 session 保留时长(晚连 SSE 回放 done;默认 60s) */
  retentionMs?: number;
}

const DEFAULT_FLUSH_MS = 80;
const DEFAULT_IDLE_MS = 10 * 60_000;
const DEFAULT_CAP_MS = 60 * 60_000;
const DEFAULT_RETENTION_MS = 60_000;

interface TakeoverSession {
  sessionId: string;
  userId: string;
  createdAt: number;
  subscribers: Set<(e: TakeoverEvent) => void>;
  lastFrame?: TakeoverFrameEvent;
  lastNav?: TakeoverNavEvent;
  final: TakeoverDoneEvent | null;
  /** 输入/订阅活动的最后时刻(idle 判定) */
  lastActiveAt: number;
  page: TakeoverPageLike | null;
  cdp: CdpSessionLike | null;
  /** 帧合并:待刷的最新帧(screencast burst 只留最新) */
  pendingFrame: { data: string; w: number; h: number } | null;
  flushTimer: ReturnType<typeof setInterval> | null;
  idleTimer: ReturnType<typeof setInterval> | null;
  stopRequested: boolean;
  /** 新标签跟随的清理函数(finish/stop 时 off 掉 context.on('page') 监听,防共享 context 累积) */
  removePopupFollow?: () => void;
  /** 重定向串行链(并发弹窗时防 detach/attach 交错) */
  retargetChain?: Promise<void>;
}

const sessions = new Map<string, TakeoverSession>();
const userSessionIds = new Map<string, string>();

function newSessionId(): string {
  return `tk_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/** 测试隔离用:清空全部会话(生产代码不得调用) */
export function resetTakeoverSessionsForTest() {
  for (const s of sessions.values()) {
    if (s.flushTimer) clearInterval(s.flushTimer);
    if (s.idleTimer) clearInterval(s.idleTimer);
  }
  sessions.clear();
  userSessionIds.clear();
}

/** 路由层鉴权/冲突查询用 */
export function getTakeoverSession(sessionId: string): {
  userId: string;
  final: TakeoverDoneEvent | null;
  lastNav?: TakeoverNavEvent;
} | null {
  const s = sessions.get(sessionId);
  if (!s) return null;
  return { userId: s.userId, final: s.final, lastNav: s.lastNav };
}

function emit(session: TakeoverSession, event: TakeoverEvent) {
  if (session.final && event.type !== 'done') return;
  if (event.type === 'frame') session.lastFrame = event;
  if (event.type === 'nav') session.lastNav = event;
  for (const cb of session.subscribers) {
    try {
      cb(event);
    } catch {}
  }
}

/**
 * 启动接管会话:附着到该用户的持久化 Page(与任务工具/登录共享同一浏览器),
 * 启动 CDP screencast 推帧。同用户已有进行中的会话 → conflict(路由层转 409,
 * 客户端直接接上既有流)。
 */
export function startTakeover(
  userId: string,
  deps: TakeoverDeps,
  opts?: { url?: string }
): { sessionId: string } | { conflict: true; sessionId: string } {
  const existing = userSessionIds.get(userId);
  if (existing && sessions.has(existing) && !sessions.get(existing)!.final) {
    return { conflict: true, sessionId: existing };
  }

  const session: TakeoverSession = {
    sessionId: newSessionId(),
    userId,
    createdAt: Date.now(),
    subscribers: new Set(),
    final: null,
    lastActiveAt: Date.now(),
    page: null,
    cdp: null,
    pendingFrame: null,
    flushTimer: null,
    idleTimer: null,
    stopRequested: false,
  };
  sessions.set(session.sessionId, session);
  userSessionIds.set(userId, session.sessionId);

  // 异步自驱动(不阻塞路由返回;错误收敛为 done 事件)
  void drive(session, deps, opts).catch(() => {});
  return { sessionId: session.sessionId };
}

async function drive(
  session: TakeoverSession,
  deps: TakeoverDeps,
  opts?: { url?: string }
) {
  const now = deps.now || (() => Date.now());
  const flushMs = deps.flushMs ?? DEFAULT_FLUSH_MS;
  const idleMs = deps.idleMs ?? DEFAULT_IDLE_MS;
  const capMs = deps.capMs ?? DEFAULT_CAP_MS;
  const retentionMs = deps.retentionMs ?? DEFAULT_RETENTION_MS;

  const finish = (outcome: TakeoverDoneEvent['outcome'], detail?: string) => {
    if (session.final) return;
    const done: TakeoverDoneEvent = { type: 'done', outcome, detail, ts: now() };
    session.final = done;
    if (session.flushTimer) clearInterval(session.flushTimer);
    if (session.idleTimer) clearInterval(session.idleTimer);
    session.flushTimer = null;
    session.idleTimer = null;
    session.removePopupFollow?.();
    // 停流但不关 Page/浏览器:登录态与页面状态留给后续任务/接管复用
    if (session.cdp) {
      session.cdp.send('Page.stopScreencast').catch(() => {});
      session.cdp.detach().catch(() => {});
      session.cdp = null;
    }
    emit(session, done);
    if (retentionMs > 0) {
      setTimeout(() => {
        if (sessions.get(session.sessionId)?.final === done) {
          sessions.delete(session.sessionId);
          if (userSessionIds.get(session.userId) === session.sessionId) {
            userSessionIds.delete(session.userId);
          }
        }
      }, retentionMs);
    }
  };

  // —— 投射/重定向的可复用单元(初始附着 + 新标签跟随共用)——

  const cdpFactory =
    deps.cdpFactory ||
    ((p: TakeoverPageLike) =>
      (p as any).context().newCDPSession(p) as Promise<CdpSessionLike>);

  /** 给指定 Page 挂 CDP screencast,帧写入 session.pendingFrame */
  async function attachScreencast(page: TakeoverPageLike): Promise<void> {
    const cdp = await cdpFactory(page);
    session.cdp = cdp;
    let viewW = 1280;
    let viewH = 800;
    cdp.on('Page.screencastFrame', (f: any) => {
      // 必须 ack 否则后续帧停发
      cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {});
      if (f.metadata?.deviceWidth) viewW = f.metadata.deviceWidth;
      if (f.metadata?.deviceHeight) viewH = f.metadata.deviceHeight;
      session.pendingFrame = { data: f.data, w: viewW, h: viewH };
    });
    await cdp.send('Page.startScreencast', {
      format: 'jpeg',
      quality: 60,
      maxWidth: 1280,
      maxHeight: 800,
      everyNthFrame: 1,
    });
  }

  /** 停当前投射(停流 + detach CDP + 丢弃旧页残帧) */
  function detachScreencast(): void {
    if (session.cdp) {
      session.cdp.send('Page.stopScreencast').catch(() => {});
      session.cdp.detach().catch(() => {});
      session.cdp = null;
    }
    session.pendingFrame = null;
  }

  /** 原生对话框兜底:alert/confirm/prompt 不在 screencast 里渲染且会阻塞输入,自动接受解阻并留痕 */
  function attachDialogHandler(page: TakeoverPageLike): void {
    if (typeof page.on !== 'function') return;
    try {
      page.on('dialog', (dialog: any) => {
        try {
          dialog?.accept?.();
        } catch {}
        emit(session, {
          type: 'status',
          detail: '页面弹出原生对话框,已自动确认解除阻塞',
          ts: now(),
        });
      });
    } catch {}
  }

  /** 发一条 nav 事件(带 title 兜底) */
  function emitNavFor(page: TakeoverPageLike): void {
    const url = page.url();
    page
      .title()
      .then((title) => emit(session, { type: 'nav', url, title, ts: now() }))
      .catch(() => emit(session, { type: 'nav', url, ts: now() }));
  }

  /** 主框架导航 → nav 事件(客户端刷新地址栏) */
  function attachNavHandler(page: TakeoverPageLike): void {
    if (typeof page.on !== 'function') return;
    let navDebounce: ReturnType<typeof setTimeout> | null = null;
    try {
      page.on('framenavigated', (frame: any) => {
        if (session.final) return;
        try {
          if (typeof page.mainFrame === 'function' && frame !== page.mainFrame()) return;
        } catch {
          // fake Page 无 mainFrame:全部当主框架
        }
        if (navDebounce) clearTimeout(navDebounce);
        navDebounce = setTimeout(() => {
          if (session.final) return;
          emitNavFor(page);
        }, 400);
      });
    } catch {}
  }

  /** 重定向投射与输入到指定 Page(停旧投射 → 置前 → 挂新投射) */
  async function retargetToPage(page: TakeoverPageLike, reason: string): Promise<void> {
    if (session.final) return;
    detachScreencast();
    session.removePopupFollow?.(); // 摘旧页跟随钩子(共享 context 防监听累积)
    try {
      await page.bringToFront?.();
    } catch {}
    session.page = page;
    attachDialogHandler(page);
    attachNavHandler(page);
    attachPopupFollow(page);
    try {
      await attachScreencast(page);
    } catch (err: any) {
      finish('error', `切换到新标签页失败: ${err?.message || String(err)}`);
      return;
    }
    emit(session, { type: 'status', detail: reason, ts: now() });
    emitNavFor(page);
  }

  /**
   * 新标签跟随:站点把流程甩到新标签(扫码登录/OAuth/target=_blank)时,把投射+输入
   * 重定向到最新页 —— 否则画面与点击都留在旧的启动壳页上,表现为「新开的页面什么都点不了」。
   * context 与任务/登录共享同一 per-user 持久浏览器;并发任务开新标签也会触发跟随
   * (POST 层已提示互相干扰)。
   */
  function attachPopupFollow(page: TakeoverPageLike): void {
    let ctx: any = null;
    try {
      ctx = typeof page.context === 'function' ? page.context() : null;
    } catch {}
    if (!ctx || typeof ctx.on !== 'function') return;
    const handler = (newPage: any) => {
      if (session.final) return;
      // 串行重定向,防并发弹窗 detach/attach 交错
      session.retargetChain = (session.retargetChain || Promise.resolve())
        .then(() => retargetToPage(newPage, '已切换到新打开的标签页'))
        .catch(() => {});
    };
    try {
      ctx.on('page', handler);
      session.removePopupFollow = () => {
        try {
          ctx.off?.('page', handler);
        } catch {}
      };
    } catch {}
  }

  try {
    emit(session, { type: 'status', detail: '正在接管浏览器…', ts: now() });
    const page = await deps.browser.acquirePage(session.userId);
    session.page = page;

    // 可选初始导航(如直接打开发布页)
    const initialUrl = opts?.url;
    if (initialUrl && /^https?:\/\//.test(initialUrl)) {
      await page.goto(initialUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    }

    // 置前:共享持久 profile 的 pages()[0] 可能是后台旧标签,确保投射的是前台页
    try {
      await page.bringToFront?.();
    } catch {}

    // CDP screencast + 对话框兜底
    attachDialogHandler(page);
    await attachScreencast(page);

    // 帧合并 flush:burst(视频/动画)只发最新,防 SSE 洪泛(session 级,重定向复用)
    session.flushTimer = setInterval(() => {
      if (session.final || !session.pendingFrame) return;
      const { data, w, h } = session.pendingFrame;
      session.pendingFrame = null;
      emit(session, { type: 'frame', data, w, h, ts: now() });
    }, flushMs);

    // 空闲/硬上限看门狗
    session.idleTimer = setInterval(() => {
      if (session.final) return;
      if (now() - session.createdAt > capMs) {
        finish('capped', '接管时长达到上限,已自动结束');
        return;
      }
      if (
        now() - session.lastActiveAt > idleMs &&
        session.subscribers.size === 0
      ) {
        finish('idle', '接管长时间无操作,已自动结束');
      }
    }, Math.min(idleMs, 5000));

    // 主框架导航 → nav 事件 + 新标签跟随
    attachNavHandler(page);
    attachPopupFollow(page);

    // 初始 nav 补发(客户端地址栏立即有值)
    emitNavFor(page);
  } catch (err: any) {
    finish('error', err?.message || String(err));
  }
}

/** 键名白名单:单字符 / 命名键 / 修饰键组合(Control+a、Shift+Tab 等) */
const KEY_TOKENS = new Set([
  'Enter', 'Tab', 'Backspace', 'Delete', 'Escape', 'Home', 'End',
  'PageUp', 'PageDown', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'Control', 'Shift', 'Alt', 'Meta',
  'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12',
  'Space',
]);

function validKey(key: string): boolean {
  if (!key || key.length > 30) return false;
  const parts = key.split('+');
  const last = parts.pop()!;
  if (parts.some((m) => !KEY_TOKENS.has(m))) return false;
  return KEY_TOKENS.has(last) || (last.length === 1 && last.charCodeAt(0) > 32 && last.charCodeAt(0) < 127);
}

/** 输入合法性:坐标/滚动量/文本长度/键名白名单(尽力而为,防脏数据打到页面) */
function validateInput(input: TakeoverInput): string | null {
  const int = (v: any) => Number.isInteger(v) && v >= -4000 && v <= 4000;
  switch (input.type) {
    case 'click':
    case 'move':
      if (!int(input.x) || !int(input.y)) return 'bad coords';
      if (input.type === 'click' && input.button && !['left', 'right', 'middle'].includes(input.button)) {
        return 'bad button';
      }
      if (input.type === 'click' && input.clickCount !== undefined) {
        if (!(input.clickCount >= 1 && input.clickCount <= 3)) return 'bad clickCount';
      }
      return null;
    case 'scroll':
      if (!int(input.x) || !int(input.y) || !int(input.deltaX) || !int(input.deltaY)) return 'bad scroll';
      return null;
    case 'key':
      if (!validKey(input.key)) return 'bad key';
      return null;
    case 'type':
    case 'insert':
      if (typeof input.text !== 'string' || input.text.length === 0 || input.text.length > 5000) return 'bad text';
      return null;
    case 'goto':
      if (!/^https?:\/\//.test(input.url) || input.url.length > 2000) return 'bad url';
      return null;
    default:
      return null;
  }
}

/** 转发一条输入到接管中的 Page;返回是否被接受 */
export async function sendTakeoverInput(
  sessionId: string,
  input: TakeoverInput
): Promise<{ ok: true } | { ok: false; error: string }> {
  const session = sessions.get(sessionId);
  if (!session) return { ok: false, error: '会话不存在或已结束' };
  if (session.final) return { ok: false, error: '会话已结束' };
  if (!session.page) return { ok: false, error: '浏览器页面尚未就绪' };

  const invalid = validateInput(input);
  if (invalid) return { ok: false, error: invalid };

  const page = session.page;
  session.lastActiveAt = Date.now();
  try {
    switch (input.type) {
      case 'click':
        await page.mouse.click(input.x, input.y, {
          button: input.button || 'left',
          ...(input.clickCount ? { clickCount: input.clickCount } : {}),
        });
        break;
      case 'move':
        await page.mouse.move(input.x, input.y);
        break;
      case 'scroll':
        await page.mouse.move(input.x, input.y).catch(() => {});
        await page.mouse.wheel(input.deltaX, input.deltaY);
        break;
      case 'key':
        await page.keyboard.press(input.key);
        break;
      case 'type':
        await page.keyboard.type(input.text, { delay: 30 });
        break;
      case 'insert':
        await page.keyboard.insertText(input.text);
        break;
      case 'back':
        if (page.goBack) await page.goBack({ waitUntil: 'domcontentloaded', timeout: 15000 });
        break;
      case 'forward':
        if (page.goForward) await page.goForward({ waitUntil: 'domcontentloaded', timeout: 15000 });
        break;
      case 'reload':
        if (page.reload) await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
        break;
      case 'goto':
        await page.goto(input.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        break;
    }
    return { ok: true };
  } catch (err: any) {
    // 单条输入失败不终止会话(页面跳转瞬间的偶发),如实返回错误
    return { ok: false, error: err?.message || String(err) };
  }
}

/** 结束接管(用户主动;浏览器与页面状态保留) */
export function stopTakeover(sessionId: string): boolean {
  const session = sessions.get(sessionId);
  if (!session || session.final) return false;
  const done: TakeoverDoneEvent = { type: 'done', outcome: 'stopped', ts: Date.now() };
  session.final = done;
  if (session.flushTimer) clearInterval(session.flushTimer);
  if (session.idleTimer) clearInterval(session.idleTimer);
  session.flushTimer = null;
  session.idleTimer = null;
  session.removePopupFollow?.();
  if (session.cdp) {
    session.cdp.send('Page.stopScreencast').catch(() => {});
    session.cdp.detach().catch(() => {});
    session.cdp = null;
  }
  emit(session, done);
  setTimeout(() => {
    if (sessions.get(sessionId)?.final === done) {
      sessions.delete(sessionId);
      if (userSessionIds.get(session.userId) === sessionId) {
        userSessionIds.delete(session.userId);
      }
    }
  }, 60_000);
  return true;
}

/**
 * 订阅接管事件流;返回退订函数。
 * 订阅即时补发:最近一次 nav + 最近一帧(晚连/断线重连不黑屏),再走实时流。
 */
export function subscribeTakeoverEvents(
  sessionId: string,
  cb: (e: TakeoverEvent) => void
): (() => void) | null {
  const s = sessions.get(sessionId);
  if (!s) return null;
  s.subscribers.add(cb);
  s.lastActiveAt = Date.now();
  if (s.lastNav) {
    try {
      cb(s.lastNav);
    } catch {}
  }
  if (s.lastFrame) {
    try {
      cb(s.lastFrame);
    } catch {}
  }
  return () => {
    s.subscribers.delete(cb);
  };
}
