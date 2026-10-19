import { describe, it, expect, afterEach } from 'vitest';
import {
  historyTokenBudget,
  effectiveCompactThreshold,
  estimateToolsBlockTokens,
  MIN_HISTORY_BUDGET,
} from './context-budget';

const ENV_KEYS = [
  'AGTPILOT_CONTEXT_WINDOW',
  'AGTPILOT_COMPACT_OUTPUT_RESERVE',
  'AGTPILOT_COMPACT_SAFETY_PCT',
  'AGTPILOT_COMPACT_THRESHOLD',
];
const savedEnv = ENV_KEYS.map((k) => [k, process.env[k]] as const);
afterEach(() => {
  for (const [k, v] of savedEnv) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  for (const k of ENV_KEYS) delete process.env[k];
});

describe('historyTokenBudget(§9.8 动态预算)', () => {
  it('预算 = 窗口×安全系数 − system − tools − 输出预留', () => {
    const budget = historyTokenBudget({
      systemTokens: 3000,
      toolsTokens: 5000,
      contextWindow: 64_000,
      outputReserve: 8000,
      safetyRatio: 0.8,
    });
    expect(budget).toBe(Math.floor(64_000 * 0.8) - 3000 - 5000 - 8000);
  });

  it('实测校准值替代 system+tools 估算(校准优先)', () => {
    const estimated = historyTokenBudget({
      systemTokens: 3000,
      toolsTokens: 5000,
      contextWindow: 64_000,
      outputReserve: 8000,
      safetyRatio: 0.8,
    });
    const calibrated = historyTokenBudget({
      systemTokens: 3000,
      toolsTokens: 5000,
      calibratedFixedCost: 12_000, // 实测固定开销比估算(8000)大
      contextWindow: 64_000,
      outputReserve: 8000,
      safetyRatio: 0.8,
    });
    expect(calibrated).toBe(estimated - 4000);
  });

  it('env 默认口径:窗口 64k、预留 8k、安全系数 0.8(与 routing 层0 共用 AGTPILOT_CONTEXT_WINDOW)', () => {
    for (const k of ENV_KEYS) delete process.env[k];
    expect(
      historyTokenBudget({ systemTokens: 0, toolsTokens: 0 })
    ).toBe(Math.floor(64_000 * 0.8) - 8000);
    process.env.AGTPILOT_CONTEXT_WINDOW = '32000';
    process.env.AGTPILOT_COMPACT_OUTPUT_RESERVE = '4000';
    process.env.AGTPILOT_COMPACT_SAFETY_PCT = '90';
    expect(
      historyTokenBudget({ systemTokens: 1000, toolsTokens: 1000 })
    ).toBe(Math.floor(32_000 * 0.9) - 1000 - 1000 - 4000);
  });
});

describe('effectiveCompactThreshold(动态压缩阈值)', () => {
  it('默认口径下动态值宽于静态 30k → 取静态值,现状不变', () => {
    const threshold = effectiveCompactThreshold({
      systemTokens: 2705,
      toolsTokens: 5000,
      contextWindow: 64_000,
      outputReserve: 8000,
      safetyRatio: 0.8,
      staticThreshold: 30_000,
    });
    // 64k×0.8 − 2705 − 5000 − 8000 = 35495 > 30000 → min 取 30000
    expect(threshold).toBe(30_000);
  });

  it('小窗模型下动态值收紧 → 取动态值,兜住 context_length_exceeded', () => {
    const threshold = effectiveCompactThreshold({
      systemTokens: 3000,
      toolsTokens: 6000,
      contextWindow: 32_000,
      outputReserve: 8000,
      safetyRatio: 0.8,
      staticThreshold: 30_000,
    });
    // 32k×0.8 − 3000 − 6000 − 8000 = 8600
    expect(threshold).toBe(8600);
    expect(threshold).toBeLessThan(30_000);
  });

  it('预算为负/极小时钳在下限,不会退化成每步反复蒸馏', () => {
    const threshold = effectiveCompactThreshold({
      systemTokens: 60_000,
      toolsTokens: 10_000,
      contextWindow: 64_000,
      outputReserve: 8000,
      safetyRatio: 0.8,
      staticThreshold: 30_000,
    });
    expect(threshold).toBe(MIN_HISTORY_BUDGET);
  });
});

describe('estimateToolsBlockTokens(tools 块估算)', () => {
  it('与 schema 上线载荷同口径:name+description+parameters 序列化后估算', () => {
    const tools = [
      { name: 'search_web', description: '搜索网页', parameters: { type: 'object', properties: {} } },
    ];
    const tokens = estimateToolsBlockTokens(tools);
    expect(tokens).toBeGreaterThan(0);
    // 中文描述按 CJK×1 计:「搜索网页」4 tokens 起步 + JSON 壳
    expect(tokens).toBeGreaterThanOrEqual(4);
  });

  it('description/parameters 缺席时按空串与空 object schema 兜底(不抛错)', () => {
    expect(estimateToolsBlockTokens([{ name: 'bare_tool' }])).toBeGreaterThan(0);
    expect(estimateToolsBlockTokens([])).toBe(0);
  });

  it('更多工具 → 更大 tools 块(单调性,预算扣减方向正确)', () => {
    const one = [{ name: 'a', description: 'x'.repeat(400) }];
    const many = [...one, { name: 'b', description: 'x'.repeat(400) }];
    expect(estimateToolsBlockTokens(many)).toBeGreaterThan(estimateToolsBlockTokens(one));
  });
});
