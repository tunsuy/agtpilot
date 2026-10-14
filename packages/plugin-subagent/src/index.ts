/**
 * plugin-subagent:只读检索子 agent(spec: docs/design/subagent-plugin-spec.md)。
 *
 * 给主 agent 挂一个 research_subagent 工具:主模型按需派发「广域调研/多路检索汇总」
 * 类子任务,插件在独立消息数组里跑一条完整子循环,边界上只回传一条 final report,
 * 原始检索噪音永不进入主上下文。
 *
 * 安全红线(spec §6):只读双层白名单、禁递归(深度 1)、三重预算闸、
 * 不动全局状态(router 档位 / ModelService 预算槽)、AGTPILOT_SUBAGENT=0 总闸。
 */
import { Context, Service } from '@deepseek-ai/cordis';
import '@agtpilot/core';
import type { ToolDefinition, ToolSession } from '@agtpilot/core';
import {
  SubagentEngine,
  type SubagentEventPayload,
  type SubagentModel,
  type SubagentResult,
  type SubagentRunArgs,
  type SubagentTranscript,
} from './runner';
import { DEFAULT_READONLY_WHITELIST, SELF_TOOL_NAME } from './whitelist';

// ---- 环境变量(模块顶层读取 + 钳制,样板 plugin-decision)----

