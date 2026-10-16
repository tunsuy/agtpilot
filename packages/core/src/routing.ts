import { ToolDefinition, ToolRoute } from './contracts';

/**
 * 工具按需挂载（阈值触发式 Tool Routing）。
 *
 * 对齐业界实践（Claude Code / 腾讯 Octop）：工具目录不大时全量挂载，
 * 保证跨任务前缀稳定、共享 provider 缓存；只有当工具声明 tokens 超过
 * 上下文窗口的一定比例才启用筛选。路由规则由各插件通过
 * `ctx.agent.registerToolRoute()` 自注册（见 contracts.ToolRoute），
 * 内核不维护任何插件专属前缀表；纯闲聊 prompt 由内核闲聊短路兜住
 * （只挂基线工具，不进插件路由）。
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
 * 闲聊短路模式（全串锚定）：整条消息就是问候 / 自我介绍 / 简单问答。
 * 「你是谁」三个字实测付了 45.8k 输入 —— 135 个 MCP 连接器工具占六成，
 * 而行为准则第 1 条本就要求这类请求直接作答不调工具。
 * 保守设计：全串匹配 + 长度上限（24 字符），「你是谁的作者」这类半截
 * 任务话不会命中（不是全串），误伤路径落回全量兜底，损失只是省不了 token。
 */
const SMALLTALK_RE =
  /^(你是谁|自我介绍|介绍(一下)?(自己|你自己)|你能(做|干)什么|你会什么|你好|您好|嗨|哈喽|hello|hi|hey|在吗|谢谢|多谢|辛苦了|再见|拜拜)[!！?？。.,，~～\s]*$/i;

/** 闲聊短路判定：明显不需要任何领域工具组的 prompt（只看文本形态，不猜语义） */
export function isSmalltalkPrompt(text: string): boolean {
  const p = String(text || '').trim().toLowerCase();
  if (!p || p.length > 24) return false;
  return SMALLTALK_RE.test(p);
}

/**
 * 依据阈值与 prompt 选出本次任务需要声明的工具子集。
 * 返回 undefined 表示全量挂载（未超阈值 / 未命中任何规则 / 路由被关闭）。
 *
 * 决策顺序：显式指定 > 路由开关 > 阈值门（工具 tokens < 上下文 10% 时
 * 全量挂载，前缀恒定跨任务共享缓存）> 闲聊短路（纯问候/自我介绍只挂基线）
 * > 插件注册的关键词规则路由。
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

  // 闲聊短路：全串锚定的问候/自我介绍 → 只挂基线工具（看板/记忆/交付等
  // 小而通用的常驻件）。返回的可能是空数组 —— 编排器照常跑，模型没有
  // 领域工具可调反而不会乱调；续聊转入真实任务时由「只扩不缩」机制
  // 在重算路由的那一步扩容（扩容才写回，前缀缓存只破一次）。
  if (isSmalltalkPrompt(prompt)) {
    return allTools.filter((t) => t.baseline).map((t) => t.name);
  }

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

/**
 * 任务内「只扩不缩」合并：把本步重算的 next 并入冻结的 mounted 集合。
 *
 * `prepareStep` 每步都会用近期消息重算路由（解决"中途需要的工具声明不到"），
 * 但全量替换会让工具声明前缀每步都变——provider 前缀缓存（DeepSeek/OpenAI
 * 自动缓存）每步 miss，每轮全价重付 schema + 历史前缀。因此任务内只在
 * **扩容**的那一步写回（一次缓存重建换新增工具），缩容不回退（下一任务
 * 的初始路由自然回到小集合）。
 *
 * 就地修改 mounted（调用方持有的稳定集合）；无新增工具返回 null
 * （调用方不写回 activeTools）。
 */
export function widenMountedTools(mounted: Set<string>, next?: string[]): string[] | null {
  if (!next) return null;
  let widened = false;
  for (const name of next) {
    if (!mounted.has(name)) {
      mounted.add(name);
      widened = true;
    }
  }
  return widened ? Array.from(mounted) : null;
}

/**
 * 缺 Key 工具不挂载(loop 执行优化 P5)。
 *
 * `requiredEnv` 声明的外部服务 Key 任一名字在 taskEnv(用户个人空间,
 * 多用户隔离)或 process.env 中存在才算已配置;缺 Key 的工具直接剔除 ——
 * 挂一个秒败的壳只会诱使模型调用后浪费轮次(种草任务 40% 有效率的主要
 * 贡献者)。missingKeyTools 同时返回,供编排器把「未配置」事实写进系统
 * 提示,让模型在决策点就知道改用替代工具,而不是只躺在记忆里(auto-distill
 * 存了「Firecrawl/Tavily 缺 Key」模型下次仍照调)。
 */
export function filterToolsByEnv<T extends { requiredEnv?: string[] }>(
  tools: T[],
  taskEnv?: Record<string, string>,
): { mounted: T[]; missingKeyTools: T[] } {
  const mounted: T[] = [];
  const missingKeyTools: T[] = [];
  for (const tool of tools) {
    if (
      tool.requiredEnv &&
      !tool.requiredEnv.some((key) => process.env[key] || taskEnv?.[key])
    ) {
      missingKeyTools.push(tool);
    } else {
      mounted.push(tool);
    }
  }
  return { mounted, missingKeyTools };
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
