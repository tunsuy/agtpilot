import { describe, it, expect } from 'vitest';
import { truncateToolOutput, messageText, isToolCallMessage } from './text';

describe('truncateToolOutput', () => {
  // A/M/B 各留足余量，确保截取的头/尾段落完整落在同一段字符内
  const long = 'A'.repeat(300) + 'M'.repeat(1000) + 'B'.repeat(300);

  it('内容类输出头优先（头 70% / 尾 30%）', () => {
    const out = truncateToolOutput(long, 'search_web', 200);
    expect(out.startsWith('A'.repeat(140))).toBe(true);
    expect(out.endsWith('B'.repeat(60))).toBe(true);
    expect(out).toContain('中间省略');
  });

  it('命令/日志类输出（sandbox_/git_ 前缀）尾优先（头 30% / 尾 70%）', () => {
    const out = truncateToolOutput(long, 'sandbox_run_command', 200);
    expect(out.startsWith('A'.repeat(60))).toBe(true);
    expect(out.endsWith('B'.repeat(140))).toBe(true);
    expect(out).toContain('尾优先');
  });

  it('标记原始长度与省略量，供模型决定是否缩小范围续读', () => {
    const out = truncateToolOutput(long, 'search_web', 200);
    expect(out).toContain('原始 1600 字符');
    expect(out).toContain('中间省略 1400 字符');
  });
});

describe('messageText', () => {
  it('string 直返', () => {
    expect(messageText('hello')).toBe('hello');
  });
  it('分片数组 JSON 化', () => {
    expect(messageText([{ type: 'text', text: 'a' }])).toBe('[{"type":"text","text":"a"}]');
  });
  it('null/undefined 与循环引用安全', () => {
    expect(messageText(null)).toBe('');
    expect(messageText(undefined)).toBe('');
    const circular: any = { self: null };
    circular.self = circular;
    expect(messageText(circular)).toBe('');
  });
});

describe('isToolCallMessage', () => {
  it('识别 tool-call 分片', () => {
    expect(isToolCallMessage({ role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'c1' }] })).toBe(true);
  });
  it('纯文本消息返回 false', () => {
    expect(isToolCallMessage({ role: 'assistant', content: '文本' })).toBe(false);
    expect(isToolCallMessage({ role: 'assistant' })).toBe(false);
  });
});
