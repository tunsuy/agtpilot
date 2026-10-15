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
  /**
   * 本步 token 用量（实时成本观测：上层逐步入账 mission.usage）。
   * 实现侧拿不到每步 usage 时缺省，由上层收尾统一对账。
   */
  usage?: { promptTokens: number; completionTokens: number };
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
 * 内核向规划器查询的最小接口：看板滞后提醒。
 * 看板进度由模型显式申报维护（planner_update_task 与实际工具调用同批
 * 发出 —— Claude Code TodoWrite / Codex update_plan 同款契约）；模型忘了
 * 申报时，内核累计「真实工具成功但看板零更新」的轮数，达到阈值时向
 * 规划器取一条催促文本注入下一轮 —— 把「忘了」从静默漂移变成一轮内
 * 可自愈的显式事件。内核不推断步骤完成（旧 noteToolResult 自动推进已废）。
 */
export interface PlannerNotifier {
  /** 无看板 / 无进行中步骤（全完结或全失败）→ null；否则返回注入提醒文本 */
  boardLagNotice(taskKey: string, idleRounds: number): string | null;
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
  /**
   * 本次物理工具调用 id(编排器逐调用生成):插件层自广播 tool_call/tool_result
   * 时原样透传,前端步骤记录按它与内核事件精确对应/幂等合并 —— 并行多工具
   * 轮次里按「工具名+末位位置」倒查会关错步骤(见 web 侧 lib/tool-steps.ts)。
   */
  callId?: string;
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
   * 只读声明(只读并行门控):true = 本工具无任何副作用(不落盘、不改外部状态、
   * 不发布、不独占共享会话)。同一轮里只读工具彼此并行执行;非只读工具
   * (含未声明者,保守视为写)独占串行 —— 等在途只读结束后单独执行,
   * 期间不放行任何调用。调度实现见 tool-gate.ts。
   */
  readOnly?: boolean;
  /**
   * 只读判定依据(仅当 readOnly=true 时有意义,审计/展示用):
   * 'annotation' = 服务器 MCP annotations 自报只读;'heuristic' = 注解沉默时按工具名动词 default-deny 判定
   * (见 plugin-mcp/src/classify.ts)。子 agent 双钥匙的机器钥匙信号来源,主循环并行门不区分此字段。
   */
  readOnlyBasis?: 'annotation' | 'heuristic';
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
  /**
   * 外部服务 Key 依赖声明(loop 执行优化 P5)：本工具执行依赖的环境变量名
   * (任一存在即视为已配置,如 ['EXA_API_KEY'])。编排器挂载前按
   * taskEnv(用户个人空间,多用户隔离) ∪ process.env 判定,缺 Key 时直接
   * 不挂载,并把「未配置」事实写进系统提示 —— 避免挂一个秒败的壳诱使
   * 模型调用后浪费轮次(实测 13ms 秒败 × N 次直接拖垮任务有效率)。
   * 插件 config 已带 Key 时不声明此项。
   */
  requiredEnv?: string[];
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

/** typed 快判断原语（对齐 Jev 品类通用形态） */
export interface DecisionQuestion {
  kind: 'choice' | 'score' | 'yes-no';
  prompt: string;
  options?: string[];
  rubric?: string;
}
export interface DecisionVerdict {
  kind: DecisionQuestion['kind'];
  value: string | number | boolean;
  confidence: number;
  latencyMs: number;
  provider: string;
  mode: 'model' | 'heuristic-fallback';
}
export type DecisionPoint = 'tool-routing' | 'tier-routing' | 'risk-assist' | 'loop-progress';
export interface DecisionGateway {
  decide(point: DecisionPoint, state: string, questions: DecisionQuestion[], opts?: { timeoutMs?: number; userId?: string }): Promise<DecisionVerdict[]>;
  isAvailable(): boolean;
}
