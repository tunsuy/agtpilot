import WebSocket from 'ws';
import {
  ADAPTER_API_VERSION,
  type AdapterCapability,
  type AdapterConnectionState,
  type ChannelAdapter,
  ChannelAdapterError,
  type ChannelAdapterErrorCode,
  type ChannelAdapterEvents,
  type ChannelAdapterFactory,
  type CredentialProbe,
  type InboundMessage,
  type OutboundReply,
  type SendResult,
} from '@agentoryhq/im-channel-contract';

/**
 * QQ OneBot v11 通道适配器（对接 NapCat / LLOneBot,负责人选定的 QQ 路线B）。
 *
 * 传输:出站 WebSocket —— 适配器主动连 NapCat 的 forward-WS 端点,
 * 全程不开入站监听（contract v1 红线）。断线指数退避重连（1s 起步,30s 封顶,带抖动）。
 *
 * 诚实边界:
 * - 非官方协议（NapCat 挂真实 QQ 号）,平台风控风险由部署方知情承担。
 * - 群聊必须 @机器人 才发射（at 段 qq == self_id 或 at-all）,非提及群消息
 *   零发射丢弃（契约归一化规则）。self_id 直接取事件自带字段,无需登录态查询。
 * - Phase 1 纯文本:非 text/at 段（图片/语音/表情）忽略;媒体是后续 additive 能力。
 * - 密钥卫生:错误消息/日志绝不回显 ws url 或 access_token。
 *
 * 传输可注入（transport 选项）:vitest 用假 socket 跑收发/重连/归一化,不起真连接。
 */

export const QQ_ONEBOT_CHANNEL = 'qq_onebot';
export const QQ_ONEBOT_WS_URL_ENV_KEY = 'QQ_ONEBOT_WS_URL';
export const QQ_ONEBOT_ACCESS_TOKEN_ENV_KEY = 'QQ_ONEBOT_ACCESS_TOKEN';
/** QQ 单条消息防御性截断上限（与 iLink 适配器同档;协议实测上限 ~4500 字,取保守值）。 */
export const QQ_ONEBOT_TEXT_LIMIT = 4000;

const DEFAULT_ACTION_TIMEOUT_MS = 15_000;
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

export type QqOnebotAdapterOptions = {
  /** NapCat forward-WS 端点,如 ws://127.0.0.1:3001/onebot/v11/ws */
  wsUrl: string;
  /** NapCat 鉴权 token（Authorization: Bearer）;未启用鉴权时省略。 */
  accessToken?: string;
  /** 传输注入（测试用;缺省走 ws 包真实 WebSocket）。 */
  transport?: OnebotTransportFactory;
  /** action 回执等待超时（ms）。 */
  actionTimeoutMs?: number;
  /** 重连退避计时注入（测试用）。 */
  scheduleReconnectIn?: (ms: number, cb: () => void) => () => void;
};

/** 最小 socket 抽象 —— 真实实现包一层 `ws`,测试实现内存直连。 */
export interface OnebotSocket {
  readonly isOpen: boolean;
  send(data: string): void;
  close(): void;
  onOpen(cb: () => void): void;
  onClose(cb: () => void): void;
  onError(cb: (err: unknown) => void): void;
  onData(cb: (json: unknown) => void): void;
}

export type OnebotTransportFactory = (url: string, headers: Record<string, string>) => OnebotSocket;

/** OneBot v11 消息事件（子集 —— 本适配器读取的字段）。 */
export type OnebotMessageEvent = {
  time?: number;
  self_id?: number | string;
  post_type?: string;
  message_type?: 'private' | 'group';
  sub_type?: string;
  message_id?: number | string;
  user_id?: number | string;
  group_id?: number | string;
  message?: string | Array<{ type: string; data?: Record<string, unknown> }>;
  raw_message?: string;
  sender?: { user_id?: number | string; nickname?: string; card?: string };
};

/** conversationId 语法:`private:<qq>` / `group:<群号>`（收发两向共用）。 */
export function parseOnebotConversationId(
  id: string,
): { type: 'private'; targetId: string } | { type: 'group'; targetId: string } | null {
  const m = /^(private|group):(\d+)$/.exec(id?.trim() ?? '');
  if (!m) return null;
  return { type: m[1] as 'private' | 'group', targetId: m[2] };
}

export function buildOnebotConversationId(type: 'private' | 'group', id: number | string): string {
  return `${type}:${id}`;
}

/**
 * 从 message 段提取纯文本 + 判定是否 @机器人。
 * 数组形态:text 段拼接,at 段（qq==selfId 或 all）置 mentioned 并跳过,其余段忽略;
 * 字符串形态（老实现发 CQ 串）:检测 [CQ:at,qq=...] 后剥掉全部 CQ 码。
 * 归一化:空白折叠 + trim;空文本返回 null。
 */
