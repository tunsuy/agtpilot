import { describe, it, expect } from 'vitest';
import { compactConversationMessages } from './compaction';

const mk = (role: string, content: any) => ({ role, content });

function longToolHistory(pairs: number) {
  const messages: Array<{ role: string; content: any }> = [mk('user', '最初的任务意图')];
  for (let i = 0; i < pairs; i++) {
    messages.push(
      mk('assistant', [{ type: 'tool-call', toolCallId: `h${i}`, toolName: 'tool_a', input: { q: i } }])
    );
    messages.push(mk('tool', '工具结果内容。'.repeat(120) + i));
  }
  messages.push(mk('assistant', '历史最终答复'));
  return messages;
}

describe('compactConversationMessages', () => {
  it('低于阈值 / 消息不足时返回 null（不压缩）', async () => {
    const few = [mk('user', 'hi'), mk('assistant', 'hello')];
    expect(await compactConversationMessages(few, { summarize: async () => '纪要' })).toBeNull();
  });

  it('超阈值时工具消息蒸馏为纪要，原始意图与近期窗口保留', async () => {
    const messages = longToolHistory(30);
    const result = await compactConversationMessages(messages, {
      summarize: async (digest) => `【已确立事实】\n- 蒸馏自 ${digest.length} 字符流水`,
      thresholdTokens: 5000,
    });
    expect(result).not.toBeNull();
    // 首条用户消息（原始意图）保留
    expect(result![0].content).toBe('最初的任务意图');
    // 纪要以 user 消息插回
    expect(result!.some((m) => typeof m.content === 'string' && m.content.startsWith('【历史会话纪要】'))).toBe(true);
    // 近期窗口（含配对的 tool 消息）保留
    expect(result!.some((m) => m.role === 'tool')).toBe(true);
    // 尾部答复保留
    expect(result![result!.length - 1].content).toBe('历史最终答复');
    // 整体体积显著下降
    expect(result!.length).toBeLessThan(messages.length / 2);
  });

  it('近期窗口边界不落在 tool 消息上（tool 结果与 tool-call 配对完整）', async () => {
    const messages = longToolHistory(30);
    const result = await compactConversationMessages(messages, { summarize: async () => '纪要', thresholdTokens: 5000 });
    // 从后往前第一条 tool 消息之前必有其 assistant tool-call 配对
    const lastToolIdx = result!.map((m) => m.role).lastIndexOf('tool');
    const prev = result!.slice(0, lastToolIdx).reverse().find((m) => m.role === 'assistant');
    expect(JSON.stringify(prev?.content)).toContain('tool-call');
  });

  it('summarize 失败/返回空串时退化为原文截断保底', async () => {
    const messages = longToolHistory(30);
    const result = await compactConversationMessages(messages, { summarize: async () => '', thresholdTokens: 5000 });
    expect(result!.some((m) => typeof m.content === 'string' && m.content.includes('原文截断保底'))).toBe(true);
  });

  it('旧纪要并入流水重新蒸馏（不保留旧纪要原文）', async () => {
    const messages = [
      mk('user', '最初意图'),
      mk('user', '【历史会话纪要】（系统自动压缩生成）\n旧内容'),
      ...longToolHistory(20).slice(1),
    ];
    const result = await compactConversationMessages(messages, { summarize: async () => '新纪要', thresholdTokens: 5000 });
    const oldDigestKept = result!.some(
      (m) => typeof m.content === 'string' && m.content.includes('旧内容') && m.role !== 'user'
    );
    expect(oldDigestKept).toBe(false);
  });

  it('纯文本对话消息原样保留（不进流水）', async () => {
    const messages = [
      mk('user', '最初的任务意图'),
      mk('user', '重要补充说明'),
      mk('assistant', '纯文本回答'),
      ...longToolHistory(20).slice(1, -1),
      mk('assistant', '最终答复'),
    ];
    const result = await compactConversationMessages(messages, { summarize: async () => '纪要', thresholdTokens: 5000 });
    const joined = result!.map((m) => JSON.stringify(m.content)).join('');
    expect(joined).toContain('重要补充说明');
    expect(joined).toContain('纯文本回答');
  });
});
