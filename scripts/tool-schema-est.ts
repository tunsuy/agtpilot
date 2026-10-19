/**
 * 工具 schema 成本估算口径 · 两段式测量的单一事实源
 * (docs/design/token-consumption-and-tool-loading.md §9.4)
 *
 * 消费方:
 * - 第 1 段 scripts/tool-schema-measure.mts(全局注册表 → tool-registry-measure.json)
 * - 第 2 段 apps/web vitest tool-schema-cost.measure.test.ts(工坊白名单挂载面 +
 *   用户级 taskTools 表面:记忆五件套/read_tool_output/ask 桥/cron/连接器桥/
 *   交付字段/TOOL_PROVIDER 固定工具——这些不进全局注册表,只能在这里现场构建测量)
 *
 * 估算口径:CJK(含全角标点)字符 ×1.0 + 其余字符 ÷4,向上取整
 * (DeepSeek 中文≈1字/token、英文≈4字符/token)。改口径只改这里,两段同步。
 */

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
export function wirePayload(t: {
  name: string;
  description?: string;
  parameters?: unknown;
}): string {
  return JSON.stringify({
    name: t.name,
    description: t.description ?? '',
    parameters: t.parameters ?? { type: 'object', properties: {} },
  });
}

/** 目录卡片一行:`- name: 一行用途`(描述首句,钳 50 字符) */
export function cardLine(t: { name: string; description?: string }): string {
  const first = (t.description ?? '').split(/[。\n;]/)[0].slice(0, 50);
  return `- ${t.name}: ${first}`;
}

/** 一把工具的上线成本行(两段共用形状) */
export interface SchemaCostRow {
  name: string;
  baseline: boolean;
  chars: number;
  tokens: number;
  cardTokens: number;
}

/** 工具定义 → 成本行(两段统一的换算入口) */
export function measureTool(t: {
  name: string;
  description?: string;
  parameters?: unknown;
  baseline?: boolean;
}): SchemaCostRow {
  const wire = wirePayload(t);
  return {
    name: t.name,
    baseline: Boolean(t.baseline),
    chars: wire.length,
    tokens: estTokens(wire),
    cardTokens: estTokens(cardLine(t)),
  };
}
