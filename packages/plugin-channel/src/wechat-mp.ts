import {
  ADAPTER_API_VERSION,
  type AdapterCapability,
  type AdapterConnectionState,
  type ChannelAdapter,
  ChannelAdapterError,
  type ChannelAdapterEvents,
  type ChannelAdapterFactory,
  type CredentialProbe,
  type InboundMessage,
  type OutboundReply,
  type SendResult,
} from '@agentoryhq/im-channel-contract';

/**
 * 微信公众号通道适配器（webhook 型）。
 *
 * 契约红线"适配器不开入站监听"的落法:HTTP 路由归应用层（apps/web 既有
 * api/wechat/callback,含签名校验）,路由把原始 XML 交给 ingestWebhook()
 * 解析归一化 —— 监听器永远在 app,插件只做协议翻译与出站发送。
 *
 * 出站:客服消息 API(message/custom/send,msgtype=text)。access_token 走
 * stable_token(POST body 携带凭证,URL 零密钥 —— 日志/错误天然卫生),
 * 内存缓存、提前 5min 过期、40001/42001 强刷重试一次。
 *
 * 诚实边界:
 * - 客服消息要求认证服务号 + 用户 48h 内有互动,平台侧限制,适配器无法绕过。
 * - Phase 1 仅文本消息;事件（关注/取关/菜单）返回 null,由应用层路由自行
 *   被动回复（欢迎语/绑定指引不进 agent）。
 * - 纯文本上限 2048 字节（平台限制）,按字节截断（中文 UTF-8 3 字节,不砍半个字）。
 */

export const WECHAT_MP_CHANNEL = 'wechat_mp';
export const WECHAT_MP_APPID_ENV_KEY = 'WECHAT_MP_APPID';
export const WECHAT_MP_APPSECRET_ENV_KEY = 'WECHAT_MP_APPSECRET';
/** 客服消息 text 平台上限（字节）。 */
export const WECHAT_MP_TEXT_BYTE_LIMIT = 2048;
/** token 提前过期缓冲（秒）。 */
const TOKEN_EXPIRY_BUFFER_S = 300;
const SEND_TIMEOUT_MS = 15_000;
const TOKEN_TIMEOUT_MS = 10_000;

export type WechatMpAdapterOptions = {
  appId: string;
  appSecret: string;
  /** 缺省 https://api.weixin.qq.com(测试注入)。 */
  apiBase?: string;
  /** 缺省全局 fetch(测试注入)。 */
  fetchImpl?: typeof fetch;
};

export type WechatMpXmlFields = {
  toUserName: string;
  fromUserName: string;
  createTime: string;
  msgType: string;
  content: string;
  msgId: string;
  event: string;
  eventKey: string;
};

/** 提取 XML 标签值（兼容 CDATA 与明文两种形态,与 web 回调路由同款策略）。 */
function getTagValue(xml: string, tag: string): string {
  const cdata = xml.match(new RegExp(`<${tag}><!\\[CDATA\\[([\\s\\S]*?)\\]\\]></${tag}>`));
  if (cdata) return cdata[1];
  const plain = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  return plain ? plain[1] : '';
}

export function parseWechatMpXml(xml: string): WechatMpXmlFields {
  return {
    toUserName: getTagValue(xml, 'ToUserName'),
    fromUserName: getTagValue(xml, 'FromUserName'),
    createTime: getTagValue(xml, 'CreateTime'),
    msgType: getTagValue(xml, 'MsgType'),
    content: getTagValue(xml, 'Content').trim(),
    msgId: getTagValue(xml, 'MsgId'),
    event: getTagValue(xml, 'Event'),
    eventKey: getTagValue(xml, 'EventKey'),
  };
}

/**
 * 归一化为契约 InboundMessage。仅 msgType=text 且有内容才发射;
 * 事件/图片/语音等返回 null（Phase 1 边界,事件由应用层路由被动回复）。
 * messageId 优先 MsgId（平台重推去重锚点）,缺失回退 from+createTime。
 */
