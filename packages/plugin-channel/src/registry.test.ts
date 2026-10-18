import { describe, it, expect } from 'vitest';
import { buildChannelsFromEnv, registeredChannelIds } from './registry';

/**
 * env 注册表守护用例。
 * 不变量:凭证不全 → 通道不注册(fail-closed,启动永不阻塞);
 * 凭证齐备 → 对应通道出现;空 env → 空注册表。
 */

const FULL_ENV = {
  WECHAT_PERSONAL_BOT_TOKEN: 'tok_fake',
  WECHAT_MP_APPID: 'wx_fake',
  WECHAT_MP_APPSECRET: 'sec_fake',
  QQ_ONEBOT_WS_URL: 'ws://127.0.0.1:3001/onebot/v11/ws',
  QQ_ONEBOT_ACCESS_TOKEN: 'nap_fake',
};

describe('buildChannelsFromEnv', () => {
  it('全量凭证 → 三通道齐', () => {
    const ids = registeredChannelIds(FULL_ENV).sort();
    expect(ids).toEqual(['qq_onebot', 'wechat_mp', 'wechat_personal']);
  });

  it('部分凭证 → 只注册对应通道(其余 fail-closed 跳过)', () => {
    expect(registeredChannelIds({ WECHAT_PERSONAL_BOT_TOKEN: 'tok' })).toEqual(['wechat_personal']);
    expect(registeredChannelIds({ QQ_ONEBOT_WS_URL: 'ws://x:1/ws' })).toEqual(['qq_onebot']);
    // MP 两缺一 → 不注册
    expect(registeredChannelIds({ WECHAT_MP_APPID: 'wx' })).toEqual([]);
    expect(registeredChannelIds({ WECHAT_MP_APPSECRET: 'sec' })).toEqual([]);
  });

  it('空 env / 空白值 → 空注册表', () => {
    expect(buildChannelsFromEnv({})).toEqual([]);
    expect(buildChannelsFromEnv({ WECHAT_PERSONAL_BOT_TOKEN: '   ', QQ_ONEBOT_WS_URL: '' })).toEqual([]);
  });

  it('返回的是可用适配器实例(身份字段齐全)', () => {
    const adapters = buildChannelsFromEnv(FULL_ENV);
    for (const a of adapters) {
      expect(a.apiVersion).toBe(1);
      expect(typeof a.channel).toBe('string');
      expect(Array.isArray(a.capabilities)).toBe(true);
      expect(typeof a.start).toBe('function');
      expect(typeof a.send).toBe('function');
    }
  });
});
