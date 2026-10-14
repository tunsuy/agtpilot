import { describe, it, expect } from 'vitest';
import { mcpToolReadOnly, sanitizeToolName } from './index';

/**
 * MCP annotations → readOnly 声明的保守映射(spec §4.3 双钥匙的「机器钥匙」)。
 * 规范默认:未注解 = 视为非只读、可能破坏;hint 是服务器自报提示,不是安全契约,
 * 因此这里只做「声明翻译」,最终放行还需子 agent 侧的服务器白名单(人工钥匙)。
 */

describe('mcpToolReadOnly', () => {
  it('readOnlyHint=true 且无 destructiveHint → 只读', () => {
    expect(mcpToolReadOnly({ readOnlyHint: true })).toBe(true);
  });

  it('readOnlyHint=true 且 destructiveHint=false → 只读', () => {
    expect(mcpToolReadOnly({ readOnlyHint: true, destructiveHint: false })).toBe(true);
  });

  it('readOnlyHint=true 但 destructiveHint=true → 非只读(矛盾声明按保守处理)', () => {
    expect(mcpToolReadOnly({ readOnlyHint: true, destructiveHint: true })).toBe(false);
  });

  it('无注解 / 空对象 → 非只读(规范保守默认)', () => {
    expect(mcpToolReadOnly(undefined)).toBe(false);
    expect(mcpToolReadOnly(null)).toBe(false);
    expect(mcpToolReadOnly({})).toBe(false);
  });

  it('readOnlyHint=false 或缺失 → 非只读,destructiveHint 不影响结论', () => {
    expect(mcpToolReadOnly({ readOnlyHint: false })).toBe(false);
    expect(mcpToolReadOnly({ destructiveHint: false })).toBe(false);
  });

  it('非布尔真值(字符串 "true")不算声明(严格 === true)', () => {
    expect(mcpToolReadOnly({ readOnlyHint: 'true' })).toBe(false);
    expect(mcpToolReadOnly({ readOnlyHint: 1 })).toBe(false);
  });
});

describe('sanitizeToolName(与子 agent 服务器前缀匹配的契约)', () => {
  it('mcp_<server>_<tool> 形态:非法字符换下划线、连续下划线折叠', () => {
    expect(sanitizeToolName('mcp_github_mcp_search_repositories')).toBe(
      'mcp_github_mcp_search_repositories',
    );
    expect(sanitizeToolName('mcp_my.server_ask')).toBe('mcp_my_server_ask');
    expect(sanitizeToolName('mcp_a..b__t')).toBe('mcp_a_b_t');
  });

  it('超 64 字符截断', () => {
    const long = `mcp_deepwiki_${'x'.repeat(80)}`;
    expect(sanitizeToolName(long)).toHaveLength(64);
  });
});
