/**
 * MCP 客户端统一输出治理(层1 源头裁剪 ③,docs/design/token-consumption-and-tool-loading.md §9.3)。
 *
 * 业界对照:Claude Code `MAX_MCP_OUTPUT_TOKENS`(默认 25k tokens,文本 >50k 字符落盘
 * 只留路径)、Codex CLI 单工具 `output_token_limit`、Cline 8k —— MCP 输出治理一律
 * 做在客户端/宿主侧,协议层不管(MCP 官方立场)。本模块是 agtpilot 的对应物:
 * plugin-mcp 在 `callTool` 返回后、结果进编排器之前统一裁剪。
 *
 * 三层动作(全部带「不静默截断」标记,红线同 truncateToolOutput):
 * 1. 非文本 content(image/audio/resource blob)→ 文本占位标记。当前模型面全是
 *    文本模型,base64 图片进上下文是纯噪音(与 browser 截图剥离同一裁定);
 * 2. JSON 文本字段压缩:content.text 能解析为 JSON 时,递归把超过
 *    maxStringChars 的字符串字段就地截短(GitHub MCP 全字段 JSON 的
 *    body/body_html 是典型肥大字段),结构、数字、短字段原样保留;
 *    structuredContent 同治(编排器序列化整个返回对象,双份都进模型);
 * 3. 总量上限:文本合计超过 per-server/统一 cap 时,按序保留到预算内,
 *    骑线段头保留 + 标记,其后各段替换为省略标记(附原始字符数)。
 *
 * 上限解析:统一 env `AGTPILOT_MCP_OUTPUT_LIMIT`(字符,默认 12000;0 = 关闭
 * 本模块,行为回退原样透传);`SERVER_OUTPUT_RULES` 按服务器 id 收紧
 * (deepwiki 8000:长 Markdown 答案;github_mcp 字段压缩 400:全字段 JSON)。
 * env 每次调用读取(热保险丝,与 reasoningStripEnabled 同款语义)。
 *
 * 无损性说明:cap 之后编排器的 16KB spill 不再对 MCP 输出触发(结果已小于
 * 阈值)—— 这是有意取舍:MCP 查询是只读可重放的,与 Claude Code 客户端侧
 * 截断同构;需要全文时用更精确参数重查(标记里已写明)。
 */

/** 统一输出上限(字符);业界锚:Claude Code MAX_MCP_OUTPUT_TOKENS=25k tokens */
export const MCP_OUTPUT_LIMIT_DEFAULT = 12_000;

/** JSON 文本内单个字符串字段的默认上限(字符) */
export const MCP_MAX_STRING_DEFAULT = 1_000;

export interface McpOutputRule {
  /** 该服务器的文本总量上限(字符);缺省用统一上限 */
  limit?: number;
  /** JSON 字段压缩的单字符串上限(字符);缺省 MCP_MAX_STRING_DEFAULT */
  maxStringChars?: number;
}

/**
 * 按服务器 id 的收紧规则(与 web 连接器目录 mcp-connectors.ts 的 id 对齐)。
 * 新增条目须实测该服务器返回形态(惯例同 plugin-subagent 的 DEFAULT_MCP_SERVERS:
 * 名单变更以实测记录为背书)。
 */
export const SERVER_OUTPUT_RULES: Record<string, McpOutputRule> = {
  // 答案型长 Markdown(ask_question 单答可到几万字符):头保留(结论先行),cap 收紧
  deepwiki: { limit: 8_000 },
  // 全字段 JSON(search_issues/get_issue 携带 body/body_html/反应计数等):字段级压缩为主
  github_mcp: { limit: 12_000, maxStringChars: 400 },
};

/** 统一上限(env 覆盖;0 = 模块关闭) */
export function mcpUnifiedLimit(): number {
  const raw = process.env.AGTPILOT_MCP_OUTPUT_LIMIT;
  if (raw !== undefined && raw !== '') {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) return Math.floor(n);
  }
  return MCP_OUTPUT_LIMIT_DEFAULT;
}

/** 该服务器生效的文本总量上限(字符);0 = 不裁剪 */
export function mcpOutputLimit(serverName: string): number {
  const unified = mcpUnifiedLimit();
  if (unified <= 0) return 0;
  const rule = SERVER_OUTPUT_RULES[serverName];
  return rule?.limit && rule.limit > 0 ? Math.min(rule.limit, unified) : unified;
}

function clipMarker(original: number, kept: number, why: string): string {
  return `…[MCP 输出已裁剪(${why}):本段原始 ${original} 字符,保留 ${kept} 字符。请携带更精确的参数缩小查询范围重查,不要原样重放]…`;
}

