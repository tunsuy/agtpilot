import { estimateTextTokens } from './routing';
import { COMPACT_THRESHOLD_TOKENS } from './compaction';

/**
 * 上下文预算(§9.8 动态压缩阈值,docs/design/token-consumption-and-tool-loading.md)。
 *
 * 为什么不能只靠静态 30k 阈值:压缩的真正约束是「模型上下文窗口」——
 *   每步请求 = system + tools 块 + 历史消息 + 本轮输出预留 ≤ 窗口。
 * 静态阈值对 64k 窗口的默认模型偏保守,对 32k 小窗模型又根本兜不住
 * (30k 历史 + system/tools ≈ 3-8k + 输出 → 直接 400 context_length_exceeded,
 * 且 AI SDK 只重试 429/5xx,400 就是任务诚实失败)。
 *
 * 口径:
 *   历史预算 = 窗口 × 安全系数 − 固定开销 − 输出预留
 *   压缩阈值 = min(静态阈值, max(下限, 历史预算))
 * 固定开销优先用「实测校准」:上一步真实 promptTokens − 上一步消息估算
 * (= system + tools + provider 协议衬垫的真实值),没有实测时才用估算值。
 *
 * 纯函数(env 只在默认值读取处出现),vitest 覆盖见 context-budget.test.ts。
 */

/** 历史预算下限:再小压缩也救不回来(纪要本身+近期窗口就要几千 tokens),
 *  低于它说明窗口/固定开销配置本身不成立,不再收紧阈值造成每步反复蒸馏 */
export const MIN_HISTORY_BUDGET = 4000;

/** 模型上下文窗口(tokens)。与 routing.ts 层0 目录阈值共用同一 env 口径。 */
export function contextWindowTokens(): number {
  return Math.max(1024, Number(process.env.AGTPILOT_CONTEXT_WINDOW) || 64_000);
}

/** 单轮输出预留(tokens):动态阈值给模型回复留的空间,默认 8000 */
export function outputReserveTokens(): number {
  return Math.max(0, Number(process.env.AGTPILOT_COMPACT_OUTPUT_RESERVE) || 8_000);
}

/** 安全系数(0-1):估算口径与 provider 计费有漂移,预算先打个折,默认 0.8 */
export function budgetSafetyRatio(): number {
  const pct = Number(process.env.AGTPILOT_COMPACT_SAFETY_PCT) || 80;
  return Math.min(100, Math.max(10, pct)) / 100;
}

export interface ContextBudgetInputs {
  /** system 提示词估算 tokens(每轮常数) */
  systemTokens: number;
  /** 本步将上线的 tools 块估算 tokens(禁用工具的收尾轮为 0) */
  toolsTokens: number;
  /**
   * 实测校准:上一步真实 promptTokens − 上一步消息估算 tokens。
   * 提供时替代 systemTokens+toolsTokens 估算(它已含两者及协议衬垫)。
   */
  calibratedFixedCost?: number;
  contextWindow?: number;
  outputReserve?: number;
  safetyRatio?: number;
  /** 静态阈值,默认 COMPACT_THRESHOLD_TOKENS(env AGTPILOT_COMPACT_THRESHOLD) */
  staticThreshold?: number;
}

/** 工具上线时 tools 块载荷的估算 tokens(与 scripts/tool-schema-est.ts 同口径:
 *  JSON 序列化 name/description/parameters 后按 CJK×1 + 其余÷4 估) */
export function estimateToolsBlockTokens(
  tools: Array<{ name: string; description?: string; parameters?: unknown }>
): number {
  let total = 0;
  for (const t of tools) {
    total += estimateTextTokens(
      JSON.stringify({
        name: t.name,
        description: t.description ?? '',
        parameters: t.parameters ?? { type: 'object', properties: {} },
      })
    );
  }
  return total;
}

/** 历史消息可用预算(tokens)。可以为负(窗口配不下固定开销)——调用方按下限钳制。 */
export function historyTokenBudget(inputs: ContextBudgetInputs): number {
  const window = inputs.contextWindow ?? contextWindowTokens();
  const reserve = inputs.outputReserve ?? outputReserveTokens();
  const safety = inputs.safetyRatio ?? budgetSafetyRatio();
  const fixed =
    inputs.calibratedFixedCost ?? inputs.systemTokens + inputs.toolsTokens;
  return Math.floor(window * safety) - fixed - reserve;
}

/**
 * 本步生效的压缩阈值(历史消息估算 tokens 超过它才触发压缩)。
 * 取「静态阈值」与「动态历史预算」的较小者:默认 64k 窗口下动态值(≈3.8万)
 * 比静态 30k 宽松,不改变现状;小窗模型/重挂载面下动态值收紧,兜住溢出。
 */
export function effectiveCompactThreshold(inputs: ContextBudgetInputs): number {
  const stat = inputs.staticThreshold ?? COMPACT_THRESHOLD_TOKENS;
  const dynamic = historyTokenBudget(inputs);
  return Math.min(stat, Math.max(MIN_HISTORY_BUDGET, dynamic));
}
