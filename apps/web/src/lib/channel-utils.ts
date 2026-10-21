import crypto from 'crypto';
import type { Mission } from '../types/agent';

/**
 * 通道纯函数(无 IO、无重依赖 —— channel-service 与测试共用)。
 * 铁律 6:纯函数必须带 vitest 用例(__tests__/channel-utils.test.ts)。
 */

/** 从任务步骤提取最终答复(与通知中心同款规则:最后一条 assistant answer)。 */
export function extractFinalAnswer(mission: Mission | undefined | null): string | null {
  if (!mission?.steps?.length) return null;
  // 纯空白 answer 不算数(工具步骤/中断产物),取最后一条有实际内容的
  const finals = mission.steps.filter(
    (s: any) => s.role === 'assistant' && typeof s.answer === 'string' && s.answer.trim(),
  );
  const last = finals.at(-1);
  return last && typeof last.answer === 'string' ? last.answer.trim() : null;
}

export type ChannelCommand =
  | { type: 'bind'; code: string }
  | { type: 'unbind' }
  | { type: 'new' };

/**
 * 微信公众平台回调签名校验(官方算法:token/timestamp/nonce 字典序拼接后 SHA1)。
 * 纯函数,GET 接入校验与 POST 消息校验共用;多租户下 token 按用户取
 * (channel-store.peekWechatMpImToken),全局 WECHAT_TOKEN 仅单租户兜底。
 */
export function verifyWechatCallbackSignature(
  token: string,
  signature: string | null | undefined,
  timestamp: string | null | undefined,
  nonce: string | null | undefined,
): boolean {
  if (!token || !signature || !timestamp || !nonce) return false;
  const sorted = [token, timestamp, nonce].sort().join('');
  // 定时摘要比较,防逐字符时序侧信道(token 是签名密钥)
  const hash = crypto.createHash('sha1').update(sorted).digest('hex');
  const a = Buffer.from(hash);
  const b = Buffer.from(String(signature));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** 控制指令解析:绑定 <6位码> / 解绑 / 新会话(/new)。非指令返回 null。 */
export function parseChannelCommand(rawText: string): ChannelCommand | null {
  const text = (rawText ?? '').trim();
  if (!text) return null;
  const bindMatch = /^(?:绑定|bind)\s+(\d{6})$/i.exec(text);
  if (bindMatch) return { type: 'bind', code: bindMatch[1] };
  if (/^(?:解绑|unbind)$/i.test(text)) return { type: 'unbind' };
  if (/^(?:\/new|新会话)$/i.test(text)) return { type: 'new' };
  return null;
}
