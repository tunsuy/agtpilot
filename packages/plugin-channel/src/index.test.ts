import { describe, it, expect } from 'vitest';
import { Context } from '@deepseek-ai/cordis';
import { apply, ChannelService, supportsWebhookIngest } from './index';
import * as ChannelPlugin from './index';
import type {
  ChannelAdapter,
  ChannelAdapterEvents,
  InboundMessage,
  OutboundReply,
} from '@agentoryhq/im-channel-contract';
import { ADAPTER_API_VERSION, ChannelAdapterError } from '@agentoryhq/im-channel-contract';

/**
 * ChannelService 引擎守护用例。
 * 不变量:挂载/卸载/替换语义、扇出顺序与异常隔离、send 路由、
 * webhook ingest 能力探测、启动失败不留残骸、错误环形缓冲。
 */

function msg(channel: string, text: string, id = '1'): InboundMessage {
  return {
    channel,
    externalUserId: `u_${id}`,
    conversationId: `c_${id}`,
    conversationType: 'private',
    messageId: id,
    text,
    mentionedBot: true,
    receivedAt: new Date().toISOString(),
  };
}

type FakeAdapter = ChannelAdapter & {
  emit(m: InboundMessage): Promise<void>;
  emitError(e: ChannelAdapterError): void;
  reportState(s: 'connected' | 'disconnected'): void;
  sent: OutboundReply[];
  stopCount: number;
  startShouldFail?: boolean;
  webhook?: (payload: string) => InboundMessage | null;
};

function fakeAdapter(channel: string, over: Partial<FakeAdapter> = {}): FakeAdapter {
  let events: ChannelAdapterEvents | null = null;
  let started = false;
  const a: FakeAdapter = {
    channel,
    apiVersion: ADAPTER_API_VERSION,
    capabilities: ['private'],
    sent: [],
    stopCount: 0,
    ...over,
    async start(ev) {
      if (a.startShouldFail) throw new ChannelAdapterError(channel, 'credential_invalid', 'fake fail');
      events = ev;
      started = true;
      ev.onStateChange?.('connected');
    },
    async stop() {
      a.stopCount += 1;
      started = false;
      events = null;
    },
    async send(reply) {
      if (!started) throw new ChannelAdapterError(channel, 'not_started', 'fake not started');
      a.sent.push(reply);
      return { channelMessageId: `m_${a.sent.length}` };
    },
    async probeCredentials() {
      return { ok: true };
    },
    async emit(m) {
      await events?.onMessage(m);
    },
    emitError(e) {
      events?.onError?.(e);
    },
    reportState(s) {
      events?.onStateChange?.(s);
    },
  };
  if (a.webhook) {
    (a as any).ingestWebhook = (payload: string) => a.webhook!(payload);
  }
  return a;
}

function makeService() {
  const ctx = new Context();
  const svc = new ChannelService(ctx);
  return { ctx, svc };
}

describe('ChannelService 挂载/卸载', () => {
  it('attach 后 status 可见;detach 停止并清理', async () => {
    const { svc } = makeService();
    const a = fakeAdapter('ch_a');
    await svc.attach(a);
    expect(svc.status()).toEqual([{ channel: 'ch_a', state: 'connected', capabilities: ['private'] }]);
    expect(await svc.detach('ch_a')).toBe(true);
    expect(a.stopCount).toBe(1);
    expect(svc.status()).toEqual([]);
    expect(await svc.detach('ch_a')).toBe(false);
  });

  it('同 channel 重复 attach = 替换(旧实例被 stop)', async () => {
    const { svc } = makeService();
    const a1 = fakeAdapter('ch_a');
    const a2 = fakeAdapter('ch_a');
    await svc.attach(a1);
    await svc.attach(a2);
    expect(a1.stopCount).toBe(1);
    expect(svc.status()).toHaveLength(1);
    await svc.send('ch_a', { conversationId: 'c', text: 'x' });
    expect(a2.sent).toHaveLength(1);
    expect(a1.sent).toHaveLength(0);
  });

  it('start 失败 → 注册表不留残骸,错误原样上抛', async () => {
    const { svc } = makeService();
    const a = fakeAdapter('ch_bad', { startShouldFail: true });
    await expect(svc.attach(a)).rejects.toMatchObject({ code: 'credential_invalid' });
    expect(svc.status()).toEqual([]);
    await expect(svc.send('ch_bad', { conversationId: 'c', text: 'x' })).rejects.toThrow(/未挂载/);
  });
});

