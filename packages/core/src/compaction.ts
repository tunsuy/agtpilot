import { messageText, isToolCallMessage, truncateText } from './text';
import { estimateTextTokens } from './routing';

/**
 * 会话压缩（Compaction，借鉴 Mastra Observer/Reflector 双层思路的轻量实现）。
 *
 * 纯函数化：蒸馏能力通过 `summarize` 回调注入（由编排器用 ModelGateway
 * 实现，失败时自动退化为原文截断），便于单测。
 *
 * 规则：
 * - 原始意图（首条用户消息）、纯文本对话、最近 N 条消息永远保留；
 * - 较早的 assistant tool-call / tool 结果消息整体移除，先收集成工具执行流水，
 *   再蒸馏成结构化纪要（【已确立事实】【关键结论】【重要链接】【未决事项】），
 *   以一条 user 消息插回首条用户消息之后；
 * - 旧纪要消息（历史轮次压缩的产物）不保留原文，并入流水重新蒸馏，防多轮累积；
 * - 近期窗口边界不落在 tool 消息上（tool 结果必须与其 assistant tool-call 配对）。
 */

/** 压缩触发阈值（估算 tokens，CJK 1 字 ≈ 1 token，其余 4 字符 ≈ 1 token） */
export const COMPACT_THRESHOLD_TOKENS = Math.max(
  2000,
  Number(process.env.AGTPILOT_COMPACT_THRESHOLD) || 30_000
);
/** 近期保护窗口：最近 N 条消息原样保留（不越过 tool 消息边界切断配对） */
export const COMPACT_RECENT_MESSAGES = Math.max(4, Number(process.env.AGTPILOT_COMPACT_RECENT) || 10);
/** 单条工具结果进入纪要摘要时的截断长度（字符） */
export const COMPACT_DIGEST_ENTRY_LIMIT = 600;

/** 蒸馏回调：把工具流水蒸馏成纪要文本；返回空串/抛错时走原文截断兜底 */
export type DigestSummarizer = (digest: string) => Promise<string>;

export interface CompactOptions {
  summarize: DigestSummarizer;
  /** 蒸馏前的进度通知（可选，用于 thought 事件） */
  onProgress?: (info: { totalTokens: number; entries: number }) => void;
  thresholdTokens?: number;
  recentMessages?: number;
}

/**
 * 压缩会话历史。返回 null 表示无需压缩（保持调用方原消息不变）。
 */
export async function compactConversationMessages(
  messages: Array<{ role: string; content: any }>,
  options: CompactOptions
): Promise<Array<{ role: string; content: any }> | null> {
  const threshold = options.thresholdTokens ?? COMPACT_THRESHOLD_TOKENS;
  const recentWindow = options.recentMessages ?? COMPACT_RECENT_MESSAGES;

  const totalTokens = messages.reduce((acc, m) => acc + estimateTextTokens(messageText(m.content)), 0);
  if (totalTokens < threshold || messages.length < recentWindow + 2) return null;

  // 近期保护窗口（起点右移直到不落在 tool 消息上）
  let recentStart = Math.max(0, messages.length - recentWindow);
  while (recentStart < messages.length && messages[recentStart].role === 'tool') recentStart++;
  const headKeep = messages[0]?.role === 'user' ? 1 : 0;
  if (recentStart <= headKeep + 1) return null; // 中间区太小，没有压缩价值

  const middle = messages.slice(headKeep, recentStart);
  const digestEntries: string[] = [];
  const keptTexts: Array<{ role: string; content: any }> = [];
  let hasDroppable = false;
  for (const m of middle) {
    const text = messageText(m.content);
    if (m.role === 'tool') {
      digestEntries.push(`[工具结果] ${truncateText(text, COMPACT_DIGEST_ENTRY_LIMIT)}`);
      hasDroppable = true;
    } else if (m.role === 'assistant' && isToolCallMessage(m)) {
      for (const part of m.content as any[]) {
        if (part?.type === 'tool-call' || typeof part?.toolCallId === 'string') {
          digestEntries.push(
            `[工具调用] ${part.toolName ?? '(unknown)'} ${truncateText(messageText(part.input ?? part.args), 200)}`
          );
        }
      }
      hasDroppable = true;
    } else if (typeof m.content === 'string' && m.content.startsWith('【历史会话纪要】')) {
      // 旧纪要并入本次流水重新蒸馏，避免多轮任务后纪要消息自身不断累积
      digestEntries.push(`[旧纪要] ${truncateText(text, 2000)}`);
      hasDroppable = true;
    } else {
      // 纯文本的 user/assistant 消息体积小、信息密度高，原样保留
      keptTexts.push(m);
    }
  }
  if (!hasDroppable) return null; // 没有工具消息可压缩

  options.onProgress?.({ totalTokens, entries: digestEntries.length });

  const digest = digestEntries.join('\n');
  let summary = '';
  try {
    summary = await options.summarize(digest);
  } catch {
    // 蒸馏失败走兜底
  }
  if (!summary) {
    summary = `以下为历史工具执行流水（原文截断保底）：\n${truncateText(digest, 8 * 1024)}`;
  }

  return [
    ...messages.slice(0, headKeep),
    {
      role: 'user',
      content: `【历史会话纪要】（系统自动压缩生成，替代更早的工具执行记录）\n${summary}`,
    },
    ...keptTexts,
    ...messages.slice(recentStart),
  ];
}