export function normalizeWechatMpMessage(parsed: WechatMpXmlFields): InboundMessage | null {
  const content = (parsed.content ?? '').trim();
  if (parsed.msgType !== 'text' || !content || !parsed.fromUserName) return null;
  const messageId = parsed.msgId || `${parsed.fromUserName}:${parsed.createTime}`;
  return {
    channel: WECHAT_MP_CHANNEL,
    externalUserId: parsed.fromUserName,
    conversationId: parsed.fromUserName,
    conversationType: 'private',
    messageId,
    text: content,
    mentionedBot: true,
    receivedAt: parsed.createTime
      ? new Date(Number(parsed.createTime) * 1000).toISOString()
      : new Date().toISOString(),
  };
}

/** 按 UTF-8 字节截断（不砍半个多字节字符),超限补省略号。 */
export function clampWechatMpText(text: string): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text, 'utf8') <= WECHAT_MP_TEXT_BYTE_LIMIT) return { text, truncated: false };
  // 预留 1 字节给省略号「…」(3 字节) → 目标 2045 字节内找最大完整字符边界
  const budget = WECHAT_MP_TEXT_BYTE_LIMIT - 3;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (Buffer.byteLength(text.slice(0, mid), 'utf8') <= budget) lo = mid;
    else hi = mid - 1;
  }
  return { text: `${text.slice(0, lo)}…`, truncated: true };
}

type TokenCache = { token: string; expiresAtMs: number };

export class WechatMpChannelAdapter implements ChannelAdapter {
  readonly channel: string = WECHAT_MP_CHANNEL;
  readonly apiVersion = ADAPTER_API_VERSION;
  /** 公众号会话即 1:1（openid）,无群概念。 */
  readonly capabilities: readonly AdapterCapability[] = ['private'];

  private started = false;
  private state: AdapterConnectionState = 'disconnected';
  private events: ChannelAdapterEvents | null = null;
  private tokenCache: TokenCache | null = null;

  constructor(private readonly opts: WechatMpAdapterOptions) {}

  /**
   * webhook 型无出站传输可开:凭证就绪即视为 connected
   * （真实入站由应用层 HTTP 路由驱动,连接状态语义 = "可收发"）。
   */
  async start(events: ChannelAdapterEvents): Promise<void> {
    if (this.started) return;
    const probe = await this.probeCredentials();
    if (!probe.ok) {
      throw new ChannelAdapterError(this.channel, 'credential_invalid', probe.reason);
    }
    this.started = true;
    this.events = events;
    this.setState('connected');
  }

  async stop(): Promise<void> {
    this.started = false;
    this.events = null;
    this.tokenCache = null;
    this.setState('disconnected');
  }

  /** 应用层 webhook 路由的解析入口:XML → 归一化消息（非文本消息 → null）。 */
  ingestWebhook(payload: string): InboundMessage | null {
    if (typeof payload !== 'string' || !payload.includes('<xml>')) return null;
    try {
      return normalizeWechatMpMessage(parseWechatMpXml(payload));
    } catch {
      return null; // 畸形 XML:显式 null,不 throw 击穿应用层路由
    }
  }

  async send(reply: OutboundReply): Promise<SendResult> {
    if (!this.started) {
      throw new ChannelAdapterError(this.channel, 'not_started', 'adapter not started');
    }
    const touser = reply.conversationId?.trim();
    if (!touser) {
      throw new ChannelAdapterError(this.channel, 'send_failed', 'conversationId(openid) 缺失');
    }
    // trim 后再判空:纯空白拒绝发送(与入站归一化同语义);截断按字节
    const { text } = clampWechatMpText((reply.text ?? '').trim());
    if (!text) {
      throw new ChannelAdapterError(this.channel, 'send_failed', '空文本拒绝发送');
    }
    const data = await this.postWithToken('/cgi-bin/message/custom/send', {
      touser,
      msgtype: 'text',
      text: { content: text },
    });
    return data?.msgid !== undefined ? { channelMessageId: String(data.msgid) } : {};
  }

  /** 非破坏性凭证检查:只看配置存在性（不动网络）,永不 throw、不回显值。 */
  async probeCredentials(): Promise<CredentialProbe> {
    if (!this.opts.appId?.trim() || !this.opts.appSecret?.trim()) {
      return { ok: false, reason: 'WECHAT_MP_APPID / WECHAT_MP_APPSECRET 缺失' };
    }
    return { ok: true };
  }

  // ── 内部 ──

