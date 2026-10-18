import { describe, it, expect, vi } from 'vitest';
import {
  QqOnebotChannelAdapter,
  QQ_ONEBOT_CHANNEL,
  QQ_ONEBOT_TEXT_LIMIT,
  buildOnebotConversationId,
  clampOnebotText,
  extractOnebotText,
  normalizeOnebotMessage,
  parseOnebotConversationId,
  type OnebotSocket,
  type OnebotTransportFactory,
} from './qq-onebot';
import { ADAPTER_API_VERSION } from '@agentoryhq/im-channel-contract';
import type { InboundMessage } from '@agentoryhq/im-channel-contract';

/**
 * QQ OneBot v11 适配器守护用例。
 * 不变量:归一化规则(群聊非@零发射/self_id 缺失 fail-closed/空白折叠/截断)、
 * 契约守卫(身份/凭证 fail-closed/not_started/密钥卫生)、假传输下的
 * 收发闭环与断线重连 —— 全程不起真实网络连接。
 */

const SECRET = 'FAKE-SECRET-xyz';

const privateMsg = (over: Record<string, unknown> = {}) => ({
  post_type: 'message',
  message_type: 'private',
  sub_type: 'friend',
  self_id: 10001,
  user_id: 20002,
  message_id: 777,
  time: 1760000000,
  message: [{ type: 'text', data: { text: ' 你好  世界 ' } }],
  sender: { user_id: 20002, nickname: '小明' },
  ...over,
});

const groupMsg = (over: Record<string, unknown> = {}) => ({
  post_type: 'message',
  message_type: 'group',
  sub_type: 'normal',
  self_id: 10001,
  user_id: 30003,
  group_id: 40004,
  message_id: 888,
  time: 1760000001,
  message: [
    { type: 'at', data: { qq: '10001' } },
    { type: 'text', data: { text: '帮我看下' } },
  ],
  sender: { user_id: 30003, nickname: '群友', card: '群名片' },
  ...over,
});

describe('parseOnebotConversationId / build', () => {
  it('private/group 前缀解析与构造互逆', () => {
    expect(parseOnebotConversationId('private:20002')).toEqual({ type: 'private', targetId: '20002' });
    expect(parseOnebotConversationId('group:40004')).toEqual({ type: 'group', targetId: '40004' });
    expect(buildOnebotConversationId('group', 40004)).toBe('group:40004');
  });
  it('非法形态 → null', () => {
    expect(parseOnebotConversationId('')).toBeNull();
    expect(parseOnebotConversationId('user:1')).toBeNull();
    expect(parseOnebotConversationId('private:abc')).toBeNull();
  });
});

describe('extractOnebotText', () => {
  it('数组形态:拼 text 段、at 段判提及并跳过、其余段忽略', () => {
    const r = extractOnebotText(
      [
        { type: 'at', data: { qq: '10001' } },
        { type: 'text', data: { text: ' 你好 ' } },
        { type: 'image', data: { file: 'x' } },
        { type: 'text', data: { text: '世界' } },
      ],
      undefined,
      '10001',
    );
    expect(r).toEqual({ text: '你好 世界', mentioned: true });
  });
  it('at all 视为提及', () => {
    const r = extractOnebotText([{ type: 'at', data: { qq: 'all' } }, { type: 'text', data: { text: 'hi' } }], undefined, '10001');
    expect(r.mentioned).toBe(true);
  });
  it('CQ 字符串形态:检测 at、剥 CQ 码(段剥离后直接拼接)', () => {
    const r = extractOnebotText('[CQ:at,qq=10001] 早上[CQ:face,id=1]好', undefined, '10001');
    expect(r).toEqual({ text: '早上好', mentioned: true });
  });
  it('空文本 → text null', () => {
    expect(extractOnebotText([{ type: 'image', data: {} }], undefined, '1').text).toBeNull();
    expect(extractOnebotText('   ', '   ', '1').text).toBeNull();
  });
});

