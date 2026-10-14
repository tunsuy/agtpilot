import { describe, expect, it } from 'vitest';
import { DEFAULT_MCP_ALLOW_TOOLS, DEFAULT_MCP_SERVERS } from './index';

/**
 * MCP 默认白名单(2026-10-14 负责人要求默认开放工坊检索连接器)。
 * 红线回归:行情类连接器永不入默认名单;逃生口默认项仅限实测确认只读的服务器。
 */

describe('DEFAULT_MCP_SERVERS(双钥匙的人工钥匙默认值)', () => {
  it('为工坊调研链的检索类连接器五台', () => {
    expect([...DEFAULT_MCP_SERVERS].sort()).toEqual(
      ['alphaxiv', 'deepwiki', 'github_mcp', 'huggingface', 'openalex'].sort(),
    );
  });

  it('行情/写操作类连接器不入默认名单(数字红线:主循环直拉)', () => {
    for (const s of ['tushare', 'alphavantage_mcp', 'coingecko_mcp', 'a_stock', 'notion', 'dida365']) {
      expect(DEFAULT_MCP_SERVERS).not.toContain(s);
    }
  });
});

describe('DEFAULT_MCP_ALLOW_TOOLS(逃生口默认值,实测背书)', () => {
  it('仅 deepwiki / newsnow 前缀(2026-10-14 annotations-report.mjs 实测全部工具只读)', () => {
    expect([...DEFAULT_MCP_ALLOW_TOOLS]).toEqual(['mcp_deepwiki_', 'mcp_newsnow_']);
  });

  it('不含裸 mcp_ 前缀(那会放行全部 MCP 工具)', () => {
    expect(DEFAULT_MCP_ALLOW_TOOLS).not.toContain('mcp_');
    expect(DEFAULT_MCP_ALLOW_TOOLS.every((p) => p.length > 'mcp_'.length)).toBe(true);
  });
});
