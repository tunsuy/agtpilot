import { describe, it, expect } from 'vitest';
import {
  truncateToolOutput,
  messageText,
  isToolCallMessage,
  effectiveOutputLimit,
  TOOL_OUTPUT_LIMIT,
} from './text';

describe('effectiveOutputLimit(工具级 outputCap,层1 源头裁剪 ②)', () => {
  it('未声明/非法(0、负数、NaN、非有限)→ TOOL_OUTPUT_LIMIT', () => {
    expect(effectiveOutputLimit(undefined)).toBe(TOOL_OUTPUT_LIMIT);
    expect(effectiveOutputLimit(0)).toBe(TOOL_OUTPUT_LIMIT);
    expect(effectiveOutputLimit(-100)).toBe(TOOL_OUTPUT_LIMIT);
    expect(effectiveOutputLimit(NaN)).toBe(TOOL_OUTPUT_LIMIT);
    expect(effectiveOutputLimit(Infinity)).toBe(TOOL_OUTPUT_LIMIT);
  });

  it('声明值小于限额 → 取声明值(向下取整)', () => {
    expect(effectiveOutputLimit(8000)).toBe(8000);
    expect(effectiveOutputLimit(2000.7)).toBe(2000);
  });

  it('声明值大于 TOOL_OUTPUT_LIMIT → 被 16KB 压顶(cap 不能放宽内核限额)', () => {
    expect(effectiveOutputLimit(999_999)).toBe(TOOL_OUTPUT_LIMIT);
  });
});

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
