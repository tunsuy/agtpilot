import { Context, Service } from '@deepseek-ai/cordis';
import { AgentEvent, ApprovalRequest, ModelStepResult } from '@agtpilot/protocol';
import {
  ToolDefinition,
  ModelGateway,
  PlannerNotifier,
  AgentLoopTool,
  ModelStreamTelemetry,
} from './contracts';
import {
  selectActiveTools,
  widenMountedTools,
  filterToolsByEnv,
  stableStringify,
  estimateTextTokens,
  isSmalltalkPrompt,
} from './routing';
import {
  LOAD_TOOLS_NAME,
  toolCatalogEnabled,
  buildToolCatalogNote,
  createLoadToolsDefinition,
} from './tool-catalog';
import { messageText, truncateToolOutput, buildSpillPointer, toolSpillEnabled, effectiveOutputLimit } from './text';
import { stripReasoningParts, reasoningStripEnabled } from './reasoning';
import { compactConversationMessages } from './compaction';
import {
  effectiveCompactThreshold,
  estimateToolsBlockTokens,
  historyTokenBudget,
} from './context-budget';
import { appendBackgroundNotice, appendBoardReminder, appendStepNotice, appendUserMessage } from './notice';
import { ToolGate } from './tool-gate';
import type { TaskOptions, TaskResult, TaskEfficiency } from './task-types';

/** 默认步数上限（一步 = 一轮模型调用）。可用环境变量 AGTPILOT_MAX_STEPS 或单任务 maxSteps 覆盖。
 *  40 → 20：熔断器只能兜住部分空转，上限过高会让跑偏任务白烧几十轮才停；
 *  真正的长任务会走"步数耗尽强制总结"路径优雅收尾，任务可继续追问。 */
const DEFAULT_MAX_STEPS = Math.max(1, Number(process.env.AGTPILOT_MAX_STEPS) || 20);

// ---- 死循环熔断（滑动窗口计数）----
/** 统计窗口：最近 N 次工具调用 */
const LOOP_WINDOW_SIZE = 20;
/** 窗口内同一签名（工具名 + 归一化参数）出现次数达到该值即熔断 */
const LOOP_TRIGGER_COUNT = 4;

// ---- 只读工具结果复用（TTL 缓存）----
/** 复用窗口：上下文压缩把早前的调用记录抹掉后,模型的失忆性重发多在 1 分钟内;
 *  5 分钟覆盖典型场景,又不至于长时间吃陈旧数据 */
const TOOL_RESULT_CACHE_TTL_MS = 5 * 60_000;
/** 缓存条数上限（FIFO 淘汰,防长任务内存膨胀） */
const TOOL_RESULT_CACHE_MAX = 32;

/** 工具「空返回」判定：null/undefined、空白串、空数组、无任何键的对象。
 *  框架把「返回空」当成功会系统性高估有效率 —— 生产实测 17 次调用中 4 次
 *  空返回,效率线仍报「失败 0 · 有效率 100%」。报错/跳过/拒绝各有口径,不算空返回。 */
export function isEmptyToolOutput(out: any): boolean {
  if (out == null) return true;
  if (typeof out === 'string') return out.trim().length === 0;
  if (Array.isArray(out)) return out.length === 0;
  if (typeof out === 'object') return Object.keys(out).length === 0;
  return false;
}

/** 输出截断判定：finishReason=length（单轮输出上限触顶）且文本里留有未闭合的
 *  tool_call 标签 = 模型在「写工具调用」途中被截停。残段若被当最终答复收口，
 *  任务会零工具执行、零交付物却落 DONE（生产实例 2026-10-16：PPT 演示稿任务，
 *  reasoning 吃掉输出预算，tool_call 标签写到一半被截，解析器一个调用也提不出）。 */
export function isCutOffToolCall(finishReason: string, text: string): boolean {
  if (finishReason !== 'length' || !text) return false;
  const open = (text.match(/<tool_call>/g) || []).length;
  const close = (text.match(/<\/tool_call>/g) || []).length;
  return open > close;
}

/** 答案正文截断判定：finishReason=length 且残段里【没有】未闭合 tool_call 标签 ——
 *  思考烧光单轮输出预算，答复正文刚开头就被截停。与 isCutOffToolCall 互补：length
 *  下二者必居其一（标签未闭合 = 工具调用截停；无标签 = 正文截停），同样必须送强制
 *  总结收口而不是当成功（生产实例 2026-10-22：《万棺之主》日更巡航，reasoning 约
 *  4.5 万 token 把单轮输出预算耗尽，正文只吐出 1 个字符"【"，任务零交付却落 DONE）。 */
export function isCutOffAnswer(finishReason: string, text: string): boolean {
  if (finishReason !== 'length' || !text) return false;
  return !isCutOffToolCall(finishReason, text);
}

/** 高危操作审批等待上限（毫秒），超时自动拒绝并释放任务，杜绝永久悬挂。0 = 永不超时 */
const APPROVAL_TIMEOUT_MS = Math.max(0, Number(process.env.AGTPILOT_APPROVAL_TIMEOUT_MS) || 5 * 60_000);

/** 看板滞后催促阈值：连续 N 轮「真实工具成功但模型未申报看板」时注入一条同步提醒 */
const BOARD_LAG_THRESHOLD = 2;

