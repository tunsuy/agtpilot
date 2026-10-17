/**
 * reasoning 部件剥离(docs/design/token-consumption-and-tool-loading.md 放大器 4)。
 *
 * 问题:@ai-sdk/deepseek(dist:314-355)与 @ai-sdk/openai-compatible(dist:94-124)
 * 会把历史 assistant 消息里的 reasoning 部件重新序列化为 reasoning_content 回传
 * 后续每次请求 —— 单轮思考(生产实测 10.8 万字)在任务循环内每步重发(20 步 ≈ ×19),
 * 落盘进 mission.conversationMessages 后还跨轮重发,全仓此前无任何剥离代码;
 * messageText 对数组 content 做 JSON.stringify,reasoning 还会混进压缩蒸馏输入
 * 与 prepareStep 路由取样二次付费。
 *
 * 安全性:
 * - DeepSeek 官方口径 reasoning_content 多轮无需回传;当前 thinking.ts 三个分支
 *   (openai / deepseek / openai-compatible)均不依赖历史 reasoning;
 * - UI「思考过程」展示走 assistant_delta 事件流(kind:'reasoning')实时累积进
 *   mission steps,不读消息历史 —— 剥离后前端照常显示思考;
 * - 只删 assistant 消息数组 content 里的 type:'reasoning' 部件,text/tool-call
 *   部件原样保留,不破坏 tool-call 与 tool 结果的配对;字符串 content 不动。
 *
 * 边界注记:未来若接 Anthropic(thinking + tool_use 要求保留 thinking 块以保证
 * 工具调用连续性)或 OpenAI o 系列(加密 reasoning items),必须在 provider 分支
 * 门控剥离范围 —— 届时按 thinking.ts 的分支形态改造,不要全局放开。
 *
 * 灰度保险丝:AGTPILOT_STRIP_REASONING=0 整体回退原行为(reasoning 照旧回传)。
 */

/** 消息形状(与 orchestrator/SDK 消息类型的宽松约束:只依赖 role 与 content) */
export interface ReasoningMessageLike {
  role: string;
  content: any;
}

export interface StripReasoningResult<M> {
  /** 剥离后的消息数组;无可剥内容时返回原数组引用(调用方以引用相等判断是否写回) */
  messages: M[];
  /** 本次剥离掉的 reasoning 部件数(效率统计与生产验证用) */
  stripped: number;
}

/** reasoning 剥离总开关(缺省启用;'0' 关闭 —— 出问题时 env 一键回退) */
export function reasoningStripEnabled(): boolean {
  return process.env.AGTPILOT_STRIP_REASONING !== '0';
}

/**
 * 剥离消息数组中所有 assistant 消息的 type:'reasoning' 部件。
 * 纯函数:不改原对象(被改写的消息为浅拷贝,其余消息共享引用);
 * 幂等:对已剥离的消息再跑一次返回原引用且 stripped=0 —— 循环内每步
 * 调用只对「最新一条 assistant 消息」产生一次尾部改写,已剥离的历史
 * 前缀跨步字节稳定,provider 前缀缓存只在尾部破一次(append-only 教义)。
 * 剥空后无部件的 assistant 消息 content 置 ''(保留消息本身,不扰动配对与序号)。
 */
export function stripReasoningParts<M extends ReasoningMessageLike>(
  messages: M[]
): StripReasoningResult<M> {
  if (!Array.isArray(messages) || messages.length === 0) {
    return { messages, stripped: 0 };
  }
  let stripped = 0;
  let out: M[] | null = null;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    const parts =
      m && m.role === 'assistant' && Array.isArray(m.content) ? m.content : null;
    const hit = parts !== null && parts.some((p: any) => p?.type === 'reasoning');
    if (hit) {
      const kept = parts!.filter((p: any) => p?.type !== 'reasoning');
      stripped += parts!.length - kept.length;
      if (out === null) out = messages.slice(0, i);
      out.push({ ...m, content: kept.length > 0 ? kept : '' } as M);
    } else if (out !== null) {
      out.push(m);
    }
  }
  return out === null ? { messages, stripped: 0 } : { messages: out, stripped };
}
