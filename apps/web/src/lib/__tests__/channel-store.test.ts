import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * channel-store 用例:绑定/会话映射落盘往返 + 绑定码 TTL/单次消费 + 去重 LRU。
 *
 * 环境隔离:USER_DATA_DIR 指向一次性临时目录(与 user-store-v2.test.ts 同款做法)。
 * channel-store 每次操作都实时调 getDataDir(),beforeAll 设置一次即可。
 */

let store: typeof import('../channel-store');
let tmpDir: string;

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agtpilot-channel-store-'));
  process.env.USER_DATA_DIR = tmpDir;
  store = await import('../channel-store');
});

beforeEach(() => {
  store.__resetInMemoryState();
  for (const f of [
    'channel-bindings.json',
    'channel-conversations.json',
    'channel-credentials.json',
    'channel-mp-tokens.json',
    'channel-mp-owners.json',
  ]) {
    try {
      fs.unlinkSync(path.join(tmpDir, f));
    } catch {}
  }
});

afterAll(() => {
  delete process.env.USER_DATA_DIR;
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {}
});

describe('绑定存取', () => {
  it('保存后可按 channel+externalUserId 精确查回', () => {
    store.saveBinding({ channel: 'wechat_mp', externalUserId: 'openid_1', userId: 'u1', boundAt: 'now' });
    store.saveBinding({ channel: 'qq_onebot', externalUserId: 'private:10001', userId: 'u2', boundAt: 'now' });
    expect(store.findBinding('wechat_mp', 'openid_1')?.userId).toBe('u1');
    expect(store.findBinding('qq_onebot', 'private:10001')?.userId).toBe('u2');
    // 跨通道同 externalUserId 不串
    expect(store.findBinding('qq_onebot', 'openid_1')).toBeNull();
    expect(store.findBinding('wechat_mp', 'private:10001')).toBeNull();
  });

  it('同键重复保存 = 覆盖(换绑)', () => {
    store.saveBinding({ channel: 'wechat_mp', externalUserId: 'openid_1', userId: 'u1', boundAt: 't1' });
    store.saveBinding({ channel: 'wechat_mp', externalUserId: 'openid_1', userId: 'u9', boundAt: 't2' });
    expect(store.findBinding('wechat_mp', 'openid_1')?.userId).toBe('u9');
    expect(store.listBindingsForUser('u1')).toHaveLength(0);
    expect(store.listBindingsForUser('u9')).toHaveLength(1);
  });

  it('deleteBinding 返回是否真删了', () => {
    store.saveBinding({ channel: 'wechat_mp', externalUserId: 'openid_1', userId: 'u1', boundAt: 'now' });
    expect(store.deleteBinding('wechat_mp', 'openid_1')).toBe(true);
    expect(store.deleteBinding('wechat_mp', 'openid_1')).toBe(false);
    expect(store.findBinding('wechat_mp', 'openid_1')).toBeNull();
  });

  it('落盘持久化:文件真实存在且是合法 JSON', () => {
    store.saveBinding({ channel: 'wechat_personal', externalUserId: 'ilink_x', userId: 'u3', boundAt: 'now' });
    const raw = JSON.parse(fs.readFileSync(path.join(tmpDir, 'channel-bindings.json'), 'utf8'));
    expect(Array.isArray(raw)).toBe(true);
    expect(raw[0].externalUserId).toBe('ilink_x');
  });
});

describe('会话映射', () => {
  it('往返 + resetConversationMission 只清 missionId', () => {
    store.saveConversation({
      channel: 'qq_onebot',
      conversationId: 'private:10001',
      userId: 'u2',
      missionId: 'm-42',
      lastActiveAt: 'now',
    });
    expect(store.getConversation('qq_onebot', 'private:10001')?.missionId).toBe('m-42');
    expect(store.resetConversationMission('qq_onebot', 'private:10001')).toBe(true);
    const after = store.getConversation('qq_onebot', 'private:10001');
    expect(after?.missionId).toBeUndefined();
    expect(after?.userId).toBe('u2'); // 绑定/归属不动
  });

  it('reset 不存在的会话 → false', () => {
    expect(store.resetConversationMission('wechat_mp', 'nobody')).toBe(false);
  });
});

