/**
 * 小红书网页版扫码登录状态机(scenario-loop P2 模块 1)。
 *
 * 远程部署形态:浏览器跑在服务器(无头),登录二维码实时截图回传前端,
 * 用户用手机小红书 App 扫码 —— 登录态落在 per-user 持久化 profile 目录,
 * 之后任务工具(xhs_read_creator_data / xhs_save_note_draft)与登录共享同一 Page。
 *
 * 可测性:浏览器服务/时钟/等待全部依赖注入,mock ctx.browser 即可覆盖
 * 已登录短路、cookie 命中、超时、同用户 409、lastFrame 补发等分支。
 */

import type { XhsManagedRecord } from './user-store';

/** ⚠️ 待真实账号实测的常量:登录页 URL、登录态 cookie 名。实测后修正这里,不改逻辑。 */
export const XHS_CREATOR_HOME = 'https://creator.xiaohongshu.com/';
/**
 * 登录态判定 cookie。⚠️ 2026-10-10 冒烟实测发现:a1 是匿名访客首访就会被种的设备
 * cookie,不能当登录信号(全新 profile 打开首页即被误判「已登录」);只有 web_session
 * 才代表真实扫码登录。判定语义是「命中任一即登录」,所以这里必须只放 web_session。
 */
export const XHS_LOGIN_COOKIE_NAMES = ['web_session'];
/** URL 出现在登录流程中(如重定向回登录页)则视为未登录完成 */
export const XHS_LOGIN_URL_HINT = /login/i;

/**
 * 登录页(creator.xiaohongshu.com/login)默认是「短信登录」表单,而扫码通道需要二维码视图。
 * 以下选择器 2026-10-10 无头实测:全用结构/文案锚点,不依赖站方 emotion 哈希 class(css-xxxx 每次发版都变)。
 */
/** 短信登录态判定:手机号输入框可见 */
export const XHS_SMS_INPUT_SELECTOR = 'input[placeholder="手机号"]';
/** 扫码态判定文案(「扫码即同意 用户协议 和 隐私政策」只在二维码视图出现) */
export const XHS_QR_MODE_TEXT = '扫码即同意';
/** 切换角标:登录卡右上角图标。短信态下它是 `.sso-login-wrapper` 内唯一 img,点击即切「APP扫一扫登录」 */
export const XHS_QR_SWITCH_SELECTOR = '.sso-login-wrapper img';
/** 等登录卡挂载 / 等切换生效的上限(登录卡是客户端渲染,goto 后需要几秒才挂载) */
export const QR_MOUNT_WAIT_MS = 8000;
export const QR_SWITCH_WAIT_MS = 8000;

/** 轮询间隔:截图推帧 + 登录判定 */
export const LOGIN_POLL_INTERVAL_MS = 1500;
/** 整体超时(可用 AGTPILOT_BROWSER_LOGIN_TIMEOUT_MS 覆盖) */
export const LOGIN_TIMEOUT_MS = Number(process.env.AGTPILOT_BROWSER_LOGIN_TIMEOUT_MS) || 300_000;
/** 登录命中后的落稳等待(等跳转完成、cookie 写全) */
export const LOGIN_SETTLE_MS = 2000;
/** 终态后 session 保留时长(晚连的 SSE 仍可回放 done) */
export const LOGIN_SESSION_RETENTION_MS = 60_000;

export type LoginPhase = 'starting' | 'opening' | 'waiting' | 'confirming' | 'success' | 'timeout' | 'cancelled' | 'error';

export interface LoginStatusEvent {
  type: 'status';
  phase: LoginPhase;
  detail?: string;
  ts: number;
}

export interface LoginFrameEvent {
  type: 'frame';
  screenshotBase64: string;
  url: string;
  ts: number;
}

export interface LoginDoneEvent {
  type: 'done';
  outcome: 'success' | 'timeout' | 'cancelled' | 'error';
  detail?: string;
  ts: number;
}

export type LoginEvent = LoginStatusEvent | LoginFrameEvent | LoginDoneEvent;