describe('normalizeOnebotMessage', () => {
  it('私聊:归一化全字段', () => {
    const m = normalizeOnebotMessage(privateMsg() as any)!;
    expect(m).toMatchObject({
      channel: QQ_ONEBOT_CHANNEL,
      externalUserId: '20002',
      externalUserName: '小明',
      conversationId: 'private:20002',
      conversationType: 'private',
      messageId: '777',
      text: '你好 世界',
      mentionedBot: true,
      receivedAt: new Date(1760000000 * 1000).toISOString(),
    });
  });
  it('群聊@机器人:发射;externalUserId 带会话前缀(群内多人不串台)', () => {
    const m = normalizeOnebotMessage(groupMsg() as any)!;
    expect(m.conversationId).toBe('group:40004');
    expect(m.conversationType).toBe('group');
    expect(m.externalUserId).toBe('group:40004/30003');
    expect(m.externalUserName).toBe('群名片');
    expect(m.text).toBe('帮我看下');
    expect(m.mentionedBot).toBe(true);
  });
  it('群聊未@ → 零发射丢弃', () => {
    const ev = groupMsg({ message: [{ type: 'text', data: { text: '闲聊' } }] });
    expect(normalizeOnebotMessage(ev as any)).toBeNull();
  });
  it('群聊 self_id 缺失 → 无法验证提及,fail-closed 丢弃', () => {
    const ev = groupMsg();
    delete (ev as any).self_id;
    expect(normalizeOnebotMessage(ev as any)).toBeNull();
  });
  it('非 message 事件 / 缺 message_id / 非文本 → null', () => {
    expect(normalizeOnebotMessage({ post_type: 'notice' } as any)).toBeNull();
    const noId = privateMsg();
    delete (noId as any).message_id;
    expect(normalizeOnebotMessage(noId as any)).toBeNull();
    expect(normalizeOnebotMessage(privateMsg({ message: [{ type: 'image', data: {} }] }) as any)).toBeNull();
  });
  it('raw 不含凭证类字段,仅诊断元数据', () => {
    const m = normalizeOnebotMessage(privateMsg() as any)!;
    expect(m.raw).toEqual({ messageType: 'private', subType: 'friend' });
  });
});

describe('clampOnebotText', () => {
  it('不超限原样;超限截断带标记', () => {
    expect(clampOnebotText('短')).toEqual({ text: '短', truncated: false });
    const long = 'a'.repeat(QQ_ONEBOT_TEXT_LIMIT + 100);
    const r = clampOnebotText(long);
    expect(r.truncated).toBe(true);
    expect(r.text.length).toBe(QQ_ONEBOT_TEXT_LIMIT);
    expect(r.text.endsWith('…')).toBe(true);
  });
});

// ── 假传输 ──

class FakeSocket implements OnebotSocket {
  isOpen = false;
  sent: string[] = [];
  private openCbs: Array<() => void> = [];
  private dataCbs: Array<(j: unknown) => void> = [];
  private errCbs: Array<(e: unknown) => void> = [];
  private closeCbs: Array<() => void> = [];
  simulateOpen() {
    this.isOpen = true;
    this.openCbs.forEach((cb) => cb());
  }
  simulateData(json: unknown) {
    this.dataCbs.forEach((cb) => cb(json));
  }
  simulateError(err: unknown) {
    this.errCbs.forEach((cb) => cb(err));
  }
  simulateClose() {
    this.isOpen = false;
    this.closeCbs.forEach((cb) => cb());
  }
  send(data: string) {
    if (!this.isOpen) throw new Error('not open');
    this.sent.push(data);
  }
  close() {
    this.simulateClose();
  }
  onOpen(cb: () => void) {
    this.openCbs.push(cb);
  }
  onClose(cb: () => void) {
    this.closeCbs.push(cb);
  }
  onError(cb: (e: unknown) => void) {
    this.errCbs.push(cb);
  }
  onData(cb: (j: unknown) => void) {
    this.dataCbs.push(cb);
  }
}