export function extractOnebotText(
  message: OnebotMessageEvent['message'],
  rawMessage: string | undefined,
  selfId: string,
): { text: string | null; mentioned: boolean } {
  let mentioned = false;
  let text = '';
  if (Array.isArray(message)) {
    for (const seg of message) {
      if (seg?.type === 'text') {
        const t = seg.data?.text;
        if (typeof t === 'string') text += t;
      } else if (seg?.type === 'at') {
        const qq = String(seg.data?.qq ?? '');
        if (qq === selfId || qq === 'all') mentioned = true;
      }
      // 其余段（image/face/record/…）Phase 1 忽略
    }
  } else {
    const raw = typeof message === 'string' && message ? message : (rawMessage ?? '');
    if (new RegExp(`\\[CQ:at,qq=(all|${escapeRegExp(selfId)})\\]`).test(raw)) mentioned = true;
    text = raw.replace(/\[CQ:[^\]]*\]/g, '');
  }
  const normalized = text.replace(/\s+/g, ' ').trim();
  return { text: normalized || null, mentioned };
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 归一化一条 OneBot 事件为契约 InboundMessage。返回 null（= 丢弃,零发射）:
 * 非 message 事件 / 缺 message_id / 群聊未 @机器人 / 无纯文本内容。
 */
export function normalizeOnebotMessage(ev: OnebotMessageEvent): InboundMessage | null {
  if (ev?.post_type !== 'message' || ev.message_id === undefined || ev.message_id === null) return null;
  const msgType = ev.message_type;
  if (msgType !== 'private' && msgType !== 'group') return null;
  const userId = ev.user_id !== undefined ? String(ev.user_id) : '';
  if (!userId) return null;
  const selfId = ev.self_id !== undefined ? String(ev.self_id) : '';

  const { text, mentioned } = extractOnebotText(ev.message, ev.raw_message, selfId);
  if (!text) return null;
  // 群聊红线:未 @机器人 零发射。self_id 缺失时无法验证提及 → 保守丢弃（fail-closed）。
  if (msgType === 'group' && (!selfId || !mentioned)) return null;

  const conversationId =
    msgType === 'group'
      ? buildOnebotConversationId('group', ev.group_id !== undefined ? String(ev.group_id) : userId)
      : buildOnebotConversationId('private', userId);
  const displayName = ev.sender?.card || ev.sender?.nickname || undefined;

  return {
    channel: QQ_ONEBOT_CHANNEL,
    externalUserId: msgType === 'group' ? `${conversationId}/${userId}` : userId,
    ...(displayName ? { externalUserName: displayName } : {}),
    conversationId,
    conversationType: msgType,
    messageId: String(ev.message_id),
    text,
    mentionedBot: msgType === 'group' ? mentioned : true,
    receivedAt: ev.time ? new Date(Number(ev.time) * 1000).toISOString() : new Date().toISOString(),
    raw: { messageType: msgType, subType: ev.sub_type },
  };
}

/** 防御性出站截断。 */
export function clampOnebotText(text: string): { text: string; truncated: boolean } {
  if (text.length <= QQ_ONEBOT_TEXT_LIMIT) return { text, truncated: false };
  return { text: `${text.slice(0, QQ_ONEBOT_TEXT_LIMIT - 1)}…`, truncated: true };
}

type PendingAction = {
  resolve: (data: unknown) => void;
  reject: (err: ChannelAdapterError) => void;
  timer: ReturnType<typeof setTimeout>;
};

export class QqOnebotChannelAdapter implements ChannelAdapter {
  readonly channel: string = QQ_ONEBOT_CHANNEL;
  readonly apiVersion = ADAPTER_API_VERSION;
  readonly capabilities: readonly AdapterCapability[] = ['private', 'group'];

  private ws: OnebotSocket | null = null;
  private events: ChannelAdapterEvents | null = null;
  private started = false;
  private stopping = false;
  private state: AdapterConnectionState = 'disconnected';
  private pending = new Map<string, PendingAction>();
  private reconnectAttempts = 0;
  private cancelReconnect: (() => void) | null = null;
  private actionSeq = 0;

  constructor(private readonly opts: QqOnebotAdapterOptions) {}

  /** 幂等启动。凭证缺失/非法 → reject credential_invalid（fail-closed,不同步 throw）。 */
  async start(events: ChannelAdapterEvents): Promise<void> {
    if (this.started) return;
    const probe = await this.probeCredentials();
    if (!probe.ok) {
      throw new ChannelAdapterError(this.channel, 'credential_invalid', probe.reason);
    }
    this.started = true;
    this.stopping = false;
    this.events = events;
    this.connect();
  }

