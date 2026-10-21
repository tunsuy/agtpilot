import { getAgentBackend } from './agent-backend';
import { logRuntime } from './runtime-log';
import * as store from './channel-store';
import { extractFinalAnswer, parseChannelCommand } from './channel-utils';
import { getUserConnectors } from './user-store';
import { WECHAT_MP_CRED_KEY, parseWechatMpCredential } from './wechat-mp';
import type { Mission } from '../types/agent';
import {
  buildChannelsFromEnv,
  parseWechatMpXml,
  requestWeixinLoginQr,
  pollWeixinLoginStatus,
  WechatPersonalChannelAdapter,
  WECHAT_PERSONAL_DEFAULT_BASE_URL,
  type InboundMessage,
  type WeixinLoginStatus,
} from '@agtpilot/plugin-channel';

/**
 * 通道服务(应用层) —— IM 消息 ↔ agent 任务的全部策略所在地。
 *
 * plugin-channel 是无头通道引擎(连接/收发/状态),这里补齐应用层四件事
 * (ARCHITECTURE.md 反模式 #10 的 cron 收敛样板同款):
 * - 身份绑定:externalUserId → 产品 userId(绑定码流程,channel-store 持久化)
 * - 会话映射:conversationId → missionId(续聊;「新会话」指令清映射)
 * - 执行:经 AgentBackend.runMission,以绑定用户身份跑;每会话串行队列,
 *   运行中追问天然排队(不与 runMission 的 steering 队列双轨)
 * - 生命周期:instrumentation.ts 启动(AGTPILOT_CHANNELS=0 总闸关闭)
 *
 * 消息卫生:回给 IM 的错误文案不含内部堆栈;日志不回显任何凭证。
 */

/** 每会话排队上限:超过说明用户在刷屏,显式拒绝而不是无限堆积 */
const MAX_QUEUE_DEPTH = 5;
const DEFAULT_ACK_MS = 8_000;

export interface QrLoginSession {
  handle: string;
  qrcode: string;
  baseUrl: string;
  createdAt: number;
}

export type QrPollResult =
  | { status: 'unknown_handle' }
  | { status: WeixinLoginStatus['status']; qrContent?: string; note?: string }
  | { status: 'confirmed' };

class ChannelManager {
  private initPromise: Promise<void> | null = null;
  private ready = false;
  private queues = new Map<string, { chain: Promise<void>; depth: number }>();
  private qrSessions = new Map<string, QrLoginSession>();
  private unsubscribe: (() => void) | null = null;

  /** 幂等启动:挂通道 + 注册入站处理。任何通道失败只记录,不阻塞其余通道与 web 启动。 */
  init(): Promise<void> {
    this.initPromise ??= this.doInit();
    return this.initPromise;
  }

  private async doInit(): Promise<void> {
    if (process.env.AGTPILOT_CHANNELS === '0') {
      logRuntime('INFO', 'channel', 'AGTPILOT_CHANNELS=0,通道服务未启动');
      return;
    }
    try {
      const backend = getAgentBackend();
      await backend.whenReady();
      const channel = backend.ctx?.channel;
      if (!channel) {
        logRuntime('WARN', 'channel', 'ctx.channel 不可用(plugin-channel 未挂载?),通道服务跳过');
        return;
      }
      const adapters = buildChannelsFromEnv(this.collectEnv(), {
        // 公众号多租户:每用户各配自己的公众号(连接器页凭证),出站按会话解析;
        // 全局 env 凭证在场时 registry 优先走静态单租户形态(部署兜底,行为不变)
        wechatMpCredentialResolver: (conversationId) => this.resolveWechatMpCredentials(conversationId),
      });
      const attached: string[] = [];
      for (const adapter of adapters) {
        try {
          await channel.attach(adapter);
          attached.push(adapter.channel);
        } catch (err: any) {
          // fail-closed:凭证无效等 → 该通道不上线,其余照常
          logRuntime('WARN', 'channel', `通道 ${adapter.channel} 挂载失败(已跳过): ${err?.message || err}`);
        }
      }
      this.unsubscribe?.();
      this.unsubscribe = channel.onMessage((msg) => this.handleInbound(msg));
      this.ready = true;
      logRuntime('INFO', 'channel', `通道服务就绪: ${attached.length ? attached.join(', ') : '(无通道配置,全部关闭)'}`);
    } catch (err: any) {
      logRuntime('ERROR', 'channel', `通道服务启动失败: ${err?.message || err}`);
    }
  }