/** 头部保留截断 + 显式标记(答案/文档类头信息密度最高,与 truncateText 同精神) */
function headClip(text: string, limit: number, why: string): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n${clipMarker(text.length, limit, why)}`;
}

/**
 * 递归压缩 JSON 值里的长字符串字段(纯函数,返回新值;字符串数 ≤ maxStr 原引用返回)。
 * 只动字符串叶子;数组/对象结构、数字、布尔、null 原样 —— 保住 schema 语义,
 * 砍掉 body/正文/HTML 类肥大字段(层1「语义裁剪」相对头尾盲截的价值所在)。
 */
export function compactJsonStrings(value: any, maxStr: number): any {
  if (typeof value === 'string') {
    return value.length > maxStr
      ? `${value.slice(0, maxStr)}…[字段已截短,原始 ${value.length} 字符]`
      : value;
  }
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((v) => {
      const c = compactJsonStrings(v, maxStr);
      if (c !== v) changed = true;
      return c;
    });
    return changed ? next : value;
  }
  if (value && typeof value === 'object') {
    let changed = false;
    const next: Record<string, any> = {};
    for (const [k, v] of Object.entries(value)) {
      const c = compactJsonStrings(v, maxStr);
      if (c !== v) changed = true;
      next[k] = c;
    }
    return changed ? next : value;
  }
  return value;
}

/** text 项:能解析为 JSON 则做字段压缩,否则原样返回(总量 cap 在后面统一处理) */
function compactTextItem(text: string, maxStr: number): string {
  const t = text.trim();
  if (!t.startsWith('{') && !t.startsWith('[')) return text;
  try {
    const parsed = JSON.parse(t);
    const compacted = compactJsonStrings(parsed, maxStr);
    if (compacted === parsed) return text;
    return JSON.stringify(compacted);
  } catch {
    return text; // 不是合法 JSON(如 Markdown 答案)→ 交给总量 cap
  }
}

/**
 * callTool 返回值的统一裁剪入口(纯函数,不改动入参;cap=0 或形态不认识时原样返回)。
 * 在 plugin-mcp execute 里包住两处 `await call(client)`(首调 + 重连重试)。
 */
export function capMcpToolResult(result: any, serverName: string): any {
  const limit = mcpOutputLimit(serverName);
  if (limit <= 0) return result;
  if (!result || typeof result !== 'object' || !Array.isArray(result.content)) return result;

  const maxStr = SERVER_OUTPUT_RULES[serverName]?.maxStringChars ?? MCP_MAX_STRING_DEFAULT;
  const originalTotal = result.content.reduce(
    (acc: number, it: any) => acc + (typeof it?.text === 'string' ? it.text.length : 0),
    0,
  );

  // 1+2. 非文本项换占位标记;文本项做 JSON 字段压缩
  let content = result.content.map((item: any) => {
    if (item?.type === 'text' && typeof item.text === 'string') {
      return { ...item, text: compactTextItem(item.text, maxStr) };
    }
    if (item?.type === 'image' || item?.type === 'audio') {
      return {
        type: 'text',
        text: `[${item.type === 'image' ? '图片' : '音频'}内容已省略:当前模型为文本模型,二进制帧不进上下文;需要画面信息时改用返回文本的查询参数]`,
      };
    }
    if (item?.type === 'resource' && item.resource && typeof item.resource !== 'object') {
      return item;
    }
    if (item?.type === 'resource' && item.resource?.blob) {
      const uri = item.resource.uri ?? '';
      return { type: 'text', text: `[嵌入资源 ${uri} 为二进制 blob,已省略;需要时用支持文本返回的参数重查]` };
    }
    return item;
  });

  // 3. 总量 cap:按序分配预算,骑线段头保留,其后各段换省略标记
  const afterCompactTotal = content.reduce(
    (acc: number, it: any) => acc + (typeof it?.text === 'string' ? it.text.length : 0),
    0,
  );
  if (afterCompactTotal > limit) {
    let budget = limit;
    content = content.map((item: any) => {
      if (item?.type !== 'text' || typeof item.text !== 'string') return item;
      if (budget <= 0) {
        return {
          type: 'text',
          text: clipMarker(item.text.length, 0, `服务器 ${serverName} 上限 ${limit} 字符,本段整体省略`),
        };
      }
      if (item.text.length <= budget) {
        budget -= item.text.length;
        return item;
      }
      const kept = item.text.slice(0, budget);
      const clipped = `${kept}\n${clipMarker(item.text.length, budget, `服务器 ${serverName} 上限 ${limit} 字符`)}`;
      budget = 0;
      return { ...item, text: clipped };
    });
  }

  const out: any = { ...result, content };
  // structuredContent 与 content 是同一份数据的双投影(GitHub MCP 形态),
  // 编排器 JSON.stringify 整个返回对象 —— 不压缩就是双份付费
  if (out.structuredContent !== undefined) {
    out.structuredContent = compactJsonStrings(out.structuredContent, maxStr);
  }
  // 可观测:被裁剪时附元数据(isError 结果同样适用;模型与审计都能看到裁剪发生过)
  if (originalTotal > 0 && (afterCompactTotal !== originalTotal || originalTotal > limit)) {
    out._agtpilotTrim = {
      server: serverName,
      originalChars: originalTotal,
      limit,
    };
  }
  return out;
}