/** 结构化的浏览器服务依赖(与 plugin-browser 的 ctx.browser 同构;测试可 mock) */
export interface LoginBrowserDeps {
  acquirePage(userId?: string): Promise<PageLike>;
  captureFrame(userId?: string): Promise<{ screenshotBase64: string; url: string }>;
  hasCookies(userId: string | undefined, domain: string, names: string[]): Promise<boolean>;
  pageUrl(userId?: string): string | null;
}

/** Page 的最小面(状态机只用 goto/url;isVisible/click 供扫码态切换,真 Page 原生具备) */
export interface PageLike {
  goto(url: string, opts?: any): Promise<any>;
  url(): string;
  /** 可选:元素可见性判定(mock 可省略,省略时扫码态切换降级为不干预) */
  isVisible?(selector: string): Promise<boolean>;
  /** 可选:选择器点击(mock 可省略) */
  click?(selector: string, opts?: any): Promise<any>;
}

export interface LoginDeps {
  browser: LoginBrowserDeps;
  /** 登录成功回调(真实环境写 user-store 的 xhsManaged.lastLoginAt) */
  onLoginSuccess?: (userId: string) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  pollIntervalMs?: number;
  timeoutMs?: number;
  settleMs?: number;
  /** 扫码态切换:等登录卡挂载 / 等切换生效的上限(测试置小值) */
  qrMountWaitMs?: number;
  qrSwitchWaitMs?: number;
  /** 终态后 session 清理延迟(测试置 0) */
  retentionMs?: number;
}

interface LoginSession {
  sessionId: string;
  userId: string;
  createdAt: number;
  /** status/done 事件回放缓冲(最近 100 条;frame 不进缓冲,单独走 lastFrame) */
  events: LoginEvent[];
  lastFrame?: LoginFrameEvent;
  subscribers: Set<(e: LoginEvent) => void>;
  final: LoginDoneEvent | null;
  cancelRequested: boolean;
}

const sessions = new Map<string, LoginSession>();
const userSessionIds = new Map<string, string>();

