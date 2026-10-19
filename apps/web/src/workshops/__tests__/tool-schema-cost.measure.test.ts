import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveExplicitTools } from '@agtpilot/core';
import { WORKSHOPS, resolveWorkshopActiveTools } from '../registry';
import type { WorkshopId } from '../types';
import { measureTool, type SchemaCostRow } from '../../../../../scripts/tool-schema-est';

/**
 * 工坊视图 · 每步 tools 块成本测量(层0「工具卡片化」第一步,
 * docs/design/token-consumption-and-tool-loading.md §9.4)。
 *
 * 两段式测量的第 2 段:第 1 段 `pnpm measure:tools`(scripts/tool-schema-measure.mts)
 * 启动 app-kit 全量注册表、把每把工具的 schema 上线成本写到
 * scripts/out/tool-registry-measure.json;本文件在 web vitest 环境里消费该 JSON
 * (工坊 registry 依赖 .md 提示词导入,只有 web 的构建链能解析,故不能进第 1 段),
 * 用与生产同一代码路径(resolveWorkshopActiveTools 四层并集 + 内核
 * resolveExplicitTools)算出每坊白名单挂载面的每步 tokens 与卡片化理论上限。
 *
 * 口径修复(2026-10-19):生产的 taskTools 里还有一整层**用户级工具**从不进
 * 全局注册表——记忆五件套 / read_tool_output / ask_user / confirm_plan /
 * cron 三件 / connector_authorize / mcp_call / workshop_deliver_field /
 * TOOL_PROVIDER 固定工具(ppt/wechat_mp/email/follow_builders/github_scan/
 * xhs/zhihu/参考资料)。第 1 段对它们全部不可见,旧表格因此系统性低估每坊
 * 每步成本约 1.3k+ tokens。本文件现在现场构建这层表面(agent-backend 同款
 * builder + stub 依赖),与注册表 JSON 合并后再算挂载面;估算口径与第 1 段
 * 共享 scripts/tool-schema-est.ts(单一事实源)。
 *
 * 挂载语义(与内核 routing.resolveExplicitTools 一致):
 * - baseline:true 的用户级工具(read_tool_output / ask 对 / connector 对 /
 *   交付字段)穿透一切工坊白名单,每任务常驻;
 * - 记忆/cron 工具**非** baseline:工坊白名单任务不挂(只在自由路由任务出现);
 * - provider 固定工具按白名单 D 层精确名挂载(email_send、xhs_* 等)。
 *
 * JSON 缺席(未跑第 1 段 / fresh clone,scripts/out 不入库)→ 工坊合并表格
 * 整组 skip;用户级表面测量不依赖 JSON,恒跑。设 MEASURE=1 打印完整表格。
 * 剩余口径缺口:MCP 连接器工具(mcp_*)本地/CI 缺席(mcpToolCount=0),
 * 生产口径需在服务器端已连接状态跑 `pnpm measure:all`(§9.4)。
 */

// 用户级 builder 背后的 user-store 惰性解析数据目录;指向临时目录避免污染 .cache
process.env.USER_DATA_DIR ||= mkdtempSync(join(tmpdir(), 'agtpilot-schema-measure-'));

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
  mcpToolCount: number;
}

const payload: MeasurePayload | null = existsSync(JSON_PATH)
  ? (JSON.parse(readFileSync(JSON_PATH, 'utf8')) as MeasurePayload)
  : null;

const describeMaybe = payload ? describe : describe.skip;

// ---- 用户级 taskTools 表面(现场构建,口径见文件头) ----

const MEASURE_UID = 'schema-measure-user';

/** 代表性逐字段交付契约(真实契约字段数 2~6;成本随字段数线性小涨,取 4 居中) */
const MEASURE_CONTRACT = {
  id: 'schema-measure',
  fields: [
    { key: 'title', label: '标题', required: true, hint: '一行标题' },
    { key: 'outline', label: '大纲', required: true, hint: '分节大纲' },
    { key: 'body', label: '正文', required: true, hint: '正文全文 markdown' },
    { key: 'summary', label: '摘要', required: false, hint: '一句话摘要' },
  ],
};

interface UserToolRow extends SchemaCostRow {
  /** 来源模块(memory / tool-output / ask / cron / connector / delivery / provider) */
  source: string;
}

