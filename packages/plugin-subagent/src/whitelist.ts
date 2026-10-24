/**
 * 只读白名单(spec §4.3):双层过滤 —— 配置名单 ∩ 注册表 readOnly 硬校验。
 *
 * 红线:
 * - 未声明 readOnly: true 的内置工具即使在配置名单里也剔除(未声明保守视为写);
 * - research_subagent 自身无条件剔除(防递归,深度固定为 1);
 * - MCP 工具(mcp_ 前缀)不走普通名单,走「双钥匙」:
 *     ① 机器钥匙 —— 服务器 annotations 声明只读(plugin-mcp 注册为 readOnly: true);
 *     ② 人工钥匙 —— 部署者把服务器名列入 mcpServers 白名单。
 *   两者同时满足才放行;另设 mcpAllowTools 前缀逃生口(无注解服务器,人工担责,不受 readOnly 限制)。
 *   普通白名单里出现 mcp_ 开头的名字一律无效(MCP 只能经双钥匙/逃生口进入)。
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
  // plugin-browser(navigate 2026-10-23 起声明 readOnly:纯导航+蒸馏读取;
  // 子 agent 读文档/范文需要它,firecrawl 需要 Key 缺失时由 filterToolsByEnv 摘除)
  'browser_navigate',
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
];

/** MCP 工具名前缀(plugin-mcp:工具名 = sanitize(`mcp_${server}_${tool}`)) */
const MCP_PREFIX = 'mcp_';

/**
 * 由服务器名构造工具名前缀,净化规则与 plugin-mcp sanitizeToolName 对齐
 * (非法字符换 _、连续 _ 折叠;不截断——服务器名远短于 64 字符限制)。
 * 空名/净化后退化为裸 'mcp_' 的条目返回 null(防止误匹配全部 MCP 工具)。
 */
export function mcpServerPrefix(server: string): string | null {
  const raw = (server ?? '').trim();
  if (!raw) return null;
  const prefix = `mcp_${raw}_`.replace(/[^a-zA-Z0-9_-]/g, '_').replace(/_+/g, '_');
  return prefix === MCP_PREFIX ? null : prefix;
}

export interface SubagentToolFilter {
  /** 内置工具名单覆盖(env AGTPILOT_SUBAGENT_WHITELIST / 插件 config);缺省用默认名单 */
  whitelist?: readonly string[];
  /** MCP 服务器白名单(服务器名,如 deepwiki、github_mcp);双钥匙的人工钥匙,默认空 = 不放行任何 MCP */
  mcpServers?: readonly string[];
  /** MCP 工具名前缀逃生口(env AGTPILOT_SUBAGENT_MCP_ALLOW_TOOLS);人工担责,不受 readOnly 限制 */
  mcpAllowTools?: readonly string[];
}

/** Array.isArray 的类型守卫对 readonly string[] 不收窄,自建守卫 */
function isNameList(v: readonly string[] | SubagentToolFilter | undefined): v is readonly string[] {
  return Array.isArray(v);
}

/**
 * 解析子 agent 可用工具集。
 * @param registry 注册表全量工具(ctx.agent.getTools())
 * @param filter 兼容两种形态:字符串数组 = 内置名单覆盖;对象 = 完整过滤配置
 * @returns 放行的工具,保持注册表顺序(运行时稳定,KV-cache 友好)
 */
export function resolveReadonlyTools(
  registry: readonly ToolDefinition[],
  filter?: readonly string[] | SubagentToolFilter,
): ToolDefinition[] {
  const opts: SubagentToolFilter = isNameList(filter) ? { whitelist: filter } : (filter ?? {});
  const allowed = new Set(opts.whitelist ?? DEFAULT_READONLY_WHITELIST);
  allowed.delete(SELF_TOOL_NAME);
  const serverPrefixes = (opts.mcpServers ?? [])
    .map((s) => mcpServerPrefix(s))
    .filter((p): p is string => p !== null);
  const escapePrefixes = (opts.mcpAllowTools ?? [])
    .map((p) => (p ?? '').trim())
    .filter(Boolean);

  return registry.filter((t) => {
    if (t.name === SELF_TOOL_NAME) return false;
    if (t.name.startsWith(MCP_PREFIX)) {
      // 逃生口:人工列出的工具名前缀,部署者自担只读责任(无注解服务器用)
      if (escapePrefixes.some((p) => t.name.startsWith(p))) return true;
      // 双钥匙:白名单服务器的工具 ∩ 注册表 readOnly 声明(来自 MCP annotations)
      return (
        t.readOnly === true && serverPrefixes.some((p) => t.name.startsWith(p))
      );
    }
    return allowed.has(t.name) && t.readOnly === true;
  });
}
