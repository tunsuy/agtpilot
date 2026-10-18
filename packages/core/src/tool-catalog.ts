import type { ToolDefinition } from './contracts';

/**
 * 层0 目录卡片 + load_tools 元工具(菜单点菜制 B v1,
 * docs/design/token-consumption-and-tool-loading.md §9.4)。
 *
 * 问题:MCP 连接器工具(生产 135 把 ≈27k tokens)不属于任何关键词路由 ——
 * 自由任务要么全量挂载(账单爆炸),要么统一不挂(§9.5 止血 A 的明码代价,
 * 模型没有自助通道)。本模块给「不挂 schema、只挂一行卡片」的中间态:
 * - 未挂载的 catalogable 工具(检索侧插件自声明,内核零插件知识)按服务器
 *   分组进系统提示【按需工具目录】,一行一把(名字+用途首句,≈37 tokens/把);
 * - load_tools 元工具(任务级注入,baseline 语义):模型点名 → 编排器记入
 *   任务内已点名单 → 下一步 prepareStep 把点名工具并入挂载面(schema 上线)。
 *
 * 缓存纪律:目录文本每任务构建一次、输入序=声明序(不排序不打时间戳),
 * 跨步字节稳定;挂载面只在点名后的那一步扩容一次(与 widenMountedTools
 * 同一次写回),provider 前缀缓存至多破一次。
 *
 * 保险丝:AGTPILOT_TOOL_CATALOG=0 → 不注入目录、不注入 load_tools,
 * 行为回到 §9.5 止血 A 现状(调用时读 env,热切)。
 */

/** load_tools 元工具名(编排器任务级注入,不进全局注册表 → 子 agent 不可见,双钥匙语义不变) */
export const LOAD_TOOLS_NAME = 'load_tools';

/** 目录保险丝:AGTPILOT_TOOL_CATALOG=0 关闭(调用时读 env,便于测试/热调) */
export function toolCatalogEnabled(): boolean {
  return process.env.AGTPILOT_TOOL_CATALOG !== '0';
}

/** 参与目录卡片的工具元信息(名字+描述+分组,RoutableTool 同构) */
export interface CatalogableTool {
  name: string;
  description?: string;
  catalogGroup?: string;
}

/** 卡片行用途截断上限(测量:一行卡片均值 ≈37 tokens,截断保目录总量可控) */
const CARD_DESC_MAX = 60;

/**
 * 卡片行:`- 工具名: 用途首句`。
 * 取 description 首行、剥掉开头 [xx] 方括号标签(如 `[MCP连接器: srv]` ——
 * 分组头已带服务器名,行内重复付费)、超 CARD_DESC_MAX 截断加省略号。
 */
export function cardLine(t: CatalogableTool): string {
  const first = String(t.description || '').split('\n')[0].trim();
  const stripped = first.replace(/^\[[^\]]*\]\s*/, '').trim();
  const body = stripped || first || t.name;
  const clamped = body.length > CARD_DESC_MAX ? `${body.slice(0, CARD_DESC_MAX)}…` : body;
  return `- ${t.name}: ${clamped}`;
}

/**
 * 按 catalogGroup 分组:组按首见序、组内按声明序(输入不重排 → 输出字节稳定)。
 * 无分组的工具归入 group='' 的兜底组(渲染时不出组头)。
 */
export function groupCatalogTools(
  tools: CatalogableTool[]
): Array<{ group: string; tools: CatalogableTool[] }> {
  const groups: Array<{ group: string; tools: CatalogableTool[] }> = [];
  const byName = new Map<string, { group: string; tools: CatalogableTool[] }>();
  for (const t of tools) {
    const key = t.catalogGroup || '';
    let g = byName.get(key);
    if (!g) {
      g = { group: key, tools: [] };
      byName.set(key, g);
      groups.push(g);
    }
    g.tools.push(t);
  }
  return groups;
}

/**
 * 系统提示目录段。空目录返回 null(编排器据此不注入 load_tools)。
 * 跨步字节稳定:纯函数、无时间戳、不排序,输入序即输出序。
 */
export function buildToolCatalogNote(tools: CatalogableTool[]): string | null {
  if (tools.length === 0) return null;
  const lines: string[] = [
    '',
    '',
    `【按需工具目录】以下 ${tools.length} 个工具当前未挂载(只有目录卡片,不占 schema)。确需使用时调用 ${LOAD_TOOLS_NAME} 传入精确工具名(可一次多个),被点名的工具从下一步起挂载可调用;目录里没有的工具无法挂载。`,
  ];
  for (const g of groupCatalogTools(tools)) {
    if (g.group) lines.push(`## ${g.group}`);
    for (const t of g.tools) lines.push(cardLine(t));
  }
  return lines.join('\n');
}

export interface LoadToolsHooks {
  /** 可挂载名单(= 本任务目录里的工具);名单外的名字如实报 unknown,不放行 */
  catalog: CatalogableTool[];
  /** 是否已在挂载面/已点名(避免重复记账) */
  isMounted: (name: string) => boolean;
  /** 每次调用回调(loaded=本次新点名,unknown=目录外名字):编排器记入已点名单 + 发观测事件(命中分布数据,§9.4 欠账自动补) */
  onLoad: (loaded: string[], unknown: string[]) => void;
}

/**
 * 构造任务级 load_tools 元工具(编排器在目录注入时合成,不进全局注册表)。
 * readOnly:纯挂载申报、无外部副作用 → 走只读并行门;dangerLevel low:
 * 挂载 ≠ 执行,被挂载工具真正调用时仍过既有审批门/双钥匙,语义不变。
 */
export function createLoadToolsDefinition(hooks: LoadToolsHooks): ToolDefinition {
  const known = new Set(hooks.catalog.map((t) => t.name));
  return {
    name: LOAD_TOOLS_NAME,
    description:
      '按名字挂载【按需工具目录】里的工具:传入目录中的精确工具名(可一次多个),挂载成功后从下一步起可调用。只能挂载目录内工具,目录外名字会如实报 unknown。',
    dangerLevel: 'low',
    readOnly: true,
    parameters: {
      type: 'object',
      properties: {
        tools: {
          type: 'array',
          items: { type: 'string' },
          description: '要挂载的精确工具名列表(从【按需工具目录】原样复制)',
        },
        reason: { type: 'string', description: '可选:一句话用途说明(进观测事件,帮助校准路由规则)' },
      },
      required: ['tools'],
    },
    execute: async (args: any) => {
      const requested = Array.isArray(args?.tools)
        ? args.tools
            .filter((x: any) => typeof x === 'string' && x.trim() !== '')
            .map((x: string) => x.trim())
        : [];
      if (requested.length === 0) {
        return {
          success: false,
          loaded: [],
          error: `tools 参数为空:请传入【按需工具目录】中的精确工具名。`,
        };
      }
      const loaded: string[] = [];
      const already: string[] = [];
      const unknown: string[] = [];
      for (const name of requested) {
        if (!known.has(name)) unknown.push(name);
        else if (hooks.isMounted(name)) already.push(name);
        else loaded.push(name);
      }
      hooks.onLoad(loaded, unknown);
      return {
        success: unknown.length === 0,
        loaded,
        ...(already.length > 0 ? { alreadyMounted: already } : {}),
        ...(unknown.length > 0
          ? { unknown, hint: '这些名字不在按需工具目录中,请核对拼写;目录外工具无法挂载。' }
          : {}),
        ...(loaded.length > 0 ? { note: '已挂载,上述工具从下一步起可调用。' } : {}),
      };
    },
  };
}
