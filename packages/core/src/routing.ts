import { ToolDefinition, ToolRoute } from './contracts';

/**
 * 工具按需挂载（阈值触发式 Tool Routing）。
 *
 * 对齐业界实践（Claude Code / 腾讯 Octop）：工具目录不大时全量挂载，
 * 保证跨任务前缀稳定、共享 provider 缓存；只有当工具声明 tokens 超过
 * 上下文窗口的一定比例才启用筛选。路由规则由各插件通过
 * `ctx.agent.registerToolRoute()` 自注册（见 contracts.ToolRoute），
 * 内核不维护任何插件专属前缀表。
 *
 * 可调参数：AGTPILOT_TOOL_ROUTING=0 整体关闭；
 * AGTPILOT_CONTEXT_WINDOW（默认 64000）；AGTPILOT_TOOL_SEARCH_THRESHOLD（默认 10，单位 %）。
 */

/** 估算一段文本的 tokens（CJK 按 1 token/字，其余按 1 token/4 字符） */
export function estimateTextTokens(text: string): number {
  let cjk = 0;
  for (const ch of text) {
    if (/[㐀-䶿一-鿿豈-﫿]/.test(ch)) cjk++;
  }
  return Math.ceil(cjk + (text.length - cjk) / 4);
}

/** 参与路由决策的工具元信息（名字 + 声明体积） */
export interface RoutableTool {
  name: string;
  description?: string;
  parameters?: Record<string, any>;
  baseline?: boolean;
}

/**
 * 估算工具声明占用的 tokens（name + description + 参数 Schema）。
 * 启发式：CJK 字符按 1 token/字，其余按 1 token/4 字符。
 */
export function estimateToolTokens(tools: RoutableTool[]): number {
  let cjk = 0;
  let total = 0;
  for (const t of tools) {
    const s = JSON.stringify({
      name: t.name,
      description: t.description ?? '',
      parameters: t.parameters ?? {},
    });
    total += s.length;
    for (const ch of s) {
      if (/[㐀-䶿一-鿿豈-﫿]/.test(ch)) cjk++;
    }
  }
  return Math.ceil(cjk + (total - cjk) / 4);
}

/** 当前配置的阈值门：工具声明 tokens 低于该值时全量挂载（调用时读 env，便于测试/热调） */
export function toolSearchTokenThreshold(): number {
  const contextWindow = Math.max(1024, Number(process.env.AGTPILOT_CONTEXT_WINDOW) || 64_000);
  const pct = Number(process.env.AGTPILOT_TOOL_SEARCH_THRESHOLD) || 10;
  return Math.floor((contextWindow * pct) / 100);
}

/**
 * 依据阈值与 prompt 选出本次任务需要声明的工具子集。
 * 返回 undefined 表示全量挂载（未超阈值 / 未命中任何规则 / 路由被关闭）。
 *
 * 决策顺序：显式指定 > 路由开关 > 阈值门（工具 tokens < 上下文 10% 时
 * 全量挂载，前缀恒定跨任务共享缓存）> 插件注册的关键词规则路由。
 * 基线工具（ToolDefinition.baseline）无论如何都挂载。
 */
export function selectActiveTools(
  prompt: string,
  allTools: RoutableTool[],
  routes: ToolRoute[],
  explicit?: string[]
): string[] | undefined {
  const allToolNames = allTools.map((t) => t.name);
  if (explicit && explicit.length > 0) {
    const filtered = explicit.filter((n) => allToolNames.includes(n));
    return filtered.length > 0 ? filtered : undefined;
  }
  if (process.env.AGTPILOT_TOOL_ROUTING === '0') return undefined;

  // 阈值门：工具目录还小 → 全量挂载，保证前缀稳定
  if (estimateToolTokens(allTools) < toolSearchTokenThreshold()) return undefined;

  // 超阈值：插件注册的关键词规则 → 工具前缀路由
  const matched = new Set<string>();
  for (const route of routes) {
    if (route.test.test(prompt)) {
      for (const prefix of route.prefixes) {
        for (const name of allToolNames) {
          if (name.startsWith(prefix)) matched.add(name);
        }
      }
    }
  }
  if (matched.size === 0) return undefined; // 拿不准 → 全量，保守兜底

  // prompt 里显式提到的工具名直接保留
  for (const name of allToolNames) {
    if (prompt.includes(name)) matched.add(name);
  }
  // 基线工具（插件自声明的通用小工具）
  for (const tool of allTools) {
    if (tool.baseline) matched.add(tool.name);
  }
  return Array.from(matched);
}

/** 参数归一化：递归排序 key、字符串去空白标点小写化，用于模糊死循环检测 */
export function stableStringify(value: any): any {
  if (Array.isArray(value)) return value.map(stableStringify);
  if (value && typeof value === 'object') {
    const out: Record<string, any> = {};
    for (const k of Object.keys(value).sort()) out[k] = stableStringify(value[k]);
    return out;
  }
  if (typeof value === 'string') {
    return value.toLowerCase().replace(/[\s.,;:!?'""()\[\]{}~`@#$%^&*+=|\\/-]+/g, '');
  }
  return value;
}

export type { ToolDefinition, ToolRoute };