  /** stable_token 换取 access_token（内存缓存,提前 5min 过期,force 强刷）。 */
  private async accessToken(force = false): Promise<string> {
    const now = Date.now();
    if (!force && this.tokenCache && this.tokenCache.expiresAtMs > now) {
      return this.tokenCache.token;
    }
    const res = await this.fetchJson(
      '/cgi-bin/stable_token',
      {
        grant_type: 'client_credential',
        appid: this.opts.appId.trim(),
        secret: this.opts.appSecret.trim(),
        ...(force ? { force_refresh: true } : {}),
      },
      TOKEN_TIMEOUT_MS,
      false,
    );
    if (typeof res.access_token !== 'string' || !res.access_token) {
      // 凭证错误(40001/40125 等):errcode 上报,errmsg 是平台文案不含凭证
      throw new ChannelAdapterError(
        this.channel,
        'credential_invalid',
        `stable_token 获取失败 errcode=${res.errcode ?? 'none'} ${res.errmsg ?? ''}`.trim(),
      );
    }
    const expiresInS = Number(res.expires_in) > 0 ? Number(res.expires_in) : 7200;
    this.tokenCache = {
      token: res.access_token,
      expiresAtMs: now + Math.max(expiresInS - TOKEN_EXPIRY_BUFFER_S, 60) * 1000,
    };
    return this.tokenCache.token;
  }

  /** 带 token 的 POST;token 过期类错误强刷重试一次。 */
  private async postWithToken(path: string, body: Record<string, unknown>): Promise<Record<string, any>> {
    for (const force of [false, true]) {
      const token = await this.accessToken(force);
      const res = await this.fetchJson(
        `${path}?access_token=${encodeURIComponent(token)}`,
        body,
        SEND_TIMEOUT_MS,
        true,
      );
      const errcode = Number(res.errcode ?? 0);
      if (errcode === 0) return res;
      if ((errcode === 40001 || errcode === 42001 || errcode === 40014) && !force) continue;
      throw new ChannelAdapterError(
        this.channel,
        'send_failed',
        `客服消息发送失败 errcode=${errcode} ${res.errmsg ?? ''}`.trim(),
        errcode === 45015, // 超出回复时限:用户再互动即可恢复,标记可重试
      );
    }
    throw new ChannelAdapterError(this.channel, 'internal', 'unreachable');
  }

  private async fetchJson(
    path: string,
    body: Record<string, unknown>,
    timeoutMs: number,
    expectJson: boolean,
  ): Promise<Record<string, any>> {
    const base = (this.opts.apiBase ?? 'https://api.weixin.qq.com').replace(/\/+$/, '');
    const doFetch = this.opts.fetchImpl ?? fetch;
    let res: Response;
    try {
      res = await doFetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err: any) {
      // fetch 异常消息只含 URL/网络层信息;stable_token 的凭证在 body,不入 URL
      throw new ChannelAdapterError(
        this.channel,
        'connection_lost',
        `微信 API 网络错误: ${err?.name === 'TimeoutError' ? '请求超时' : '连接失败'}`,
        true,
      );
    }
    if (!res.ok && !expectJson) {
      throw new ChannelAdapterError(this.channel, 'connection_lost', `微信 API http ${res.status}`, true);
    }
    try {
      return (await res.json()) as Record<string, any>;
    } catch {
      throw new ChannelAdapterError(this.channel, 'internal', `微信 API 响应非 JSON (http ${res.status})`);
    }
  }

  private setState(state: AdapterConnectionState): void {
    if (this.state === state) return;
    this.state = state;
    this.events?.onStateChange?.(state);
  }
}

export class WechatMpChannelFactory implements ChannelAdapterFactory {
  readonly channel: string = WECHAT_MP_CHANNEL;
  readonly envKeys: readonly string[] = [WECHAT_MP_APPID_ENV_KEY, WECHAT_MP_APPSECRET_ENV_KEY];

  fromEnv(env: Record<string, string | undefined>): ChannelAdapter | null {
    const appId = env[WECHAT_MP_APPID_ENV_KEY]?.trim();
    const appSecret = env[WECHAT_MP_APPSECRET_ENV_KEY]?.trim();
    // fail-closed:凭证不全 → 不注册,启动永不阻塞
    if (!appId || !appSecret) return null;
    return new WechatMpChannelAdapter({ appId, appSecret });
  }
}

export function createWechatMpChannelFactory(): WechatMpChannelFactory {
  return new WechatMpChannelFactory();
}