function readInt(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

/** 逗号分隔 env → 去空白去空项的字符串数组(缺省/全空 → []) */
function splitList(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

const MASTER_ENABLED = process.env.AGTPILOT_SUBAGENT !== '0';
const MAX_STEPS = readInt('AGTPILOT_SUBAGENT_MAX_STEPS', 8, 2, 20);
const MAX_TOKENS = readInt('AGTPILOT_SUBAGENT_MAX_TOKENS', 60000, 0, Number.MAX_SAFE_INTEGER);
const TIMEOUT_MS = readInt('AGTPILOT_SUBAGENT_TIMEOUT_MS', 180000, 30000, 24 * 3600 * 1000);
const MAX_CONCURRENT = readInt('AGTPILOT_SUBAGENT_MAX_CONCURRENT', 4, 1, 8);
const REPORT_LIMIT = readInt('AGTPILOT_SUBAGENT_REPORT_LIMIT', 8000, 500, 64000);
// 档位默认对齐 router fast 档;AGTPILOT_SUBAGENT_PROVIDER/_MODEL 可单独覆盖(spec §4.2)
const PROVIDER =
  process.env.AGTPILOT_SUBAGENT_PROVIDER || process.env.AGTPILOT_FAST_PROVIDER || 'deepseek';
const MODEL = process.env.AGTPILOT_SUBAGENT_MODEL || process.env.AGTPILOT_FAST_MODEL || 'deepseek-chat';
const WHITELIST_OVERRIDE = splitList(process.env.AGTPILOT_SUBAGENT_WHITELIST);

// ---- MCP 双钥匙(2026-10-14 提前落地,原 M3 项;负责人要求默认开放工坊检索连接器)----
// 机器钥匙 = plugin-mcp 按服务器 annotations 注册的 readOnly 声明;
// 人工钥匙 = 下面的服务器白名单。两者同时满足才放行。
// 默认名单 = 工坊调研链涉及的检索类连接器;行情类(tushare/alphavantage/coingecko/a_stock)
// 依红线默认不开(数字必须主循环直拉)。env 设置即整体覆盖;设 off/none = 全关。
export const DEFAULT_MCP_SERVERS: readonly string[] = [
  'github_mcp',
  'huggingface',
  'openalex',
  'alphaxiv',
  'deepwiki',
];
// 逃生口默认项(不要求 readOnly 声明,人工担责)——以 2026-10-14 annotations-report.mjs
// 实测记录为背书:deepwiki 全部 3 个工具(ask/read 类)、newsnow 全部 1 个工具(拉热榜)均为只读,
// 但两台服务器都不带 annotations,双钥匙机器钥匙缺席,只能走前缀放行。
export const DEFAULT_MCP_ALLOW_TOOLS: readonly string[] = ['mcp_deepwiki_', 'mcp_newsnow_'];

/** env 列表解析:未设置 → 内置默认;off/none → 空(全关);其余 → 逗号分隔覆盖 */
function listWithDefault(raw: string | undefined, defaults: readonly string[]): string[] {
  const v = (raw ?? '').trim();
  if (v === '') return [...defaults];
  if (/^(off|none)$/i.test(v)) return [];
  return splitList(raw);
}

const MCP_SERVERS = listWithDefault(process.env.AGTPILOT_SUBAGENT_MCP_SERVERS, DEFAULT_MCP_SERVERS);
const MCP_ALLOW_TOOLS = listWithDefault(
  process.env.AGTPILOT_SUBAGENT_MCP_ALLOW_TOOLS,
  DEFAULT_MCP_ALLOW_TOOLS,
);

// ---- 插件配置(app-kit 装配时传入)----

export interface SubagentPluginConfig {
  /** 缺省 () => ctx.model(ModelGateway 结构兼容窄接口) */
  getModel?: () => SubagentModel | undefined;
  /** 缺省 () => ctx.agent.getTools() */
  listTools?: () => ToolDefinition[];
  /** 白名单覆盖(仍受注册表 readOnly 硬校验);缺省 env → 内置名单 */
  whitelist?: string[];
  /** MCP 服务器白名单(双钥匙的人工钥匙);缺省 env AGTPILOT_SUBAGENT_MCP_SERVERS → 内置检索连接器名单 */
  mcpServers?: string[];
  /**
   * 逐用户解析 MCP 服务器白名单(宿主注入)。web 宿主按「用户已连接 ∩ 连接器目录
   * subagentOpen 标记」动态计算(mcp-connectors.ts buildUserSubagentMcpServers);
   * env AGTPILOT_SUBAGENT_MCP_SERVERS 显式设置时宿主不注入,env 语义优先。
   */
  resolveMcpServers?: (userId: string | undefined) => readonly string[] | undefined;
  /** MCP 工具名前缀逃生口;缺省 env AGTPILOT_SUBAGENT_MCP_ALLOW_TOOLS → 内置名单(deepwiki/newsnow,实测背书) */
  mcpAllowTools?: string[];
  maxSteps?: number;
  maxTokens?: number;
  timeoutMs?: number;
  maxConcurrent?: number;
  reportLimit?: number;
  /** M2:宿主注入 transcript 落盘(web 侧 JSONL);缺失静默不落盘 */
  appendTranscript?: (entry: SubagentTranscript) => void;
}

class SubagentService extends Service {
  readonly engine: SubagentEngine;

  constructor(ctx: Context, config: SubagentPluginConfig = {}) {
    super(ctx, 'subagents');
    const whitelist = config.whitelist ?? (WHITELIST_OVERRIDE.length > 0 ? WHITELIST_OVERRIDE : undefined);
    this.engine = new SubagentEngine(
      {
        getModel: config.getModel ?? (() => this.ctx.model),
        listTools: config.listTools ?? (() => this.ctx.agent.getTools()),
        emit: (payload) => this.ctx.emit('agtpilot/subagent', payload),
      },
      {
        maxSteps: config.maxSteps ?? MAX_STEPS,
        maxTokens: config.maxTokens ?? MAX_TOKENS,
        timeoutMs: config.timeoutMs ?? TIMEOUT_MS,
        maxConcurrent: config.maxConcurrent ?? MAX_CONCURRENT,
        reportLimit: config.reportLimit ?? REPORT_LIMIT,
        whitelist,
        mcpServers: config.mcpServers ?? MCP_SERVERS,
        resolveMcpServers: config.resolveMcpServers,
        mcpAllowTools: config.mcpAllowTools ?? MCP_ALLOW_TOOLS,
        // per-call 覆盖,不写 router 全局档位(spec §4.2)
        configOverride: { activeModelId: PROVIDER, modelName: MODEL },
        appendTranscript: config.appendTranscript,
      },
    );
  }

  /** 工具 execute 入口:永不 throw,异常收敛为 { ok: false } */
  run(args: SubagentRunArgs, session: ToolSession): Promise<SubagentResult> {
    return this.engine.run(args, session);
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    subagents: SubagentService;
  }
  interface Events {
    /** 子 agent 生命周期事件(不进 SSE,只存元数据与摘要,spec §5.1) */
    'agtpilot/subagent'(payload: SubagentEventPayload): void;
  }
}

const TOOL_DESCRIPTION = [
  '派发一个只读检索子 agent 完成广域调研:多路搜索、网页阅读、资料汇总。',
  '适用:需要翻大量资料才能得出结论、且各路检索相互独立的任务(横向对比、尽调、文献/项目雷达)。',
  '不适用:单点查询(直接用 search_web 更快)、写操作、需要审批的动作。',
  '子 agent 在独立上下文中运行,只回传提炼后的结论报告(含来源引用),原始检索内容不占主上下文。',
  '多路独立调研可在一轮内并行派发多个调用。',
].join('');

export function apply(ctx: Context, config: SubagentPluginConfig = {}) {
  const service = new SubagentService(ctx, config);
  // 总闸:AGTPILOT_SUBAGENT=0 时不注册工具,行为回到今天(spec §6.7)
  if (!MASTER_ENABLED) return service;

  const tool: ToolDefinition = {
    name: SELF_TOOL_NAME,
    description: TOOL_DESCRIPTION,
    dangerLevel: 'low',
    // 关键:走 toolGate.runReadonly,不占独占锁 → 一轮多个并行调用天然安全
    readOnly: true,
    // 进路由:调研类 prompt 命中才挂载,闲聊不浪费 token
    baseline: false,
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '子任务描述:查什么、汇总成什么' },
        sources_hint: { type: 'string', description: '可选:建议的检索源/关键词方向' },
        output_schema: { type: 'string', description: '可选:期望的结论字段结构(自由文本)' },
        max_steps: { type: 'number', description: '可选:子 agent 步数上限(钳制 2..20,默认 8)' },
      },
      required: ['query'],
    },
    execute: (args: any, session: ToolSession) => service.run(args ?? {}, session),
  };
  ctx.agent.registerTool(tool);
  ctx.agent.registerToolRoute({
    id: 'subagent',
    prefixes: [SELF_TOOL_NAME],
    test: /调研|检索汇总|多路|横向对比|尽调|文献|雷达|research|survey|investigate|landscape/i,
  });
  return service;
}

export const name = 'agtpilot-plugin-subagent';
export const inject = ['agent', 'model'];

export { SubagentService, DEFAULT_READONLY_WHITELIST, SELF_TOOL_NAME };
export type {
  SubagentModel,
  SubagentResult,
  SubagentRunArgs,
  SubagentRunMeta,
  SubagentEventPayload,
  SubagentTranscript,
} from './runner';
export { SubagentEngine, SUBAGENT_SYSTEM_PROMPT, buildTaskPrompt, clampSteps } from './runner';
export { resolveReadonlyTools, mcpServerPrefix } from './whitelist';
export type { SubagentToolFilter } from './whitelist';
