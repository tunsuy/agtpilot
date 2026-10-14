import { describe, it, expect } from 'vitest';
import { compactConversationMessages } from './compaction';

const mk = (role: string, content: any) => ({ role, content });

function longToolHistory(pairs: number) {
  const messages: Array<{ role: string; content: any }> = [mk('user', '最初的任务意图')];
  for (let i = 0; i < pairs; i++) {
    messages.push(
      mk('assistant', [{ type: 'tool-call', toolCallId: `h${i}`, toolName: 'tool_a', input: { q: i } }])
    );
    // 真实链路形态：tool 结果为 AI SDK 数组分片（台账按分片 output 判空,不看 JSON 壳）
    messages.push(
      mk('tool', [{ type: 'tool-result', toolCallId: `h${i}`, output: '工具结果内容。'.repeat(120) + i }])
    );
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

  describe('工具调用台账（系统精确统计,不经蒸馏）', () => {
    it('纪要末尾附台账:工具名 ×次数 + 参数摘要 + 结果状态', async () => {
      const messages = longToolHistory(30);
      const result = await compactConversationMessages(messages, {
        summarize: async () => '蒸馏纪要正文',
        thresholdTokens: 5000,
      });
      const digestMsg = result!.find(
        (m) => typeof m.content === 'string' && m.content.startsWith('【历史会话纪要】')
      ) as { content: string };
      expect(digestMsg.content).toContain('蒸馏纪要正文');
      // 台账标记 + 指令（回答来源类问题以此为准）
      expect(digestMsg.content).toContain('【工具调用台账】');
      expect(digestMsg.content).toContain('不要凭记忆估计');
      // 工具名 ×次数（30 个 tool_a 调用全部压缩进中段）
      expect(digestMsg.content).toMatch(/- tool_a ×\d+/);
      // 逐条「参数摘要 → 返回 N 字符」
      expect(digestMsg.content).toMatch(/「.*q.*」→ 返回 \d+ 字符/);
    });

    it('空返回在台账中显式标注（和有效返回可区分,JSON 壳不算内容）', async () => {
      const messages = [
        mk('user', '最初的任务意图'),
        mk('assistant', [{ type: 'tool-call', toolCallId: 'e1', toolName: 'search_web', input: { query: '空结果查询' } }]),
        mk('tool', [{ type: 'tool-result', toolCallId: 'e1', output: '' }]),
        mk('assistant', [{ type: 'tool-call', toolCallId: 'e2', toolName: 'search_web', input: { query: '有结果查询' } }]),
        mk('tool', [{ type: 'tool-result', toolCallId: 'e2', output: '找到 3 条结果的内容' }]),
        ...longToolHistory(20).slice(1, -1),
        mk('assistant', '最终答复'),
      ];
      const result = await compactConversationMessages(messages, { summarize: async () => '纪要', thresholdTokens: 5000 });
      const digestMsg = result!.find(
        (m) => typeof m.content === 'string' && m.content.startsWith('【历史会话纪要】')
      ) as { content: string };
      // argsText 是入参的 JSON 序列化,断言只锚参数值与结果状态
      expect(digestMsg.content).toContain('空结果查询"}」→ 空返回');
      expect(digestMsg.content).toContain('有结果查询"}」→ 返回');
    });

    it('keep 白名单命中的调用原文保留在上下文,不进台账', async () => {
      const messages = longToolHistory(30);
      // h10 在中段(近期窗口只护住最后 ~10 条);命中白名单 → 原文保留、台账不记
      const keep = new Set(['h10']);
      const result = await compactConversationMessages(messages, {
        summarize: async () => '纪要',
        thresholdTokens: 5000,
        keepToolCallIds: keep,
      });
      const digestMsg = result!.find(
        (m) => typeof m.content === 'string' && m.content.startsWith('【历史会话纪要】')
      ) as { content: string };
      // h10 的 tool 结果仍以原文消息保留（数组 content 用 JSON.stringify 看;中段唯一含 "h10" 的 tool 消息）
      expect(result!.some((m) => m.role === 'tool' && JSON.stringify(m.content).includes('"h10"'))).toBe(true);
      // 中段共 26 条调用(h0..h25),h10 原文保留 → 台账只记 25 条
      expect(digestMsg.content).toMatch(/- tool_a ×25/);
    });

    it('无工具消息可压缩时没有台账段', async () => {
      // 只有旧纪要可蒸馏 + 足量纯文本消息过阈值/窗口,没有 tool 消息 → ledgerByTool 为空
      const messages = [
        mk('user', '最初意图'),
        mk('user', '【历史会话纪要】（系统自动压缩生成）\n旧纪要内容'),
        ...Array.from({ length: 14 }, (_, i) => mk('user', `补充说明 ${i} ${'详情'.repeat(80)}`)),
      ];
      const result = await compactConversationMessages(messages, { summarize: async () => '新纪要', thresholdTokens: 10 });
      const digestMsg = result!.find(
        (m) => typeof m.content === 'string' && m.content.startsWith('【历史会话纪要】')
      ) as { content: string };
      expect(digestMsg.content).toContain('新纪要');
      expect(digestMsg.content).not.toContain('【工具调用台账】');
    });
  });
});