  /** 幂等停止;清空重连计划与在飞 action。start 前调用安全。 */
  async stop(): Promise<void> {
    this.stopping = true;
    this.started = false;
    this.cancelReconnect?.();
    this.cancelReconnect = null;
    this.rejectAllPending('not_started');
    const ws = this.ws;
    this.ws = null;
    try {
      ws?.close();
    } catch {
      // 关闭失败不影响停机语义
    }
    this.setState('disconnected');
  }

  async send(reply: OutboundReply): Promise<SendResult> {
    if (!this.started) {
      throw new ChannelAdapterError(this.channel, 'not_started', 'adapter not started');
    }
    if (!this.ws?.isOpen) {
      throw new ChannelAdapterError(this.channel, 'connection_lost', 'onebot websocket not connected', true);
    }
    const target = parseOnebotConversationId(reply.conversationId);
    if (!target) {
      throw new ChannelAdapterError(
        this.channel,
        'send_failed',
        'conversationId 需为 private:<qq> 或 group:<群号> 形态',
      );
    }
    // trim 后再判空:纯空白拒绝发送(与入站归一化同语义)
    const { text } = clampOnebotText((reply.text ?? '').trim());
    if (!text) {
      throw new ChannelAdapterError(this.channel, 'send_failed', '空文本拒绝发送');
    }
    const action = target.type === 'private' ? 'send_private_msg' : 'send_group_msg';
    const params =
      target.type === 'private'
        ? { user_id: Number(target.targetId), message: [{ type: 'text', data: { text } }] }
        : { group_id: Number(target.targetId), message: [{ type: 'text', data: { text } }] };
    const data = (await this.request(action, params)) as { message_id?: number | string } | null;
    return data?.message_id !== undefined ? { channelMessageId: String(data.message_id) } : {};
  }

  /** 非破坏性凭证检查:只看配置形态,不建连接、不回显值。永不 throw。 */
  async probeCredentials(): Promise<CredentialProbe> {
    const url = this.opts.wsUrl?.trim();
    if (!url) return { ok: false, reason: 'QQ_ONEBOT_WS_URL 缺失' };
    if (!/^wss?:\/\/\S+$/i.test(url)) return { ok: false, reason: 'QQ_ONEBOT_WS_URL 需以 ws:// 或 wss:// 开头' };
    return { ok: true };
  }

  /** 测试/回环钩子:直接喂一帧（事件或 action 回执）,走真实分发路径。 */
  injectFrame(frame: unknown): void {
    this.handleFrame(frame);
  }

  // ── 内部 ──

  private connect(): void {
    this.setState('connecting');
    const headers: Record<string, string> = this.opts.accessToken
      ? { Authorization: `Bearer ${this.opts.accessToken}` }
      : {};
    let socket: OnebotSocket;
    try {
      socket = (this.opts.transport ?? defaultOnebotTransport)(this.opts.wsUrl, headers);
    } catch (err: any) {
      // 构造失败（URL 畸形等）不回显值
      this.emitError('connection_lost', `websocket 建连失败: ${err?.message ? '见部署配置' : '未知原因'}`, true);
      this.scheduleReconnect();
      return;
    }
    this.ws = socket;
    socket.onOpen(() => {
      this.reconnectAttempts = 0;
      this.setState('connected');
    });
    socket.onData((json) => this.handleFrame(json));
    socket.onError(() => {
      this.emitError('connection_lost', 'websocket 传输错误', true);
    });
    socket.onClose(() => {
      if (this.ws === socket) this.ws = null;
      this.rejectAllPending('connection_lost');
      if (this.started && !this.stopping) this.scheduleReconnect();
      else this.setState('disconnected');
    });
  }

  private scheduleReconnect(): void {
    this.setState('reconnecting');
    const base = Math.min(RECONNECT_BASE_MS * 2 ** this.reconnectAttempts, RECONNECT_MAX_MS);
    this.reconnectAttempts += 1;
    const delay = base + Math.floor(base * 0.2 * Math.random());
    const schedule = this.opts.scheduleReconnectIn ?? defaultScheduleReconnect;
    this.cancelReconnect?.();
    this.cancelReconnect = schedule(delay, () => {
      this.cancelReconnect = null;
      if (this.started && !this.stopping) this.connect();
    });
  }

