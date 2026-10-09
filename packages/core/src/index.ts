import type { AgentEvent } from '@agtpilot/protocol';
import type { ToolDefinition, ModelGateway, PlannerNotifier } from './contracts';
import { AgentService } from './agent-service';
import { OrchestratorService } from './orchestrator';

// ---- 公共 API（保持既有导出面不变，新增契约与路由接口）----
export type {
  ToolDefinition,
  ToolSession,
  ToolRoute,
  ModelGateway,
  PlannerNotifier,
  ModelConfigOverride,
  ModelInvokeOptions,
  AgentLoopTool,
  AgentLoopStepInfo,
  AgentLoopPrepareStep,
  AgentLoopOptions,
  AgentLoopResult,
} from './contracts';
export {
  estimateTextTokens,
  estimateToolTokens,
  toolSearchTokenThreshold,
  selectActiveTools,
  stableStringify,
} from './routing';
export type { RoutableTool } from './routing';
export {
  messageText,
  isToolCallMessage,
  truncateText,
  truncateToolOutput,
  TOOL_OUTPUT_LIMIT,
} from './text';
export {
  compactConversationMessages,
  COMPACT_THRESHOLD_TOKENS,
  COMPACT_RECENT_MESSAGES,
  COMPACT_DIGEST_ENTRY_LIMIT,
} from './compaction';
export type { CompactOptions, DigestSummarizer } from './compaction';
export { AgentService } from './agent-service';
export { OrchestratorService } from './orchestrator';
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
    /** 模型用量上报（runAgentLoop 结束后由内核发出；plugin-router 预算统计消费） */
    'agtpilot/usage'(usage: { promptTokens: number; completionTokens: number; taskId?: string }): void;
    /**
     * 运行中消息检查点（每步 prepareStep 时由内核发出，payload 为本步实际
     * 使用的消息快照，含压缩重写）。持久化层监听此事件把会话历史增量落盘，
     * 进程崩溃/重启后任务可从最近检查点续跑。
     */
    'agtpilot/checkpoint'(payload: { taskId: string; stepNumber: number; messages: any[] }): void;
  }
}

export const name = 'agtpilot-core';
export const inject: string[] = [];

export function apply(ctx: import('@deepseek-ai/cordis').Context) {
  new AgentService(ctx);
  new OrchestratorService(ctx);
}