  /** env 白名单收集:进程 env 优先,扫码授权产物(channel-store)兜底。插件不读 process.env。 */
  private collectEnv(): Record<string, string | undefined> {
    const creds = store.getChannelCredentials();
    return {
      WECHAT_PERSONAL_BOT_TOKEN: process.env.WECHAT_PERSONAL_BOT_TOKEN || creds.wechatPersonalBotToken,
      WECHAT_PERSONAL_BASE_URL: process.env.WECHAT_PERSONAL_BASE_URL || creds.wechatPersonalBaseUrl,
      WECHAT_MP_APPID: process.env.WECHAT_MP_APPID,
      WECHAT_MP_APPSECRET: process.env.WECHAT_MP_APPSECRET,
      QQ_ONEBOT_WS_URL: process.env.QQ_ONEBOT_WS_URL,
      QQ_ONEBOT_ACCESS_TOKEN: process.env.QQ_ONEBOT_ACCESS_TOKEN,
    };
  }

  /** 状态快照(运维 API / 设置页消费)。 */
  status() {
    const channel = getAgentBackend().ctx?.channel;
    return {
      ready: this.ready,
      adapters: channel?.status() ?? [],
      recentErrors: channel?.recentErrors() ?? [],
    };
  }

  /**
   * 公众号多租户凭证解析(注入给适配器):openid → 会话归属公众号主人
   * (webhook 入站时学习,channel-store 持久化)→ 该用户连接器页凭证
   * (与草稿箱直连同一份 WECHAT_MP_CREDENTIAL)。解析不到返回 null,
   * 适配器回落静态 env 凭证(单租户兜底);皆无则 send fail-closed。
   * 注意归属是「公众号主人」而非绑定用户:粉丝绑自己的账号跑任务,
   * 但客服消息永远从收到消息的那个公众号发出。
   */
  private resolveWechatMpCredentials(conversationId: string): { appId: string; appSecret: string } | null {
    const ownerUserId = store.findWechatMpOwner(conversationId);
    if (!ownerUserId) return null;
    return parseWechatMpCredential(getUserConnectors(ownerUserId).configs[WECHAT_MP_CRED_KEY]);
  }

  /**
   * 公众号 webhook 入口:应用层路由(api/wechat/callback)把原始 XML 交这里,
   * 后台异步处理(平台要求 5s 内响应,agent 任务远超此时长 → 被动回复静默,
   * 实际答复走客服消息)。未挂 wechat_mp 通道时返回 false,路由回退旧提示语。
   *
   * ownerUserId(带 u 参数的按用户回调必传):先学习 openid 归属再扇出 ——
   * ingestWebhook 内部同步 await 消息处理器,绑定引导等回复在返回前就会发出,
   * 归属必须赶在第一条回复之前落盘,否则出站凭证解析不到。
   */
  async ingestWechatMpWebhook(rawXml: string, ownerUserId?: string): Promise<boolean> {
    const channel = getAgentBackend().ctx?.channel;
    if (!channel) return false;
    if (ownerUserId) {
      try {
        const openid = parseWechatMpXml(rawXml).fromUserName;
        if (openid) store.learnWechatMpOwner(openid, ownerUserId);
      } catch {
        // 畸形 XML:归属学习跳过,交给适配器 ingest 返回 null
      }
    }
    const msg = await channel.ingestWebhook('wechat_mp', rawXml);
    return msg !== null;
  }

  wechatMpAttached(): boolean {
    const channel = getAgentBackend().ctx?.channel;
    return !!channel?.status().some((s) => s.channel === 'wechat_mp');
  }

  /**
   * 全局单租户路径(无 u 参数的旧回调)是否可用:env 凭证 + 适配器挂载双就绪。
   * 多租户下适配器恒挂载(解析器在场即注册),旧路径必须另查 env 凭证 ——
   * 否则全局公众号没配凭证也会 ingest,回复时才发现无凭证可用。
   */
  wechatMpGlobalReady(): boolean {
    return (
      Boolean(process.env.WECHAT_MP_APPID?.trim() && process.env.WECHAT_MP_APPSECRET?.trim()) &&
      this.wechatMpAttached()
    );
  }

  /** 按用户路径(带 u 参数)的凭证门槛:该用户连接器页配了 AppID:AppSecret 才收消息 */
  wechatMpUserReady(userId: string): boolean {
    try {
      return Boolean(parseWechatMpCredential(getUserConnectors(userId).configs[WECHAT_MP_CRED_KEY]));
    } catch {
      return false;
    }
  }

  // ── 入站主流程 ──

  private async handleInbound(msg: InboundMessage): Promise<void> {
    // 1. 平台重推去重(公众号 3 次重试语义 / WS 重连补发)
    if (store.isDuplicateMessage(msg.channel, msg.messageId)) return;

    // 2. 控制指令(绑定/解绑/新会话)优先于任务派发
    const handled = await this.handleCommand(msg);
    if (handled) return;

    // 3. 身份绑定查询
    const binding = store.findBinding(msg.channel, msg.externalUserId);
    if (!binding) {
      await this.safeSend(msg.channel, msg.conversationId, this.bindGuideText());
      return;
    }

    // 4. 每会话串行派发(同一会话同时最多 1 个在飞任务,追问排队)
    this.enqueue(msg, binding.userId);
  }