  private handleFrame(json: unknown): void {
    if (!json || typeof json !== 'object') return;
    const frame = json as Record<string, unknown>;
    if (frame.echo !== undefined) {
      const key = String(frame.echo);
      const pending = this.pending.get(key);
      if (pending) {
        this.pending.delete(key);
        clearTimeout(pending.timer);
        // OneBot v11 回执:retcode===0(数值协议)或 status==='ok'(字符串协议)都算成功
        const ok = frame.retcode === 0 || frame.status === 'ok';
        if (ok) {
          pending.resolve(frame.data ?? null);
        } else {
          const code = frame.retcode ?? frame.status ?? 'unknown';
          pending.reject(
            new ChannelAdapterError(this.channel, 'send_failed', `onebot action 失败 retcode=${String(code)}`),
          );
        }
      }
      return;
    }
    if (frame.post_type === 'message') {
      const msg = normalizeOnebotMessage(frame as OnebotMessageEvent);
      if (msg) void this.events?.onMessage(msg);
    }
    // lifecycle / heartbeat / notice:无需处理
  }

  private request(action: string, params: Record<string, unknown>): Promise<unknown> {
    const echo = `agt_${++this.actionSeq}_${Date.now().toString(36)}`;
    return new Promise<unknown>((resolve, reject) => {
      const timeoutMs = this.opts.actionTimeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS;
      const timer = setTimeout(() => {
        this.pending.delete(echo);
        reject(new ChannelAdapterError(this.channel, 'send_failed', `onebot action ${action} 超时`, true));
      }, timeoutMs);
      this.pending.set(echo, { resolve, reject, timer });
      try {
        this.ws?.send(JSON.stringify({ action, params, echo }));
      } catch {
        clearTimeout(timer);
        this.pending.delete(echo);
        reject(new ChannelAdapterError(this.channel, 'send_failed', 'websocket 发送失败', true));
      }
    });
  }

  private rejectAllPending(code: 'connection_lost' | 'not_started'): void {
    for (const [key, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new ChannelAdapterError(this.channel, code, '连接中断,action 未完成', code === 'connection_lost'));
      this.pending.delete(key);
    }
  }

  private setState(state: AdapterConnectionState): void {
    if (this.state === state) return;
    this.state = state;
    this.events?.onStateChange?.(state);
  }

  private emitError(code: ChannelAdapterErrorCode, message: string, retryable: boolean): void {
    this.events?.onError?.(new ChannelAdapterError(this.channel, code, message, retryable));
  }
}

function defaultScheduleReconnect(ms: number, cb: () => void): () => void {
  const t = setTimeout(cb, ms);
  return () => clearTimeout(t);
}

/** 缺省传输:`ws` 包(纯 JS,无原生依赖)。 */
const defaultOnebotTransport: OnebotTransportFactory = (url, headers) => {
  const ws = new WebSocket(url, { headers });
  let open = false;
  let closed = false;
  const openCbs: Array<() => void> = [];
  const dataCbs: Array<(json: unknown) => void> = [];
  const errCbs: Array<(err: unknown) => void> = [];
  const closeCbs: Array<() => void> = [];
  ws.on('open', () => {
    open = true;
    for (const cb of openCbs) cb();
  });
  ws.on('message', (raw) => {
    let json: unknown;
    try {
      json = JSON.parse(String(raw));
    } catch {
      return; // 非 JSON 帧丢弃
    }
    for (const cb of dataCbs) cb(json);
  });
  ws.on('error', (err) => {
    for (const cb of errCbs) cb(err);
  });
  ws.on('close', () => {
    open = false;
    closed = true;
    for (const cb of closeCbs) cb();
  });
  return {
    get isOpen() {
      return open && !closed;
    },
    send(data) {
      if (!open || closed) throw new Error('websocket not open');
      ws.send(data);
    },
    close() {
      try {
        ws.close();
      } catch {
        // 忽略关闭竞态
      }
    },
    onOpen(cb) {
      openCbs.push(cb);
    },
    onClose(cb) {
      closeCbs.push(cb);
    },
    onError(cb) {
      errCbs.push(cb);
    },
    onData(cb) {
      dataCbs.push(cb);
    },
  };
};

export class QqOnebotChannelFactory implements ChannelAdapterFactory {
  readonly channel: string = QQ_ONEBOT_CHANNEL;
  readonly envKeys: readonly string[] = [QQ_ONEBOT_WS_URL_ENV_KEY, QQ_ONEBOT_ACCESS_TOKEN_ENV_KEY];

  fromEnv(env: Record<string, string | undefined>): ChannelAdapter | null {
    const wsUrl = env[QQ_ONEBOT_WS_URL_ENV_KEY]?.trim();
    // fail-closed:配置不全 → 不注册,启动永不阻塞
    if (!wsUrl) return null;
    const accessToken = env[QQ_ONEBOT_ACCESS_TOKEN_ENV_KEY]?.trim();
    return new QqOnebotChannelAdapter({ wsUrl, ...(accessToken ? { accessToken } : {}) });
  }
}

export function createQqOnebotChannelFactory(): QqOnebotChannelFactory {
  return new QqOnebotChannelFactory();
}
