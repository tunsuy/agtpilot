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

/** 执行效率摘要步骤标题（驾驶舱活动流 step_eff_ 条目）
 *  历史会话的 efficiency 事件没有 emptyCalls/dedupedCalls 字段 —— 数值字段一律
 *  缺省 0,老数据不显示 NaN。 */
export function buildEfficiencyStepTitle(eff: TaskEfficiency): string {
  const empty = Number.isFinite((eff as Partial<TaskEfficiency>).emptyCalls)
    ? (eff as Partial<TaskEfficiency>).emptyCalls!
    : 0;
  const deduped = Number.isFinite((eff as Partial<TaskEfficiency>).dedupedCalls)
    ? (eff as Partial<TaskEfficiency>).dedupedCalls!
    : 0;
  const base =
    `执行效率: ${eff.stepsCount} 步 · 工具调用 ${eff.toolCalls} 次` +
    (deduped > 0 ? ` · 只读复用 ${deduped}` : '') +
    ` · 失败 ${eff.failedCalls} · 空返回 ${empty}` +
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

/** 任务 token 总预算缺省值(多轮共享一个总账;env AGTPILOT_MISSION_TOKEN_BUDGET 可覆盖) */
export const DEFAULT_MISSION_TOKEN_BUDGET = 300_000;

/**
 * 本轮可花的 token 预算 = 任务总账上限 − 已花(含子代理/压缩蒸馏等全部入账消耗)。
 *
 * - cap 显式为 0 → undefined(不设限,总闸关闭语义)
 * - 余额耗尽不回 0(0 在网关语义 = 不设限!)—— 钉住 1,让循环最多再走 1 步
 *   即触顶,由强制总结轮诚实收尾:「预算用完」对用户可见,而不是静默放开
 * - 负余额(理论不可达,防脏数据)同样钉 1
 */
export function computeMissionTokenBudget(
  used: { promptTokens?: number; completionTokens?: number } | undefined,
  cap?: number
): number | undefined {
  if (cap === 0) return undefined;
  const budget = Number.isFinite(cap) && (cap as number) > 0 ? (cap as number) : DEFAULT_MISSION_TOKEN_BUDGET;
  const p = Number.isFinite(used?.promptTokens) ? (used?.promptTokens as number) : 0;
  const c = Number.isFinite(used?.completionTokens) ? (used?.completionTokens as number) : 0;
  return Math.max(1, Math.floor(budget - p - c));
}

/** env 解析:AGTPILOT_MISSION_TOKEN_BUDGET → 数值 cap(非法值回缺省,显式 0 = 关闭) */
export function missionTokenBudgetCapFromEnv(
  env: Record<string, string | undefined> = process.env
): number | undefined {
  const raw = (env.AGTPILOT_MISSION_TOKEN_BUDGET ?? '').trim();
  if (!raw) return undefined; // 未配置 → computeMissionTokenBudget 用缺省值
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return undefined;
  return Math.floor(n);
}