describe('ChannelService 消息扇出', () => {
  it('多处理器按注册顺序收到;注销函数生效', async () => {
    const { svc } = makeService();
    const a = fakeAdapter('ch_a');
    await svc.attach(a);
    const order: string[] = [];
    const off1 = svc.onMessage((m) => {
      order.push(`h1:${m.text}`);
    });
    svc.onMessage(async (m) => {
      order.push(`h2:${m.text}`);
    });
    await a.emit(msg('ch_a', 'hello'));
    expect(order).toEqual(['h1:hello', 'h2:hello']);
    off1();
    await a.emit(msg('ch_a', 'again', '2'));
    expect(order).toEqual(['h1:hello', 'h2:hello', 'h2:again']);
  });

  it('处理器异常不击穿适配器循环,后续处理器照常', async () => {
    const { svc } = makeService();
    const a = fakeAdapter('ch_a');
    await svc.attach(a);
    const seen: string[] = [];
    svc.onMessage(() => {
      throw new Error('boom');
    });
    svc.onMessage((m) => {
      seen.push(m.text);
    });
    await a.emit(msg('ch_a', 'still delivered'));
    expect(seen).toEqual(['still delivered']);
  });
});

describe('ChannelService 发送路由', () => {
  it('按 channel 路由到对应适配器', async () => {
    const { svc } = makeService();
    const a = fakeAdapter('ch_a');
    const b = fakeAdapter('ch_b');
    await svc.attach(a);
    await svc.attach(b);
    const r = await svc.send('ch_b', { conversationId: 'c1', text: 'to b' });
    expect(r).toEqual({ channelMessageId: 'm_1' });
    expect(b.sent).toEqual([{ conversationId: 'c1', text: 'to b' }]);
    expect(a.sent).toHaveLength(0);
  });

  it('未挂载通道 → 显式报错(不静默)', async () => {
    const { svc } = makeService();
    await expect(svc.send('nope', { conversationId: 'c', text: 'x' })).rejects.toThrow(/未挂载/);
  });
});

describe('ChannelService webhook ingest', () => {
  it('支持 ingest 的适配器:payload → 归一化 → 扇出', async () => {
    const { svc } = makeService();
    const a = fakeAdapter('ch_hook', {
      webhook: (payload) => (payload === '<xml>ok' ? msg('ch_hook', 'from webhook', 'w1') : null),
    });
    await svc.attach(a);
    expect(supportsWebhookIngest(a)).toBe(true);
    const seen: InboundMessage[] = [];
    svc.onMessage((m) => {
      seen.push(m);
    });
    const r = await svc.ingestWebhook('ch_hook', '<xml>ok');
    expect(r?.text).toBe('from webhook');
    expect(seen).toHaveLength(1);
    expect(await svc.ingestWebhook('ch_hook', 'junk')).toBeNull();
  });

  it('不支持 ingest / 未挂载 → null(显式,不假装成功)', async () => {
    const { svc } = makeService();
    const a = fakeAdapter('ch_a');
    await svc.attach(a);
    expect(supportsWebhookIngest(a)).toBe(false);
    expect(await svc.ingestWebhook('ch_a', 'x')).toBeNull();
    expect(await svc.ingestWebhook('ghost', 'x')).toBeNull();
  });
});

describe('ChannelService 状态与错误', () => {
  it('状态翻转跟随适配器上报;错误进环形缓冲', async () => {
    const { svc } = makeService();
    const a = fakeAdapter('ch_a');
    await svc.attach(a);
    a.reportState('disconnected');
    expect(svc.status()[0].state).toBe('disconnected');
    a.emitError(new ChannelAdapterError('ch_a', 'connection_lost', 'ws dropped', true));
    const errs = svc.recentErrors();
    expect(errs).toHaveLength(1);
    expect(errs[0]).toMatchObject({ channel: 'ch_a', code: 'connection_lost', message: expect.stringContaining('ws dropped') });
  });
});

describe('cordis 插件入口', () => {
  it('导出 apply;ctx.plugin 挂模块对象即注册 ctx.channel(app-kit mount 同路径,生产 invalid plugin 加载失败回归)', async () => {
    expect(typeof apply).toBe('function');
    const ctx = new Context();
    await ctx.plugin(ChannelPlugin);
    expect(ctx.channel).toBeInstanceOf(ChannelService);
  });
});