  private bindGuideText(): string {
    return [
      '👋 我是 AgtPilot 智能体。你还没有绑定账号。',
      '',
      '绑定方法:',
      '1. 登录 AgtPilot 网页 → /channel 页面,生成 6 位绑定码',
      '2. 在这里发送:绑定 123456(换成你的码,10 分钟内有效)',
      '',
      '绑定后,发给我的消息会由你的 AgtPilot 智能体处理。',
      '其他指令:「解绑」解除绑定;「新会话」开启全新对话。',
    ].join('\n');
  }

  /** 控制指令处理。返回 true = 已消费,不再派发任务。 */
  private async handleCommand(msg: InboundMessage): Promise<boolean> {
    const cmd = parseChannelCommand(msg.text);
    if (!cmd) return false;

    if (cmd.type === 'bind') {
      const consumed = store.consumeBindCode(cmd.code);
      if (!consumed) {
        await this.safeSend(msg.channel, msg.conversationId, '❌ 绑定码无效或已过期,请在网页端重新生成(10 分钟内有效)。');
        return true;
      }
      store.saveBinding({
        channel: msg.channel,
        externalUserId: msg.externalUserId,
        ...(msg.externalUserName ? { externalUserName: msg.externalUserName } : {}),
        userId: consumed.userId,
        boundAt: new Date().toISOString(),
      });
      logRuntime('INFO', 'channel', `绑定成功: ${msg.channel} 用户 → ${consumed.userId}`);
      await this.safeSend(
        msg.channel,
        msg.conversationId,
        '✅ 绑定成功!现在直接把消息发给我,你的 AgtPilot 智能体会处理并回复。\n发送「新会话」可随时开启全新对话。',
      );
      return true;
    }

    if (cmd.type === 'unbind') {
      const removed = store.deleteBinding(msg.channel, msg.externalUserId);
      await this.safeSend(
        msg.channel,
        msg.conversationId,
        removed ? '✅ 已解除绑定。发送「绑定 <6位码>」可重新绑定。' : '当前身份未绑定任何账号。',
      );
      return true;
    }

    // cmd.type === 'new'
    store.resetConversationMission(msg.channel, msg.conversationId);
    await this.safeSend(msg.channel, msg.conversationId, '🆕 已开启新会话,此前的对话上下文不再延续。');
    return true;
  }

  private enqueue(msg: InboundMessage, userId: string): void {
    const key = `${msg.channel}:${msg.conversationId}`;
    const q = this.queues.get(key) ?? { chain: Promise.resolve(), depth: 0 };
    if (q.depth >= MAX_QUEUE_DEPTH) {
      void this.safeSend(msg.channel, msg.conversationId, `⚠️ 排队消息已达 ${MAX_QUEUE_DEPTH} 条,请等当前任务完成后再发。`);
      return;
    }
    q.depth += 1;
    q.chain = q.chain
      .then(() => this.processMessage(msg, userId))
      .catch((err: any) => {
        logRuntime('ERROR', 'channel', `会话 ${key} 处理异常: ${err?.message || err}`);
      })
      .finally(() => {
        q.depth -= 1;
      });
    this.queues.set(key, q);
  }

  private async processMessage(msg: InboundMessage, userId: string): Promise<void> {
    const backend = getAgentBackend();
    const conv = store.getConversation(msg.channel, msg.conversationId);
    // 会话映射只在归属同一用户时续用(防换绑后串上下文)
    const missionId = conv && conv.userId === userId ? conv.missionId : undefined;

    // 慢任务 ack:超过阈值未完成先发「处理中」,避免用户以为掉线
    const ackMs = Number(process.env.AGTPILOT_CHANNEL_ACK_MS ?? DEFAULT_ACK_MS);
    let ackSent = false;
    const ackTimer =
      ackMs > 0
        ? setTimeout(() => {
            ackSent = true;
            void this.safeSend(msg.channel, msg.conversationId, '⏳ 已收到,任务处理中……');
          }, ackMs)
        : null;

    try {
      const mission: Mission = await backend.runMission(msg.text, {
        userId,
        ...(missionId ? { missionId } : {}),
        title: `${msg.channel} 对话`,
        // IM 通道看不到网页问题卡(首版),按无人值守处理:不挂 ask_user,
        // 模糊需求走模型自行拍板,不让用户隔着 IM 干等 5 分钟超时
        unattended: true,
      });
      store.saveConversation({
        channel: msg.channel,
        conversationId: msg.conversationId,
        userId,
        missionId: mission?.id,
        lastActiveAt: new Date().toISOString(),
      });
      const answer = extractFinalAnswer(mission) || '(任务已完成,但没有产生文本答复 —— 可到网页工作台查看详情)';
      await this.safeSend(msg.channel, msg.conversationId, answer);
    } catch (err: any) {
      logRuntime('ERROR', 'channel', `runMission 失败(${msg.channel}): ${err?.message || err}`);
      await this.safeSend(msg.channel, msg.conversationId, `❌ 任务处理失败: ${err?.message || '未知错误'}`);
    } finally {
      if (ackTimer) clearTimeout(ackTimer);
      void ackSent; // ack 与最终答复都可能送达,平台侧按消息序展示,无需撤回
    }
  }

