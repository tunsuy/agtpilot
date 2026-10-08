import { Context, Service } from '@deepseek-ai/cordis';
import { AgentEvent, ApprovalRequest, ModelStepResult } from '@agtpilot/protocol';

/** 默认步数上限（一步 = 一轮模型调用）。可用环境变量 AGTPILOT_MAX_STEPS 或单任务 maxSteps 覆盖。 */
const DEFAULT_MAX_STEPS = Math.max(1, Number(process.env.AGTPILOT_MAX_STEPS) || 40);
/** 单个工具结果回填模型上下文的字符上限，超长截断，防止上下文膨胀导致模型退化。 */
const TOOL_OUTPUT_LIMIT = 16 * 1024;

// ---- 工具按需挂载（阈值触发式 Tool Routing）----
// 对齐业界实践（Claude Code / 腾讯 Octop）：工具目录不大时全量挂载，
// 保证跨任务前缀稳定、共享 provider 缓存；只有当工具声明 tokens 超过
// 上下文窗口的一定比例（Claude Code 二进制内为 10%）才启用筛选。
// 本实现：低于阈值 → 全量挂载（现状 49 工具 ≈6K tokens，64K 窗口的 9.4%）；
// 超过阈值（MCP 动态工具接入后会发生）→ 按 prompt 关键词只挂载相关工具组，
// 拿不准仍全量兜底，宁可多花 tokens 不可饿死任务。
// 可调参数：AGTPILOT_TOOL_ROUTING=0 整体关闭；
// AGTPILOT_CONTEXT_WINDOW（默认 64000）；AGTPILOT_TOOL_SEARCH_THRESHOLD（默认 10，单位 %）。

/** 任何任务都挂载的基线工具（规划/交付/记忆，体积小且通用） */
const BASELINE_TOOLS = [
  'planner_create_plan',
  'planner_update_task',
  'artifact_render',
  'memory_recall',
  'memory_store',
];

/** 关键词 → 工具组前缀映射 */
const TOOL_GROUPS: Array<{ test: RegExp; prefixes: string[] }> = [
  {
    test: /(网页|网站|浏览|抓取|爬取|打开链接|https?:\/\/|www\.|\.(com|cn|org|net|io)\b|browser|webpage|scrape|crawl)/i,
    prefixes: ['browser_'],
  },
  { test: /(搜索|检索|查一下|查下|搜一下|查查|最新|新闻|资讯|search|news|look\s?up)/i, prefixes: ['search_'] },
  {
    test: /(代码|脚本|运行|执行|命令|编译|部署|python|javascript|node|shell|sql|code|script|run|execute)/i,
    prefixes: ['sandbox_'],
  },
  { test: /(git|仓库|提交代码|分支|回滚|commit|repo|diff|patch|merge)/i, prefixes: ['git_'] },
  { test: /(文件|目录|读写|截图|剪贴板|桌面|file|directory|screenshot|clipboard|desktop)/i, prefixes: ['sandbox_', 'desktop_'] },
  { test: /(定时|每天|每小时|每周|每晚|提醒|cron|schedule|remind)/i, prefixes: ['cron_', 'notify_'] },
  { test: /(知识库|向量|索引文档|rag)/i, prefixes: ['rag_'] },
  { test: /(mcp|外部工具服务)/i, prefixes: ['mcp_'] },
  { test: /(通知|推送|webhook|notify)/i, prefixes: ['notify_'] },
];

/** 参与路由决策的工具元信息（名字 + 声明体积） */
export interface RoutableTool {
  name: string;
  description?: string;
  parameters?: Record<string, any>;
}

/**
 * 估算工具声明占用的 tokens（name + description + 参数 Schema）。
 * 启发式：CJK 字符按 1 token/字，其余按 1 token/4 字符。
 */
export function estimateToolTokens(tools: RoutableTool[]): number {
  let cjk = 0;
  let total = 0;
  for (const t of tools) {
    const s = JSON.stringify({
      name: t.name,
      description: t.description ?? '',
      parameters: t.parameters ?? {},
    });
    total += s.length;
    for (const ch of s) {
      if (/[㐀-䶿一-鿿豈-﫿]/.test(ch)) cjk++;
    }
  }
  return Math.ceil(cjk + (total - cjk) / 4);
}