/** 缺省系统提示（CLI 单用户路径；Web 层传入自己的产品化提示） */
export const DEFAULT_SYSTEM_PROMPT =
  '你是一个专业高效的自主执行智能体。你可以根据用户需求灵活调用已接入的原子工具来完成任务。\n' +
  '涉及多个异构动作的复杂任务，先用 planner_create_plan 建立任务看板再开始执行；简单任务直接执行，不要建看板。\n' +
  '当缺少某个平台的专用工具或连接器未授权时，优先使用可用的网页浏览类工具直接在网页上完成操作作为兜底，而不是放弃任务。\n' +
  '多个互相独立的工具调用请在同一轮并行发起。独立检索尤其如此：把主题拆成多个不同角度的关键词/信息源，一轮批量发出全部搜索，等结果齐了再汇总决定下一步 —— 每轮只发一个查询会成倍浪费模型往返与上下文重发；浏览多个互不依赖的网页同理。看板状态由你维护：步骤完成的当轮在与实际工具调用同一批里调用 planner_update_task 标记 completed（附一句话成果），开始新步骤时同批标记 in_progress；严禁为汇报进度单独花一轮。\n' +
  '若挂载了 ask_user 工具：需求存在多种合理解读且不同解读导致明显不同的交付方向时，先弹问题卡（2-4 个具体选项、标注推荐项）等用户回答，不要逐个方向试探消耗轮次；能自行查证的细节与不影响方向的琐事自行拍板，同一任务提问不超过 2 次。\n' +
  '若挂载了 confirm_plan 工具：大任务（多步执行/外部副作用/高成本）建好看板后、动手前把计划概要与任务清单弹给用户确认，approved 后开工、有修改意见按意见改完直接执行；每任务至多一次，小任务与闲聊严禁调用。';

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
   *   全部交给模型网关（ModelGateway，plugin-model 实现）内置的 agent loop；
   * - 产品差异化逻辑保留在本层：死循环熔断、高危操作审批（HITL）、
   *   标准化事件广播、工具结果截断、步数耗尽强制总结收尾、
   *   任务内会话压缩、运行中消息检查点（agtpilot/checkpoint）。
   */
  async runTask(options: TaskOptions): Promise<TaskResult> {
    // 依赖守卫：模型网关缺失时在入口给出明确错误，而不是裸奔到第一次调用
    const model = this.ctx.reflect.get('model');
    if (!model) {
      throw new Error(
        '[agtpilot-core] 缺少 model 服务（ModelGateway 实现）。请先加载 @agtpilot/plugin-model 或注册同名服务。'
      );
    }

    const taskId = options.taskId || `task_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS;
    const events: AgentEvent[] = [];

    const broadcast = (event: AgentEvent) => {
      // 事件统一盖章 taskId（payload 顶层）：observability 追踪与前端按任务
      // 过滤的归属锚点 —— 多用户并发时不过滤会把 A 的事件挂到 B 的任务上
      const stamped: AgentEvent = {
        ...event,
        payload: { ...(event.payload || {}), taskId },
      };
      events.push(stamped);
      this.ctx.agent.emitEvent(stamped);
      if (options.onEvent) {
        options.onEvent(stamped);
      }
    };

    // reasoning 剥离计数(三道闸合计,进 TaskEfficiency 供生产验证节省效果)
    let reasoningPartsStripped = 0;
    // 闸1(入口):剥离存量历史里的 reasoning 部件 —— 剥离上线前落盘的 mission
    // 续聊轮不再把历史思考重发回 provider;新历史(闸3 已剥)幂等零开销。
    // 保险丝 AGTPILOT_STRIP_REASONING=0 时三道闸整体回退(见 reasoning.ts)
    let historyIn =
      options.historyMessages && options.historyMessages.length > 0
        ? options.historyMessages
        : [];
    if (reasoningStripEnabled() && historyIn.length > 0) {
      const r = stripReasoningParts(historyIn);
      reasoningPartsStripped += r.stripped;
      historyIn = r.messages;
    }
    const baseMessages: Array<{ role: 'user' | 'assistant' | 'tool'; content: any }> =
      historyIn.length > 0
        ? [...historyIn, { role: 'user', content: options.prompt }]
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
    // 效率统计（识别空转任务）；emptyCalls = 成功口径下的空返回,dedupedCalls = 只读复用
    const stats = { toolCalls: 0, failedCalls: 0, skippedCalls: 0, approvalRejected: 0, emptyCalls: 0, dedupedCalls: 0, spilledOutputs: 0, spilledChars: 0 };
    // 只读工具结果缓存：TTL 内同签名（工具名 + 归一化参数）直接复用,不重新执行。
    // 非只读工具绝不入缓存（两次 email_send 可能都是合法的）。
    const toolResultCache = new Map<string, { at: number; output: any }>();
    // 看板滞后检测状态(业界同款契约:看板进度由模型显式申报,内核只催不推):
    // - roundRealToolSuccess:本轮是否有「真实工具成功且模型未申报看板」
    //   (元工具 planner_/memory_/router_/observability_ 不算真实推进;
    //   planner_ 系执行本身就是显式申报,直接把滞后清零);
    // - boardLagRounds:连续滞后的轮数,达 BOARD_LAG_THRESHOLD 时在下一步
    //   注入一条看板同步提醒(PlannerNotifier.boardLagNotice 取文本)并清零,
    //   把「模型忘了申报」变成一轮内自愈的显式事件,而不是静默漂移。
    let boardLagRounds = 0;
    let roundRealToolSuccess = false;
    // 只读并行门控(读写锁,一次任务一把):SDK 对同轮全部工具调用是 Promise.all
    // 并发触发的 —— readOnly 工具保留并发红利,非只读工具经此收敛为独占串行
    const toolGate = new ToolGate();
    // 当前步序号（1-based，供工具会话上下文使用）
    let currentStep = 1;

    // ---- 工具包装层：熔断 + 审批门 + 事件广播 + 结果截断 + 效率统计 + 看板滞后检测 ----
    // 全局注册工具 + 任务级附加工具（taskTools，如 MCP 用户连接器）；同名时任务级优先
    const globalTools = this.ctx.agent.getTools();
    const taskTools = options.taskTools || [];
    const taskToolNames = new Set(taskTools.map((t) => t.name));
    const mergedTools = [...globalTools.filter((g) => !taskToolNames.has(g.name)), ...taskTools];
    // P5 缺 Key 工具不挂载:剔除后下游(路由/loopTools/效率统计)全部只见
    // availableTools;被剔除清单写进系统提示,模型在决策点就改用替代工具
    const { mounted: allTools, missingKeyTools } = filterToolsByEnv(mergedTools, options.taskEnv);
    // 「缺 Key」事实传导到模型可见层(P5 长期项):替代 auto-distill 记忆
    // 「存了但模型下次仍照调」的断链 —— 决策点直接告知不要调用 + 指引替代
    const missingKeyNote =
      missingKeyTools.length > 0
        ? '\n\n【工具可用性】以下工具因对应服务 Key 未配置,本次未挂载:' +
          missingKeyTools
            .map((t) => `${t.name}(${(t.requiredEnv || []).join('/')})`)
            .join('、') +
          '。不要尝试调用它们,请直接使用已挂载的替代工具完成任务;确需启用时,在最终答复中提示用户在个人空间配置对应 Key 后重新发起任务。'
        : '';
    // 工具按需挂载：显式指定 > 阈值门（未超线全量）> 插件注册的关键词规则 > 零命中收敛兜底
    // 路由依据 = 本次 prompt + 历史中的近期用户消息（多轮任务里"继续/打开刚才那个链接"
    // 这类跟进指令本身没有关键词，但历史里有）；system 提示词刻意不参与——
    // 它通篇提到各工具名，参与匹配会让路由永远退化为全量。
    // 路由计算先于 loopTools/系统提示定型:层0 目录卡片(下方)要按「哪些
    // catalogable 工具没挂」决定注入与否,load_tools 也要走同一条工具包装管道。
    const routingText = [
      options.prompt,
      ...(options.historyMessages || [])
        .filter((m) => m.role === 'user')
        .slice(-5)
        .map((m) => messageText(m.content)),
    ]
      .filter(Boolean)
      .join('\n');
    const routedTools = selectActiveTools(
      routingText,
      allTools,
      this.ctx.agent.getToolRoutes(),
      options.activeTools
    );
    // 任务内路由结果「只扩不缩」：mountedNames 冻结为初始路由集合，
    // 每步重算只并入新增（如工具结果里出现 URL → 把浏览器组扩进来），
    // 集合不变/缩容都不写回 —— 工具声明前缀跨步稳定，provider 前缀缓存
    // （DeepSeek/OpenAI 自动缓存）不再每步 miss 全价重付 schema + 历史前缀。
    const mountedNames = new Set<string>(routedTools || []);
    let toolsMounted = routedTools ? routedTools.length : allTools.length;

    // ---- 层0 目录卡片(菜单点菜制 B v1,token 文档 §9.4)----
    // 自由任务(无工坊白名单、路由已启用、非闲聊短路)里,未挂载的 catalogable
    // 工具(检索侧插件自声明,当前 = plugin-mcp 连接器工具)以一行卡片进系统
    // 提示【按需工具目录】,并注入 load_tools 元工具:模型点名 → loadedToolNames
    // → 下一步 prepareStep 并入挂载面(schema 上线)。不注入的档位:工坊白名单
    // (确定性挂载照旧)、routedTools undefined 的全量挂载档(人人有 schema)、
    // 闲聊短路档(只挂 baseline,与 MCP 无关)。保险丝 AGTPILOT_TOOL_CATALOG=0。
    const loadedToolNames = new Set<string>();
    // 效率统计口径:toolsTotal 不含任务级合成的 load_tools(与历史 mission 可比)
    const toolsTotalBase = allTools.length;
    let catalogNote = '';
    let initialActiveTools = routedTools;
    if (
      toolCatalogEnabled() &&
      routedTools !== undefined &&
      !(options.activeTools && options.activeTools.length > 0) &&
      !isSmalltalkPrompt(routingText)
    ) {
      const catalogTools = allTools.filter((t) => t.catalogable && !mountedNames.has(t.name));
      const note = buildToolCatalogNote(catalogTools);
      if (note) {
        catalogNote = note;
        // load_tools 并入 allTools 后走与其他工具完全相同的包装管道(广播/
        // 熔断/审批门/截断);它不进全局注册表 → 子 agent 不可见,双钥匙不变
        allTools.push(
          createLoadToolsDefinition({
            catalog: catalogTools,
            isMounted: (n) => mountedNames.has(n) || loadedToolNames.has(n),
            onLoad: (loaded, unknown) => {
              for (const n of loaded) loadedToolNames.add(n);
              // 观测事件:每次点名单一条 = 目录命中分布样本(§9.4 想要的
              // 服务端数据由 B 自身自动采集);cordis 自定义事件,不进 SSE
              this.ctx.emit('agtpilot/tool-catalog', {
                taskId,
                step: currentStep,
                loaded,
                unknown,
              });
            },
          })
        );
        mountedNames.add(LOAD_TOOLS_NAME);
        toolsMounted = mountedNames.size;
        // 初始挂载面带上 load_tools(routedTools 序 + 尾部追加,字节稳定)
        initialActiveTools = Array.from(mountedNames);
      }
    }
    const systemPrompt = (options.system || DEFAULT_SYSTEM_PROMPT) + missingKeyNote + catalogNote;
    // ---- 动态压缩阈值状态（§9.8，docs/design/token-consumption-and-tool-loading.md）----
    // 压缩的真正约束是模型上下文窗口：每步请求 = system + tools + 历史 + 输出预留。
    // 阈值不再是写死的 30k，而是 min(静态阈值, 窗口×安全系数 − 固定开销 − 输出预留)；
    // 固定开销优先用上一步实测校准（真实 promptTokens − 消息估算），没有实测时用估算。
    const systemPromptTokens = estimateTextTokens(systemPrompt);
    /** 最近一次 prepareStep 实际发送消息的估算 tokens（onStepFinish 用它做实测校准） */
    let lastSentMessagesEst = 0;
    /** 实测校准值：上一步 promptTokens − 消息估算 = system+tools+协议衬垫的真实开销 */
    let calibratedFixedCost: number | undefined;
    /** 收尾相位（强制总结/task-end 压缩）阈值：不带工具上线，tools 块按 0 计 */
    const endPhaseThreshold = (): number =>
      effectiveCompactThreshold({
        systemTokens: systemPromptTokens,
        toolsTokens: 0,
        calibratedFixedCost,
      });
    const loopTools: AgentLoopTool[] = allTools.map((toolDef) => ({
      name: toolDef.name,
      description: toolDef.description,
      parameters: toolDef.parameters, // 透传真实 JSON Schema，模型不再盲猜参数
      execute: async (args: any): Promise<any> => {
        const toolSignature = `${toolDef.name}:${JSON.stringify(stableStringify(args))}`;
        // 物理调用 id:tool_call/tool_result 事件与 ToolSession 双通道携带。
        // 前端步骤记录按它精确对应 —— 同轮并行多工具 + 插件层双广播下,
        // 「工具名+末位位置」倒查会关错步骤/留孤儿「执行中」(生产实例
        // 2026-10-14:重复步骤对、入参与出参交叉、虚假百秒耗时)
        const callId = `call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        // 只读工具结果复用：上下文压缩会抹掉早前的工具记录,模型「失忆」后重发
        // 同参数查询（生产实测:17 次调用里 5 对完全重复）。TTL 内直接复用:
        // 不重新执行、不计入 toolCalls、单独计 dedupedCalls,事件流照常广播
        //（UI 上该次调用照实展示,结果带 deduplicated 标记）。
        if (toolDef.readOnly) {
          const hit = toolResultCache.get(toolSignature);
          if (hit && Date.now() - hit.at < TOOL_RESULT_CACHE_TTL_MS) {
            stats.dedupedCalls++;
            broadcast({ type: 'tool_call', payload: { tool: toolDef.name, args, callId }, timestamp: Date.now() });
            broadcast({
              type: 'tool_result',
              payload: { tool: toolDef.name, output: hit.output, deduplicated: true, callId },
              timestamp: Date.now(),
            });
            return hit.output;
          }
        }
        stats.toolCalls++;
        // 死循环检测 (Loop Detector)：滑动窗口计数见上；熔断降级为跳过本次调用
        // 并返回提醒，让模型换思路，而非终止整个任务
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
          payload: { tool: toolDef.name, args, callId },
          timestamp: Date.now(),
        });

        // 真实调用工具(经只读并行门控:readOnly 并行、其余独占串行。
        // 审批等待在门控之外已完成,不会拿着独占锁等人工审批)
        const invoke = async (): Promise<any> => {
          try {
            return await toolDef.execute(args, {
              taskId,
              step: currentStep,
              env: options.taskEnv,
              userId: options.userId,
              sandbox: options.taskSandbox,
              callId,
              ...(options.activeTools ? { activeTools: options.activeTools } : {}),
            });
          } catch (err: any) {
            return { error: err.message };
          }
        };
        let output: any = toolDef.readOnly
          ? await toolGate.runReadonly(invoke)
          : await toolGate.runExclusive(invoke);

        // 失败统计 + 连续失败守卫：同一工具连续失败达阈值时注入换思路提示
        //（仍然返回真实报错，不拦截执行，避免误杀合法的重试序列）
        const callFailed = Boolean(output && typeof output === 'object' && 'error' in output);
        const callSkippedOrRejected = Boolean(
          output && typeof output === 'object' && (output.skipped || output.rejected)
        );
        // 空返回统计：「返回空」既不是失败也不是有效调用 —— 单独计数,
        // 有效率口径从 (总-失败-跳过)/总 收紧为 (总-失败-跳过-空返回)/总
        const callEmpty = !callFailed && !callSkippedOrRejected && isEmptyToolOutput(output);
        if (callEmpty) stats.emptyCalls++;
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
          // 看板滞后计数(替代旧的自动推进入队):真实工具成功但模型未申报
          // 看板的轮数。planner_ 系工具执行本身就是显式申报 → 滞后清零;
          // 元工具(memory_/router_/observability_)不产出任务交付物,不计;
          // 失败/被熔断跳过/被审批拒绝/空返回不算真实推进。
          if (/^planner_/.test(toolDef.name)) {
            boardLagRounds = 0;
          } else if (!callSkippedOrRejected && !callEmpty && !/^(memory_|router_|observability_)/.test(toolDef.name)) {
            roundRealToolSuccess = true;
          }
        }

        // 超长结果治理(docs/design/tool-output-spill.md):先试全量落盘换
        // 「预览+指针」(可恢复,read_tool_output 续读),无回调/落盘失败/保险丝关
        // → 回退头尾混合截断(truncateToolOutput —— 尾 > 头 > 中间的注意力分布
        // + 报错在尾部的经验)。落盘决策先于广播,tool_result 事件得以携带
        // spilled 元数据;广播的 output 始终为全量原文 —— UI 展示不受截断影响。
        // 限额 = 工具级 outputCap(层1 源头裁剪 ②)与 TOOL_OUTPUT_LIMIT 的较小者
        // (effectiveOutputLimit);未声明 outputCap 的工具行为与从前逐字节一致。
        const serialized = typeof output === 'string' ? output : JSON.stringify(output);
        const outputLimit = effectiveOutputLimit(toolDef.outputCap);
        let finalOutput: any = output;
        let spillInfo: { callId: string; originalChars: number } | undefined;
        if (serialized.length > outputLimit) {
          let storedRef: string | null = null;
          if (toolSpillEnabled() && options.spillToolOutput) {
            try {
              const r = await options.spillToolOutput({
                taskId,
                callId,
                toolName: toolDef.name,
                fullText: serialized,
              });
              if (typeof r === 'string' && r.length > 0) storedRef = r;
            } catch {
              storedRef = null; // 落盘失败绝不失败工具调用 —— 降级为现行截断
            }
          }
          if (storedRef !== null) {
            stats.spilledOutputs++;
            stats.spilledChars += serialized.length;
            spillInfo = { callId, originalChars: serialized.length };
            finalOutput = buildSpillPointer(serialized, toolDef.name, callId);
          } else {
            finalOutput = truncateToolOutput(serialized, toolDef.name, outputLimit);
          }
        }

        // 广播工具执行结果（compensation 透传：持久化层随步骤快照落盘回滚把手，
        // 治理不变量 I5 —— 每个行动都要留下可回滚/可追责的元数据;
        // spilled = 本次输出已全量落盘的元数据,前端「已保存」徽章用）
        broadcast({
          type: 'tool_result',
          payload: {
            tool: toolDef.name,
            output,
            callId,
            ...(toolDef.compensation ? { compensation: toolDef.compensation } : {}),
            ...(spillInfo ? { spilled: spillInfo } : {}),
          },
          timestamp: Date.now(),
        });
        // 只读且拿到非空数据的调用入缓存（缓存的是模型实际拿到的 finalOutput,
        // 复用时不再二次截断）；空返回不缓存 —— 可能是瞬时故障,重试可能成功
        if (toolDef.readOnly && !callFailed && !callSkippedOrRejected && !callEmpty) {
          if (toolResultCache.size >= TOOL_RESULT_CACHE_MAX) {
            toolResultCache.delete(toolResultCache.keys().next().value as string);
          }
          toolResultCache.set(toolSignature, { at: Date.now(), output: finalOutput });
        }
        return finalOutput;
      },
    }));

    // 用量累计（成本可观测）：loop 主循环 + 步数耗尽后的强制总结轮都要付费；
    // 先声明后赋值 —— buildEfficiency 闭包在收尾时读取最终值
    let usageAcc = { promptTokens: 0, completionTokens: 0 };
    // 实时上报记账：agtpilot/usage 改为逐步发增量（agent-backend 累计进 mission.usage
    // 并轻量透传前端），收尾只补 SDK 汇总口径与逐步汇报的残差，防双计
    const usageEmitted = { promptTokens: 0, completionTokens: 0 };
    const emitUsageDelta = (delta: { promptTokens?: number; completionTokens?: number }) => {
      const p = Number.isFinite(delta?.promptTokens) ? (delta!.promptTokens as number) : 0;
      const c = Number.isFinite(delta?.completionTokens) ? (delta!.completionTokens as number) : 0;
      if (p + c <= 0) return; // 残差为负/零:不发
      usageEmitted.promptTokens += p;
      usageEmitted.completionTokens += c;
      this.ctx.emit('agtpilot/usage', { taskId, promptTokens: p, completionTokens: c });
    };
    const buildEfficiency = (stepsCount: number): TaskEfficiency => ({
      stepsCount,
      toolCalls: stats.toolCalls,
      failedCalls: stats.failedCalls,
      skippedCalls: stats.skippedCalls,
      approvalRejected: stats.approvalRejected,
      emptyCalls: stats.emptyCalls,
      dedupedCalls: stats.dedupedCalls,
      effectiveRate:
        stats.toolCalls > 0
          ? Math.round(
              ((stats.toolCalls - stats.failedCalls - stats.skippedCalls - stats.emptyCalls) / stats.toolCalls) * 100
            ) / 100
          : 1,
      toolsMounted,
      toolsTotal: toolsTotalBase,
      routed: Boolean(routedTools),
      reasoningPartsStripped,
      // spill 计数仅在实际发生时携带(可选字段语义,零落盘时不扰动既有
      // efficiency 形状 —— 历史 mission 与 strict-equal 测试零漂移)
      ...(stats.spilledOutputs > 0
        ? { spilledOutputs: stats.spilledOutputs, spilledChars: stats.spilledChars }
        : {}),
      promptTokens: usageAcc.promptTokens,
      completionTokens: usageAcc.completionTokens,
    });

    try {
      // ---- 主循环：完全交给模型网关的内置 agent loop ----
      const loopResult = await model.runAgentLoop({
        model: options.model,
        system: systemPrompt,
        messages: baseMessages as any,
        configOverride: options.configOverride,
        maxSteps,
        ...(options.tokenBudget !== undefined ? { tokenBudget: options.tokenBudget } : {}),
        tools: loopTools,
        activeTools: initialActiveTools,
        // 每步准备回调（AI SDK v5 prepareStep，每一步模型调用前触发）：
        // 1) 动态路由（仅初始路由已启用时生效）：用近期消息（含工具结果——
        //    搜索结果里出现 URL 自然该把浏览器工具组挂进来）重算本步可见工具，
        //    解决"路由在任务开始时一次性冻结、中途需要的工具永远声明不到"的问题；
        //    重算结果经 widenMountedTools「只扩不缩」并入冻结集合（见其注释——
        //    全量替换会每步打破 provider 前缀缓存，扩容那一步才写回一次）；
        // 2) 任务内压缩（始终启用）：上下文超阈值时把较早的工具消息蒸馏成纪要
        //    并重写本步消息 —— 长研究任务不再等到收尾才压缩，模型全程视野清爽。
        //    压缩后的消息成为循环后续状态（SDK 原生支持 messages 重写），
        //    下一步复查时已低于阈值，天然自限不会每步重复蒸馏。
        // 3) 运行中检查点：把当前（压缩后）消息快照发 agtpilot/checkpoint 事件，
        //    进程崩溃/重启后任务可从最近检查点续跑（消息历史已落盘）。
        // 4) 治理提示注入（回退弧感知通道，getStepNotice 有值时）：把上层排队的
        //    治理事件（记忆被删/授权撤销等）作为一条【系统治理提示】user 消息
        //    追加到本步消息末尾 —— 刻意放在压缩之后，保证提示不被蒸馏掉。
        prepareStep: async ({ stepNumber, messages }: { stepNumber: number; messages: Array<any> }) => {
          const adjust: { activeTools?: string[]; messages?: Array<any> } = {};
          if (routedTools) {
            const recentText = (messages || [])
              .slice(-8)
              .map((m) => messageText(m.content))
              .join('\n');
            // explicit(工坊白名单)必须同步传入:prepareStep 重算若不带它,
            // 关键词路由会把白名单外的工具组(如雷达任务命中「网页/执行」拖进
            // browser/sandbox 全组)经 widenMountedTools 扩容回挂载面,白名单
            // 形同虚设。带上 explicit 后重算结果恒等于白名单∩目录,widen 无
            // 新增可并 —— 声明前缀跨步字节稳定,缓存不破。
            const next = selectActiveTools(
              recentText,
              allTools,
              this.ctx.agent.getToolRoutes(),
              options.activeTools
            );
            let changed = widenMountedTools(mountedNames, next) !== null;
            // 目录点菜(§9.4 B):上一步 load_tools 点名的工具在本步并入挂载面
            // (schema 上线)。与 widen 共用同一次写回 —— 一步内既扩容又点菜
            // 也只破一次前缀缓存;点名只增不减,集合跨步稳定。
            for (const n of loadedToolNames) {
              if (!mountedNames.has(n)) {
                mountedNames.add(n);
                changed = true;
              }
            }
            if (changed) {
              adjust.activeTools = Array.from(mountedNames);
              toolsMounted = adjust.activeTools.length;
            }
          }
          // reasoning 剥离(闸2·循环内):provider 会把消息状态里历史 assistant 的
          // reasoning 部件序列化回本步请求 —— 不剥则单轮思考在 20 步任务里全量
          // 重发 ×19(73 万事件放大器 4)。放在压缩之前:蒸馏输入(messageText 对
          // 数组 content 做 JSON.stringify)同步干净,不再为思考文本二次付费。
          // 只在剥到部件时写回;幂等性保证改写只发生在最新一条 assistant 消息上
          // (上一步已剥的前缀字节稳定),前缀缓存只在尾部破一次,不破 append-only。
          if (reasoningStripEnabled()) {
            const r = stripReasoningParts(adjust.messages ?? messages);
            if (r.stripped > 0) {
              adjust.messages = r.messages;
              reasoningPartsStripped += r.stripped;
            }
          }
          // 动态压缩阈值（§9.8）：按本步实际挂载面估 tools 块,与 system 估算
          // (或上一步实测校准值)一起算历史预算,与静态阈值取小 —— 默认 64k 窗口
          // 下不改变现状,小窗模型/重挂载面下自动收紧,兜住 context_length_exceeded。
          const stepToolsTokens = estimateToolsBlockTokens(
            routedTools ? allTools.filter((t) => mountedNames.has(t.name)) : allTools
          );
          const compactThreshold = effectiveCompactThreshold({
            systemTokens: systemPromptTokens,
            toolsTokens: stepToolsTokens,
            calibratedFixedCost,
          });
          try {
            const compacted = await this.compactConversation(adjust.messages ?? messages, options, 'in-loop', compactThreshold);
            if (compacted) adjust.messages = compacted;
          } catch {
            // 压缩失败继续用原消息
          }
          // 看板滞后催促(压缩之后注入,与治理提示同点位防被蒸馏):上轮真实
          // 工具成功而模型未申报看板 → 滞后轮数累计;达阈值注入一条同步提醒
          // (文本由规划器给出,带当前步骤上下文)并清零计数 —— 防连环催促。
          // 契约见 PlannerNotifier.boardLagNotice:看板进度由模型显式申报
          // (业界同款),内核只负责把「忘了」变成一轮内自愈的催促。
          if (roundRealToolSuccess) {
            roundRealToolSuccess = false;
            boardLagRounds++;
          }
          if (boardLagRounds >= BOARD_LAG_THRESHOLD) {
            const idleRounds = boardLagRounds;
            boardLagRounds = 0;
            try {
              const reminder = this.ctx.reflect.get('planner')?.boardLagNotice(taskId, idleRounds);
              const withReminder = appendBoardReminder(adjust.messages ?? messages, reminder ?? null);
              if (withReminder) adjust.messages = withReminder;
            } catch {
              // 看板提醒获取失败不影响主流程
            }
          }
          if (options.getStepNotice) {
            try {
              const notice = await options.getStepNotice();
              const withNotice = appendStepNotice(adjust.messages ?? messages, notice);
              if (withNotice) adjust.messages = withNotice;
            } catch {
              // 治理提示获取失败不影响主流程
            }
          }
          // 后台任务通知注入(压缩之后,与治理提示同一插入点):派生的后台
          // 子任务完成/失败时,结果摘要在此进入父任务本轮上下文(docs/design/
          // background-child-missions.md)。放在用户追加消息之前:用户消息
          // 离末尾最近、注意力权重最高。多条通知由上层合并成一条
          if (options.getBackgroundNotice) {
            try {
              const bgNotice = await options.getBackgroundNotice();
              const withBgNotice = appendBackgroundNotice(adjust.messages ?? messages, bgNotice);
              if (withBgNotice) adjust.messages = withBgNotice;
            } catch {
              // 后台通知获取失败不影响主流程(消息仍在队列里,下步重试)
            }
          }
          // 用户追加消息注入(压缩之后,与治理提示同一插入点):任务执行中
          // 用户排队的追问在此进入本轮上下文,模型下一步即见(docs/design/
          // mid-run-user-messages.md)。注入的消息经 adjust.messages 进入循环
          // 状态,随 result.messages 落进会话历史,续聊不丢
          if (options.getUserMessages) {
            try {
              const userText = await options.getUserMessages();
              const withUser = appendUserMessage(adjust.messages ?? messages, userText);
              if (withUser) adjust.messages = withUser;
            } catch {
              // 追加消息获取失败不影响主流程(消息仍在队列里,下步重试)
            }
          }
          // 发送前预算护栏（§9.8 双保险①）：治理提示/看板催促/用户追加消息都在
          // 常规压缩之后注入,理论上能把本步重新顶爆窗口。发送前实测一次总账
          // (消息估算 vs 历史预算),超了就地再压一轮(紧急相位,阈值=预算本身);
          // 仍压不下去(全是不可压的近期文本)则如实放行 —— 溢出走诚实失败,不伪造。
          const sendEstimate = (list: Array<any>) =>
            list.reduce((acc: number, m: any) => acc + estimateTextTokens(messageText(m.content)), 0);
          let outbound = adjust.messages ?? messages;
          let outboundEst = sendEstimate(outbound);
          const budget = historyTokenBudget({
            systemTokens: systemPromptTokens,
            toolsTokens: stepToolsTokens,
            calibratedFixedCost,
          });
          if (outboundEst > budget) {
            try {
              const forced = await this.compactConversation(outbound, options, 'in-loop', Math.max(2000, budget));
              if (forced) {
                adjust.messages = forced;
                outbound = forced;
                outboundEst = sendEstimate(forced);
              }
            } catch {
              // 紧急压缩失败:按原消息发送,溢出由 provider 报错如实上浮
            }
          }
          lastSentMessagesEst = outboundEst;
          // 检查点采用本步实际使用的消息（含压缩重写与治理提示注入）
          const finalMessages = outbound;
          try {
            this.ctx.emit('agtpilot/checkpoint', { taskId, stepNumber, messages: finalMessages });
          } catch {
            // 检查点失败不影响主流程
          }
          return Object.keys(adjust).length > 0 ? adjust : undefined;
        },
        abortSignal: options.abortSignal,
        // 流式可见性接线：每步开始 → step_started（前端"正在思考"指示）；
        // 文本/推理增量 → assistant_delta（打字机式输出，kind 区分正文与思考过程）
        onStepStart: ({ stepNumber }: { stepNumber: number }) => {
          broadcast({
            type: 'step_started',
            payload: { stepNumber, reason: 'model-step' },
            timestamp: Date.now(),
          });
        },
        onTextDelta: (delta: string) => {
          broadcast({
            type: 'assistant_delta',
            payload: { delta, kind: 'text' },
            timestamp: Date.now(),
          });
        },
        onReasoningDelta: (delta: string) => {
          broadcast({
            type: 'assistant_delta',
            payload: { delta, kind: 'reasoning' },
            timestamp: Date.now(),
          });
        },
        // 模型流遥测 → 广播（前端任务终端日志实时可见；TTFT/静默告警/流错误/看门狗中止）
        onTelemetry: (info: ModelStreamTelemetry) => {
          broadcast({
            type: 'model_telemetry',
            payload: { ...info },
            timestamp: Date.now(),
          });
        },
        onStepFinish: (info: { stepNumber: number; text: string; finishReason: string; usage?: { promptTokens: number; completionTokens: number } }) => {
          currentStep = (info.stepNumber || 1) + 1;
          // 实时成本：本步账单即刻上行（前端任务执行中就能看到 tokens 在涨）
          if (info.usage) emitUsageDelta(info.usage);
          // 实测校准（§9.8）：真实 promptTokens − 本步发送前的消息估算
          // = system+tools+provider 协议衬垫的真实开销。下一步的动态压缩阈值
          // 优先用它替代估算值 —— 估算口径漂移(分词器差异/缓存计法)不再靠
          // 安全系数硬扛。负值(估算反超真实)钳 0。
          if (info.usage?.promptTokens && lastSentMessagesEst > 0) {
            calibratedFixedCost = Math.max(0, info.usage.promptTokens - lastSentMessagesEst);
          }
          if (info.text) {
            broadcast({
              type: 'thought',
              payload: { step: info.stepNumber || currentStep, text: info.text },
              timestamp: Date.now(),
            });
          }
        },
      });

      // 主循环用量入账（强制总结轮在下方补记，之后统一上报）。
      // 取 max(SDK 汇总, 逐步已发之和)兜底:网关应报全步累计(plugin-model 已
      // 改用 totalUsage),但若某网关退化成只报最后一步(result.usage 旧语义),
      // 效率行会低报数倍(生产实测:逐步累计 126.6k vs 末步 29.1k)。max 之后
      // 下方残差恒 ≥0,负残差被 emitUsageDelta 零闸拦下的旧路径不再依赖。
      usageAcc = {
        promptTokens: Math.max(loopResult.usage?.promptTokens || 0, usageEmitted.promptTokens),
        completionTokens: Math.max(loopResult.usage?.completionTokens || 0, usageEmitted.completionTokens),
      };
      // 残差对账：SDK 汇总与逐步汇报的口径差（如缓存 token 计法差异）
      // 一次性补发；逐步已发够（或超发）时不发 —— mission 总账仍与旧口径一致
      emitUsageDelta({
        promptTokens: usageAcc.promptTokens - usageEmitted.promptTokens,
        completionTokens: usageAcc.completionTokens - usageEmitted.completionTokens,
      });

      const stepsCount = Math.max(1, loopResult.stepsCount || 1);
      let finalAnswer: string = loopResult.text || '';
      // 单轮输出截顶:工具调用残段(isCutOffToolCall)与答复正文残段(isCutOffAnswer)
      // 两种形态都必须送强制总结收口 —— 否则任务零工具执行/零交付却落 DONE
      // (生产实例 2026-10-16 PPT 演示稿;2026-10-22 小说日更巡航正文仅 1 字符)
      // 二者互斥(isCutOffAnswer 显式排除标签未闭合形态),口径由各自分支交代
      const cutOffToolCall = isCutOffToolCall(loopResult.finishReason || '', finalAnswer);
      const cutOffAnswer = isCutOffAnswer(loopResult.finishReason || '', finalAnswer);
      const cutOff = cutOffToolCall || cutOffAnswer;

      // 会话历史 = 输入消息 + SDK 产出的标准 assistant/tool 消息。
      // reasoning 剥离(闸3·装配):SDK responseMessages 保留着最后一步的 reasoning
      // 部件(闸2 只覆盖 prepareStep 可见的步前消息)—— 装配前剥离,保证强制总结
      // invokeStep、task-end 压缩、result.messages 落盘(mission.conversationMessages)
      // 与跨轮续聊重发全部不带思考文本
      let responseMsgs: Array<{ role: 'user' | 'assistant' | 'tool'; content: any }> =
        loopResult.responseMessages || [];
      if (reasoningStripEnabled()) {
        const r = stripReasoningParts(responseMsgs);
        reasoningPartsStripped += r.stripped;
        responseMsgs = r.messages;
      }
      const conversation: Array<{ role: 'user' | 'assistant' | 'tool'; content: any }> = [
        ...baseMessages,
        ...responseMsgs,
      ];

      // 步数耗尽（模型仍想调工具被 stopWhen 截停）或没有文本产出：
      // 追加一轮【禁用工具】的强制总结，尽力交付结论而非报错
      const needsWrapUp = Boolean(loopResult.stepsExhausted) || !finalAnswer || cutOff;
      if (needsWrapUp) {
        if (loopResult.stepsExhausted) {
          broadcast({
            type: 'thought',
            payload: { step: stepsCount, text: `已达步数上限（${maxSteps} 步），正在做最终总结…` },
            timestamp: Date.now(),
          });
        } else if (cutOff) {
          broadcast({
            type: 'thought',
            payload: {
              step: stepsCount,
              text: cutOffAnswer
                ? '上一轮输出被单轮上限截断（思考耗尽输出预算，答复正文刚开头即被截），正在做强制总结…'
                : '上一轮输出被单轮上限截断（工具调用写到一半被截），正在做强制总结…',
            },
            timestamp: Date.now(),
          });
        }
        // 强制总结走非流式 invokeStep，先广播 step_started 让"正在思考"
        // 指示覆盖这 10-60s 的总结窗口
        broadcast({
          type: 'step_started',
          payload: { reason: 'wrap-up' },
          timestamp: Date.now(),
        });
        // 先压缩再收尾（§9.8 双保险②）：强制总结轮此前原样发送全量历史——
        // 历史顶着窗口上限时,最需要成功收口的这次调用反而先 400。收尾轮不带
        // 工具上线(tools 块按 0 计,预算更宽),按同一动态阈值先蒸馏一轮;
        // 未超预算时返回 null,行为与旧版完全一致。压缩结果就地替换 conversation,
        // 后续强制总结调用与落盘续聊历史共用同一份,task-end 相位不会二次蒸馏。
        try {
          const wrapCompacted = await this.compactConversation(conversation, options, 'wrap-up', endPhaseThreshold());
          if (wrapCompacted) {
            conversation.splice(0, conversation.length, ...(wrapCompacted as typeof conversation));
          }
        } catch {
          // 压缩失败按原历史收尾（诚实失败路径不变）
        }
        try {
          // 截断收尾与步数耗尽的交代口径不同,且两种截断各自如实:
          // 工具调用截停 = 调用未执行,必须说明零执行不得编造成果;
          // 正文截停 = 前面的工具轮已真实执行,要求补写完整正文而非全盘否定
          const wrapReason = loopResult.stepsExhausted
            ? `可用步数已全部用完，禁止再调用任何工具。请立即基于以上已收集的信息输出最终总结：已完成什么、未能完成什么、结论与交付物。`
            : cutOffToolCall
              ? `上一轮输出被单轮输出上限截断（工具调用写到一半被截，该调用未执行），禁止再调用任何工具。请基于以上信息如实说明：已完成什么、因截断未完成什么（含工具调用未执行的事实）、用户下一步该怎么做（重跑或拆小任务）。不得编造交付物或宣称成功。`
              : cutOffAnswer
                ? `上一轮答复正文被单轮输出上限截断（思考消耗了输出预算，正文刚开头即被截停），禁止再调用任何工具、不要再展开冗长思考。请基于以上已完成的工作，直接完整输出最终答复正文；此前已产出的交付物（如章节/文档/清单）按原格式完整重写，不要只写摘要。确实无法交付的部分如实说明，不得宣称成功。`
                : `未产出文本结论，禁止再调用任何工具。请立即基于以上已收集的信息输出最终总结：已完成什么、未能完成什么、结论与交付物。`;
          const wrapResult: ModelStepResult = await model.invokeStep({
            model: options.model,
            system: `${systemPrompt}\n\n【重要】${wrapReason}若此前已按任务要求的格式(字段头/清单结构)产出过完整交付物，最终总结必须按原格式完整保留该交付物正文，状态说明只可附加在其后，不得改写或省略。`,
            messages: conversation as any,
            // 正文截停的收口轮强制压低思考深度:截停根因是思考烧光预算,收口轮
            // 再高思考会原样复烧(重演 1 字符截停)。连接器/env 配置不动,只对
            // 这一次调用覆盖;中转不认 reasoning_effort 时 effort-fallback 兜底剥参重试
            configOverride: cutOffAnswer
              ? { ...(options.configOverride || {}), reasoningEffort: 'low' }
              : options.configOverride,
            disableTools: true,
          });
          finalAnswer = wrapResult.text || finalAnswer;
          // 强制总结轮同样要付费：补记进任务用量（增量上行，实时口径）
          if (wrapResult.usage) {
            usageAcc.promptTokens += wrapResult.usage.promptTokens || 0;
            usageAcc.completionTokens += wrapResult.usage.completionTokens || 0;
            emitUsageDelta(wrapResult.usage);
          }
        } catch {
          // 总结调用失败时，回退到已有的最后一段文本；截断残段补如实附注，
          // 防止未执行工具调用的残篇被误读成完整交付
          if (cutOffToolCall) {
            finalAnswer += '\n\n（注：本任务上一轮输出被单轮上限截断，工具调用未执行，以上内容可能不完整。请重跑或拆小任务重试。）';
          } else if (cutOffAnswer) {
            finalAnswer += '\n\n（注：本任务上一轮答复正文被单轮输出上限截断（思考耗尽输出预算），强制总结也未能完成，以上内容可能不完整。建议重跑任务。）';
          }
        }
      }

      // 用量上报收口：主循环逐步 + 残差 + 强总结轮都已发过增量 —— 此处无动作。
      // （apps/web agent-backend 消费 agtpilot/usage 累计进 mission 落库）

      if (!finalAnswer) {
        finalAnswer = loopResult.stepsExhausted
          ? `任务达到步数上限（${maxSteps} 步），未能生成完整结论。建议将任务拆小后重试。`
          : '任务已结束，但未生成文本结论。';
      }

      // 保证会话历史以最终 assistant 回复收尾（正常文本收尾时 SDK 已含该消息，避免重复追加）
      const lastMessage: any = conversation[conversation.length - 1];
      const endsWithFinalAssistant =
        !loopResult.stepsExhausted &&
        !cutOff &&
        Boolean(loopResult.text) &&
        lastMessage &&
        lastMessage.role === 'assistant';
      if (!endsWithFinalAssistant) {
        conversation.push({ role: 'assistant', content: finalAnswer });
      }

      // 会话压缩：多轮任务历史无限累积会让模型逐轮退化（越跑越笨、步数越跑越多）。
      // 超过阈值时把较早的工具调用/结果压成一条结构化纪要，近期窗口原样保留。
      // 阈值走收尾相位动态值（§9.8）：强制总结轮已就地压过时这里天然低于阈值,
      // 不会二次蒸馏;正常文本收尾的任务在这里按窗口预算收口,续聊重放不再全额。
      let finalMessages: Array<{ role: 'user' | 'assistant' | 'tool'; content: any }> = conversation;
      try {
        finalMessages =
          ((await this.compactConversation(conversation, options, 'task-end', endPhaseThreshold())) as typeof conversation) ?? conversation;
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
          outputTruncated: cutOff,
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
   * 会话压缩（compaction.ts 纯函数的网关注入包装）：
   * 三个触发相位：'in-loop'（prepareStep 每步检查，长任务不等收尾就地压缩）、
   * 'wrap-up'（强制总结轮发送前压缩，防最需要收口的调用先溢出）、
   * 'task-end'（任务收尾时压缩会话历史，供下一轮继承）。
   * thresholdTokens 由调用方按上下文预算动态计算（context-budget.ts），
   * 不传时走纯函数内的静态默认值。
   * 返回 null 表示无需压缩（保持调用方原消息不变）。
   */
  private async compactConversation(
    messages: Array<{ role: string; content: any }>,
    options: TaskOptions,
    phase: 'task-end' | 'in-loop' | 'wrap-up' = 'task-end',
    thresholdTokens?: number
  ): Promise<Array<{ role: string; content: any }> | null> {
    const enabled = process.env.AGTPILOT_COMPACTION_CLASSIFY !== '0';
    let keepToolCallIds: Set<string> | undefined;
    if (enabled) {
      try {
        const svc = this.ctx.reflect.get('compaction') as any;
        if (svc?.classify) {
          const { groups, verdicts } = await svc.classify(messages);
          const keepIds = new Set<string>();
          const groupById = new Map<string, any>(
            (groups ?? []).map((g: any) => [g.id, g] as [string, any])
          );
          for (const v of verdicts ?? []) {
            if (v.action === 'keep') {
              const gid = groupById.get(v.id)?.toolCallId;
              if (gid) keepIds.add(gid);
            }
          }
          if (keepIds.size > 0) keepToolCallIds = keepIds;
        }
      } catch {
        // 分类失败回退老纪要路径
      }
    }
    const model = this.ctx.reflect.get('model');
    return compactConversationMessages(messages, {
      keepToolCallIds,
      ...(thresholdTokens ? { thresholdTokens } : {}),
      summarize: async (digest) => {
        if (!model) return '';
        const result: ModelStepResult = await model.invokeStep({
          system:
            '你是会话压缩器。把以下历史工具调用与结果流水蒸馏成简洁的结构化纪要，供后续对话作为上下文使用。格式：\n【已确立事实】\n【关键结论与数据】\n【重要链接】\n【未决事项】\n只保留对继续当前任务有信息量的内容，忽略重复与失败细节，总长不超过 800 字。',
          messages: [{ role: 'user', content: digest }] as any,
          disableTools: true,
          configOverride: options.configOverride,
        });
        // 蒸馏调用同样烧钱 —— 入账 mission.usage(走既有 agtpilot/usage 通道,
        // agent-backend 累计),消灭「压缩越频繁、账外消耗越大」的观测盲区
        if (options.taskId && result?.usage) {
          this.ctx.emit('agtpilot/usage', {
            taskId: options.taskId,
            promptTokens: result.usage.promptTokens ?? 0,
            completionTokens: result.usage.completionTokens ?? 0,
          });
        }
        return result?.text || '';
      },
      onProgress: ({ totalTokens, entries }) => {
        this.ctx.agent.emitEvent({
          type: 'thought',
          payload: {
            text: `${
              phase === 'in-loop' ? '任务执行中' : phase === 'wrap-up' ? '强制总结前' : '任务收尾'
            }检测到会话上下文约 ${totalTokens} tokens，超过压缩阈值，正在把 ${entries} 条历史工具记录蒸馏为纪要…`,
          },
          timestamp: Date.now(),
        });
      },
    });
  }
}

export type { TaskOptions, TaskResult, TaskEfficiency };