  /** 发送兜底:通道故障不能把异常抛回适配器循环(引擎虽会兜,这里显式记日志)。 */
  private async safeSend(channelId: string, conversationId: string, text: string): Promise<void> {
    try {
      const channel = getAgentBackend().ctx?.channel;
      if (!channel) return;
      await channel.send(channelId, { conversationId, text });
    } catch (err: any) {
      logRuntime('WARN', 'channel', `回复发送失败(${channelId}): ${err?.message || err}`);
    }
  }

  // ── 微信个人号(iLink)扫码授权运维流 ──

  /** 第一步:取登录二维码。返回 handle(轮询用)与可渲染的二维码内容。 */
  async startWechatPersonalQr(): Promise<{ handle: string; qrContent: string }> {
    const qr = await requestWeixinLoginQr();
    const handle = `qr_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    this.qrSessions.set(handle, {
      handle,
      qrcode: qr.qrcode,
      baseUrl: WECHAT_PERSONAL_DEFAULT_BASE_URL,
      createdAt: Date.now(),
    });
    return { handle, qrContent: qr.qrcodeImgContent || qr.qrcode };
  }

  /**
   * 第二步:轮询授权状态。confirmed → token 落 channel-store(绝不回显给前端)
   * 并热挂载适配器;*redirect → 换 host 重新取码(同 handle,返回新 qrContent);
   * 其余状态透传。会话 10 分钟过期。
   */
  async pollWechatPersonalQr(handle: string): Promise<QrPollResult> {
    const session = this.qrSessions.get(handle);
    if (!session || Date.now() - session.createdAt > 10 * 60 * 1000) {
      this.qrSessions.delete(handle);
      return { status: 'unknown_handle' };
    }
    let st: WeixinLoginStatus;
    try {
      st = await pollWeixinLoginStatus(session.qrcode, session.baseUrl);
    } catch (err: any) {
      return { status: 'wait', note: `poll error: ${err?.message || err}` };
    }
    if (st.status === 'scaned_but_redirect' || st.status === 'binded_redirect') {
      if (st.redirectHost) {
        try {
          const base = st.redirectHost.replace(/^https?:\/\//, '');
          const next = await requestWeixinLoginQr(`https://${base}`);
          this.qrSessions.set(handle, {
            handle,
            qrcode: next.qrcode,
            baseUrl: `https://${base}`,
            createdAt: Date.now(),
          });
          return { status: 'wait', qrContent: next.qrcodeImgContent || next.qrcode, note: 'redirected, rescan required' };
        } catch {
          return { status: 'expired', note: 'redirect re-qrcode failed' };
        }
      }
      return { status: 'wait', note: 'redirect without host' };
    }
    if (st.status === 'confirmed') {
      this.qrSessions.delete(handle);
      store.saveChannelCredentials({
        wechatPersonalBotToken: st.botToken,
        wechatPersonalBaseUrl: st.baseUrl,
      });
      // 热挂载:不等进程重启,扫码完成即上线
      try {
        const channel = getAgentBackend().ctx?.channel;
        if (channel) {
          await channel.attach(
            new WechatPersonalChannelAdapter({
              botToken: st.botToken,
              ...(st.baseUrl ? { baseUrl: st.baseUrl } : {}),
            }),
          );
        }
        logRuntime('INFO', 'channel', 'wechat_personal 扫码授权完成,通道已热挂载');
      } catch (err: any) {
        logRuntime('ERROR', 'channel', `wechat_personal 热挂载失败(重启后按存储凭证重试): ${err?.message || err}`);
      }
      return { status: 'confirmed' };
    }
    return { status: st.status };
  }
}

const g = globalThis as typeof globalThis & { __agtChannelManager?: ChannelManager };

export function getChannelManager(): ChannelManager {
  g.__agtChannelManager ??= new ChannelManager();
  return g.__agtChannelManager;
}

/** instrumentation.ts 启动入口(fire-and-forget,内部全捕获,永不拖垮进程启动)。 */
export function initChannelService(): void {
  getChannelManager()
    .init()
    .catch((err: any) => {
      console.error('[channel-service] init failed:', err?.message || err);
    });
}
