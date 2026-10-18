import type { ChannelAdapter } from '@agentoryhq/im-channel-contract';
import { createWechatPersonalChannelFactory } from '@agentoryhq/im-channel-wechat-personal';
import { createWechatMpChannelFactory } from './wechat-mp';
import { createQqOnebotChannelFactory } from './qq-onebot';

/**
 * env 驱动的通道注册表（契约 factory 语义:凭证不全 → null → 通道不注册,
 * 启动永不因通道阻塞）。应用层把 process.env(或白名单子集)显式传进来 ——
 * 插件自身不读 process.env(密钥卫生 + 可测性)。
 *
 * 额外凭证源:wechat_personal 的 bot_token 也可能来自扫码绑定后的运行时存储
 * (channel-store),应用层把它合并进 env 对象再调这里(env 优先序由调用方决定)。
 */
export function buildChannelsFromEnv(env: Record<string, string | undefined>): ChannelAdapter[] {
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
  return adapters;
}

/** 注册表覆盖的全部通道 id（状态页/文档用）。 */
export function registeredChannelIds(env: Record<string, string | undefined>): string[] {
  return buildChannelsFromEnv(env).map((a) => a.channel);
}
