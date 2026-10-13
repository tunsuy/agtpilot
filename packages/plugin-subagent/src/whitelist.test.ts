import { describe, expect, it } from 'vitest';
import type { ToolDefinition } from '@agtpilot/core';
import { DEFAULT_READONLY_WHITELIST, resolveReadonlyTools, SELF_TOOL_NAME } from './whitelist';

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
