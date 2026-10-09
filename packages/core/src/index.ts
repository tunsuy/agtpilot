import { Context, Service } from '@deepseek-ai/cordis';
import { AgentEvent, ApprovalRequest, ModelStepResult } from '@agtpilot/protocol';

/** 默认步数上限（一步 = 一轮模型调用）。可用环境变量 AGTPILOT_MAX_STEPS 或单任务 maxSteps 覆盖。
 *  40 → 20：熔断器只能兜住部分空转，上限过高会让跑偏任务白烧几十轮才停；
 *  真正的长任务会走"步数耗尽强制总结"路径优雅收尾，任务可继续追问。 */
const DEFAULT_MAX_STEPS = Math.max(1, Number(process.env.AGTPILOT_MAX_STEPS) || 20);
/** 单个工具结果回填模型上下文的字符上限，超长截断，防止上下文膨胀导致模型退化。 */
const TOOL_OUTPUT_LIMIT = 16 * 1024;

// ---- 会话压缩（Compaction，借鉴 Mastra Observer/Reflector 双层思路的轻量实现）----
// 每轮任务结束后检查会话历史：超过阈值时把较早的工具调用/结果消息压成一条
// 结构化纪要（模型总结，失败时退化为原文截断），近期窗口原样保留。
// 原始意图（首条用户消息）、纯文本对话、最近 N 条消息永远不压缩。
/** 压缩触发阈值（估算 tokens，CJK 1 字 ≈ 1 token，其余 4 字符 ≈ 1 token） */
const COMPACT_THRESHOLD_TOKENS = Math.max(2000, Number(process.env.AGTPILOT_COMPACT_THRESHOLD) || 30_000);
/** 近期保护窗口：最近 N 条消息原样保留（不越过 tool 消息边界切断配对） */
const COMPACT_RECENT_MESSAGES = Math.max(4, Number(process.env.AGTPILOT_COMPACT_RECENT) || 10);
/** 单条工具结果进入纪要摘要时的截断长度（字符） */
const COMPACT_DIGEST_ENTRY_LIMIT = 600;

// ---- 死循环熔断（滑动窗口计数）----
/** 统计窗口：最近 N 次工具调用 */
const LOOP_WINDOW_SIZE = 20;
/** 窗口内同一签名（工具名 + 归一化参数）出现次数达到该值即熔断 */
const LOOP_TRIGGER_COUNT = 4;

/** 高危操作审批等待上限（毫秒），超时自动拒绝并释放任务，杜绝永久悬挂。0 = 永不超时 */
const APPROVAL_TIMEOUT_MS = Math.max(0, Number(process.env.AGTPILOT_APPROVAL_TIMEOUT_MS) || 5 * 60_000);

/** 估算一段文本的 tokens（CJK 按 1 token/字，其余按 1 token/4 字符） */
export function estimateTextTokens(text: string): number {
  let cjk = 0;
  for (const ch of text) {
    if (/[㐀-䶿一-鿿豈-﫿]/.test(ch)) cjk++;
  }
  return Math.ceil(cjk + (text.length - cjk) / 4);
}

/** 取任意消息 content 的可读文本（string 直返，分片数组 JSON 化） */
function messageText(content: any): string {
  if (typeof content === 'string') return content;
  if (content == null) return '';
  try {
    return JSON.stringify(content);
  } catch {
    return '';
  }
}

/** 判断 assistant 消息是否携带 tool-call 分片（压缩时这类消息要和对应 tool 结果一起处理） */
function isToolCallMessage(message: any): boolean {
  return (
    Array.isArray(message?.content) &&
    message.content.some((p: any) => p?.type === 'tool-call' || (p && typeof p.toolCallId === 'string'))
  );
}

