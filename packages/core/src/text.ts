/**
 * 文本处理工具：消息文本提取、工具输出截断策略。
 */

/** 单个工具结果回填模型上下文的字符上限，超长截断，防止上下文膨胀导致模型退化。 */
export const TOOL_OUTPUT_LIMIT = 16 * 1024;

/**
 * 工具级输出限额(层1 源头裁剪 ②,docs/design/token-consumption-and-tool-loading.md §9.3):
 * ToolDefinition.outputCap 声明时取 min(outputCap, TOOL_OUTPUT_LIMIT),未声明/非法(≤0)
 * → TOOL_OUTPUT_LIMIT。编排器截断点与 plugin-subagent 内部截断共用本函数(单一事实源)。
 * cap 只压「进模型」的一份:spill 落盘仍是全量原文(无损),tool_result 广播不受影响。
 */
export function effectiveOutputLimit(outputCap?: number): number {
  return typeof outputCap === 'number' && Number.isFinite(outputCap) && outputCap > 0
    ? Math.min(Math.floor(outputCap), TOOL_OUTPUT_LIMIT)
    : TOOL_OUTPUT_LIMIT;
}

/** 头尾混合截断时，尾部优先的工具组前缀（命令执行/版本控制输出：错误与结论在尾部） */
const TAIL_FIRST_PREFIXES = ['sandbox_', 'git_'];

/** 取任意消息 content 的可读文本（string 直返，分片数组 JSON 化） */
export function messageText(content: any): string {
  if (typeof content === 'string') return content;
  if (content == null) return '';
  try {
    return JSON.stringify(content);
  } catch {
    return '';
  }
}

/** 判断 assistant 消息是否携带 tool-call 分片（压缩时这类消息要和对应 tool 结果一起处理） */
export function isToolCallMessage(message: any): boolean {
  return (
    Array.isArray(message?.content) &&
    message.content.some((p: any) => p?.type === 'tool-call' || (p && typeof p.toolCallId === 'string'))
  );
}

export function truncateText(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}…(截断)` : text;
}

// ---- 工具输出截断策略（头尾混合）----
// 依据 lost-in-the-middle 研究（Liu et al.）：LLM 注意力呈 U 形，
// 头部和尾部召回率最高、中间是盲区；且报错/结论/最新状态往往在输出尾部
// （日志堆栈、构建失败原因）。纯取头会把这些关键信息丢掉。
// 按工具类型自适应比例：命令/日志类尾优先（尾 70%），结构化/内容类头优先（头 70%）。

/**
 * 头尾混合截断：保留头部与尾部、丢弃中间，并标记省略量。
 * 模型需要中间内容时会看到省略量与续读指引，可用更精确的参数缩小输出范围，
 * 而不是整体重取（重取是步数空转的典型来源）。
 */
export function truncateToolOutput(text: string, toolName: string, limit: number): string {
  const { tailFirst, headLen, tailLen, head, tail } = headTailSplit(text, toolName, limit);
  const omitted = text.length - headLen - tailLen;
  return (
    `${head}\n` +
    `…[输出过长已截断（原始 ${text.length} 字符）：${tailFirst ? '命令/日志类输出，尾优先' : '内容类输出，头优先'}——` +
    `保留头部 ${headLen} 字符 + 尾部 ${tailLen} 字符，中间省略 ${omitted} 字符。` +
    `若工具支持 offset 参数可携带 offset 续读；需要中间内容时请用更精确的参数缩小输出范围，不要整体重取]…\n` +
    `${tail}`
  );
}

// ---- 超长输出 spill-to-file(docs/design/tool-output-spill.md)----

/** spill 后进历史的头尾预览上限：指针版整体 ~4.5KB,压缩保护窗 10 条
 *  最坏占用从 16KB×10=160KB 降到 ~45KB(骑线病理缓解,见方案 §4.3) */
export const SPILL_PREVIEW_LIMIT = 4 * 1024;

/** 工具输出落盘总开关(缺省启用;'0' 关闭 —— 内核不再调注入的落盘回调,
 *  全链路回退现行头尾截断,行为与上线前逐字节一致) */
export function toolSpillEnabled(): boolean {
  return process.env.AGTPILOT_TOOL_SPILL !== '0';
}

/** 头尾混合切分(truncateToolOutput 与 buildSpillPointer 共用同一注意力模型) */
function headTailSplit(text: string, toolName: string, limit: number) {
  const tailFirst = TAIL_FIRST_PREFIXES.some((p) => toolName.startsWith(p));
  const headRatio = tailFirst ? 0.3 : 0.7;
  const headLen = Math.floor(limit * headRatio);
  const tailLen = limit - headLen;
  return {
    tailFirst,
    headLen,
    tailLen,
    head: text.slice(0, headLen),
    tail: text.slice(text.length - tailLen),
  };
}

/**
 * 落盘成功后的指针消息:头尾预览 + 全量保存声明 + 续读指引。
 * 红线(业界共识):不静默截断 —— 必须告知原始大小与如何继续获取,
 * 否则模型基于残缺数据自信作答。截断部分经 read_tool_output(callId, offset)
 * 可恢复(= Manus「丢正文保引用」的可恢复压缩形态)。
 */
export function buildSpillPointer(
  text: string,
  toolName: string,
  callId: string,
  limit: number = SPILL_PREVIEW_LIMIT
): string {
  const { headLen, tailLen, head, tail } = headTailSplit(text, toolName, limit);
  return (
    `${head}\n` +
    `…[原输出共 ${text.length} 字符,过长,全量已保存(引用 ref=${callId})。` +
    `以上仅为头尾预览(头 ${headLen} + 尾 ${tailLen} 字符)。` +
    `需要中间或指定位置内容:调用 read_tool_output(callId="${callId}", offset=起始字符位置) 窗口续读;` +
    `或用更精确参数缩小范围重查,不要整体重取]…\n` +
    `${tail}`
  );
}
