/**
 * 只读白名单(spec §4.3):双层过滤 —— 配置名单 ∩ 注册表 readOnly 硬校验。
 *
 * 红线:
 * - 未声明 readOnly: true 的工具即使在配置名单里也剔除(未声明保守视为写);
 * - research_subagent 自身无条件剔除(防递归,深度固定为 1);
 * - MCP 工具(plugin-mcp 一律 medium 且不带 readOnly)天然进不来,M2 再议前缀白名单。
 */
import type { ToolDefinition } from '@agtpilot/core';

/** 子 agent 自身的工具名(防递归:内部工具集永不含它) */
export const SELF_TOOL_NAME = 'research_subagent';

/** 默认白名单:注册表中现有已声明 readOnly: true 的检索/读取类工具 */
export const DEFAULT_READONLY_WHITELIST: readonly string[] = [
  // plugin-search(后两者带 requiredEnv,缺 Key 时由 filterToolsByEnv 自动不挂)
  'search_web',
  'search_exa',
  'search_tavily',
  // plugin-browser(browser 组唯一只读,不触共享浏览器会话)
  'browser_firecrawl_scrape',
  // plugin-rag
  'rag_search',
  'rag_list_indexed',
  // plugin-sandbox
  'sandbox_read_file',
  'sandbox_list_dir',
  // plugin-git
  'git_status',
  'git_diff',
  'codebase_search_symbols',
  // plugin-memory
  'memory_recall',
  'memory_list',
];

/**
 * 解析子 agent 可用工具集。
 * @param registry 注册表全量工具(ctx.agent.getTools())
 * @param configured 配置覆盖名单(env AGTPILOT_SUBAGENT_WHITELIST / 插件 config);缺省用默认名单
 * @returns 同时满足「名单内 + readOnly === true + 非自身」的工具,保持注册表顺序(运行时稳定,KV-cache 友好)
 */
export function resolveReadonlyTools(
  registry: readonly ToolDefinition[],
  configured?: readonly string[],
): ToolDefinition[] {
  const allowed = new Set(configured ?? DEFAULT_READONLY_WHITELIST);
  allowed.delete(SELF_TOOL_NAME);
  return registry.filter(
    (t) => allowed.has(t.name) && t.readOnly === true && t.name !== SELF_TOOL_NAME,
  );
}