/** 当前配置的阈值门：工具声明 tokens 低于该值时全量挂载（调用时读 env，便于测试/热调） */
export function toolSearchTokenThreshold(): number {
  const contextWindow = Math.max(1024, Number(process.env.AGTPILOT_CONTEXT_WINDOW) || 64_000);
  const pct = Number(process.env.AGTPILOT_TOOL_SEARCH_THRESHOLD) || 10;
  return Math.floor((contextWindow * pct) / 100);
}

/**
 * 依据阈值与 prompt 选出本次任务需要声明的工具子集。
 * 返回 undefined 表示全量挂载（未超阈值 / 未命中任何规则 / 路由被关闭）。
 * 决策顺序：显式指定 > 路由开关 > 阈值门（Claude Code 同款：工具 tokens
 * < 上下文 10% 时全量挂载，前缀恒定跨任务共享缓存）> 关键词分组路由。
 */
export function selectActiveTools(
  prompt: string,
  allTools: RoutableTool[],
  explicit?: string[]
): string[] | undefined {
  const allToolNames = allTools.map((t) => t.name);
  if (explicit && explicit.length > 0) {
    const filtered = explicit.filter((n) => allToolNames.includes(n));
    return filtered.length > 0 ? filtered : undefined;
  }
  if (process.env.AGTPILOT_TOOL_ROUTING === '0') return undefined;

  // 阈值门：工具目录还小 → 全量挂载，保证前缀稳定
  if (estimateToolTokens(allTools) < toolSearchTokenThreshold()) return undefined;

  // 超阈值：关键词 → 工具组路由
  const matched = new Set<string>();
  for (const group of TOOL_GROUPS) {
    if (group.test.test(prompt)) {
      for (const prefix of group.prefixes) {
        for (const name of allToolNames) {
          if (name.startsWith(prefix)) matched.add(name);
        }
      }
    }
  }
  if (matched.size === 0) return undefined; // 拿不准 → 全量，保守兜底

  // prompt 里显式提到的工具名直接保留
  for (const name of allToolNames) {
    if (prompt.includes(name)) matched.add(name);
  }
  // 基线工具（仅取系统里真实注册的）
  for (const name of BASELINE_TOOLS) {
    if (allToolNames.includes(name)) matched.add(name);
  }
  return Array.from(matched);
}