function truncateText(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}…(截断)` : text;
}

// ---- 工具输出截断策略（头尾混合）----
// 依据 lost-in-the-middle 研究（Liu et al.）：LLM 注意力呈 U 形，
// 头部和尾部召回率最高、中间是盲区；且报错/结论/最新状态往往在输出尾部
// （日志堆栈、构建失败原因）。纯取头会把这些关键信息丢掉。
// 按工具类型自适应比例：命令/日志类尾优先（尾 70%），结构化/内容类头优先（头 70%）。
/** 尾部优先的工具组前缀（命令执行/版本控制输出：错误与结论在尾部） */
const TAIL_FIRST_PREFIXES = ['sandbox_', 'git_'];

/**
 * 头尾混合截断：保留头部与尾部、丢弃中间，并标记省略量。
 * 模型需要中间内容时会看到省略量与续读指引，可用更精确的参数缩小输出范围，
 * 而不是整体重取（重取是步数空转的典型来源）。
 */
function truncateToolOutput(text: string, toolName: string, limit: number): string {
  const tailFirst = TAIL_FIRST_PREFIXES.some((p) => toolName.startsWith(p));
  const headRatio = tailFirst ? 0.3 : 0.7;
  const headLen = Math.floor(limit * headRatio);
  const tailLen = limit - headLen;
  const omitted = text.length - headLen - tailLen;
  const head = text.slice(0, headLen);
  const tail = text.slice(text.length - tailLen);
  return (
    `${head}\n` +
    `…[输出过长已截断（原始 ${text.length} 字符）：${tailFirst ? '命令/日志类输出，尾优先' : '内容类输出，头优先'}——` +
    `保留头部 ${headLen} 字符 + 尾部 ${tailLen} 字符，中间省略 ${omitted} 字符。` +
    `若工具支持 offset 参数可携带 offset 续读；需要中间内容时请用更精确的参数缩小输出范围，不要整体重取]…\n` +
    `${tail}`
  );
}

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

    // 死循环熔断状态：滑动窗口签名计数。窗口内同一签名（工具名 + 归一化参数）
    // 累计出现达到阈值即熔断。相比旧版"只查与上一次调用是否相同"，能同时抓住：
    // 1) A→B→A→B 交替空转（每次都和上一次不同，旧版永远重置计数）；
    // 2) 微调参数式重试（stableStringify 归一化后签名相同）。
    const signatureWindow: string[] = [];
    const signatureCounts = new Map<string, number>();
    // 连续失败守卫：同一工具连续报错达到阈值后，在结果里注入换思路提示
    let lastFailedTool = '';
    let consecutiveFailures = 0;
    const FAILURE_GUARD_THRESHOLD = 3;
    // 效率统计（识别空转任务）
    const stats = { toolCalls: 0, failedCalls: 0, skippedCalls: 0, approvalRejected: 0 };
    // 当前步序号（1-based，供工具会话上下文使用）
    let currentStep = 1;

    // ---- 工具包装层：熔断 + 审批门 + 事件广播 + 结果截断 + 效率统计 + 看板自动推进 ----
    // 全局注册工具 + 任务级附加工具（taskTools，如 MCP 用户连接器）；同名时任务级优先
    const globalTools = this.ctx.agent.getTools();
    const taskTools = options.taskTools || [];
    const taskToolNames = new Set(taskTools.map((t) => t.name));
    const allTools = [...globalTools.filter((g) => !taskToolNames.has(g.name)), ...taskTools];
    const loopTools = allTools.map((toolDef) => ({
      name: toolDef.name,
      description: toolDef.description,
      parameters: toolDef.parameters, // 透传真实 JSON Schema，模型不再盲猜参数
      execute: async (args: any): Promise<any> => {
        stats.toolCalls++;
        // 死循环检测 (Loop Detector)：滑动窗口计数见上；熔断降级为跳过本次调用
        // 并返回提醒，让模型换思路，而非终止整个任务
        const toolSignature = `${toolDef.name}:${JSON.stringify(stableStringify(args))}`;
        signatureWindow.push(toolSignature);
        signatureCounts.set(toolSignature, (signatureCounts.get(toolSignature) || 0) + 1);
        if (signatureWindow.length > LOOP_WINDOW_SIZE) {
          const evicted = signatureWindow.shift()!;
          const remaining = (signatureCounts.get(evicted) || 1) - 1;
          if (remaining <= 0) signatureCounts.delete(evicted);
          else signatureCounts.set(evicted, remaining);
        }
        const occurrences = signatureCounts.get(toolSignature) || 1;
        if (occurrences >= LOOP_TRIGGER_COUNT) {
          stats.skippedCalls++;
          return {
            skipped: true,
            message: `[Loop Detector] 工具 [${toolDef.name}] 在最近 ${LOOP_WINDOW_SIZE} 次调用中以相同（归一化后）参数出现了 ${occurrences} 次，疑似空转循环，本次已被跳过。请更换思路（调整参数、改用其他工具，或基于已有信息直接总结给出最终回答），不要重复相同调用。`,
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
            let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
            const settle = (value: boolean) => {
              if (timeoutTimer) clearTimeout(timeoutTimer);
              this.pendingApprovals.delete(approvalId);
              resolve(value);
            };
            this.pendingApprovals.set(approvalId, settle);
            const onAbort = () => {
              if (this.pendingApprovals.has(approvalId)) settle(false);
            };
            if (options.abortSignal?.aborted) {
              onAbort();
            } else {
              options.abortSignal?.addEventListener('abort', onAbort, { once: true });
            }
            if (APPROVAL_TIMEOUT_MS > 0) {
              timeoutTimer = setTimeout(() => {
                // 超时自动拒绝：拒绝结果照常回填给模型（走 rejected 兜底路径），
                // 并广播 approval_resolved 让前端撤下审批卡片、任务状态恢复 ACTIVE
                broadcast({
                  type: 'approval_resolved',
                  payload: { id: approvalId, approved: false, reason: 'timeout' },
                  timestamp: Date.now(),
                });
                settle(false);
              }, APPROVAL_TIMEOUT_MS);
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
          output = await toolDef.execute(args, { taskId, step: currentStep, env: options.taskEnv });
        } catch (err: any) {
          output = { error: err.message };
        }

        // 失败统计 + 连续失败守卫：同一工具连续失败达阈值时注入换思路提示
        //（仍然返回真实报错，不拦截执行，避免误杀合法的重试序列）
        const callFailed = Boolean(output && typeof output === 'object' && 'error' in output);
        const callSkippedOrRejected = Boolean(
          output && typeof output === 'object' && (output.skipped || output.rejected)
        );
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
          // 看板自动推进：真实工具执行成功即推进当前 in_progress 的计划步骤。
          // 模型不再需要为"汇报进度"单独花一轮调用 planner_update_task ——
          // 这是"本该 2 步的任务跑 6 步"的最大膨胀源（每个阶段一次汇报调用）。
          // 失败（可能合法重试）、被熔断跳过、被审批拒绝的调用不推进。
          if (!callSkippedOrRejected) {
            try {
              (this.ctx as any).planner?.noteToolResult?.(taskId, toolDef.name);
            } catch {
              // 看板推进失败不影响主流程
            }
          }
        }

        // 广播工具执行结果
        broadcast({
          type: 'tool_result',
          payload: { tool: toolDef.name, output },
          timestamp: Date.now(),
        });

        // 超长结果截断（头尾混合，防上下文膨胀导致模型退化）：
        // 见 truncateToolOutput —— 尾 > 头 > 中间的注意力分布 + 报错在尾部的经验
        const serialized = typeof output === 'string' ? output : JSON.stringify(output);
        if (serialized.length > TOOL_OUTPUT_LIMIT) {
          return truncateToolOutput(serialized, toolDef.name, TOOL_OUTPUT_LIMIT);
        }
        return output;
      },
    }));

    // 工具按需挂载：显式指定 > 阈值门（未超线全量）> 关键词路由 > 全量兜底
    // 路由依据 = 本次 prompt + 历史中的近期用户消息（多轮任务里"继续/打开刚才那个链接"
    // 这类跟进指令本身没有关键词，但历史里有）；system 提示词刻意不参与——
    // 它通篇提到 browser_/mcp_，参与匹配会让路由永远退化为全量。
    const routingText = [
      options.prompt,
      ...(options.historyMessages || [])
        .filter((m) => m.role === 'user')
        .slice(-5)
        .map((m) => messageText(m.content)),
    ]
      .filter(Boolean)
      .join('\n');
    const routedTools = selectActiveTools(routingText, allTools, options.activeTools);
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
          '你是一个专业高效的自主执行智能体。你可以根据用户需求灵活调用浏览器等原子工具来完成任务。\n当缺少某个平台的专用工具或连接器未授权时，优先使用 browser_ 系列工具直接在网页上完成操作作为兜底，而不是放弃任务。\n多个互相独立的工具调用请在同一轮并行发出；任务看板由系统随工具执行自动推进，无需调用 planner_update_task 汇报进度。',
        messages: baseMessages as any,
        configOverride: options.configOverride,
        maxSteps,
        tools: loopTools,
        activeTools: routedTools,
        // 每步准备回调（AI SDK v5 prepareStep，每一步模型调用前触发）：
        // 1) 动态路由（仅初始路由已启用时生效）：用近期消息（含工具结果——
        //    搜索结果里出现 URL 自然该把 browser_ 组挂进来）重算本步可见工具，
        //    解决"路由在任务开始时一次性冻结、中途需要的工具永远声明不到"的问题；
        // 2) 任务内压缩（始终启用）：上下文超阈值时把较早的工具消息蒸馏成纪要
        //    并重写本步消息 —— 长研究任务不再等到收尾才压缩，模型全程视野清爽。
        //    压缩后的消息成为循环后续状态（SDK 原生支持 messages 重写），
        //    下一步复查时已低于阈值，天然自限不会每步重复蒸馏。
        prepareStep: async ({ stepNumber, messages }: { stepNumber: number; messages: Array<any> }) => {
          const adjust: { activeTools?: string[]; messages?: Array<any> } = {};
          if (routedTools) {
            const recentText = (messages || [])
              .slice(-8)
              .map((m) => messageText(m.content))
              .join('\n');
            const next = selectActiveTools(recentText, allTools);
            if (next) adjust.activeTools = next;
          }
          try {
            const compacted = await this.compactConversation(messages, options, 'in-loop');
            if (compacted) adjust.messages = compacted;
          } catch {
            // 压缩失败继续用原消息
          }
          return Object.keys(adjust).length > 0 ? adjust : undefined;
        },
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

      // 会话压缩：多轮任务历史无限累积会让模型逐轮退化（越跑越笨、步数越跑越多）。
      // 超过阈值时把较早的工具调用/结果压成一条结构化纪要，近期窗口原样保留。
      let finalMessages: Array<{ role: 'user' | 'assistant' | 'tool'; content: any }> = conversation;
      try {
        finalMessages = ((await this.compactConversation(conversation, options)) as typeof conversation) ?? conversation;
      } catch {
        // 压缩失败不影响任务结果，保留原始历史
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
        messages: finalMessages,
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

  /**
   * 会话压缩（借鉴 Mastra Observer/Reflector 的轻量实现）：
   * - 原始意图（首条用户消息）、纯文本对话、最近 N 条消息永远保留；
   * - 较早的 assistant tool-call / tool 结果消息整体移除，先收集成工具执行流水，
   *   再让模型蒸馏成结构化纪要（【已确立事实】【关键结论】【重要链接】【未决事项】），
   *   以一条 user 消息插回首条用户消息之后；
   * - 旧纪要消息（历史轮次压缩的产物）不保留原文，并入流水重新蒸馏，防多轮累积；
   * - 模型蒸馏失败时退化为原文截断的流水摘录，保证压缩永远有产物；
   * - 近期窗口边界不落在 tool 消息上（tool 结果必须与其 assistant tool-call 配对）。
   *
   * 两个触发相位：'in-loop'（prepareStep 每步检查，长任务不等收尾就地压缩）、
   * 'task-end'（任务收尾时压缩会话历史，供下一轮继承）。
   * 返回 null 表示无需压缩（保持调用方原消息不变）。
   */
  private async compactConversation(
    messages: Array<{ role: string; content: any }>,
    options: TaskOptions,
    phase: 'task-end' | 'in-loop' = 'task-end'
  ): Promise<Array<{ role: string; content: any }> | null> {
    const totalTokens = messages.reduce((acc, m) => acc + estimateTextTokens(messageText(m.content)), 0);
    if (totalTokens < COMPACT_THRESHOLD_TOKENS || messages.length < COMPACT_RECENT_MESSAGES + 2) return null;

    // 近期保护窗口（起点右移直到不落在 tool 消息上）
    let recentStart = Math.max(0, messages.length - COMPACT_RECENT_MESSAGES);
    while (recentStart < messages.length && messages[recentStart].role === 'tool') recentStart++;
    const headKeep = messages[0]?.role === 'user' ? 1 : 0;
    if (recentStart <= headKeep + 1) return null; // 中间区太小，没有压缩价值

    const middle = messages.slice(headKeep, recentStart);
    const digestEntries: string[] = [];
    const keptTexts: Array<{ role: string; content: any }> = [];
    let hasDroppable = false;
    for (const m of middle) {
      const text = messageText(m.content);
      if (m.role === 'tool') {
        digestEntries.push(`[工具结果] ${truncateText(text, COMPACT_DIGEST_ENTRY_LIMIT)}`);
        hasDroppable = true;
      } else if (m.role === 'assistant' && isToolCallMessage(m)) {
        for (const part of m.content as any[]) {
          if (part?.type === 'tool-call' || typeof part?.toolCallId === 'string') {
            digestEntries.push(
              `[工具调用] ${part.toolName ?? '(unknown)'} ${truncateText(messageText(part.input ?? part.args), 200)}`
            );
          }
        }
        hasDroppable = true;
      } else if (typeof m.content === 'string' && m.content.startsWith('【历史会话纪要】')) {
        // 旧纪要并入本次流水重新蒸馏，避免多轮任务后纪要消息自身不断累积
        digestEntries.push(`[旧纪要] ${truncateText(text, 2000)}`);
        hasDroppable = true;
      } else {
        // 纯文本的 user/assistant 消息体积小、信息密度高，原样保留
        keptTexts.push(m);
      }
    }
    if (!hasDroppable) return null; // 没有工具消息可压缩

    this.ctx.agent.emitEvent({
      type: 'thought',
      payload: {
        text: `${
          phase === 'in-loop' ? '任务执行中' : '任务收尾'
        }检测到会话上下文约 ${totalTokens} tokens，超过压缩阈值 ${COMPACT_THRESHOLD_TOKENS}，正在把 ${digestEntries.length} 条历史工具记录蒸馏为纪要…`,
      },
      timestamp: Date.now(),
    });

    const digest = digestEntries.join('\n');
    let summary = '';
    try {
      const model = (this.ctx as any).model;
      if (model?.invokeStep) {
        const result: ModelStepResult = await model.invokeStep({
          system:
            '你是会话压缩器。把以下历史工具调用与结果流水蒸馏成简洁的结构化纪要，供后续对话作为上下文使用。格式：\n【已确立事实】\n【关键结论与数据】\n【重要链接】\n【未决事项】\n只保留对继续当前任务有信息量的内容，忽略重复与失败细节，总长不超过 800 字。',
          messages: [{ role: 'user', content: digest }] as any,
          disableTools: true,
          configOverride: options.configOverride,
        });
        if (result?.text) summary = result.text;
      }
    } catch {
      // 蒸馏失败走兜底
    }
    if (!summary) {
      summary = `以下为历史工具执行流水（原文截断保底）：\n${truncateText(digest, 8 * 1024)}`;
    }

    return [
      ...messages.slice(0, headKeep),
      {
        role: 'user',
        content: `【历史会话纪要】（系统自动压缩生成，替代更早的工具执行记录）\n${summary}`,
      },
      ...keptTexts,
      ...messages.slice(recentStart),
    ];
  }
}

export const name = 'agtpilot-core';

export function apply(ctx: Context) {
  new AgentService(ctx);
  new OrchestratorService(ctx);
}