function fakeTransport() {
  const sockets: FakeSocket[] = [];
  const factory: OnebotTransportFactory = (url, headers) => {
    const s = new FakeSocket();
    (s as any).url = url;
    (s as any).headers = headers;
    sockets.push(s);
    return s;
  };
  return { factory, sockets };
}

function makeAdapter(over: Partial<ConstructorParameters<typeof QqOnebotChannelAdapter>[0]> = {}) {
  const { factory, sockets } = fakeTransport();
  const reconnects: Array<{ ms: number; cb: () => void }> = [];
  const adapter = new QqOnebotChannelAdapter({
    wsUrl: 'ws://napcat.local:3001/onebot/v11/ws',
    accessToken: SECRET,
    transport: factory,
    actionTimeoutMs: 50,
    scheduleReconnectIn: (ms, cb) => {
      reconnects.push({ ms, cb });
      return () => {};
    },
    ...over,
  });
  return { adapter, sockets, reconnects };
}

const events = (sink: InboundMessage[]) => ({
  onMessage: (m: InboundMessage) => {
    sink.push(m);
  },
});

describe('QqOnebotChannelAdapter 契约守卫', () => {
  it('身份:apiVersion / channel / capabilities', () => {
    const { adapter } = makeAdapter();
    expect(adapter.apiVersion).toBe(ADAPTER_API_VERSION);
    expect(adapter.channel).toBe(QQ_ONEBOT_CHANNEL);
    expect([...adapter.capabilities]).toEqual(['private', 'group']);
  });
  it('probeCredentials fail-closed 且不回显值', async () => {
    const { adapter } = makeAdapter({ wsUrl: '' });
    const p = await adapter.probeCredentials();
    expect(p.ok).toBe(false);
    const bad = makeAdapter({ wsUrl: 'http://x' }).adapter;
    const p2 = await bad.probeCredentials();
    expect(p2.ok).toBe(false);
    const good = makeAdapter().adapter;
    expect((await good.probeCredentials()).ok).toBe(true);
  });
  it('凭证非法 → start reject credential_invalid', async () => {
    const { adapter } = makeAdapter({ wsUrl: '' });
    await expect(adapter.start(events([]))).rejects.toMatchObject({ code: 'credential_invalid' });
  });
  it('未 start 就 send → not_started;start 前 stop 安全', async () => {
    const { adapter } = makeAdapter();
    await expect(adapter.send({ conversationId: 'private:1', text: 'x' })).rejects.toMatchObject({ code: 'not_started' });
    await expect(adapter.stop()).resolves.toBeUndefined();
  });
  it('密钥卫生:token 不出现在任何错误消息', async () => {
    const { adapter } = makeAdapter();
    await adapter.start(events([]));
    // 未 open 就 send → connection_lost
    try {
      await adapter.send({ conversationId: 'private:1', text: 'x' });
      expect.unreachable();
    } catch (e: any) {
      expect(e.message).not.toContain(SECRET);
    }
    await adapter.stop();
  });
});