describe('通道凭证', () => {
  it('patch 合并 + updatedAt 自动写入', () => {
    store.saveChannelCredentials({ wechatPersonalBotToken: 'tok-1' });
    store.saveChannelCredentials({ wechatPersonalBaseUrl: 'https://ilinkai.weixin.qq.com' });
    const creds = store.getChannelCredentials();
    expect(creds.wechatPersonalBotToken).toBe('tok-1');
    expect(creds.wechatPersonalBaseUrl).toBe('https://ilinkai.weixin.qq.com');
    expect(typeof creds.updatedAt).toBe('string');
  });

  it('空文件 → 空对象(不抛)', () => {
    expect(store.getChannelCredentials()).toEqual({});
  });
});

describe('绑定码', () => {
  it('生成 6 位数字码(前导零补齐)', () => {
    expect(store.generateBindCodeDigits(() => 0)).toBe('000000');
    expect(store.generateBindCodeDigits(() => 0.0000123)).toBe('000012');
    expect(store.generateBindCodeDigits(() => 0.999999)).toBe('999999');
    expect(store.generateBindCodeDigits()).toMatch(/^\d{6}$/);
  });

  it('create → consume 单次消费', () => {
    const now = 1_000_000;
    const code = store.createBindCode('u1', now);
    expect(code).toMatch(/^\d{6}$/);
    expect(store.consumeBindCode(code, now + 1000)).toEqual({ userId: 'u1' });
    // 第二次消费同一码 → null(单次)
    expect(store.consumeBindCode(code, now + 2000)).toBeNull();
  });

  it('TTL 过期 → null,且过期码同样作废', () => {
    const now = 1_000_000;
    const code = store.createBindCode('u1', now);
    const after = now + 10 * 60 * 1000 + 1; // > 10min
    expect(store.consumeBindCode(code, after)).toBeNull();
    expect(store.consumeBindCode(code, now)).toBeNull(); // 已被上一步作废
  });

  it('未知码 → null', () => {
    expect(store.consumeBindCode('999999')).toBeNull();
  });
});

describe('消息去重', () => {
  it('同 channel+messageId 第二次 → true', () => {
    expect(store.isDuplicateMessage('wechat_mp', 'msg-1')).toBe(false);
    expect(store.isDuplicateMessage('wechat_mp', 'msg-1')).toBe(true);
  });

  it('跨通道同 messageId 互不干扰', () => {
    expect(store.isDuplicateMessage('wechat_mp', 'msg-2')).toBe(false);
    expect(store.isDuplicateMessage('qq_onebot', 'msg-2')).toBe(false);
  });

  it('LRU 封顶:超容量丢最旧一半,新消息仍可去重', () => {
    for (let i = 0; i < 600; i++) {
      store.isDuplicateMessage('wechat_mp', `m-${i}`);
    }
    // 最新一条仍在窗口内 → 判重成功
    expect(store.isDuplicateMessage('wechat_mp', 'm-599')).toBe(true);
    // 最旧一条已被逐出 → 视为新消息(去重窗口是尽力而为,平台重推在秒级)
    expect(store.isDuplicateMessage('wechat_mp', 'm-0')).toBe(false);
  });
});

describe('公众号 IM(按用户多租户):专属 Token / 会话归属', () => {
  it('peek 不自动生成(未认证请求不得落盘);ensure 生成后稳定幂等;rotate 换值', () => {
    expect(store.peekWechatMpImToken('u1')).toBeNull();
    const t1 = store.ensureWechatMpImToken('u1');
    expect(t1).toMatch(/^[0-9a-f]{32}$/);
    expect(store.ensureWechatMpImToken('u1')).toBe(t1); // 幂等:不重复生成
    expect(store.peekWechatMpImToken('u1')).toBe(t1);
    const t2 = store.rotateWechatMpImToken('u1');
    expect(t2).toMatch(/^[0-9a-f]{32}$/);
    expect(t2).not.toBe(t1);
    expect(store.peekWechatMpImToken('u1')).toBe(t2);
    expect(store.peekWechatMpImToken('u2')).toBeNull(); // 按用户隔离
  });

  it('会话归属:learn/find 往返;改派覆盖;未知 openid 与空值 → null/不落盘', () => {
    expect(store.findWechatMpOwner('oX')).toBeNull();
    store.learnWechatMpOwner('oX', 'owner1');
    expect(store.findWechatMpOwner('oX')).toBe('owner1');
    store.learnWechatMpOwner('oX', 'owner2'); // 改派覆盖
    expect(store.findWechatMpOwner('oX')).toBe('owner2');
    store.learnWechatMpOwner('', 'owner1'); // 空 openid 不落盘
    store.learnWechatMpOwner('oY', ''); // 空归属不落盘
    expect(store.findWechatMpOwner('oY')).toBeNull();
  });
});
