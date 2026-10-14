/**
 * MCP 工具「只读」自动分类(default-deny)——机器钥匙的信号来源扩展。
 *
 * 背景(spec §4.3 / §6.1):子 agent 无审批门,MCP 工具进入子 agent 需同时满足
 * 「服务器在人工钥匙白名单(subagentOpen)」∩「工具声明只读(readOnly)」。原实现里
 * readOnly 只来自服务器 `annotations` 自报;但大量正规检索服务器根本不填注解,
 * 于是永远卡黄灯,且靠人工逐台配凭证跑测量脚本不可持续、也不符合真实开发形态。
 *
 * 本模块把「机器钥匙」的信号来源从「仅注解」扩展为三级优先、default-deny:
 *   ① 服务器注解(权威):有实质 hint(readOnlyHint / destructiveHint 任一为 boolean)
 *      就完全交给注解判定,启发式不介入 —— 尊重服务器自我声明。
 *   ② 名称动词启发(仅当注解完全沉默时):首个词素是明确只读动词,且名称中不含
 *      破坏性动词,才判只读。
 *   ③ 拿不准 = 拒绝(default-deny):未识别的动词、写动词开头、含破坏性动词、
 *      名词开头等一律不判只读 —— 失败方向永远是「少放行」,不会「多放行」。
 *
 * 安全边界:本分类只影响 `readOnly` 声明,且它只是子 agent 双钥匙里的「机器钥匙」;
 * 人工钥匙(subagentOpen 目录标记)不变,行情/写操作类服务器在目录层就 false,
 * 根本轮不到工具级分类。因此启发式误判的最坏后果 = 某检索工具没被开进子 agent
 * (可用逃生口/加注解救回),不会把写操作放进无人值守的子 agent。
 *
 * 逃生口(AGTPILOT_SUBAGENT_MCP_ALLOW_TOOLS 前缀)仍是独立旁路:命中前缀不要求
 * readOnly,用于 ask_question 这类「动词含糊但实测只读」的工具。分类优先级因此是:
 * 逃生口名单 → 服务器注解 → 名称动词启发 → 拿不准拒绝。
 */
/** 分类依据:注解 / 名称启发 / 拒绝(default-deny) */
export type ReadOnlyBasis = 'annotation' | 'heuristic' | 'denied';

/**
 * MCP annotations → 只读声明(spec §4.3 双钥匙的「机器钥匙」原始形态)。
 * 规范语义:MCPToolAnnotations 的 hint 是服务器自报提示而非契约,且「未注解 = 保守视为写」
 * (readOnlyHint 缺省 false、destructiveHint 缺省 true)。这里同样保守:
 * 仅当 readOnlyHint === true 且 destructiveHint 未声明为 true 时才判定只读。
 * 从 index.ts 迁来此处(与分类器同源,避免 classify↔index 循环依赖);index.ts re-export 保持外部引用不变。
 */
export function mcpToolReadOnly(annotations: unknown): boolean {
  const a = annotations as { readOnlyHint?: unknown; destructiveHint?: unknown } | undefined;
  return a?.readOnlyHint === true && a?.destructiveHint !== true;
}

export interface ToolClassification {
  readOnly: boolean;
  basis: ReadOnlyBasis;
}

/**
 * 明确只读动词(名称首词素精确匹配才判只读)。
 * 只收「拉取/查询/列举」类,任何带副作用可能的动词都不在此列。
 * 宁缺毋滥:漏收的动词会落进 default-deny(不开进子 agent),方向安全。
 */
export const READ_VERBS = new Set([
  'get',
  'list',
  'search',
  'fetch',
  'query',
  'read',
  'view',
  'find',
  'browse',
  'retrieve',
  'lookup',
  'show',
  'describe',
  'check',
  'status',
  'info',
  'count',
  'whoami',
  'explore',
  'discover',
  'preview',
  'diff',
  'grep',
  'stat',
  'log',
  'blame',
  'cat',
]);

/**
 * 破坏性动词(含其常见屈折形)。名称中任何词素命中即拒绝——即便首词素是只读动词。
 * 只收「删除/销毁/不可逆」类,用于兜住 `search_and_delete` 这种把破坏动作藏在后面的名字。
 * 非破坏性的写动词(create/send/comment…)靠「首词素不在 READ_VERBS」这条规则拦截,
 * 不做「任意位置匹配」,以免误伤 `get_issue_comments` 这类只读工具。
 */
export const DESTRUCTIVE_TOKENS = new Set([
  'delete', 'deletes', 'deleted', 'deleting',
  'remove', 'removes', 'removed', 'removing',
  'destroy', 'destroys', 'destroyed', 'destroying',
  'drop', 'drops', 'dropped', 'dropping',
  'purge', 'purges', 'purged', 'purging',
  'truncate', 'truncates', 'truncated', 'truncating',
  'erase', 'erases', 'erased', 'erasing',
  'wipe', 'wipes', 'wiped', 'wiping',
  'kill', 'kills', 'killed', 'killing',
]);

/** 把工具名切成小写词素:按下划线/连字符/点/空格分割,并拆 camelCase。 */
export function tokenizeToolName(name: string): string[] {
  const split = String(name || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2') // camelCase → 空格分隔
    .split(/[_\-./\s]+/)
    .filter(Boolean);
  return split.map((t) => t.toLowerCase());
}

/**
 * 名称动词启发式(default-deny)。仅当服务器注解完全沉默时调用。
 * 规则:首词素 ∈ READ_VERBS 且 名称中不含 DESTRUCTIVE_TOKENS → 只读;否则拒绝。
 */
export function heuristicReadOnly(name: string): boolean {
  const tokens = tokenizeToolName(name);
  if (tokens.length === 0) return false;
  if (tokens.some((t) => DESTRUCTIVE_TOKENS.has(t))) return false;
  return READ_VERBS.has(tokens[0]);
}

/** 注解里是否含有实质 hint(任一为 boolean 即算「服务器表过态」)。 */
function hasAnnotationHints(annotations: unknown): boolean {
  const a = annotations as { readOnlyHint?: unknown; destructiveHint?: unknown } | undefined;
  if (!a || typeof a !== 'object') return false;
  return typeof a.readOnlyHint === 'boolean' || typeof a.destructiveHint === 'boolean';
}

/**
 * 对单个 MCP 工具做只读分类。
 * @param tool.name        服务器原始工具名(未加 mcp_<server>_ 前缀)
 * @param tool.annotations 服务器自报注解(可能缺省)
 */
export function classifyToolReadOnly(tool: { name?: string; annotations?: unknown }): ToolClassification {
  // ① 服务器注解权威:有实质 hint 就完全交给注解,启发式不介入
  if (hasAnnotationHints(tool.annotations)) {
    return mcpToolReadOnly(tool.annotations)
      ? { readOnly: true, basis: 'annotation' }
      : { readOnly: false, basis: 'denied' };
  }
  // ② 注解沉默 → 名称动词启发式
  if (heuristicReadOnly(tool.name || '')) {
    return { readOnly: true, basis: 'heuristic' };
  }
  // ③ default-deny
  return { readOnly: false, basis: 'denied' };
}