/** 参数归一化：递归排序 key、字符串去空白标点小写化，用于模糊死循环检测 */
function stableStringify(value: any): any {
  if (Array.isArray(value)) return value.map(stableStringify);
  if (value && typeof value === 'object') {
    const out: Record<string, any> = {};
    for (const k of Object.keys(value).sort()) out[k] = stableStringify(value[k]);
    return out;
  }
  if (typeof value === 'string') {
    return value.toLowerCase().replace(/[\s.,;:!?'""()\[\]{}~`@#$%^&*+=|\\/-]+/g, '');
  }
  return value;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, any>;
  dangerLevel?: 'low' | 'medium' | 'high';
  execute: (args: any, session: any) => Promise<any>;
}

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

declare module '@deepseek-ai/cordis' {
  interface Context {
    agent: AgentService;
    orchestrator: OrchestratorService;
  }
  interface Events {
    dispose(): void;
    'agtpilot/tool-registered'(tool: ToolDefinition): void;
    'agtpilot/event'(event: AgentEvent): void;
  }
}

export class AgentService extends Service {
  private tools: Map<string, ToolDefinition> = new Map();

  constructor(ctx: Context) {
    super(ctx, 'agent');
  }

  registerTool(tool: ToolDefinition) {
    this.tools.set(tool.name, tool);
    this.ctx.emit('agtpilot/tool-registered', tool);
  }

  getTools(): ToolDefinition[] {
    return Array.from(this.tools.values());
  }

  getTool(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  emitEvent(event: AgentEvent) {
    this.ctx.emit('agtpilot/event', event);
  }
}

export class OrchestratorService extends Service {
  private pendingApprovals: Map<string, (approved: boolean) => void> = new Map();

  constructor(ctx: Context) {
    super(ctx, 'orchestrator');
  }

  /**
   * 提交外部审批结论（供前端 Web 或 CLI 异步解冻调用）
   */
  submitApproval(approvalId: string, approved: boolean): boolean {
    const resolver = this.pendingApprovals.get(approvalId);
    if (resolver) {
      resolver(approved);
      this.pendingApprovals.delete(approvalId);
      return true;
    }
    return false;
  }

  /**
   * 运行任务循环。
   *
   * 架构分工（AI SDK v5 迁移后）：
   * - 通用逻辑（多步循环、消息拼装、tool-call/result 配对、provider 协议）
   *   全部交给 Vercel AI SDK 内置 agent loop（stopWhen: stepCountIs）；
   * - 产品差异化逻辑保留在本层：死循环熔断、高危操作审批（HITL）、
   *   标准化事件广播、工具结果截断、步数耗尽强制总结收尾。
   */
  async runTask(options: TaskOptions): Promise<TaskResult> {
    const taskId = options.taskId || `task_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS;
    const events: AgentEvent[] = [];

    const broadcast = (event: AgentEvent) => {
      events.push(event);
      this.ctx.agent.emitEvent(event);
      if (options.onEvent) {
        options.onEvent(event);
      }
    };

    const baseMessages: Array<{ role: 'user' | 'assistant' | 'tool'; content: any }> =
      options.historyMessages && options.historyMessages.length > 0
        ? [...options.historyMessages, { role: 'user', content: options.prompt }]
        : [{ role: 'user', content: options.prompt }];

    // 死循环熔断状态：只统计【连续】相同调用（滑动窗口）。
    // 签名做归一化（排序 key/去空白标点/小写），模型微调参数的重试也能被识别
    let lastSignature = '';
    let repeatCount = 0;
    // 连续失败守卫：同一工具连续报错达到阈值后，在结果里注入换思路提示
    let lastFailedTool = '';
    let consecutiveFailures = 0;
    const FAILURE_GUARD_THRESHOLD = 3;
    // 效率统计（识别空转任务）
    const stats = { toolCalls: 0, failedCalls: 0, skippedCalls: 0, approvalRejected: 0 };
    // 当前步序号（1-based，供工具会话上下文使用）
    let currentStep = 1;

    // ---- 工具包装层：熔断 + 审批门 + 事件广播 + 结果截断 + 效率统计 ----
    // 全局注册工具 + 任务级附加工具（taskTools，如 MCP 用户连接器）；同名时任务级优先
    const globalTools = this.ctx.agent.getTools();
    const taskOnlyTools = (options.taskTools || []).filter(
      (t) => !globalTools.some((g) => g.name === t.name)
    );
    const allTools = [...globalTools, ...taskOnlyTools];
    const loopTools = allTools.map((toolDef) => ({
      name: toolDef.name,
      description: toolDef.description,
      parameters: toolDef.parameters, // 透传真实 JSON Schema，模型不再盲猜参数
      execute: async (args: any): Promise<any> => {
        stats.toolCalls++;
        // 死循环检测 (Loop Detector): 同一工具+归一化后相同参数【连续】3 次才熔断；
        // 熔断降级为跳过本次调用并返回提醒，让模型换思路，而非终止整个任务
        const toolSignature = `${toolDef.name}:${JSON.stringify(stableStringify(args))}`;
        if (toolSignature === lastSignature) {
          repeatCount++;
        } else {
          lastSignature = toolSignature;
          repeatCount = 1;
        }
        if (repeatCount >= 3) {
          stats.skippedCalls++;
          return {
            skipped: true,
            message: `[Loop Detector] 该工具已连续 ${repeatCount} 次以完全相同的参数调用，本次已被跳过。请更换思路（调整参数、改用其他工具，或基于已有信息直接总结给出最终回答），不要重复相同调用。`,
          };
        }

        // 安全审批拦截 (Human-in-the-Loop)：冻结挂起等待外部审批；
        // 任务被主动终止时自动拒绝并释放挂起，避免永久悬挂
        if (toolDef.dangerLevel === 'high') {
          const approvalId = `approval_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
          const approvalReq: ApprovalRequest = {
            id: approvalId,
            action: toolDef.name,
            description: `Agent 正在尝试执行高危操作: ${toolDef.description}`,
            dangerLevel: 'high',
            params: args,
          };

          broadcast({
            type: 'approval_request',
            payload: approvalReq,
            timestamp: Date.now(),
          });

          const approved = await new Promise<boolean>((resolve) => {
            this.pendingApprovals.set(approvalId, resolve);
            const onAbort = () => {
              if (this.pendingApprovals.delete(approvalId)) {
                resolve(false);
              }
            };
            if (options.abortSignal?.aborted) {
              onAbort();
            } else {
              options.abortSignal?.addEventListener('abort', onAbort, { once: true });
            }
          });

          if (!approved) {
            stats.approvalRejected++;
            return { rejected: true, message: `用户拒绝了执行工具 [${toolDef.name}] 的请求。` };
          }
        }

        // 广播工具执行开始
        broadcast({
          type: 'tool_call',
          payload: { tool: toolDef.name, args },
          timestamp: Date.now(),
        });

        // 真实调用工具
        let output: any;
        try {
          output = await toolDef.execute(args, { taskId, step: currentStep });
        } catch (err: any) {
          output = { error: err.message };
        }

        // 失败统计 + 连续失败守卫：同一工具连续失败达阈值时注入换思路提示
        //（仍然返回真实报错，不拦截执行，避免误杀合法的重试序列）
        const callFailed = Boolean(output && typeof output === 'object' && 'error' in output);
        if (callFailed) {
          stats.failedCalls++;
          if (toolDef.name === lastFailedTool) {
            consecutiveFailures++;
          } else {
            lastFailedTool = toolDef.name;
            consecutiveFailures = 1;
          }
          if (consecutiveFailures >= FAILURE_GUARD_THRESHOLD) {
            const hint = `[Efficiency Guard] 工具 [${toolDef.name}] 已连续失败 ${consecutiveFailures} 次。请停止简单重试：检查参数是否正确、改用其他工具，或基于已有信息直接总结。`;
            output = { ...output, guardHint: hint };
          }
        } else {
          lastFailedTool = '';
          consecutiveFailures = 0;
        }

        // 广播工具执行结果
        broadcast({
          type: 'tool_result',
          payload: { tool: toolDef.name, output },
          timestamp: Date.now(),
        });

        // 超长结果截断，防上下文膨胀导致模型退化
        const serialized = typeof output === 'string' ? output : JSON.stringify(output);
        if (serialized.length > TOOL_OUTPUT_LIMIT) {
          return `${serialized.slice(0, TOOL_OUTPUT_LIMIT)}\n...[结果过长已截断，原始长度 ${serialized.length} 字符]`;
        }
        return output;
      },
    }));

    // 工具按需挂载：显式指定 > 阈值门（未超线全量）> prompt 关键词路由 > 全量兜底
    const routedTools = selectActiveTools(options.prompt, allTools, options.activeTools);
    const toolsMounted = routedTools ? routedTools.length : allTools.length;
    const buildEfficiency = (stepsCount: number): TaskEfficiency => ({
      stepsCount,
      toolCalls: stats.toolCalls,
      failedCalls: stats.failedCalls,
      skippedCalls: stats.skippedCalls,
      approvalRejected: stats.approvalRejected,
      effectiveRate:
        stats.toolCalls > 0
          ? Math.round(((stats.toolCalls - stats.failedCalls - stats.skippedCalls) / stats.toolCalls) * 100) / 100
          : 1,
      toolsMounted,
      toolsTotal: allTools.length,
      routed: Boolean(routedTools),
    });

    try {
      // ---- 主循环：完全交给 AI SDK v5 内置 agent loop ----
      const loopResult = await (this.ctx as any).model.runAgentLoop({
        model: options.model,
        system:
          options.system ||
          '你是一个专业高效的自主执行智能体。你可以根据用户需求灵活调用浏览器等原子工具来完成任务。\n当缺少某个平台的专用工具或连接器未授权时，优先使用 browser_ 系列工具直接在网页上完成操作作为兜底，而不是放弃任务。',
        messages: baseMessages as any,
        configOverride: options.configOverride,
        maxSteps,
        tools: loopTools,
        activeTools: routedTools,
        abortSignal: options.abortSignal,
        onStepFinish: (info: { stepNumber: number; text: string; finishReason: string }) => {
          currentStep = (info.stepNumber || 1) + 1;
          if (info.text) {
            broadcast({
              type: 'thought',
              payload: { step: info.stepNumber || currentStep, text: info.text },
              timestamp: Date.now(),
            });
          }
        },
      });

      const stepsCount = Math.max(1, loopResult.stepsCount || 1);
      let finalAnswer: string = loopResult.text || '';

      // 会话历史 = 输入消息 + SDK 产出的标准 assistant/tool 消息
      const conversation: Array<{ role: 'user' | 'assistant' | 'tool'; content: any }> = [
        ...baseMessages,
        ...(loopResult.responseMessages || []),
      ];

      // 步数耗尽（模型仍想调工具被 stopWhen 截停）或没有文本产出：
      // 追加一轮【禁用工具】的强制总结，尽力交付结论而非报错
      const needsWrapUp = Boolean(loopResult.stepsExhausted) || !finalAnswer;
      if (needsWrapUp) {
        if (loopResult.stepsExhausted) {
          broadcast({
            type: 'thought',
            payload: { step: stepsCount, text: `已达步数上限（${maxSteps} 步），正在做最终总结…` },
            timestamp: Date.now(),
          });
        }
        try {
          const wrapResult: ModelStepResult = await (this.ctx as any).model.invokeStep({
            model: options.model,
            system: `${options.system || '你是一个专业高效的自主执行智能体。'}\n\n【重要】可用步数已全部用完，禁止再调用任何工具。请立即基于以上已收集的信息输出最终总结：已完成什么、未能完成什么、结论与交付物。`,
            messages: conversation as any,
            configOverride: options.configOverride,
            disableTools: true,
          });
          finalAnswer = wrapResult.text || finalAnswer;
        } catch {
          // 总结调用失败时，回退到已有的最后一段文本
        }
      }

      if (!finalAnswer) {
        finalAnswer = loopResult.stepsExhausted
          ? `任务达到步数上限（${maxSteps} 步），未能生成完整结论。建议将任务拆小后重试。`
          : '任务已结束，但未生成文本结论。';
      }

      // 保证会话历史以最终 assistant 回复收尾（正常文本收尾时 SDK 已含该消息，避免重复追加）
      const lastMessage: any = conversation[conversation.length - 1];
      const endsWithFinalAssistant =
        !loopResult.stepsExhausted &&
        Boolean(loopResult.text) &&
        lastMessage &&
        lastMessage.role === 'assistant';
      if (!endsWithFinalAssistant) {
        conversation.push({ role: 'assistant', content: finalAnswer });
      }

      const efficiency = buildEfficiency(stepsCount);
      broadcast({
        type: 'done',
        payload: {
          taskId,
          stepsCount,
          finalAnswer,
          stepsExhausted: Boolean(loopResult.stepsExhausted),
          efficiency,
        },
        timestamp: Date.now(),
      });

      return {
        taskId,
        success: true,
        stepsCount,
        finalAnswer,
        events,
        messages: conversation,
        efficiency,
      };
    } catch (err: any) {
      const message = options.abortSignal?.aborted
        ? '任务已被主动终止 (Cancelled)'
        : err?.message || String(err);
      broadcast({
        type: 'error',
        payload: { taskId, error: message },
        timestamp: Date.now(),
      });
      return {
        taskId,
        success: false,
        stepsCount: Math.max(0, currentStep - 1),
        finalAnswer: '',
        events,
        efficiency: buildEfficiency(Math.max(0, currentStep - 1)),
        error: message,
      };
    }
  }
}

export const name = 'agtpilot-core';

export function apply(ctx: Context) {
  new AgentService(ctx);
  new OrchestratorService(ctx);
}
