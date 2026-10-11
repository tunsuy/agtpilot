import type { TaskEfficiency } from '@agtpilot/core';

/**
 * 任务效率摘要的展示层纯函数（loop 执行优化 P3：token 用量可观测）。
 *
 * 内核 buildEfficiency 已带上 promptTokens/completionTokens（单次运行值，
 * 含步数耗尽后的强制总结轮）；任务级累计账在 mission.usage，由
 * agent-backend 接 agtpilot/usage 事件经 accumulateMissionUsage 累加。
 */

/** token 数展示格式：<1k 原样，≥1k 保留一位小数的 k 值 */
export function formatTokenCount(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0';
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`;
}

/** 是否携带 token 字段：历史会话的 efficiency 事件没有这两个字段，标题不追加 */
function hasUsage(eff: Partial<TaskEfficiency>): boolean {
  return Number.isFinite(eff.promptTokens) || Number.isFinite(eff.completionTokens);
}

/** 执行效率摘要步骤标题（驾驶舱活动流 step_eff_ 条目） */
export function buildEfficiencyStepTitle(eff: TaskEfficiency): string {
  const base =
    `执行效率: ${eff.stepsCount} 步 · 工具调用 ${eff.toolCalls} 次 · 失败 ${eff.failedCalls}` +
    ` · 熔断跳过 ${eff.skippedCalls} · 有效率 ${Math.round((eff.effectiveRate ?? 1) * 100)}%` +
    ` · 挂载工具 ${eff.toolsMounted}/${eff.toolsTotal}${eff.routed ? ' (按需)' : ''}`;
  if (!hasUsage(eff)) return base;
  return `${base} · tokens 输入 ${formatTokenCount(eff.promptTokens)} / 输出 ${formatTokenCount(eff.completionTokens)}`;
}

/** 任务级用量累计：agtpilot/usage 事件逐次并入（多轮追问续跑时是总账） */
export function accumulateMissionUsage(
  prev: { promptTokens: number; completionTokens: number } | undefined,
  delta: { promptTokens?: number; completionTokens?: number } | undefined
): { promptTokens: number; completionTokens: number } {
  const base = prev || { promptTokens: 0, completionTokens: 0 };
  return {
    promptTokens: base.promptTokens + (Number.isFinite(delta?.promptTokens) ? (delta?.promptTokens as number) : 0),
    completionTokens:
      base.completionTokens + (Number.isFinite(delta?.completionTokens) ? (delta?.completionTokens as number) : 0),
  };
}
