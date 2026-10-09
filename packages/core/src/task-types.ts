import { AgentEvent } from '@agtpilot/protocol';
import { ToolDefinition } from './contracts';

export interface TaskOptions {
  taskId?: string;
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
  abortSignal?: AbortSignal;
  configOverride?: any;
  historyMessages?: Array<{ role: 'user' | 'assistant' | 'tool'; content: any }>;
  onEvent?: (event: AgentEvent) => void;
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
