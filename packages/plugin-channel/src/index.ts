import { Context, Service } from '@deepseek-ai/cordis';
import type {
  AdapterConnectionState,
  ChannelAdapter,
  ChannelAdapterError,
  ChannelId,
  InboundMessage,
  OutboundReply,
  SendResult,
} from '@agentoryhq/im-channel-contract';
import '@agtpilot/core';

export const name = 'agtpilot-plugin-channel';

/**
 * 无头通道引擎（headless channel engine）—— IM 通道接入的唯一插件形态。
 *
 * 只提供"能力"：适配器挂载/卸载、入站消息扇出、出站发送路由、连接状态表。
 * 四件事刻意不做（ARCHITECTURE.md 反模式 #10，plugin-cron 收敛样板同款）：
 * - 不做身份绑定（externalUserId → 产品 userId 的映射是策略，归应用层）
 * - 不做会话→任务映射（消息触发什么、以谁的身份跑，由注册方 onMessage 回调决定）
 * - 不做持久化（绑定/会话/凭证存哪，应用层决定）
 * - 不读 process.env（凭证经 buildChannelsFromEnv(env) 由应用层显式传入，
 *   对齐 @agentoryhq/im-channel-contract 的密钥卫生红线）
 *
 * 适配器契约（contract v1）红线在插件侧同样生效：
 * - 适配器不开入站监听；webhook 型通道（公众号）由应用层持有 HTTP 路由，
 *   解析后经 ingestWebhook() 交给适配器归一化 —— 监听器永远在 app，不在插件。
 * - 凭证绝不进错误消息 / 日志 / raw payload。
 */

declare module '@deepseek-ai/cordis' {
  interface Context {
    channel: ChannelService;
  }
}

/** webhook 型适配器的可选能力（契约允许的 additive 扩展成员）。 */
export interface WebhookIngestCapable {
  /** 应用层把原始 webhook payload（如公众号 XML）交给适配器解析归一化;非消息返回 null。 */
  ingestWebhook(payload: string): Promise<InboundMessage | null> | InboundMessage | null;
}

export function supportsWebhookIngest(a: ChannelAdapter): a is ChannelAdapter & WebhookIngestCapable {
  return typeof (a as Partial<WebhookIngestCapable>).ingestWebhook === 'function';
}

export type ChannelMessageHandler = (msg: InboundMessage) => void | Promise<void>;

export interface ChannelStatusEntry {
  channel: ChannelId;
  state: AdapterConnectionState;
  capabilities: readonly string[];
}

export interface ChannelErrorEntry {
  channel: ChannelId;
  code: string;
  message: string;
  at: string;
}

const ERROR_RING_LIMIT = 50;

export class ChannelService extends Service {
  private adapters = new Map<ChannelId, ChannelAdapter>();
  private states = new Map<ChannelId, AdapterConnectionState>();
  private handlers = new Set<ChannelMessageHandler>();
  private errors: ChannelErrorEntry[] = [];

  constructor(ctx: Context) {
    super(ctx, 'channel');
  }

  /**
   * 挂载并启动一个通道适配器。同 channel 重复挂载 = 替换旧实例
   * （扫码换绑/凭证轮换后的热替换路径）。start 失败原样上抛
   * （ChannelAdapterError，fail-closed），不留半挂载状态。
   */
  async attach(adapter: ChannelAdapter): Promise<void> {
    if (this.adapters.has(adapter.channel)) {
      await this.detach(adapter.channel);
    }
    this.adapters.set(adapter.channel, adapter);
    this.states.set(adapter.channel, 'disconnected');
    try {
      await adapter.start({
        onMessage: (msg) => this.fanOut(msg),
        onError: (err) => this.recordError(err),
        onStateChange: (state) => this.states.set(adapter.channel, state),
      });
    } catch (err) {
      // 启动失败不留残骸:状态表/注册表回滚,调用方决定重试或放弃
      this.adapters.delete(adapter.channel);
      this.states.delete(adapter.channel);
      throw err;
    }
  }

