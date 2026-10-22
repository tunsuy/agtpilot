/**
 * 输出截断判定 isCutOffToolCall / isCutOffAnswer(orchestrator 截断→强制总结收口路的入口)。
 *
 * 生产实例 2026-10-16:PPT 演示稿任务 reasoning 吃掉单轮输出预算,tool_call 标签
 * 写到一半被截(finishReason=length),解析器提不出任何调用,残段被当最终答复 →
 * 零工具执行、零交付物却落 DONE。此判定把这种残段送进强制总结如实交代。
 *
 * 生产实例 2026-10-22:小说日更巡航 reasoning 约 4.5 万 token 耗尽输出预算,正文
 * 只吐出 1 个字符(无未闭合标签)—— isCutOffToolCall 判不出,同样落 DONE 零交付。
 * isCutOffAnswer 补这个洞:finishReason=length 且无未闭合标签 = 正文截停。
 * length 下二者必居其一,两种残段都不再被当成功收口。
 */
import { describe, it, expect } from 'vitest';
import { isCutOffToolCall, isCutOffAnswer } from './orchestrator';

const OPEN = '<tool' + '_call>';
const CLOSE = '</tool' + '_call>';

describe('isCutOffToolCall(截断 + 未闭合工具调用标签)', () => {
  it('length + 未闭合标签 = 截断(生产实例形态:标签写到一半被截)', () => {
    const text = `收到。我来制作演示稿。${OPEN}planner_create_plan(tasks=[{"title": "环境自检"`;
    expect(isCutOffToolCall('length', text)).toBe(true);
  });

  it('length + 开闭配对 = 不算截断(调用完整写出,只是没被执行另说)', () => {
    const text = `${OPEN}search_web(query="x")${CLOSE} 以上调用已列出。`;
    expect(isCutOffToolCall('length', text)).toBe(false);
  });

  it('length + 多开少闭(2 开 1 闭)= 截断', () => {
    const text = `${OPEN}a(x)${CLOSE} 接着 ${OPEN}b(y)`;
    expect(isCutOffToolCall('length', text)).toBe(true);
  });

  it('length + 无标签 = 不算(纯文本被截由 isCutOffAnswer 兜底,不误判)', () => {
    expect(isCutOffToolCall('length', '这是一段被截断的普通结论文本……')).toBe(false);
  });

  it('stop/other + 未闭合标签 = 不算(提供商未报截断,不替它猜)', () => {
    const text = `${OPEN}planner_create_plan(tasks=[`;
    expect(isCutOffToolCall('stop', text)).toBe(false);
    expect(isCutOffToolCall('tool-calls', text)).toBe(false);
  });

  it('空文本 = 不算', () => {
    expect(isCutOffToolCall('length', '')).toBe(false);
  });
});

describe('isCutOffAnswer(截断 + 无未闭合标签 = 正文截停)', () => {
  it('length + 正文刚开头即被截(生产实例 2026-10-22:仅 1 字符) = 截断', () => {
    expect(isCutOffAnswer('length', '【')).toBe(true);
  });

  it('length + 无标签正文被截 = 截断', () => {
    expect(isCutOffAnswer('length', '这是一段被截断的普通结论文本……')).toBe(true);
  });

  it('length + 未闭合标签(工具调用截停形态)= 不算(归 isCutOffToolCall 管)', () => {
    const text = `${OPEN}search_web(query="x"`;
    expect(isCutOffAnswer('length', text)).toBe(false);
  });

  it('stop/other + 正文 = 不算(提供商未报截断,不替它猜)', () => {
    expect(isCutOffAnswer('stop', '【')).toBe(false);
    expect(isCutOffAnswer('tool-calls', '结论正文')).toBe(false);
  });

  it('空文本 = 不算(无残段可判,归"未产出文本"路径处理)', () => {
    expect(isCutOffAnswer('length', '')).toBe(false);
  });

  it('length 下两判定互补:任一非空文本必命中其一,且互斥', () => {
    const samples = ['【', '结论文本…', `${OPEN}a(b`, `${OPEN}a(b)${CLOSE} 尾随文本`];
    for (const s of samples) {
      expect(isCutOffToolCall('length', s) !== isCutOffAnswer('length', s)).toBe(true);
    }
  });
});