const state: {
  rows: UserToolRow[];
  /** 固定表面模块构建失败(硬失败,测试断言清零) */
  buildFailures: string[];
  /** provider 装载日志(resolveProviderTools 容错语义:单个失败不中断其余) */
  providerLog: string[];
  /** 声明了但产出 0 把工具的 provider id(如本地无托管凭证的 xhs/zhihu)——低估项 */
  providerEmpty: string[];
  ready: boolean;
} = { rows: [], buildFailures: [], providerLog: [], providerEmpty: [], ready: false };

const noopEmit = () => {};

async function buildUserPool(): Promise<typeof state> {
  if (state.ready) return state;

  // 固定表面:六模块与 agent-backend taskTools 装配同源(builder 直调,stub 依赖)
  const fixed: Array<{ source: string; load: () => Promise<any[]> }> = [
    {
      source: 'memory',
      load: async () => (await import('@/lib/memory-service')).buildUserMemoryTools(MEASURE_UID),
    },
    {
      source: 'tool-output',
      load: async () => (await import('@/lib/tool-output-store')).buildToolOutputTools(MEASURE_UID),
    },
    {
      source: 'ask',
      load: async () => {
        const m = await import('@/lib/ask-user-bridge');
        return [m.buildAskUserTool({ emit: noopEmit }), m.buildConfirmPlanTool({ emit: noopEmit })];
      },
    },
    {
      source: 'cron',
      load: async () =>
        (await import('@/lib/cron-service')).buildUserCronTools(MEASURE_UID, {
          register: () => {},
          unregister: () => {},
        }),
    },
    {
      source: 'connector',
      load: async () =>
        (await import('@/lib/connector-bridge')).buildConnectorBridgeTools({
          userId: MEASURE_UID,
          emit: noopEmit,
          getMcpSvc: () => undefined,
        }),
    },
    {
      source: 'delivery',
      load: async () => [
        (await import('@/lib/workshop-delivery')).buildDeliverFieldTool(MEASURE_CONTRACT),
      ],
    },
  ];
  for (const g of fixed) {
    try {
      const tools = await g.load();
      for (const t of tools) state.rows.push({ ...measureTool(t), source: g.source });
    } catch (e: any) {
      state.buildFailures.push(`${g.source}: ${e?.message || e}`);
    }
  }

  // TOOL_PROVIDER 固定工具(ppt/wechat_mp/email_smtp/email_imap/follow_builders/
  // github_scan/xhs/zhihu/reference):resolveProviderTools 自带 per-provider 容错
  try {
    const { resolveProviderTools, TOOL_PROVIDERS } = await import('@/lib/tool-providers');
    const stub = () => {
      throw new Error('measure-stub: 测量只读 schema,不执行工具');
    };
    const tools = await resolveProviderTools(
      { uid: MEASURE_UID, browser: undefined, createArtifact: stub, storeFile: stub },
      (_level, msg) => {
        state.providerLog.push(msg);
      },
    );
    for (const t of tools) state.rows.push({ ...measureTool(t), source: 'provider' });
    // 产出 0 把的 provider(resolveProviderTools 只在 built.length>0 时打日志):
    // 显式记为低估项,不让「本地无凭证」静默变成「表面不存在」
    const logged = new Set(
      state.providerLog
        .map((l) => /^\[REG\] (\S+) 工具挂载/.exec(l)?.[1])
        .filter(Boolean),
    );
    state.providerEmpty = TOOL_PROVIDERS.map((p) => p.id).filter((id) => !logged.has(id));
  } catch (e: any) {
    state.buildFailures.push(`tool-providers: ${e?.message || e}`);
  }

  state.ready = true;
  return state;
}

const sum = (list: { tokens: number; cardTokens: number }[], key: 'tokens' | 'cardTokens' = 'tokens') =>
  list.reduce((acc, r) => acc + r[key], 0);

/** 用户级 baseline 常驻六件(穿透一切白名单;与 routing.ts baseline 语义同源) */
const USER_BASELINE_NAMES = [
  'ask_user',
  'confirm_plan',
  'connector_authorize',
  'mcp_call',
  'read_tool_output',
  'workshop_deliver_field',
].sort();

