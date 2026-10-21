import { describe, it, expect, vi } from 'vitest';
import {
  WechatMpChannelAdapter,
  WECHAT_MP_CHANNEL,
  WECHAT_MP_TEXT_BYTE_LIMIT,
  clampWechatMpText,
  normalizeWechatMpMessage,
  parseWechatMpXml,
} from './wechat-mp';
import { ADAPTER_API_VERSION } from '@agentoryhq/im-channel-contract';
import type { InboundMessage } from '@agentoryhq/im-channel-contract';

/**
 * 公众号适配器守护用例。
 * 不变量:XML 解析(CDATA/明文/事件/畸形)、归一化(仅文本发射/MsgId 去重锚点)、
 * 字节级截断(不砍半个汉字)、token 缓存与 40001 强刷重试一次、
 * 契约守卫(身份/fail-closed/not_started/密钥卫生) —— stub fetch,零真实网络。
 */

const APPID = 'wx_FAKE_APPID';
const SECRET = 'FAKE-SECRET-xyz';

const textXml = `<xml>
  <ToUserName><![CDATA[gh_bot]]></ToUserName>
  <FromUserName><![CDATA[oABC123]]></FromUserName>
  <CreateTime>1760000000</CreateTime>
  <MsgType><![CDATA[text]]></MsgType>
  <Content><![CDATA[ 你好 agtpilot ]]></Content>
  <MsgId>1234567890</MsgId>
</xml>`;

const eventXml = `<xml>
  <ToUserName><![CDATA[gh_bot]]></ToUserName>
  <FromUserName><![CDATA[oABC123]]></FromUserName>
  <CreateTime>1760000001</CreateTime>
  <MsgType><![CDATA[event]]></MsgType>
  <Event><![CDATA[subscribe]]></Event>
</xml>`;

describe('parseWechatMpXml', () => {
  it('CDATA 与明文字段、事件字段', () => {
    const p = parseWechatMpXml(textXml);
    expect(p).toMatchObject({
      fromUserName: 'oABC123',
      toUserName: 'gh_bot',
      msgType: 'text',
      content: '你好 agtpilot',
      msgId: '1234567890',
      createTime: '1760000000',
    });
    const e = parseWechatMpXml(eventXml);
    expect(e.msgType).toBe('event');
    expect(e.event).toBe('subscribe');
  });
  it('明文 Content 也可解析;畸形 XML 不 throw(字段为空)', () => {
    const plain = '<xml><MsgType>text</MsgType><Content>hi</Content><FromUserName>o1</FromUserName></xml>';
    expect(parseWechatMpXml(plain).content).toBe('hi');
    expect(parseWechatMpXml('garbage').msgType).toBe('');
  });
});

describe('normalizeWechatMpMessage', () => {
  it('文本消息 → InboundMessage(openid 即会话)', () => {
    const m = normalizeWechatMpMessage(parseWechatMpXml(textXml))!;
    expect(m).toMatchObject({
      channel: WECHAT_MP_CHANNEL,
      externalUserId: 'oABC123',
      conversationId: 'oABC123',
      conversationType: 'private',
      messageId: '1234567890',
      text: '你好 agtpilot',
      mentionedBot: true,
      receivedAt: new Date(1760000000 * 1000).toISOString(),
    });
  });
  it('事件/空内容/缺 openid → null(零发射)', () => {
    expect(normalizeWechatMpMessage(parseWechatMpXml(eventXml))).toBeNull();
    expect(
      normalizeWechatMpMessage({ ...parseWechatMpXml(textXml), content: '   ' }),
    ).toBeNull();
    expect(
      normalizeWechatMpMessage({ ...parseWechatMpXml(textXml), fromUserName: '' }),
    ).toBeNull();
  });
  it('MsgId 缺失回退 from+createTime(仍有去重锚点)', () => {
    const m = normalizeWechatMpMessage({ ...parseWechatMpXml(textXml), msgId: '' })!;
    expect(m.messageId).toBe('oABC123:1760000000');
  });
});

