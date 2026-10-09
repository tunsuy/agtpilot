/**
 * 文本处理工具：消息文本提取、工具输出截断策略。
 */

/** 单个工具结果回填模型上下文的字符上限，超长截断，防止上下文膨胀导致模型退化。 */
export const TOOL_OUTPUT_LIMIT = 16 * 1024;

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
  const tailFirst = TAIL_FIRST_PREFIXES.some((p) => toolName.startsWith(p));
  const headRatio = tailFirst ? 0.3 : 0.7;
  const headLen = Math.floor(limit * headRatio);
  const tailLen = limit - headLen;
  const omitted = text.length - headLen - tailLen;
  const head = text.slice(0, headLen);
  const tail = text.slice(text.length - tailLen);
  return (
    `${head}\n` +
    `…[输出过长已截断（原始 ${text.length} 字符）：${tailFirst ? '命令/日志类输出，尾优先' : '内容类输出，头优先'}——` +
    `保留头部 ${headLen} 字符 + 尾部 ${tailLen} 字符，中间省略 ${omitted} 字符。` +
    `若工具支持 offset 参数可携带 offset 续读；需要中间内容时请用更精确的参数缩小输出范围，不要整体重取]…\n` +
    `${tail}`
  );
}