function userTable(): string[] {
  const rows = [...state.rows].sort((a, b) => b.tokens - a.tokens);
  const baseline = rows.filter((r) => r.baseline);
  const bySource = new Map<string, UserToolRow[]>();
  for (const r of rows) {
    const list = bySource.get(r.source) || [];
    list.push(r);
    bySource.set(r.source, list);
  }
  const table: string[] = [
    '',
    `== 用户级 taskTools 表面(第 1 段注册表不可见;MEASURE_UID=${MEASURE_UID}) ==`,
    `共 ${rows.length} 把,合计 ≈ ${sum(rows)} tokens;其中 baseline 常驻 ${baseline.length} 把 ≈ ${sum(baseline)} tokens/步(每任务必付)`,
    '',
    '| 来源 | 把数 | ≈tokens | 明细(工具:tokens, * = baseline) |',
    '|---|---:|---:|---|',
  ];
  for (const [source, list] of bySource) {
    table.push(
      `| ${source} | ${list.length} | ${sum(list)} | ${list
        .map((r) => `${r.name}${r.baseline ? '*' : ''}:${r.tokens}`)
        .join(', ')} |`,
    );
  }
  if (state.buildFailures.length) {
    table.push('', `⚠️ 构建失败(表面被低估):${state.buildFailures.join(' | ')}`);
  }
  if (state.providerEmpty.length) {
    table.push(
      `⚠️ 产出 0 把工具的 provider(本地缺凭证/环境,表面被低估):${state.providerEmpty.join(', ')}`,
    );
  }
  table.push('', 'provider 装载日志:', ...state.providerLog.map((l) => `  ${l}`));
  return table;
}

describe('用户级 taskTools 表面测量(§9.4 口径修复:注册表外的每步暗账)', () => {
  beforeAll(async () => {
    await buildUserPool();
    if (process.env.MEASURE === '1') console.log(userTable().join('\n'));
  });

  it('固定表面六模块全部构建成功(memory/tool-output/ask/cron/connector/delivery)', () => {
    expect(state.buildFailures, `用户级表面构建失败: ${state.buildFailures.join(' | ')}`).toEqual([]);
    for (const src of ['memory', 'tool-output', 'ask', 'cron', 'connector', 'delivery']) {
      expect(state.rows.some((r) => r.source === src), `${src} 模块应产出工具`).toBe(true);
    }
  });

  it('baseline 常驻块恰为六件:ask 对 / connector 对 / read_tool_output / 交付字段', () => {
    const base = state.rows.filter((r) => r.baseline).map((r) => r.name).sort();
    expect(base).toEqual(USER_BASELINE_NAMES);
  });

  it('记忆/cron 工具非 baseline(工坊白名单任务不挂,只在自由路由出现——挂载语义钉死)', () => {
    for (const src of ['memory', 'cron']) {
      const rows = state.rows.filter((r) => r.source === src);
      expect(rows.length, src).toBeGreaterThan(0);
      expect(rows.every((r) => !r.baseline), `${src} 不应有 baseline 工具`).toBe(true);
    }
  });

  it('用户级常驻块成本为正且量级可见(曾被整体遗漏的 ~1k+ tokens/步暗账)', () => {
    const baseTokens = sum(state.rows.filter((r) => r.baseline));
    expect(baseTokens).toBeGreaterThan(500);
    // 自由路由任务的用户级全表面(记忆+cron+provider 全挂)应显著大于常驻块
    expect(sum(state.rows)).toBeGreaterThan(baseTokens);
  });
});

