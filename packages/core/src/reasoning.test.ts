import { describe, it, expect } from 'vitest';
import { stripReasoningParts } from './reasoning';

/**
 * reasoning 剥离纯函数单测(orchestrator 三道闸的行为测试见
 * orchestrator-reasoning.test.ts)。核心不变量:
 * 1. 只删 assistant 数组 content 里的 type:'reasoning' 部件,text/tool-call 保留;
 * 2. 不改原对象(浅拷贝改写);3. 幂等 + 无可剥内容时返回原引用(调用方据此免写回);
 * 4. 剥空后 content 置 ''(消息保留,不扰动 tool-call 配对与序号)。
 */

const reasoning = (text: string) => ({ type: 'reasoning', text });
const text = (t: string) => ({ type: 'text', text: t });
const toolCall = (id: string) => ({ type: 'tool-call', toolCallId: id, toolName: 'search_web', input: {} });

describe('stripReasoningParts', () => {
  it('剥离 assistant 的 reasoning 部件,text/tool-call 原样保留(工具配对不破)', () => {
    const messages = [
      { role: 'user' as const, content: '查一下' },
      {
        role: 'assistant' as const,
        content: [reasoning('想了很多'.repeat(100)), text('结论'), toolCall('c1')],
      },
      { role: 'tool' as const, content: [{ type: 'tool-result', toolCallId: 'c1', output: 'ok' }] },
    ];
    const r = stripReasoningParts(messages);
    expect(r.stripped).toBe(1);
    expect(r.messages).toHaveLength(3);
    expect(r.messages[1].content).toEqual([text('结论'), toolCall('c1')]);
    // 未改写消息共享引用(user/tool 不动)
    expect(r.messages[0]).toBe(messages[0]);
    expect(r.messages[2]).toBe(messages[2]);
  });

  it('不改原对象:原数组与原消息 content 保持原样', () => {
    const original = {
      role: 'assistant' as const,
      content: [reasoning('思考'), text('答复')],
    };
    const messages = [original];
    const r = stripReasoningParts(messages);
    expect(r.messages).not.toBe(messages);
    expect(original.content).toHaveLength(2); // 原消息未被就地修改
    expect(messages[0]).toBe(original);
  });

  it('无可剥内容时返回原数组引用且 stripped=0(调用方免写回,前缀缓存不破)', () => {
    const messages = [
      { role: 'user' as const, content: '你好' },
      { role: 'assistant' as const, content: [text('答复')] },
      { role: 'assistant' as const, content: '纯字符串回复' },
    ];
    const r = stripReasoningParts(messages);
    expect(r.messages).toBe(messages);
    expect(r.stripped).toBe(0);
  });

  it('幂等:剥离结果再剥一次 → 原引用 + stripped=0', () => {
    const messages = [
      { role: 'assistant' as const, content: [reasoning('思考'), text('答复')] },
    ];
    const first = stripReasoningParts(messages);
    const second = stripReasoningParts(first.messages);
    expect(second.messages).toBe(first.messages);
    expect(second.stripped).toBe(0);
  });

  it('字符串 content 的 assistant 消息不动(旧格式/强制总结追加的纯文本)', () => {
    const messages = [{ role: 'assistant' as const, content: '纯文本' }];
    const r = stripReasoningParts(messages);
    expect(r.messages).toBe(messages);
  });

  it('非 assistant 角色即使带 reasoning 型部件也不动(只信 provider 序列化路径)', () => {
    const messages = [
      { role: 'user' as const, content: [reasoning('用户消息里的怪部件')] },
      { role: 'tool' as const, content: [reasoning('工具结果里的怪部件')] },
    ];
    const r = stripReasoningParts(messages);
    expect(r.messages).toBe(messages);
    expect(r.stripped).toBe(0);
  });

  it('剥空后无部件 → content 置空串,消息本身保留(不扰动序号与配对)', () => {
    const messages = [
      { role: 'assistant' as const, content: [reasoning('只有思考')] },
      { role: 'tool' as const, content: [{ type: 'tool-result', toolCallId: 'c9', output: 'x' }] },
    ];
    const r = stripReasoningParts(messages);
    expect(r.stripped).toBe(1);
    expect(r.messages).toHaveLength(2);
    expect(r.messages[0].content).toBe('');
  });

  it('多段 reasoning 全部计入 stripped(生产单轮思考可拆多个部件)', () => {
    const messages = [
      { role: 'assistant' as const, content: [reasoning('一'), reasoning('二'), text('答')] },
      { role: 'assistant' as const, content: [reasoning('三'), text('答2')] },
    ];
    const r = stripReasoningParts(messages);
    expect(r.stripped).toBe(3);
    expect(r.messages[0].content).toEqual([text('答')]);
    expect(r.messages[1].content).toEqual([text('答2')]);
  });

  it('空数组安全返回', () => {
    const empty: any[] = [];
    expect(stripReasoningParts(empty)).toEqual({ messages: empty, stripped: 0 });
  });
});
