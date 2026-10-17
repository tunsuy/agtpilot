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
  /**
   * 任务执行中排队的用户追加消息(docs/design/mid-run-user-messages.md):
   * 每步 prepareStep 前调用,返回非空字符串时内核把它作为一条
   * 【用户追加消息】user 消息追加到本步消息末尾 —— 用户在任务进行中发的
   * 追问不打断轮次,而是注入到正在跑的这一轮(steering)。多条由上层
   * 合并成一条(对齐 Claude Code)。与 getStepNotice 同款拉取式通道,
   * 抛错时内核静默跳过。
   */
  getUserMessages?: () => string | null | undefined | Promise<string | null | undefined>;
  /**
   * 超长工具输出全量落盘回调(docs/design/tool-output-spill.md):
   * 工具结果序列化后超过 TOOL_OUTPUT_LIMIT 时,内核先经本回调尝试把全量原文
   * 写入调用方管理的存储(web 层 = 用户上下文目录 v2/<userId>/tool-output/)。
   * 返回非空字符串(= 存储引用 id)时模型收到「头尾预览 + 指针」而非纯截断,
   * 被截部分可经 read_tool_output(callId, offset) 续读(可恢复);
   * 无回调 / 返回 null / 抛错 → 回退现行头尾截断,绝不因落盘失败工具调用。
   * 内核侧受 AGTPILOT_TOOL_SPILL=0 保险丝门控(关闭时不调用本回调)。
   * CLI/runner 不注入 = 行为与上线前一致。
   */
  spillToolOutput?: (info: {
    taskId: string;
    callId: string;
    toolName: string;
    fullText: string;
  }) => string | null | Promise<string | null>;
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
  /** 执行成功但返回空结果的次数（null/空串/空对象；框架把空返回当成功会系统性高估有效率） */
  emptyCalls: number;
  /** 只读工具同参数调用命中 TTL 结果缓存被复用的次数（不重新执行,不计入 toolCalls） */
  dedupedCalls: number;
  /** 有效调用率 = (总调用 - 失败 - 跳过 - 空返回) / 总调用，无调用时为 1 */
  effectiveRate: number;
  /** 本次实际向模型声明的工具数 */
  toolsMounted: number;
  /** 系统注册的工具总数 */
  toolsTotal: number;
  /** 是否启用了按需挂载（false = 全量声明） */
  routed: boolean;
  /** 本次剥离的 assistant reasoning 部件数(闸1 入口/闸2 循环内/闸3 装配合计;
   *  可选:历史落盘的旧 mission 与 AGTPILOT_STRIP_REASONING=0 回退时无此字段) */
  reasoningPartsStripped?: number;
  /** 本次全量落盘并替换为「预览+指针」的超长工具输出条数
   *  (可选:无落盘/保险丝关闭时无此字段 —— 对齐 reasoningPartsStripped 先例,
   *  历史 mission 与 strict-equal 测试不受影响) */
  spilledOutputs?: number;
  /** 落盘输出的原始字符总量(可恢复量级观测:这些内容此前会被截断永久丢失) */
  spilledChars?: number;
  /** 本次运行消耗的输入 tokens（工具声明 + 历史前缀；成本可观测的前提） */
  promptTokens: number;
  /** 本次运行消耗的输出 tokens */
  completionTokens: number;
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