describeMaybe('工坊 tools 块成本测量(§9.4 · 需要 scripts/tool-schema-measure.mts 产物)', () => {
  let byName = new Map<string, ToolCostRow>();
  let perWorkshop: Array<{ id: string; full: number; catalog: number; nonBaseline: number; userMounted: number }> = [];
  let table: string[] = [];

  beforeAll(async () => {
    await buildUserPool();
    const rows = payload!.tools;
    byName = new Map(rows.map((r) => [r.name, r]));
    // 合并口径:注册表(第 1 段 JSON)+ 用户级表面(现场构建);同名时 taskTools
    // 覆盖全局(orchestrator mergedTools 语义),用户级行胜出
    for (const r of state.rows) byName.set(r.name, r);
    const asRoutable = [...byName.values()].map((r) => ({ name: r.name, baseline: r.baseline }));
    const userBaselineTokens = sum(state.rows.filter((r) => r.baseline));

    table = [
      '',
      `测量时间: ${payload!.measuredAt}(注册表 ${rows.length} 把,mcpToolCount=${payload!.mcpToolCount}) + 用户级表面 ${state.rows.length} 把`,
      `内置注册表全量挂载(最坏情形)≈ ${payload!.fullMountTokens} tokens/步;内置 baseline ≈ ${payload!.baselineTokens};用户级 baseline 常驻块 ≈ ${userBaselineTokens} tokens/步(已计入下表每行)`,
      `自由路由任务最坏情形 ≈ ${payload!.fullMountTokens + sum(state.rows)} tokens/步(注册表全量 + 用户级全表面)`,
      '',
      '| 工坊 | 挂载(内置+用户级) | ≈tokens/步 | 全卡片目录≈tokens | 差值(理论上限) | 非常驻前 3 贵 |',
      '|---|---:|---:|---:|---:|---|',
    ];
    perWorkshop = [];

    for (const def of WORKSHOPS) {
      const names = resolveWorkshopActiveTools(def.id as WorkshopId);
      if (!names) continue;
      const mounted = resolveExplicitTools(names, asRoutable);
      const mrows = mounted.map((n) => byName.get(n)).filter(Boolean) as ToolCostRow[];
      const full = sum(mrows);
      const userMounted = mrows.filter((r) => state.rows.some((u) => u.name === r.name)).length;
      const nonBaseline = mrows
        .filter((r) => !r.baseline)
        .sort((a, b) => b.tokens - a.tokens);
      const catalog =
        sum(mrows.filter((r) => r.baseline)) + sum(nonBaseline, 'cardTokens');
      perWorkshop.push({ id: def.id, full, catalog, nonBaseline: nonBaseline.length, userMounted });
      table.push(
        `| ${def.id} | ${mrows.length} | ${full} | ${catalog} | ${full - catalog} | ${nonBaseline
          .slice(0, 3)
          .map((r) => `${r.name}(${r.tokens})`)
          .join(', ')} |`,
      );
    }
    table.push(
      '',
      '注 1:「差值」= 非常驻工具全部卡片化且整任务零 load 的理论上限;实际节省取决于命中分布(§9.4 动态测量)。',
      '注 2:口径 = 内置注册表 + 用户级 taskTools;MCP 连接器工具(mcp_*)本地/CI 缺席,表格仍是下限——生产口径在服务器端已连接状态跑 `pnpm measure:all`。',
      state.buildFailures.length || state.providerEmpty.length
        ? `注 3:⚠️ 表面被低估——构建失败:${state.buildFailures.join(' | ') || '无'};provider 产出 0 把:${state.providerEmpty.join(', ') || '无'}(服务器端跑 pnpm measure:all 取生产口径)`
        : '注 3:用户级表面全部构建成功。',
    );
  });

  it('每个工坊:白名单可解析、挂载非空;有非常驻工具时卡片目录严格便宜于全量 schema', () => {
    expect(perWorkshop.length).toBeGreaterThan(0);
    for (const w of perWorkshop) {
      expect(w.full, `${w.id} 每步成本应为正`).toBeGreaterThan(0);
      if (w.nonBaseline > 0) {
        expect(w.catalog, `${w.id} 卡片目录应严格便宜于全量常驻`).toBeLessThan(w.full);
      } else {
        expect(w.catalog).toBe(w.full);
      }
    }
    if (process.env.MEASURE === '1') console.log(table.join('\n'));
  });

  it('每坊挂载面都含用户级 baseline 常驻六件(穿透白名单的暗账已入表)', () => {
    const names6 = new Set(USER_BASELINE_NAMES);
    for (const def of WORKSHOPS) {
      const whitelist = resolveWorkshopActiveTools(def.id as WorkshopId);
      if (!whitelist) continue;
      const asRoutable = [...byName.values()].map((r) => ({ name: r.name, baseline: r.baseline }));
      const mounted = new Set(resolveExplicitTools(whitelist, asRoutable));
      for (const n of names6) {
        if (byName.has(n)) expect(mounted.has(n), `${def.id} 应常驻 ${n}`).toBe(true);
      }
    }
  });

  it('provider 固定工具按 D 层精确名进对应工坊白名单(合并口径与生产挂载一致)', () => {
    const exact = new Set(state.rows.filter((r) => r.source === 'provider').map((r) => r.name));
    let checked = 0;
    for (const def of WORKSHOPS) {
      const whitelist = resolveWorkshopActiveTools(def.id as WorkshopId);
      if (!whitelist) continue;
      const asRoutable = [...byName.values()].map((r) => ({ name: r.name, baseline: r.baseline }));
      const mounted = new Set(resolveExplicitTools(whitelist, asRoutable));
      for (const name of whitelist) {
        if (!exact.has(name)) continue; // 只查 provider 工具被白名单点名的组合
        expect(mounted.has(name), `${def.id} 白名单点名 ${name} 应挂载`).toBe(true);
        checked++;
      }
    }
    expect(checked, '至少应有白名单点名的 provider 工具被核对(email/xhs/ppt 等)').toBeGreaterThan(0);
  });

  it('测量表格可生成(MEASURE=1 打印;CI 静默)', () => {
    expect(table.length).toBeGreaterThan(8 + perWorkshop.length);
  });
});
