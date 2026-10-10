import { ModelStepResult } from '@agtpilot/protocol';

/**
 * 内核级服务契约（依赖倒置的锚点）。
 *
 * 微内核不 import 任何插件；它只依赖这里的接口。插件实现接口并在
 * cordis 上以同名服务注册（`super(ctx, 'model')` 等），内核通过
 * `ctx.model` / `ctx.planner` 类型化访问（见 index.ts 的模块增强）。
 * 缺实现时内核在运行前给出明确错误，而不是 `as any` 裸奔到第一次调用才炸。
 */

// ---- 模型网关（由 plugin-model 实现）----

/** 模型调用配置覆盖（多用户部署时按用户传入，优先级高于环境变量） */
export interface ModelConfigOverride {
  activeModelId?: string;
  apiKey?: string;
  baseURL?: string;
  modelName?: string;
}

/** 单步无状态调用选项（纯文本场景：总结收尾、会话压缩蒸馏等） */
export interface ModelInvokeOptions {
  model?: string;
  system?: string;
  messages: any[];
  temperature?: number;
  /** 本次调用禁用全部工具声明 */
  disableTools?: boolean;
  configOverride?: ModelConfigOverride;
}

/** 交给 agent loop 执行的工具（真实 execute 由编排器包装注入） */
export interface AgentLoopTool {
  name: string;
  description: string;
  /** JSON Schema 参数定义，透传给模型（缺失时退化为自由参数） */
  parameters?: Record<string, any>;
  execute: (args: any) => Promise<any>;
}

/** 每步完成回调信息（供上层做事件广播与效率统计） */
export interface AgentLoopStepInfo {
  stepNumber: number;
  text: string;
  toolCalls: Array<{ toolCallId: string; toolName: string; args: Record<string, any> }>;
  toolResults: Array<{ toolCallId: string; toolName: string; result: any }>;
  finishReason: string;
}

/**
 * 每步准备回调（对应 AI SDK v5 prepareStep）：进入每一步前由上层做
 * 动态工具路由与任务内会话压缩（重写本步消息）。
 */
export type AgentLoopPrepareStep = (info: { stepNumber: number; messages: any[] }) =>
  | { activeTools?: string[]; messages?: any[] }
  | undefined
  | Promise<{ activeTools?: string[]; messages?: any[] } | undefined>;

export interface AgentLoopOptions {
  model?: string;
  system?: string;
  messages: any[];
  temperature?: number;
  /** 多步循环的最大步数 */
  maxSteps?: number;
  tools?: AgentLoopTool[];
  /** 本次调用只向模型声明的工具子集（其余仍可执行但不进上下文），缺省为全量 */
  activeTools?: string[];
  abortSignal?: AbortSignal;
  configOverride?: ModelConfigOverride;
  prepareStep?: AgentLoopPrepareStep;
  onStepFinish?: (info: AgentLoopStepInfo) => void;
  /** 每步模型调用开始（供上层做"正在思考"指示广播） */
  onStepStart?: (info: { stepNumber: number }) => void;
  /** 文本增量回调（P1 流式）；实现不支持流式时可缺省不调 */
  onTextDelta?: (delta: string) => void;
  /** 推理增量回调（reasoning 模型思考过程）；实现可忽略 */
  onReasoningDelta?: (delta: string) => void;
}

export interface AgentLoopResult {
  /** 最后一步的文本输出 */
  text: string;
  finishReason: string;
  /** 实际执行步数 */
  stepsCount: number;
  /** 是否因触达步数上限而停止（此时模型可能仍想继续调工具） */
  stepsExhausted: boolean;
  /** 循环期间产生的标准 assistant/tool 消息（可拼回会话历史） */
  responseMessages: any[];
  usage?: { promptTokens: number; completionTokens: number };
}

/**
 * 模型网关：内核编排循环对"模型能力"的全部依赖面。
 * 由 plugin-model（或任何替代实现）提供。
 */
export interface ModelGateway {
  /** 单步无状态调用（不执行工具） */
  invokeStep(options: ModelInvokeOptions): Promise<ModelStepResult>;
  /** 完整 agent loop：多步循环、tool-call/result 配对交给 AI SDK */
  runAgentLoop(options: AgentLoopOptions): Promise<AgentLoopResult>;
  /**
   * 设置偏好模型（plugin-router 等运行时切换入口使用）。
   * 优先级：configOverride > 显式 model 参数 > 本偏好 > 环境变量默认。
   */
  setPreferredModel(pref: { activeModelId?: string; modelName?: string; reason?: string }): void;
  /** 设置 token 预算上限；超限时 agent loop 主动收尾（返回明确错误） */
  setBudget(budget: { maxTokens?: number; maxCostUsd?: number }): void;
}

// ---- 规划器通知（由 plugin-planner 实现）----

/**
 * 内核向规划器推送的最小接口：工具执行成功后自动推进看板。
 * 内核只依赖这个方法，planner 的完整 API（createPlan 等）留在插件内部。
 */
export interface PlannerNotifier {
  noteToolResult(taskKey: string, toolName: string): void;
}

// ---- 工具契约 ----

/**
 * 工具执行会话（编排器注入）：插件侧做隔离/记账的唯一身份锚点。
 * 多用户部署时 Web 传入 userId；CLI 单用户场景缺省。
 * 插件持有进程级状态（缓存/索引/沙箱目录）时必须按 userId 分域，
 * 缺省回退 'default' —— 不允许裸用 process.cwd() 级全局状态。
 */
export interface ToolSession {
  taskId: string;
  step: number;
  env?: Record<string, string>;
  userId?: string;
  /**
   * 任务级沙箱策略(docs/design/sandbox-control-hardening.md §4.2):
   * 子进程环境暴露白名单 / 凭据-端点绑定 / bwrap 围栏模式 / 出站网络开关。
   * web 层构建后持有活引用 —— 权限提案批准即原地热更新,in-flight 任务下一步生效。
   */
  sandbox?: import('./sandbox-fence').SandboxSessionPolicy;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, any>;
  dangerLevel?: 'low' | 'medium' | 'high';
  /**
   * 副作用补偿声明(持久状态治理不变量 I5:每个行动都要留下可回滚的「把手」)。
   * 编排器在 tool_result 事件里透传给上层,由持久化层随任务步骤快照落盘 ——
   * reversible 支持事后撤销,irreversible 在事前就明确告知(配合审批门)。
   */
  compensation?: {
    kind: 'reversible' | 'partially-reversible' | 'irreversible';
    /** 可(部分)回滚时:补偿方式的说明(供前端「撤销」入口与审计展示) */
    undoHint?: string;
  };
  execute: (args: any, session: ToolSession) => Promise<any>;
  /** 基线工具：任何任务都挂载（体积小且通用的规划/交付/记忆类），由插件自声明 */
  baseline?: boolean;
}

/**
 * 工具路由规则：由插件在 apply() 里自注册，把"任务 prompt 关键词 → 本插件工具前缀"
 * 的映射下沉到插件侧 —— 新插件不再需要改内核路由表。
 */
export interface ToolRoute {
  /** 路由规则标识（插件名，如 'browser'） */
  id: string;
  /** 命中本规则时挂载的工具名前缀 */
  prefixes: string[];
  /** prompt 关键词匹配（含近期用户消息） */
  test: RegExp;
}
