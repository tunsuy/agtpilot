/**
 * 工具 schema 上线成本测量 · 第 1 段:注册表(层0「工具卡片化」第一步,
 * docs/design/token-consumption-and-tool-loading.md §9.4)
 *
 * 用法: npx tsx scripts/tool-schema-measure.mts [--json]
 * 产出: stdout 报告 + scripts/out/tool-registry-measure.json(供第 2 段工坊视图
 *       消费:apps/web vitest 的 tool-schema-cost.measure.test.ts——工坊 registry
 *       依赖 .md 提示词导入,只能在 web 的 vitest 环境里解析,故分两段)。
 *
 * 量什么:
 *  1. 全注册表每把工具的 schema 上线成本(name+description+parameters 序列化字符数
 *     与估算 token 数)——tools 块是「每步全额重付」的固定开销,估算口径:
 *     CJK 字符 ×1.0 + 其余字符 ÷4(DeepSeek 中文≈1字/token、英文≈4字符/token)。
 *  2. baseline 常驻块的每步固定成本。
 *  3. 卡片目录单价(名字+一行用途)——卡片化静态模拟的输入。
 *
 * 注意:
 *  - MCP 工具在本地无连接器时不注册(github_mcp 等大户缺席)——生产口径需在
 *    服务器端已连接状态跑本脚本补测(输出会标注 MCP 缺口)。
 *  - EXA/TAVILY/FIRECRAWL 用假 key 置位以对齐生产注册面(requiredEnv 只做存在性
 *    检查;本脚本只读注册表,不执行任何工具、不发任何网络请求)。
 */
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// 生产对齐:有 key 的检索/爬虫工具照常注册(requiredEnv 存在性检查)
process.env.EXA_API_KEY ||= 'measure-fake-key';
process.env.TAVILY_API_KEY ||= 'measure-fake-key';
process.env.FIRECRAWL_API_KEY ||= 'measure-fake-key';
// 数据目录指向临时目录,避免污染仓库 .cache
process.env.USER_DATA_DIR ||= mkdtempSync(join(tmpdir(), 'agtpilot-measure-'));

const { createAgentRuntime } = await import('../packages/app-kit/src/index');

/** CJK(含全角标点)×1 + 其余 ÷4,向上取整 */
export function estTokens(s: string): number {
  let cjk = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (
      (c >= 0x4e00 && c <= 0x9fff) ||
      (c >= 0x3000 && c <= 0x303f) ||
      (c >= 0xff00 && c <= 0xffef)
    ) cjk++;
  }
  return Math.ceil(cjk + (s.length - cjk) / 4);
}

/** 工具上线时 tools 块的载荷(与 AI SDK 发给模型的字段一致) */
function wirePayload(t: { name: string; description?: string; parameters?: unknown }): string {
  return JSON.stringify({
    name: t.name,
    description: t.description ?? '',
    parameters: t.parameters ?? { type: 'object', properties: {} },
  });
}

/** 目录卡片一行:`- name: 一行用途`(描述首句,钳 50 字符) */
function cardLine(t: { name: string; description?: string }): string {
  const first = (t.description ?? '').split(/[。\n;]/)[0].slice(0, 50);
  return `- ${t.name}: ${first}`;
}

const runtime = await createAgentRuntime({ browser: { headless: true } });
const failed = runtime.loaded.filter((l) => !l.ok);
const tools = runtime.agent.getTools();

export interface ToolCostRow {
  name: string;
  baseline: boolean;
  chars: number;
  tokens: number;
  cardTokens: number;
}
const rows: ToolCostRow[] = tools
  .map((t) => {
    const wire = wirePayload(t);
    return {
      name: t.name,
      baseline: Boolean(t.baseline),
      chars: wire.length,
      tokens: estTokens(wire),
      cardTokens: estTokens(cardLine(t)),
    };
  })
  .sort((a, b) => b.tokens - a.tokens);

const sum = (list: ToolCostRow[], key: 'tokens' | 'cardTokens' = 'tokens') =>
  list.reduce((acc, r) => acc + r[key], 0);
const mcpRows = rows.filter((r) => r.name.startsWith('mcp_'));
const baselineRows = rows.filter((r) => r.baseline);

console.log(`# 工具 schema 上线成本测量(${new Date().toISOString().slice(0, 10)})`);
console.log(
  `\n注册表: ${rows.length} 把工具(插件加载失败 ${failed.length} 个` +
    (failed.length ? `: ${failed.map((f) => f.plugin).join(', ')}` : '') +
    `)\n全量挂载(最坏情形)每步 tools 块 ≈ ${sum(rows)} tokens / ${rows.reduce((a, r) => a + r.chars, 0)} 字符`,
);
if (mcpRows.length === 0) {
  console.log(
    '⚠️ 本地无 MCP 连接器,mcp_* 工具缺席——github_mcp 等大户成本需在服务器端已连接状态补测(§9.4 动态测量)。',
  );
}

console.log('\n## 单工具 schema 成本排行(前 20)');
console.log('| 工具 | baseline | 字符 | ≈tokens | 卡片≈tokens |');
console.log('|---|---|---:|---:|---:|');
for (const r of rows.slice(0, 20)) {
  console.log(`| ${r.name} | ${r.baseline ? '✓' : ''} | ${r.chars} | ${r.tokens} | ${r.cardTokens} |`);
}

console.log(
  `\nbaseline 常驻 ${baselineRows.length} 把,每步固定成本 ≈ ${sum(baselineRows)} tokens;` +
    `卡片目录全表均值 ≈ ${Math.round(sum(rows, 'cardTokens') / Math.max(rows.length, 1))} tokens/把`,
);

// JSON 落盘,供第 2 段(apps/web vitest 工坊视图)消费
const outDir = join(ROOT, 'scripts', 'out');
mkdirSync(outDir, { recursive: true });
const payload = {
  measuredAt: new Date().toISOString(),
  pluginFailures: failed.map((f) => ({ plugin: f.plugin, error: f.error })),
  fullMountTokens: sum(rows),
  mcpToolCount: mcpRows.length,
  baselineTokens: sum(baselineRows),
  tools: rows,
};
writeFileSync(join(outDir, 'tool-registry-measure.json'), JSON.stringify(payload, null, 1));
console.log(`\n已写入 scripts/out/tool-registry-measure.json(第 2 段: apps/web vitest tool-schema-cost.measure)`);

if (process.argv.includes('--json')) {
  console.log('\n```json\n' + JSON.stringify(payload, null, 1) + '\n```');
}

try {
  await (runtime.ctx as any).dispose?.();
} catch {}
process.exit(0);
