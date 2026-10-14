import { describe, expect, it } from 'vitest';
import type { ToolDefinition } from '@agtpilot/core';
import {
  DEFAULT_READONLY_WHITELIST,
  mcpServerPrefix,
  resolveReadonlyTools,
  SELF_TOOL_NAME,
} from './whitelist';

function mkTool(name: string, extra: Partial<ToolDefinition> = {}): ToolDefinition {
  return {
    name,
    description: name,
    parameters: { type: 'object', properties: {} },
    execute: async () => 'ok',
    ...extra,
  };
}

describe('resolveReadonlyTools 双层过滤(spec §4.3 / §9.5)', () => {
  const registry = [
    mkTool('search_web', { readOnly: true }),
    mkTool('memory_recall', { readOnly: true }),
    mkTool('sandbox_exec'), // 未声明 readOnly → 保守视为写
    mkTool('sandbox_write_file', { readOnly: false }),
    mkTool('browser_navigate', { readOnly: true }), // readOnly 但不在默认名单
    mkTool(SELF_TOOL_NAME, { readOnly: true }), // 自身
  ];

  it('默认名单 ∩ 注册表 readOnly 硬校验,保持注册表顺序', () => {
    const out = resolveReadonlyTools(registry);
    expect(out.map((t) => t.name)).toEqual(['search_web', 'memory_recall']);
  });

  it('未声明 readOnly 的工具即使在配置名单里也剔除', () => {
    const out = resolveReadonlyTools(registry, ['sandbox_exec', 'search_web', 'browser_navigate']);
    expect(out.map((t) => t.name)).toEqual(['search_web', 'browser_navigate']);
    expect(out.some((t) => t.name === 'sandbox_exec')).toBe(false);
  });

  it('research_subagent 自身无条件剔除(防递归,配置名单也压不进来)', () => {
    const out = resolveReadonlyTools(registry, [SELF_TOOL_NAME, 'search_web']);
    expect(out.some((t) => t.name === SELF_TOOL_NAME)).toBe(false);
    expect(DEFAULT_READONLY_WHITELIST).not.toContain(SELF_TOOL_NAME);
  });

  it('不在名单内但声明 readOnly 的工具默认进不来', () => {
    const out = resolveReadonlyTools(registry);
    expect(out.some((t) => t.name === 'browser_navigate')).toBe(false);
  });

  it('空注册表返回空数组', () => {
    expect(resolveReadonlyTools([])).toEqual([]);
  });
});

describe('resolveReadonlyTools · MCP 双钥匙(spec §4.3,2026-10-14)', () => {
  const reg = [
    mkTool('search_web', { readOnly: true }),
    mkTool('mcp_deepwiki_ask_question', { readOnly: true }), // 服务器声明只读(annotations)
    mkTool('mcp_deepwiki_create_wiki'), // 同服务器的写工具(无只读声明)
    mkTool('mcp_github_mcp_search_repositories', { readOnly: true }), // 服务器不在白名单
    mkTool('mcp_newsnow_fetch_hot'), // 无注解服务器(永无 readOnly)
  ];

  it('默认(白名单全空)= 不放行任何 MCP 工具,内置只读工具不受影响', () => {
    const out = resolveReadonlyTools(reg);
    expect(out.map((t) => t.name)).toEqual(['search_web']);
  });

  it('双钥匙:白名单服务器 ∩ readOnly 声明 → 放行;同服务器写工具不放行', () => {
    const out = resolveReadonlyTools(reg, { mcpServers: ['deepwiki'] });
    expect(out.map((t) => t.name)).toEqual(['search_web', 'mcp_deepwiki_ask_question']);
  });

  it('只满足一把钥匙不放行:readOnly 但服务器不在白名单', () => {
    const out = resolveReadonlyTools(reg, { mcpServers: ['deepwiki'] });
    expect(out.some((t) => t.name === 'mcp_github_mcp_search_repositories')).toBe(false);
  });

  it('普通白名单里的 mcp_ 名字无效(MCP 只能经双钥匙/逃生口)', () => {
    const out = resolveReadonlyTools(reg, {
      whitelist: ['search_web', 'mcp_deepwiki_ask_question'],
    });
    expect(out.some((t) => t.name.startsWith('mcp_'))).toBe(false);
  });

  it('逃生口:人工前缀放行无注解服务器的工具(不需要 readOnly),不影响其他 MCP', () => {
    const out = resolveReadonlyTools(reg, { mcpAllowTools: ['mcp_newsnow_'] });
    expect(out.map((t) => t.name)).toEqual(['search_web', 'mcp_newsnow_fetch_hot']);
  });

  it('双钥匙与逃生口可叠加', () => {
    const out = resolveReadonlyTools(reg, {
      mcpServers: ['github_mcp'],
      mcpAllowTools: ['mcp_newsnow_'],
    });
    expect(out.map((t) => t.name)).toEqual([
      'search_web',
      'mcp_github_mcp_search_repositories',
      'mcp_newsnow_fetch_hot',
    ]);
  });

  it('空白/退化服务器名不产生「匹配全部 mcp_」的裸前缀', () => {
    const out = resolveReadonlyTools(reg, { mcpServers: ['', '  ', '_'] });
    expect(out.some((t) => t.name.startsWith('mcp_'))).toBe(false);
  });

  it('服务器名净化与 plugin-mcp 对齐:my.server → mcp_my_server_ 前缀', () => {
    const r = [mkTool('mcp_my_server_ask', { readOnly: true })];
    expect(resolveReadonlyTools(r, { mcpServers: ['my.server'] })).toHaveLength(1);
  });
});

describe('mcpServerPrefix', () => {
  it('常规名直拼', () => {
    expect(mcpServerPrefix('deepwiki')).toBe('mcp_deepwiki_');
    expect(mcpServerPrefix(' github_mcp ')).toBe('mcp_github_mcp_');
  });

  it('非法字符换下划线、连续折叠', () => {
    expect(mcpServerPrefix('my.server')).toBe('mcp_my_server_');
    expect(mcpServerPrefix('a..b')).toBe('mcp_a_b_');
  });

  it('空名/退化前缀返回 null', () => {
    expect(mcpServerPrefix('')).toBeNull();
    expect(mcpServerPrefix('   ')).toBeNull();
  });
});
