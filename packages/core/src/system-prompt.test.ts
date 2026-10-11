import { describe, expect, it } from 'vitest';
import { DEFAULT_SYSTEM_PROMPT } from './orchestrator';

/**
 * loop 执行优化 P6:CLI 缺省系统提示同样带独立检索的并行指引。
 * (Web 层传入产品化提示,走 task-system-prompt.test.ts 覆盖。)
 */
describe('DEFAULT_SYSTEM_PROMPT', () => {
  it('包含独立检索一轮批量发起的具体指引(而非仅泛化的并行提醒)', () => {
    expect(DEFAULT_SYSTEM_PROMPT).toContain('一轮批量发出全部搜索');
    expect(DEFAULT_SYSTEM_PROMPT).toContain('每轮只发一个查询');
  });
});
