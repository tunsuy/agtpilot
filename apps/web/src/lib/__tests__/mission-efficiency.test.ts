import { describe, it, expect } from 'vitest';
import { formatTokenCount, buildEfficiencyStepTitle, accumulateMissionUsage } from '@/lib/mission-efficiency';
import type { TaskEfficiency } from '@agtpilot/core';

/**
 * 任务效率摘要展示层（loop 执行优化 P3：token 用量可观测）。
 * 内核 TaskEfficiency 已带 promptTokens/completionTokens；这里验证
 * 摘要标题、格式化与任务级累计账的纯函数行为。
 */

const EFF = (over: Partial<TaskEfficiency> = {}): TaskEfficiency => ({
  stepsCount: 6,
  toolCalls: 11,
  failedCalls: 0,
  skippedCalls: 0,
  approvalRejected: 0,
  emptyCalls: 0,
  dedupedCalls: 0,
  effectiveRate: 1,
  toolsMounted: 25,
  toolsTotal: 114,
  routed: true,
  promptTokens: 0,
  completionTokens: 0,
  ...over,
});

describe('formatTokenCount', () => {
  it('0 / 负数 / 非数统一显示 0', () => {
    expect(formatTokenCount(0)).toBe('0');
    expect(formatTokenCount(-5)).toBe('0');
    expect(formatTokenCount(Number.NaN)).toBe('0');
  });
  it('千位以下原样展示；千位以上保留一位小数的 k 值', () => {
    expect(formatTokenCount(780)).toBe('780');
    expect(formatTokenCount(1000)).toBe('1.0k');
    expect(formatTokenCount(12345)).toBe('12.3k');
  });
});

describe('buildEfficiencyStepTitle', () => {
  it('带 token 字段：标题追加输入/输出用量', () => {
    const title = buildEfficiencyStepTitle(EFF({ promptTokens: 5230, completionTokens: 980 }));
    expect(title).toContain('执行效率: 6 步');
    expect(title).toContain('有效率 100%');
    expect(title).toContain('挂载工具 25/114 (按需)');
    expect(title).toContain('tokens 输入 5.2k / 输出 980');
  });

  it('两字段都缺失（历史会话的旧 efficiency 事件）：不追加 token 段', () => {
    const eff: any = EFF();
    delete eff.promptTokens;
    delete eff.completionTokens;
    expect(buildEfficiencyStepTitle(eff)).not.toContain('tokens');
  });

  it('字段存在但为 0（免费档/无计量）：仍追加段，显示 0', () => {
    expect(buildEfficiencyStepTitle(EFF())).toContain('tokens 输入 0 / 输出 0');
  });

  it('只读复用为 0 时不显示该段；空返回与失败/熔断同为常显项（口径并列可读）', () => {
    const title = buildEfficiencyStepTitle(EFF());
    expect(title).not.toContain('只读复用');
    expect(title).toContain('失败 0');
    expect(title).toContain('空返回 0');
  });

  it('空返回/只读复用 > 0 时如实展示（生产实测:空返回曾虚报有效率 100%）', () => {
    const title = buildEfficiencyStepTitle(
      EFF({ toolCalls: 17, emptyCalls: 4, dedupedCalls: 5, failedCalls: 0, skippedCalls: 0, effectiveRate: 0.76 })
    );
    expect(title).toContain('空返回 4');
    expect(title).toContain('只读复用 5');
    expect(title).toContain('有效率 76%');
  });

  it('历史事件缺 emptyCalls/dedupedCalls 字段：按 0 兜底,不出 NaN', () => {
    const eff: any = EFF();
    delete eff.emptyCalls;
    delete eff.dedupedCalls;
    const title = buildEfficiencyStepTitle(eff);
    expect(title).not.toContain('NaN');
    expect(title).toContain('空返回 0');
  });
});

describe('accumulateMissionUsage（agtpilot/usage 事件逐次并入任务总账）', () => {
  it('首轮从 0 起账；续跑逐次累加', () => {
    let usage = accumulateMissionUsage(undefined, { promptTokens: 5000, completionTokens: 900 });
    expect(usage).toEqual({ promptTokens: 5000, completionTokens: 900 });
    usage = accumulateMissionUsage(usage, { promptTokens: 3200, completionTokens: 400 });
    expect(usage).toEqual({ promptTokens: 8200, completionTokens: 1300 });
  });

  it('事件缺字段/非数值按 0 并入，不产生 NaN', () => {
    const usage = accumulateMissionUsage(
      { promptTokens: 100, completionTokens: 20 },
      { promptTokens: undefined, completionTokens: Number.NaN }
    );
    expect(usage).toEqual({ promptTokens: 100, completionTokens: 20 });
  });
});
