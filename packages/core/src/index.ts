import type { AgentEvent } from '@agtpilot/protocol';
import type { ToolDefinition, ModelGateway, PlannerNotifier, DecisionGateway } from './contracts';
import { AgentService } from './agent-service';
import { OrchestratorService } from './orchestrator';

// ---- 公共 API（保持既有导出面不变，新增契约与路由接口）----
export type {
  ToolDefinition,
  ToolSession,
  ToolRoute,
  ModelGateway,
  PlannerNotifier,
  DecisionGateway,
  DecisionQuestion,
  DecisionVerdict,
  DecisionPoint,
  ModelConfigOverride,
  ModelInvokeOptions,
  AgentLoopTool,
  AgentLoopStepInfo,
  AgentLoopPrepareStep,
  AgentLoopOptions,
  AgentLoopResult,
  ModelStreamTelemetry,
} from './contracts';
export {
  estimateTextTokens,
  estimateToolTokens,
  toolSearchTokenThreshold,
  selectActiveTools,
  resolveExplicitTools,
  widenMountedTools,
  filterToolsByEnv,
  stableStringify,
} from './routing';
export type { RoutableTool } from './routing';
export {
  LOAD_TOOLS_NAME,
  toolCatalogEnabled,
  cardLine,
  groupCatalogTools,
  buildToolCatalogNote,
  createLoadToolsDefinition,
} from './tool-catalog';
export type { CatalogableTool, LoadToolsHooks } from './tool-catalog';
export {
  messageText,
  isToolCallMessage,
  truncateText,
  truncateToolOutput,
  buildSpillPointer,
  toolSpillEnabled,
  effectiveOutputLimit,
  TOOL_OUTPUT_LIMIT,
  SPILL_PREVIEW_LIMIT,
} from './text';
export {
  compactConversationMessages,
  assistantTextDigestEnabled,
  COMPACT_THRESHOLD_TOKENS,
  COMPACT_RECENT_MESSAGES,
  COMPACT_RECENT_TOKEN_BUDGET,
  COMPACT_RECENT_MIN_MESSAGES,
  COMPACT_DIGEST_ENTRY_LIMIT,
  ASSISTANT_TEXT_KEEP_CHARS,
} from './compaction';
export type { CompactOptions, DigestSummarizer } from './compaction';
export {
  contextWindowTokens,
  outputReserveTokens,
  budgetSafetyRatio,
  estimateToolsBlockTokens,
  historyTokenBudget,
  effectiveCompactThreshold,
  MIN_HISTORY_BUDGET,
} from './context-budget';
export type { ContextBudgetInputs } from './context-budget';
export { appendStepNotice, STEP_NOTICE_PREFIX, appendBackgroundNotice, BACKGROUND_NOTICE_PREFIX } from './notice';
export { stripReasoningParts, reasoningStripEnabled } from './reasoning';
export type { ReasoningMessageLike, StripReasoningResult } from './reasoning';
export { ToolGate } from './tool-gate';
export type { StepNoticeMessage } from './notice';
export { isPrivateOrReservedIp, guardUrlHost } from './net-guard';
export type { HostLookup, UrlGuardResult } from './net-guard';
export { classifyBrowserFailure } from './browser-failure';
export type { BrowserFailureKind, BrowserFailureGuide } from './browser-failure';
export {
  DEFAULT_CREDENTIAL_BINDINGS,
  buildChildEnv,
  resolveCredentialRequest,
  decideFence,
  buildBwrapArgs,
} from './sandbox-fence';
export type { SandboxSessionPolicy, CredentialDecision, FenceDecision } from './sandbox-fence';
export { AgentService } from './agent-service';
export { OrchestratorService, DEFAULT_SYSTEM_PROMPT, isEmptyToolOutput, isCutOffToolCall } from './orchestrator';
export type { TaskOptions, TaskResult, TaskEfficiency } from './task-types';

// ---- Cordis 模块增强：内核依赖的服务契约 ----
// model / planner 由插件提供实现（plugin-model 实现 ModelGateway、
// plugin-planner 实现 PlannerNotifier），内核只面向接口编程。
// 其余插件（mcp/memory/cron/...）的 Context 增强仍留在各自插件包内。
declare module '@deepseek-ai/cordis' {
  interface Context {
    agent: AgentService;
    orchestrator: OrchestratorService;
    model: ModelGateway;
    planner: PlannerNotifier;
  }
  interface Events {
    dispose(): void;
    'agtpilot/tool-registered'(tool: ToolDefinition): void;
    'agtpilot/event'(event: AgentEvent): void;
    /** 模型用量上报（runAgentLoop 逐步发增量；apps/web mission 用量累计消费） */
    'agtpilot/usage'(usage: { promptTokens: number; completionTokens: number; taskId?: string }): void;
    /**
     * 运行中消息检查点（每步 prepareStep 时由内核发出，payload 为本步实际
     * 使用的消息快照，含压缩重写）。持久化层监听此事件把会话历史增量落盘，
     * 进程崩溃/重启后任务可从最近检查点续跑。
     */
    'agtpilot/checkpoint'(payload: { taskId: string; stepNumber: number; messages: any[] }): void;
    /**
     * 目录点菜观测(层0 目录卡片 B v1,token 文档 §9.4):load_tools 每次被
     * 调用发一条(loaded=本次新点名的工具,unknown=目录外名字)。这就是
     * §9.4 想要的「命中分布」数据 —— 由 B 自身自动采集,不进 SSE。
     */
    'agtpilot/tool-catalog'(payload: { taskId: string; step: number; loaded: string[]; unknown: string[] }): void;
  }
}

export const name = 'agtpilot-core';
export const inject: string[] = [];

export function apply(ctx: import('@deepseek-ai/cordis').Context) {
  new AgentService(ctx);
  new OrchestratorService(ctx);
}
