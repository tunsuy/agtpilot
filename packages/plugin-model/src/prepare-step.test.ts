import { describe, it, expect } from 'vitest';
import { adaptPrepareStepResult } from './index';

/**
 * prepareStep 返回值适配(存量 bug 修复的回归锁,2026-10-18):
 * `activeTools: []` 是 plugin-subagent token 预算闸的「收掉全部工具」收敛信号,
 * 旧实现 `if (result.activeTools?.length)` 按 falsy 丢弃 → 收敛闸在生产静默
 * 失效(只剩注入的收敛提示消息起作用)。修复后显式空数组必须透传;
 * 非空声明全部不在工具表时仍维持现状(不得误发收工具语义)。
 */

const toolsMap = { search_web: {}, rag_search: {} };

describe('adaptPrepareStepResult', () => {
  it('显式空数组 activeTools: [] → 原样透传(预算闸收敛信号,bug 修复本体)', () => {
    const out = adaptPrepareStepResult({ activeTools: [] }, toolsMap);
    expect(out).toBeDefined();
    expect(out!.activeTools).toEqual([]);
  });

  it('预算闸真实形态:空数组 + 注入收敛消息 → 两者都透传', () => {
    const msgs = [{ role: 'user', content: '【系统提示】预算触顶,直接输出报告' }];
    const out = adaptPrepareStepResult({ activeTools: [], messages: msgs }, toolsMap);
    expect(out!.activeTools).toEqual([]);
    expect(out!.messages).toBe(msgs);
  });

  it('非空 activeTools 按本次调用工具表过滤(不在表内的名字剔除)', () => {
    const out = adaptPrepareStepResult(
      { activeTools: ['search_web', 'not_mounted', 'rag_search'] },
      toolsMap,
    );
    expect(out!.activeTools).toEqual(['search_web', 'rag_search']);
  });

  it('非空声明但全部不在工具表 → 不输出 activeTools(维持现状,不误发收工具语义)', () => {
    const out = adaptPrepareStepResult({ activeTools: ['ghost_a', 'ghost_b'] }, toolsMap);
    expect(out).toBeUndefined();
  });

  it('undefined / null → undefined(不干预本步)', () => {
    expect(adaptPrepareStepResult(undefined, toolsMap)).toBeUndefined();
    expect(adaptPrepareStepResult(null, toolsMap)).toBeUndefined();
  });

  it('messages 重写透传;空数组丢弃(空重写无意义)', () => {
    const msgs = [{ role: 'user', content: '压缩纪要' }];
    expect(adaptPrepareStepResult({ messages: msgs }, toolsMap)!.messages).toBe(msgs);
    expect(adaptPrepareStepResult({ messages: [] }, toolsMap)).toBeUndefined();
  });
});
