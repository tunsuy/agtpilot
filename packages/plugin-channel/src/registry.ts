import type { ChannelAdapter } from '@agentoryhq/im-channel-contract';
import { createWechatPersonalChannelFactory } from '@agentoryhq/im-channel-wechat-personal';
import {
  createWechatMpChannelFactory,
  WechatMpChannelAdapter,
  WECHAT_MP_CHANNEL,
  type WechatMpCredentialResolver,
} from './wechat-mp';
import { createQqOnebotChannelFactory } from './qq-onebot';

export interface BuildChannelsOptions {
  /**
   * 公众号多租户凭证解析器(应用层注入):env 单租户凭证缺失时,仍以此注册
   * wechat_mp 适配器 —— 每用户各配自己的公众号(连接器页凭证),出站按会话
   * 解析。env 凭证在场则优先走 factory 的静态单租户形态(部署兜底,行为不变)。
   */
  wechatMpCredentialResolver?: WechatMpCredentialResolver;
}

/**
 * env 驱动的通道注册表（契约 factory 语义:凭证不全 → null → 通道不注册,
 * 启动永不因通道阻塞）。应用层把 process.env(或白名单子集)显式传进来 ——
 * 插件自身不读 process.env(密钥卫生 + 可测性)。
 *
 * 额外凭证源:wechat_personal 的 bot_token 也可能来自扫码绑定后的运行时存储
 * (channel-store),应用层把它合并进 env 对象再调这里(env 优先序由调用方决定);
 * wechat_mp 支持多租户解析器(opts.wechatMpCredentialResolver,见上)。
 */
export function buildChannelsFromEnv(
  env: Record<string, string | undefined>,
  opts?: BuildChannelsOptions,
): ChannelAdapter[] {
  const factories = [
    createWechatPersonalChannelFactory(),
    createWechatMpChannelFactory(),
    createQqOnebotChannelFactory(),
  ];
  const adapters: ChannelAdapter[] = [];
  for (const factory of factories) {
    try {
      const adapter = factory.fromEnv(env);
      if (adapter) adapters.push(adapter);
    } catch (err: any) {
      // 单个 factory 异常不拖垮其余通道;不回显 env 值
      console.error(`[plugin-channel] 通道 ${factory.channel} 构造失败(已跳过): ${err?.message || err}`);
    }
  }
  // 公众号多租户:env 凭证缺失但应用层注入了按用户解析器 → 仍注册适配器
  if (opts?.wechatMpCredentialResolver && !adapters.some((a) => a.channel === WECHAT_MP_CHANNEL)) {
    adapters.push(new WechatMpChannelAdapter({ credentialResolver: opts.wechatMpCredentialResolver }));
  }
  return adapters;
}

/** 注册表覆盖的全部通道 id（状态页/文档用）。 */
export function registeredChannelIds(env: Record<string, string | undefined>): string[] {
  return buildChannelsFromEnv(env).map((a) => a.channel);
}
