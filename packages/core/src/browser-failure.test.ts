import { describe, it, expect } from 'vitest';
import { classifyBrowserFailure } from './browser-failure';

/**
 * 易碎浏览器操作的失败分类(loop 执行优化 P4):
 * 环境级故障(页面改版/网络/会话断)必须返回「下一步指引」,而不是裸
 * Playwright 报错 —— 生产实测一次改版让 agent 盲诊空转 8 轮。
 */
describe('classifyBrowserFailure', () => {
  it('选择器/等待超时 → page-structure(改版或加载慢,指引停止盲诊)', () => {
    const g = classifyBrowserFailure('locator.fill: Timeout 20000ms exceeded.');
    expect(g.kind).toBe('page-structure');
    expect(g.hint).toContain('环境级故障');
    expect(g.hint).toContain('停止浏览器操作');
  });

  it('waitForSelector 超时文案 → page-structure', () => {
    const g = classifyBrowserFailure('page.waitForSelector: Timeout 30000ms exceeded waiting for selector "input[placeholder*=标题]"');
    expect(g.kind).toBe('page-structure');
  });

  it('网络层报错 → network(指引换源,不原地重试)', () => {
    const g = classifyBrowserFailure('net::ERR_NAME_NOT_RESOLVED at https://example.com');
    expect(g.kind).toBe('network');
    expect(g.hint).toContain('换一个信息源');
  });

  it('会话/页面已关闭 → session(指引重开页面)', () => {
    const g = classifyBrowserFailure('Target page, context or browser has been closed');
    expect(g.kind).toBe('session');
    expect(g.hint).toContain('重新打开');
  });

  it('超时文案里混 net:: 错误码 → 归 network(网络优先于超时)', () => {
    const g = classifyBrowserFailure('Navigation failed: net::ERR_CONNECTION_RESET');
    expect(g.kind).toBe('network');
  });

  it('无法归类 → unknown(指引按环境级故障处理,不盲目重试)', () => {
    const g = classifyBrowserFailure('一些完全没见过的错误');
    expect(g.kind).toBe('unknown');
    expect(g.hint).toContain('不要盲目重试');
  });
});