  /** 卸载并停止通道。未挂载返回 false;stop 异常也保证注册表清理。 */
  async detach(channelId: ChannelId): Promise<boolean> {
    const adapter = this.adapters.get(channelId);
    if (!adapter) return false;
    try {
      await adapter.stop();
    } finally {
      this.adapters.delete(channelId);
      this.states.delete(channelId);
    }
    return true;
  }

  /** 出站发送,按 channel 路由到适配器。通道未挂载 → 显式报错（不静默）。 */
  async send(channelId: ChannelId, reply: OutboundReply): Promise<SendResult> {
    const adapter = this.adapters.get(channelId);
    if (!adapter) {
      throw new Error(`[channel] 通道未挂载: ${channelId}`);
    }
    return adapter.send(reply);
  }

  /** 注册入站消息处理器（应用层挂绑定/任务派发逻辑）。返回注销函数。 */
  onMessage(handler: ChannelMessageHandler): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  /**
   * webhook 型通道入口:应用层 HTTP 路由收到原始 payload 后调这里,
   * 由适配器解析归一化并扇出。通道未挂载或不支持 webhook → null（显式,不假装成功）。
   */
  async ingestWebhook(channelId: ChannelId, payload: string): Promise<InboundMessage | null> {
    const adapter = this.adapters.get(channelId);
    if (!adapter || !supportsWebhookIngest(adapter)) return null;
    const msg = await adapter.ingestWebhook(payload);
    if (msg) await this.fanOut(msg);
    return msg;
  }

  /** 连接状态快照（通道状态页 / 运维 API 消费）。 */
  status(): ChannelStatusEntry[] {
    return [...this.adapters.values()].map((a) => ({
      channel: a.channel,
      state: this.states.get(a.channel) ?? 'disconnected',
      capabilities: a.capabilities,
    }));
  }

  /** 最近的传输层错误（环形缓冲,消息已由适配器做过密钥卫生处理）。 */
  recentErrors(): ChannelErrorEntry[] {
    return [...this.errors];
  }

  private recordError(err: ChannelAdapterError): void {
    this.errors.push({
      channel: err?.channel ?? 'unknown',
      code: err?.code ?? 'internal',
      message: err?.message || String(err),
      at: new Date().toISOString(),
    });
    if (this.errors.length > ERROR_RING_LIMIT) this.errors.shift();
  }

  private async fanOut(msg: InboundMessage): Promise<void> {
    // 单个处理器异常不许击穿适配器循环;按注册顺序串行 await（契约允许背压）
    for (const handler of this.handlers) {
      try {
        await handler(msg);
      } catch (err: any) {
        console.error(`[plugin-channel] 消息处理器异常(${msg.channel}):`, err?.message || err);
      }
    }
  }
}

// 契约类型与适配器实现统一从插件面再导出,应用层只依赖本包（单一入口）。
export type {
  ChannelAdapter,
  ChannelId,
  InboundMessage,
  OutboundReply,
  SendResult,
  AdapterConnectionState,
} from '@agentoryhq/im-channel-contract';
export { ADAPTER_API_VERSION, ChannelAdapterError, KnownChannel } from '@agentoryhq/im-channel-contract';
export {
  WechatPersonalChannelAdapter,
  WechatPersonalChannelFactory,
  createWechatPersonalChannelFactory,
  requestWeixinLoginQr,
  pollWeixinLoginStatus,
  WECHAT_PERSONAL_TOKEN_ENV_KEY,
  WECHAT_PERSONAL_BASE_URL_ENV_KEY,
  WECHAT_PERSONAL_DEFAULT_BASE_URL,
} from '@agentoryhq/im-channel-wechat-personal';
export type { WeixinLoginQr, WeixinLoginStatus } from '@agentoryhq/im-channel-wechat-personal';
export * from './qq-onebot';
export * from './wechat-mp';
export * from './registry';