function newSessionId(): string {
  return `login_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/** 测试隔离用:清空全部会话(生产代码不得调用) */
export function resetLoginSessionsForTest() {
  sessions.clear();
  userSessionIds.clear();
}

function emit(session: LoginSession, event: LoginEvent) {
  // 终态后只允许 done 本身;防止清理竞态里的迟发事件
  if (session.final && event.type !== 'done') return;
  if (event.type !== 'frame') {
    session.events.push(event);
    if (session.events.length > 100) session.events.splice(0, session.events.length - 100);
  }
  if (event.type === 'frame') {
    session.lastFrame = event;
  }
  for (const cb of session.subscribers) {
    try {
      cb(event);
    } catch {
      // 订阅方异常不阻断状态机
    }
  }
}

function isLoginUrl(url: string): boolean {
  return XHS_LOGIN_URL_HINT.test(url || '');
}

/**
 * 登录判定:cookie 命中 + 当前 URL 已离开登录流程。
 * (⚠️ cookie 名与 URL 形态待实测,集中在文件头常量)
 */
export function checkLoginState(
  hasCookies: boolean,
  currentUrl: string
): boolean {
  return hasCookies && !isLoginUrl(currentUrl);
}

/**
 * 登录页默认停在「短信登录」表单,而扫码通道要的是二维码视图:
 * 登录卡挂载后若手机号输入框可见,点击卡右上角角标切到「APP扫一扫登录」。
 * 尽力而为:站方改版导致选择器失配时返回 false、不抛错,帧流原样展示页面,人工仍可自救。
 * 返回 true = 已确认处于扫码态(含站方本就默认扫码);false = 未确认(卡未挂载/改版/能力缺失)。
 */
export async function ensureQrLoginMode(
  page: PageLike,
  sleep: (ms: number) => Promise<void>,
  opts?: { mountWaitMs?: number; switchWaitMs?: number; tickMs?: number }
): Promise<boolean> {
  if (!page.isVisible || !page.click) return false;
  const tick = opts?.tickMs ?? 500;
  const visible = async (sel: string) => {
    try {
      return await page.isVisible!(sel);
    } catch {
      // 页面跳转瞬间等偶发失败按不可见处理,下一轮重试
      return false;
    }
  };
  const qrMarker = `text=${XHS_QR_MODE_TEXT}`;

  // 登录卡客户端渲染:等到两种形态之一出现才算挂载
  const mountDeadline = Date.now() + (opts?.mountWaitMs ?? QR_MOUNT_WAIT_MS);
  let smsVisible = false;
  while (Date.now() < mountDeadline) {
    if (await visible(qrMarker)) return true; // 站方本就默认扫码态
    smsVisible = await visible(XHS_SMS_INPUT_SELECTOR);
    if (smsVisible) break;
    await sleep(tick);
  }
  if (!smsVisible) return false;

  try {
    await page.click(XHS_QR_SWITCH_SELECTOR, { timeout: 5000 });
  } catch {
    return false;
  }

  // 模式切换即时生效(二维码图片另走 qr-code 接口,实测 1-4s,由帧流自然带出)
  const switchDeadline = Date.now() + (opts?.switchWaitMs ?? QR_SWITCH_WAIT_MS);
  while (Date.now() < switchDeadline) {
    if (await visible(qrMarker)) return true;
    await sleep(tick);
  }
  return false;
}

/**
 * 启动登录会话。同用户已有进行中的会话 → 返回 conflict(路由层转 409)。
 * 状态机异步自驱动,调用方拿到 sessionId 后经 SSE 订阅事件。
 */
export function startBrowserLogin(
  userId: string,
  deps: LoginDeps
): { sessionId: string } | { conflict: true; sessionId: string } {
  const existing = userSessionIds.get(userId);
  if (existing && sessions.has(existing) && !sessions.get(existing)!.final) {
    return { conflict: true, sessionId: existing };
  }

  const session: LoginSession = {
    sessionId: newSessionId(),
    userId,
    createdAt: Date.now(),
    events: [],
    subscribers: new Set(),
    final: null,
    cancelRequested: false,
  };
  sessions.set(session.sessionId, session);
  userSessionIds.set(userId, session.sessionId);

  // 状态机自驱动(不阻塞调用方;错误全部收敛为终态事件)
  void drive(session, deps).catch(() => {});
  return { sessionId: session.sessionId };
}

async function drive(session: LoginSession, deps: LoginDeps) {
  const now = deps.now || (() => Date.now());
  const sleep = deps.sleep || ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const pollMs = deps.pollIntervalMs ?? LOGIN_POLL_INTERVAL_MS;
  const timeoutMs = deps.timeoutMs ?? LOGIN_TIMEOUT_MS;
  const settleMs = deps.settleMs ?? LOGIN_SETTLE_MS;
  const retentionMs = deps.retentionMs ?? LOGIN_SESSION_RETENTION_MS;

  const finish = (outcome: LoginDoneEvent['outcome'], detail?: string) => {
    if (session.final) return;
    const done: LoginDoneEvent = { type: 'done', outcome, detail, ts: now() };
    session.final = done;
    emit(session, done);
    // 终态后延迟清理:晚连的 SSE 在保留窗口内仍能回放 done
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

  try {
    emit(session, { type: 'status', phase: 'starting', detail: '正在启动浏览器…', ts: now() });
    const page = await deps.browser.acquirePage(session.userId);

    if (session.cancelRequested) return finish('cancelled');

    emit(session, { type: 'status', phase: 'opening', detail: '正在打开小红书创作平台…', ts: now() });
    await page.goto(XHS_CREATOR_HOME, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // 已登录短路:profile 里本来就有有效会话(如 30 天内扫过)
    if (
      checkLoginState(
        await deps.browser.hasCookies(session.userId, XHS_CREATOR_HOME, XHS_LOGIN_COOKIE_NAMES),
        page.url()
      )
    ) {
      emit(session, { type: 'status', phase: 'confirming', detail: '检测到已有登录态,正在确认…', ts: now() });
      await sleep(settleMs);
      deps.onLoginSuccess?.(session.userId);
      emit(session, { type: 'status', phase: 'success', detail: '已登录', ts: now() });
      await releasePage(session, deps);
      return finish('success', '浏览器已保存登录态,无需重复扫码');
    }

    // 登录页默认是短信登录表单:切到扫码态,用户帧流里看到的才是二维码(尽力而为,失败不阻断)
    await ensureQrLoginMode(page, sleep, {
      mountWaitMs: deps.qrMountWaitMs ?? QR_MOUNT_WAIT_MS,
      switchWaitMs: deps.qrSwitchWaitMs ?? QR_SWITCH_WAIT_MS,
    });
    if (session.cancelRequested) return finish('cancelled');

    emit(
      session,
      { type: 'status', phase: 'waiting', detail: '请用小红书 App 扫描页面中的二维码', ts: now() }
    );
    // 轮询:推帧 + 登录判定,直到命中 / 超时 / 取消
    const startedAt = now();
    while (!session.final) {
      if (session.cancelRequested) {
        await releasePage(session, deps);
        return finish('cancelled', '已取消登录');
      }
      if (now() - startedAt > timeoutMs) {
        await releasePage(session, deps);
        return finish('timeout', '等待扫码超时,登录未完成');
      }

      let frame: { screenshotBase64: string; url: string };
      try {
        frame = await deps.browser.captureFrame(session.userId);
      } catch (err: any) {
        // 截图偶发失败不终止等待(页面跳转瞬间等),下一轮重试
        await sleep(pollMs);
        continue;
      }
      emit(
        session,
        { type: 'frame', screenshotBase64: frame.screenshotBase64, url: frame.url, ts: now() }
      );

      const hasCookies = await deps.browser
        .hasCookies(session.userId, XHS_CREATOR_HOME, XHS_LOGIN_COOKIE_NAMES)
        .catch(() => false);

      if (checkLoginState(hasCookies, frame.url)) {
        emit(session, { type: 'status', phase: 'confirming', detail: '扫码成功,正在确认登录…', ts: now() });
        await sleep(settleMs);
        if (session.cancelRequested) {
          await releasePage(session, deps);
          return finish('cancelled');
        }
        deps.onLoginSuccess?.(session.userId);
        emit(session, { type: 'status', phase: 'success', detail: '登录成功,已保存在本服务', ts: now() });
        await releasePage(session, deps);
        return finish('success');
      }

      await sleep(pollMs);
    }
  } catch (err: any) {
    await releasePage(session, deps).catch(() => {});
    finish('error', err?.message || String(err));
  }
}

/** 终态收尾:Page 导航回空白页释放占用(登录态留在 profile 目录,任务工具随时可复用) */
async function releasePage(session: LoginSession, deps: LoginDeps) {
  try {
    const page = await deps.browser.acquirePage(session.userId);
    if (page.url() && page.url() !== 'about:blank') {
      await page.goto('about:blank').catch(() => {});
    }
  } catch {
    // 页面已关闭等场景忽略
  }
}

/** 取消进行中的登录会话(用户关弹窗/DELETE 调用) */
export function cancelBrowserLogin(sessionId: string): boolean {
  const session = sessions.get(sessionId);
  if (!session || session.final) return false;
  session.cancelRequested = true;
  return true;
}

export function getLoginSession(sessionId: string): {
  userId: string;
  final: LoginDoneEvent | null;
  events: LoginEvent[];
  lastFrame?: LoginFrameEvent;
} | null {
  const s = sessions.get(sessionId);
  if (!s) return null;
  return { userId: s.userId, final: s.final, events: [...s.events], lastFrame: s.lastFrame };
}

/**
 * 订阅会话的后续事件;返回退订函数。
 * 订阅即时补发:先重放 status 历史 + 最近一帧(晚连补发),再走实时流。
 */
export function subscribeLoginEvents(
  sessionId: string,
  cb: (e: LoginEvent) => void
): (() => void) | null {
  const s = sessions.get(sessionId);
  if (!s) return null;
  // 先入列再补发,避免补发与实时之间丢事件
  s.subscribers.add(cb);
  for (const e of s.events) {
    try {
      cb(e);
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

/** 供路由层读取用户登录徽标数据(登录时间 + 是否可能过期) */
export function loginBadgeInfo(record: XhsManagedRecord | undefined): {
  loggedIn: boolean;
  lastLoginAt?: number;
  maybeStale: boolean;
} {
  const lastLoginAt = record?.lastLoginAt;
  if (!lastLoginAt) return { loggedIn: false, maybeStale: false };
  // ⚠️ 30 天为经验值:网页版会话有效期待实测
  const maybeStale = Date.now() - lastLoginAt > 30 * 24 * 3600 * 1000;
  return { loggedIn: true, lastLoginAt, maybeStale };
}
