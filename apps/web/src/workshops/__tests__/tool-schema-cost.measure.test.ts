import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolveExplicitTools } from '@agtpilot/core';
import { WORKSHOPS, resolveWorkshopActiveTools } from '../registry';
import type { WorkshopId } from '../types';

/**
 * 工坊视图 · 每步 tools 块成本测量(层0「工具卡片化」第一步,
 * docs/design/token-consumption-and-tool-loading.md §9.4)。
 *
 * 两段式测量的第 2 段:第 1 段 `npx tsx scripts/tool-schema-measure.mts` 启动
 * app-kit 全量注册表、把每把工具的 schema 上线成本写到
 * scripts/out/tool-registry-measure.json;本文件在 web vitest 环境里消费该 JSON
 * (工坊 registry 依赖 .md 提示词导入,只有 web 的构建链能解析,故不能进第 1 段),
 * 用与生产同一代码路径(resolveWorkshopActiveTools 四层并集 + 内核
 * resolveExplicitTools)算出每坊白名单挂载面的每步 tokens 与卡片化理论上限。
 *
 * JSON 缺席(未跑第 1 段 / fresh clone,scripts/out 不入库)→ 整组 skip,
 * 不影响常规测试。设 MEASURE=1 打印完整表格,否则只在失败时可见。
 * 口径注意:JSON 只含内置工具——本地无 MCP 连接器,mcp_* 缺席;工坊的 MCP
 * 组(newsnow/deepwiki/github 精确名等)在 mounted 里自然落空,表格是
 * 「内置口径」下限,生产口径需服务器端已连接状态重跑第 1 段。
 */

const JSON_PATH = fileURLToPath(
  new URL('../../../../../scripts/out/tool-registry-measure.json', import.meta.url),
);

interface ToolCostRow {
  name: string;
  baseline: boolean;
  tokens: number;
  cardTokens: number;
}
interface MeasurePayload {
  measuredAt: string;
  tools: ToolCostRow[];
  fullMountTokens: number;
  baselineTokens: number;
}

const payload: MeasurePayload | null = existsSync(JSON_PATH)
  ? (JSON.parse(readFileSync(JSON_PATH, 'utf8')) as MeasurePayload)
  : null;

const describeMaybe = payload ? describe : describe.skip;

describeMaybe('工坊 tools 块成本测量(§9.4 · 需要 scripts/tool-schema-measure.mts 产物)', () => {
  const rows = payload!.tools;
  const byName = new Map(rows.map((r) => [r.name, r]));
  const asRoutable = rows.map((r) => ({ name: r.name, baseline: r.baseline }));
  const sum = (list: ToolCostRow[], key: 'tokens' | 'cardTokens' = 'tokens') =>
    list.reduce((acc, r) => acc + r[key], 0);

  const table: string[] = [
    '',
    `测量时间: ${payload!.measuredAt}`,
    `内置注册表全量挂载(最坏情形)≈ ${payload!.fullMountTokens} tokens/步;baseline 常驻块 ≈ ${payload!.baselineTokens} tokens/步`,
    '',
    '| 工坊 | 挂载(内置口径) | ≈tokens/步 | 全卡片目录≈tokens | 差值(理论上限) | 非常驻前 3 贵 |',
    '|---|---:|---:|---:|---:|---|',
  ];
  const perWorkshop: Array<{ id: string; full: number; catalog: number; nonBaseline: number }> = [];

  for (const def of WORKSHOPS) {
    const names = resolveWorkshopActiveTools(def.id as WorkshopId);
    if (!names) continue;
    const mounted = resolveExplicitTools(names, asRoutable);
    const mrows = mounted.map((n) => byName.get(n)).filter(Boolean) as ToolCostRow[];
    const full = sum(mrows);
    const nonBaseline = mrows
      .filter((r) => !r.baseline)
      .sort((a, b) => b.tokens - a.tokens);
    const catalog =
      sum(mrows.filter((r) => r.baseline)) + sum(nonBaseline, 'cardTokens');
    perWorkshop.push({ id: def.id, full, catalog, nonBaseline: nonBaseline.length });
    table.push(
      `| ${def.id} | ${mrows.length} | ${full} | ${catalog} | ${full - catalog} | ${nonBaseline
        .slice(0, 3)
        .map((r) => `${r.name}(${r.tokens})`)
        .join(', ')} |`,
    );
  }
  table.push(
    '',
    '注:「差值」= 非常驻工具全部卡片化且整任务零 load 的理论上限;实际节省取决于命中分布(§9.4 动态测量)。',
  );

  it('每个工坊:白名单可解析、挂载非空;有非常驻工具时卡片目录严格便宜于全量 schema', () => {
    expect(perWorkshop.length).toBeGreaterThan(0);
    for (const w of perWorkshop) {
      expect(w.full, `${w.id} 每步成本应为正`).toBeGreaterThan(0);
      if (w.nonBaseline > 0) {
        // 非常驻为空(如 email_triage 内置口径只剩 baseline)时目录=常驻,无节省可言
        expect(w.catalog, `${w.id} 卡片目录应严格便宜于全量常驻`).toBeLessThan(w.full);
      } else {
        expect(w.catalog).toBe(w.full);
      }
    }
    if (process.env.MEASURE === '1') console.log(table.join('\n'));
  });

  it('测量表格可生成(MEASURE=1 打印;CI 静默)', () => {
    expect(table.length).toBeGreaterThan(6 + perWorkshop.length);
  });
});