describe('QqOnebotChannelAdapter 收发闭环', () => {
  it('start→open 置 connected;入站帧归一化后发射', async () => {
    const { adapter, sockets } = makeAdapter();
    const sink: InboundMessage[] = [];
    const states: string[] = [];
    await adapter.start({ ...events(sink), onStateChange: (s) => states.push(s) });
    sockets[0].simulateOpen();
    expect(states).toEqual(['connecting', 'connected']);
    sockets[0].simulateData(privateMsg());
    expect(sink).toHaveLength(1);
    expect(sink[0].text).toBe('你好 世界');
    await adapter.stop();
    expect(states.at(-1)).toBe('disconnected');
  });

  it('出站:action 帧带 Bearer 头与 echo;回执 retcode=0 → resolve channelMessageId', async () => {
    const { adapter, sockets } = makeAdapter();
    await adapter.start(events([]));
    sockets[0].simulateOpen();
    expect((sockets[0] as any).headers.Authorization).toBe(`Bearer ${SECRET}`);
    const p = adapter.send({ conversationId: 'group:40004', text: '收到' });
    const frame = JSON.parse(sockets[0].sent[0]);
    expect(frame.action).toBe('send_group_msg');
    expect(frame.params.group_id).toBe(40004);
    expect(frame.params.message).toEqual([{ type: 'text', data: { text: '收到' } }]);
    sockets[0].simulateData({ echo: frame.echo, retcode: 0, data: { message_id: 999 } });
    await expect(p).resolves.toEqual({ channelMessageId: '999' });
    await adapter.stop();
  });

  it('回执 status=ok 形态同样成功;retcode≠0 → send_failed', async () => {
    const { adapter, sockets } = makeAdapter();
    await adapter.start(events([]));
    sockets[0].simulateOpen();
    const p1 = adapter.send({ conversationId: 'private:20002', text: 'a' });
    const f1 = JSON.parse(sockets[0].sent[0]);
    sockets[0].simulateData({ echo: f1.echo, status: 'ok', data: {} });
    await expect(p1).resolves.toEqual({});
    const p2 = adapter.send({ conversationId: 'private:20002', text: 'b' });
    const f2 = JSON.parse(sockets[0].sent[1]);
    sockets[0].simulateData({ echo: f2.echo, retcode: 100, status: 'failed' });
    await expect(p2).rejects.toMatchObject({ code: 'send_failed' });
    await adapter.stop();
  });

  it('action 超时 → send_failed(retryable)', async () => {
    const { adapter, sockets } = makeAdapter();
    await adapter.start(events([]));
    sockets[0].simulateOpen();
    await expect(adapter.send({ conversationId: 'private:1', text: 'x' })).rejects.toMatchObject({
      code: 'send_failed',
      retryable: true,
    });
    await adapter.stop();
  });

  it('非法 conversationId → send_failed', async () => {
    const { adapter, sockets } = makeAdapter();
    await adapter.start(events([]));
    sockets[0].simulateOpen();
    await expect(adapter.send({ conversationId: 'bad', text: 'x' })).rejects.toMatchObject({ code: 'send_failed' });
    await adapter.stop();
  });

  it('断线 → reconnecting + 退避重连;stop 后不再重连', async () => {
    const { adapter, sockets, reconnects } = makeAdapter();
    const states: string[] = [];
    await adapter.start({ onMessage: () => {}, onStateChange: (s) => states.push(s) });
    sockets[0].simulateOpen();
    sockets[0].simulateClose();
    expect(states.at(-1)).toBe('reconnecting');
    expect(reconnects).toHaveLength(1);
    expect(reconnects[0].ms).toBeGreaterThanOrEqual(1000);
    // 触发重连 → 建新 socket
    reconnects[0].cb();
    expect(sockets).toHaveLength(2);
    sockets[1].simulateOpen();
    expect(states.at(-1)).toBe('connected');
    // 再断 + stop → 不再新建
    sockets[1].simulateClose();
    await adapter.stop();
    const before = sockets.length;
    reconnects.at(-1)!.cb();
    expect(sockets.length).toBe(before);
  });

  it('断线时在飞 action 全部 reject(connection_lost)', async () => {
    const { adapter, sockets } = makeAdapter();
    await adapter.start(events([]));
    sockets[0].simulateOpen();
    const p = adapter.send({ conversationId: 'private:1', text: 'x' });
    sockets[0].simulateClose();
    await expect(p).rejects.toMatchObject({ code: 'connection_lost' });
    await adapter.stop();
  });

  it('start 幂等:二次 start 不重复建连', async () => {
    const { adapter, sockets } = makeAdapter();
    await adapter.start(events([]));
    await adapter.start(events([]));
    expect(sockets).toHaveLength(1);
    await adapter.stop();
  });
});
