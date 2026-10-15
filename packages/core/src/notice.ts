/**
 * 治理提示注入(纯函数)—— 持久状态治理「回退弧」的感知通道。
 * 设计依据 docs/design/persistent-state-governance.md §3.3:
 * 权限纪元推进 / 记忆被软删等状态回退发生时,in-flight 任务需要在
 * 下一步模型调用前显式感知,否则模型会拿着已失效的授权继续执行。
 *
 * 内核只提供「把一条治理提示追加到消息末尾」的纯机制;提示文本的
 * 产生与排队由上层(Web agent-backend 订阅 governance-bus)负责。
 */

/** 治理提示统一前缀:便于审计检索与前端识别,也让模型明确这不是用户闲聊 */
export const STEP_NOTICE_PREFIX = '【系统治理提示】';

export interface StepNoticeMessage {
  role: 'user';
  content: string;
}

/**
 * 把一条治理提示作为 user 消息追加到消息数组末尾(不改原数组)。
 * - notice 为空/纯空白时返回 null(调用方据此跳过,消息保持原样);
 * - 返回新数组,末尾为 `{ role: 'user', content: 前缀 + notice }`。
 * 刻意用 user 角色而非改写 system:system 在循环中是常量,且治理提示
 * 属于「本步必须看到的一次性事件」,追加在末尾最贴近注意力分布。
 */
export function appendStepNotice(messages: any[], notice?: string | null): any[] | null {
  const text = typeof notice === 'string' ? notice.trim() : '';
  if (!text) return null;
  const injected: StepNoticeMessage = { role: 'user', content: `${STEP_NOTICE_PREFIX}${text}` };
  return [...(messages || []), injected];
}

/**
 * 用户追加消息前缀(docs/design/mid-run-user-messages.md):任务执行中用户
 * 追问经 prepareStep 注入。与治理提示同样刻意区别于工具结果—— Claude Code
 * 生产踩过排队消息紧贴 tool_result 被模型误读为工具输出的坑(#97575),
 * 显式前缀 + user 角色双保险。
 */
export const USER_MESSAGE_PREFIX = '【用户追加消息】';

/**
 * 把任务执行中用户排队的追加消息作为 user 消息追加到末尾(不改原数组)。
 * 与 appendStepNotice 同构:调用方在压缩之后调用,防被蒸馏;经 adjust.messages
 * 进入循环状态后随 result.messages 落进会话历史,续聊不丢上下文。
 */
export function appendUserMessage(messages: any[], text?: string | null): any[] | null {
  const content = typeof text === 'string' ? text.trim() : '';
  if (!content) return null;
  const injected: StepNoticeMessage = { role: 'user', content: `${USER_MESSAGE_PREFIX}${content}` };
  return [...(messages || []), injected];
}

/**
 * 看板同步提醒前缀:模型连续多轮真实工具成功但看板零更新(忘了同批申报
 * 进度)时,内核在下一步注入的催促 —— Claude Code 检测到 todo 落后注入
 * system-reminder 的同款机制。与治理提示同构:user 角色末尾追加,一次性
 * 事件不改写常量 system,压缩之后注入防被蒸馏。
 */
export const BOARD_REMINDER_PREFIX = '【看板同步提醒】';

/**
 * 把一条看板同步提醒作为 user 消息追加到消息数组末尾(不改原数组)。
 * - text 为空/纯空白时返回 null(调用方据此跳过,消息保持原样);
 * - 返回新数组,末尾为 `{ role: 'user', content: 前缀 + text }`。
 */
export function appendBoardReminder(messages: any[], text?: string | null): any[] | null {
  const content = typeof text === 'string' ? text.trim() : '';
  if (!content) return null;
  const injected: StepNoticeMessage = { role: 'user', content: `${BOARD_REMINDER_PREFIX}${content}` };
  return [...(messages || []), injected];
}
