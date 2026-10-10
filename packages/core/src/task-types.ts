import { AgentEvent } from '@agtpilot/protocol';
import { ToolDefinition } from './contracts';
import type { SandboxSessionPolicy } from './sandbox-fence';

export interface TaskOptions {
  taskId?: string;
  /** 任务归属用户（多用户 Web 传入；CLI 单用户缺省）。经 ToolSession 传给每个工具，插件按其分域隔离状态 */
  userId?: string;
  prompt: string;
  system?: string;
  model?: string;
  maxSteps?: number;
  /** 显式指定本次任务向模型声明的工具子集；缺省时仅当工具声明 tokens 超阈值才按关键词路由，否则全量挂载 */
  activeTools?: string[];
  /**
   * 任务级附加工具（如 MCP 用户连接器工具）。
   * 只注入本次 runTask，不进全局注册表 —— 多用户部署时避免 A 用户的
   * 连接器工具泄漏给 B 用户的任务。同名时覆盖全局注册的同名工具。
   */
  taskTools?: ToolDefinition[];
  /**
   * 任务级环境变量（如当前用户在个人空间保存的 EXA_API_KEY 等非 LLM 服务密钥）。
   * 通过工具 execute 的 session.env 透传，插件优先读取 —— 多用户部署时
   * 绝不写入 process.env，避免 A 用户的 Key 被 B 用户的请求使用。
   */
  taskEnv?: Record<string, string>;
  /**
   * 任务级沙箱策略(docs/design/sandbox-control-hardening.md §4.2)。
   * 经 ToolSession.sandbox 透传给沙箱类工具:控制子进程环境暴露(exposeEnv)、
   * 凭据-端点绑定(credentialBindings)、bwrap 内核围栏(fence)、出站网络(net)。
   * 与 taskEnv 同一注入点、同样活引用语义(web 层热更新点)。缺省 = 全部默认
   * (零 Key 暴露 / 默认绑定 / 逻辑围栏 / 网络放行)。
   */
  taskSandbox?: SandboxSessionPolicy;
  abortSignal?: AbortSignal;
  configOverride?: any;
  historyMessages?: Array<{ role: 'user' | 'assistant' | 'tool'; content: any }>;
  onEvent?: (event: AgentEvent) => void;
  /**
   * 动态治理提示(回退弧感知通道):每步 prepareStep 前调用,返回非空字符串时
   * 内核把它作为一条【系统治理提示】用户消息追加到本步消息末尾 —— 用于向
   * in-flight 任务即时通报「记忆已被删除」「连接器授权已撤销(纪元 a→b)」等
   * 状态变化,让模型显式调整计划而不是拿着失效授权继续跑(治理不变量 I1/I3)。
   * 每次返回一条(上层自行排队),抛错时内核静默跳过。
   */
  getStepNotice?: () => string | null | undefined | Promise<string | null | undefined>;
}

/** 单任务执行效率统计（识别"本该 2 步却跑了很多步"的空转任务） */
export interface TaskEfficiency {
  /** 实际模型步数 */
  stepsCount: number;
  /** 工具调用尝试总次数（含被熔断跳过的） */
  toolCalls: number;
  /** 执行报错的次数 */
  failedCalls: number;
  /** 被死循环熔断跳过的次数 */
  skippedCalls: number;
  /** 审批被拒绝的次数 */
  approvalRejected: number;
  /** 有效调用率 = (总调用 - 失败 - 跳过) / 总调用，无调用时为 1 */
  effectiveRate: number;
  /** 本次实际向模型声明的工具数 */
  toolsMounted: number;
  /** 系统注册的工具总数 */
  toolsTotal: number;
  /** 是否启用了按需挂载（false = 全量声明） */
  routed: boolean;
}

export interface TaskResult {
  taskId: string;
  success: boolean;
  stepsCount: number;
  finalAnswer: string;
  events: AgentEvent[];
  messages?: Array<{ role: 'user' | 'assistant' | 'tool'; content: any }>;
  efficiency?: TaskEfficiency;
  error?: string;
}