describe('clampWechatMpText(字节级)', () => {
  it('ASCII 不超限原样', () => {
    expect(clampWechatMpText('hello')).toEqual({ text: 'hello', truncated: false });
  });
  it('中文按字节截断且不砍半个字', () => {
    const long = '汉'.repeat(1000); // 3000 字节 > 2048
    const r = clampWechatMpText(long);
    expect(r.truncated).toBe(true);
    expect(Buffer.byteLength(r.text, 'utf8')).toBeLessThanOrEqual(WECHAT_MP_TEXT_BYTE_LIMIT);
    expect(r.text.endsWith('…')).toBe(true);
    // 截断点前的正文仍是完整「汉」
    expect(r.text.slice(0, -1)).toMatch(/^汉+$/);
  });
});

// ── stub fetch ──

type FetchCall = { url: string; body: any };

function stubFetch(handler: (call: FetchCall, n: number) => Record<string, any>) {
  const calls: FetchCall[] = [];
  const impl = vi.fn(async (url: any, init: any) => {
    const call = { url: String(url), body: JSON.parse(String(init?.body ?? '{}')) };
    calls.push(call);
    const json = handler(call, calls.length);
    return { ok: true, status: 200, json: async () => json } as any;
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

function makeAdapter(fetchImpl: typeof fetch) {
  return new WechatMpChannelAdapter({ appId: APPID, appSecret: SECRET, fetchImpl });
}

const tokenOk = { access_token: 'TOKEN-1', expires_in: 7200 };

describe('WechatMpChannelAdapter 契约守卫', () => {
  it('身份:apiVersion / channel / capabilities(仅私聊)', () => {
    const { impl } = stubFetch(() => ({}));
    const a = makeAdapter(impl);
    expect(a.apiVersion).toBe(ADAPTER_API_VERSION);
    expect(a.channel).toBe(WECHAT_MP_CHANNEL);
    expect([...a.capabilities]).toEqual(['private']);
  });
  it('凭证缺失:probe fail-closed(不回显值)、start reject credential_invalid', async () => {
    const { impl } = stubFetch(() => ({}));
    const a = new WechatMpChannelAdapter({ appId: '', appSecret: SECRET, fetchImpl: impl });
    const p = await a.probeCredentials();
    expect(p.ok).toBe(false);
    if (!p.ok) expect(p.reason).not.toContain(SECRET);
    await expect(a.start({ onMessage: () => {} })).rejects.toMatchObject({ code: 'credential_invalid' });
  });
  it('未 start 就 send → not_started;start 前 stop 安全', async () => {
    const { impl } = stubFetch(() => ({}));
    const a = makeAdapter(impl);
    await expect(a.send({ conversationId: 'o1', text: 'x' })).rejects.toMatchObject({ code: 'not_started' });
    await expect(a.stop()).resolves.toBeUndefined();
  });
});

describe('WechatMpChannelAdapter 收发', () => {
  it('ingestWebhook:文本 XML → 归一化消息;事件/畸形 → null', async () => {
    const { impl } = stubFetch(() => ({}));
    const a = makeAdapter(impl);
    await a.start({ onMessage: () => {} });
    expect(a.ingestWebhook(textXml)).toMatchObject({ text: '你好 agtpilot', conversationId: 'oABC123' });
    expect(a.ingestWebhook(eventXml)).toBeNull();
    expect(a.ingestWebhook('not xml at all')).toBeNull();
    await a.stop();
  });

  it('send:stable_token → custom/send 两跳;返回 channelMessageId', async () => {
    const { impl, calls } = stubFetch((c) =>
      c.url.includes('stable_token') ? tokenOk : { errcode: 0, errmsg: 'ok', msgid: 555 },
    );
    const a = makeAdapter(impl);
    await a.start({ onMessage: () => {} });
    const r = await a.send({ conversationId: 'oABC123', text: '回复内容' });
    expect(r).toEqual({ channelMessageId: '555' });
    expect(calls).toHaveLength(2);
    expect(calls[0].url).toContain('/cgi-bin/stable_token');
    expect(calls[0].body).toMatchObject({ grant_type: 'client_credential', appid: APPID, secret: SECRET });
    expect(calls[1].url).toContain('/cgi-bin/message/custom/send?access_token=TOKEN-1');
    expect(calls[1].body).toEqual({ touser: 'oABC123', msgtype: 'text', text: { content: '回复内容' } });
    await a.stop();
  });

  it('token 内存缓存:二次 send 不再换 token', async () => {
    const { impl, calls } = stubFetch((c) =>
      c.url.includes('stable_token') ? tokenOk : { errcode: 0, errmsg: 'ok' },
    );
    const a = makeAdapter(impl);
    await a.start({ onMessage: () => {} });
    await a.send({ conversationId: 'o1', text: 'a' });
    await a.send({ conversationId: 'o1', text: 'b' });
    expect(calls.filter((c) => c.url.includes('stable_token'))).toHaveLength(1);
    await a.stop();
  });

  it('40001 → 强刷 token(force_refresh)重试一次成功', async () => {
    let sendCount = 0;
    const { impl, calls } = stubFetch((c) => {
      if (c.url.includes('stable_token')) return c.body.force_refresh ? { access_token: 'TOKEN-2', expires_in: 7200 } : tokenOk;
      sendCount += 1;
      return sendCount === 1 ? { errcode: 40001, errmsg: 'invalid credential' } : { errcode: 0, errmsg: 'ok', msgid: 1 };
    });
    const a = makeAdapter(impl);
    await a.start({ onMessage: () => {} });
    await expect(a.send({ conversationId: 'o1', text: 'x' })).resolves.toEqual({ channelMessageId: '1' });
    const tokenCalls = calls.filter((c) => c.url.includes('stable_token'));
    expect(tokenCalls).toHaveLength(2);
    expect(tokenCalls[1].body.force_refresh).toBe(true);
    await a.stop();
  });

  it('业务 errcode(45015 超时限)→ send_failed 且 retryable;错误不含密钥', async () => {
    const { impl } = stubFetch((c) =>
      c.url.includes('stable_token') ? tokenOk : { errcode: 45015, errmsg: 'response out of time limit' },
    );
    const a = makeAdapter(impl);
    await a.start({ onMessage: () => {} });
    try {
      await a.send({ conversationId: 'o1', text: 'x' });
      expect.unreachable();
    } catch (e: any) {
      expect(e.code).toBe('send_failed');
      expect(e.retryable).toBe(true);
      expect(e.message).toContain('45015');
      expect(e.message).not.toContain(SECRET);
      expect(e.message).not.toContain(APPID);
    }
    await a.stop();
  });

  it('stable_token 业务失败(40125)→ credential_invalid,不回显密钥', async () => {
    const { impl } = stubFetch(() => ({ errcode: 40125, errmsg: 'invalid appsecret' }));
    const a = makeAdapter(impl);
    await a.start({ onMessage: () => {} });
    try {
      await a.send({ conversationId: 'o1', text: 'x' });
      expect.unreachable();
    } catch (e: any) {
      expect(e.code).toBe('credential_invalid');
      expect(e.message).not.toContain(SECRET);
    }
    await a.stop();
  });

  it('网络层失败 → connection_lost(retryable);响应非 JSON → internal', async () => {
    const netErr = vi.fn(async () => {
      throw Object.assign(new Error('fetch failed'), { name: 'Error' });
    }) as unknown as typeof fetch;
    const a = makeAdapter(netErr);
    await a.start({ onMessage: () => {} });
    await expect(a.send({ conversationId: 'o1', text: 'x' })).rejects.toMatchObject({
      code: 'connection_lost',
      retryable: true,
    });

    const badJson = vi.fn(async () => ({ ok: true, status: 200, json: async () => { throw new Error('nope'); } })) as unknown as typeof fetch;
    const b = makeAdapter(badJson);
    await b.start({ onMessage: () => {} });
    await expect(b.send({ conversationId: 'o1', text: 'x' })).rejects.toMatchObject({ code: 'internal' });
    await a.stop();
    await b.stop();
  });

  it('空文本 / 缺 conversationId → send_failed', async () => {
    const { impl } = stubFetch(() => tokenOk);
    const a = makeAdapter(impl);
    await a.start({ onMessage: () => {} });
    await expect(a.send({ conversationId: 'o1', text: '  ' })).rejects.toMatchObject({ code: 'send_failed' });
    await expect(a.send({ conversationId: '', text: 'x' })).rejects.toMatchObject({ code: 'send_failed' });
    await a.stop();
  });
});

describe('WechatMpChannelAdapter 多租户(credentialResolver)', () => {
  it('仅解析器(无静态凭证)→ probe/start 就绪;send 按会话解析凭证,token 缓存按 appId 分键', async () => {
    const { impl, calls } = stubFetch((c) =>
      c.url.includes('stable_token')
        ? { access_token: `TOK-${c.body.appid}`, expires_in: 7200 }
        : { errcode: 0, errmsg: 'ok', msgid: 9 },
    );
    const a = new WechatMpChannelAdapter({
      fetchImpl: impl,
      credentialResolver: (cid) =>
        cid === 'oA' ? { appId: 'wx_A', appSecret: 'sec_A' } : cid === 'oB' ? { appId: 'wx_B', appSecret: 'sec_B' } : null,
    });
    expect((await a.probeCredentials()).ok).toBe(true);
    await a.start({ onMessage: () => {} });
    await a.send({ conversationId: 'oA', text: 'x' });
    await a.send({ conversationId: 'oB', text: 'x' });
    await a.send({ conversationId: 'oA', text: 'y' }); // 缓存命中,不再换 token
    const tokenCalls = calls.filter((c) => c.url.includes('stable_token'));
    expect(tokenCalls).toHaveLength(2);
    expect(tokenCalls[0].body).toMatchObject({ appid: 'wx_A', secret: 'sec_A' });
    expect(tokenCalls[1].body).toMatchObject({ appid: 'wx_B', secret: 'sec_B' });
    // 各自会话用各自的 token 发送
    const sends = calls.filter((c) => c.url.includes('custom/send'));
    expect(sends[0].url).toContain('access_token=TOK-wx_A');
    expect(sends[1].url).toContain('access_token=TOK-wx_B');
    await a.stop();
  });

  it('解析不到 → 回落静态 env 凭证;两者皆无 → credential_invalid(fail-closed,不回显密钥)', async () => {
    const { impl, calls } = stubFetch((c) =>
      c.url.includes('stable_token') ? tokenOk : { errcode: 0, errmsg: 'ok' },
    );
    const withStatic = new WechatMpChannelAdapter({
      appId: APPID,
      appSecret: SECRET,
      fetchImpl: impl,
      credentialResolver: () => null,
    });
    await withStatic.start({ onMessage: () => {} });
    await expect(withStatic.send({ conversationId: 'oX', text: 'x' })).resolves.toBeDefined();
    expect(calls.filter((c) => c.url.includes('stable_token'))[0].body).toMatchObject({ appid: APPID });
    await withStatic.stop();

    const bare = new WechatMpChannelAdapter({ fetchImpl: impl, credentialResolver: () => null });
    await bare.start({ onMessage: () => {} }); // 解析器在场 → start 就绪(凭证门槛在 send)
    try {
      await bare.send({ conversationId: 'oX', text: 'x' });
      expect.unreachable();
    } catch (e: any) {
      expect(e.code).toBe('credential_invalid');
      expect(e.message).not.toContain(SECRET);
    }
    await bare.stop();
  });

  it('解析器可异步;空白凭证视为解析不到;凭证值 trim 后使用', async () => {
    const { impl, calls } = stubFetch((c) =>
      c.url.includes('stable_token') ? tokenOk : { errcode: 0, errmsg: 'ok' },
    );
    const a = new WechatMpChannelAdapter({
      fetchImpl: impl,
      credentialResolver: async (cid) =>
        cid === 'oA' ? { appId: ' wx_A ', appSecret: ' sec_A ' } : { appId: '  ', appSecret: '' },
    });
    await a.start({ onMessage: () => {} });
    await expect(a.send({ conversationId: 'oA', text: 'x' })).resolves.toBeDefined();
    expect(calls.filter((c) => c.url.includes('stable_token'))[0].body).toMatchObject({
      appid: 'wx_A',
      secret: 'sec_A',
    });
    await expect(a.send({ conversationId: 'oZ', text: 'x' })).rejects.toMatchObject({
      code: 'credential_invalid',
    });
    await a.stop();
  });
});
