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
  estimateTextTokens,
  isSmalltalkPrompt,
} from './routing';
import {
  LOAD_TOOLS_NAME,
  toolCatalogEnabled,
  buildToolCatalogNote,
  createLoadToolsDefinition,
} from './tool-catalog';
import { messageText, toolSpillEnabled } from './text';
import { stripReasoningParts, reasoningStripEnabled } from './reasoning';
import {
  compactConversationMessages,
  continuationCompactThreshold,
  continuationCompactEnabled,
} from './compaction';
import {
  effectiveCompactThreshold,
  estimateToolsBlockTokens,
  historyTokenBudget,
} from './context-budget';
import { appendBackgroundNotice, appendBoardReminder, appendStepNotice, appendUserMessage } from './notice';
import { ToolGate } from './tool-gate';
import { ToolRuntime, isEmptyToolOutput } from './tool-runtime';
import { runAgentLoopWithHooks } from './agent-loop';
import { runPreparePipeline } from './prepare-pipeline';
import type { PrepareStepContext, PrepareMiddleware } from './prepare-pipeline';
import type { TaskOptions, TaskResult, TaskEfficiency } from './task-types';

/** 默认步数上限（一步 = 一轮模型调用）。可用环境变量 AGTPILOT_MAX_STEPS 或单任务 maxSteps 覆盖。
 *  40 → 20：熔断器只能兜住部分空转，上限过高会让跑偏任务白烧几十轮才停；
 *  真正的长任务会走"步数耗尽强制总结"路径优雅收尾，任务可继续追问。 */
const DEFAULT_MAX_STEPS = Math.max(1, Number(process.env.AGTPILOT_MAX_STEPS) || 20);

export { isEmptyToolOutput };

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
    let baseMessages: Array<{ role: 'user' | 'assistant' | 'tool'; content: any }> =
      historyIn.length > 0
        ? [...historyIn, { role: 'user', content: options.prompt }]
        : [{ role: 'user', content: options.prompt }];

    // 闸0(续聊轮入口):对「上一轮及更早」的历史强制蒸馏一次(§9.8)。
    // task-end 压缩只在估算超动态阈值(≈30k)时触发,且估算不含 system/tools
    // 固定开销 —— 「估算刚好低于阈值」的历史全额落盘后,续聊轮每一步都按
    // 30k+ 实付(生产实测:公众号续聊轮首步 promptTokens 30.5k)。这里用低
    // 阈值(默认 10k)在开轮前压一次:更早的工具流水/长文本折叠成一条纪要,
    // 近期窗口(上一轮末尾的答复——续聊追问引用的正是它)与新消息原样保留。
    // 自限:历史比阈值短 → 守卫返回 null,连蒸馏调用都不发生;蒸馏结果随
    // task-end 的 result.messages 落盘,下一轮续聊从「纪要+近期」起步不再膨胀。
    // 失败保持全额历史,不阻塞本轮(与 task-end 同款兜底)。
    if (historyIn.length > 0 && continuationCompactEnabled()) {
      try {
        baseMessages =
          ((await this.compactConversation(
            baseMessages,
            options,
            'round-start',
            continuationCompactThreshold()
          )) as typeof baseMessages) ?? baseMessages;
      } catch {
        // 入口蒸馏失败不影响续聊轮本身
      }
    }

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

    // ---- 工具装配：全局注册 + 任务级附加工具,后续统一交给 ToolRuntime 执行 ----
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
    const toolRuntime = new ToolRuntime({
      policy: {
        approval: 'hitl',
        readonlyGate: true,
        cache: true,
        deadLoop: true,
        failureGuard: true,
        spill: true,
        truncate: true,
      },
      emit: (event) =>
        broadcast({
          type: event.type,
          payload: event.payload,
          timestamp: Date.now(),
        }),
      approve: (request) => this.requestApproval(request, options.abortSignal, broadcast),
      ...(options.spillToolOutput && toolSpillEnabled()
        ? {
            spill: (input) =>
              options.spillToolOutput!({
                taskId,
                callId: input.callId,
                toolName: input.toolName,
                fullText: input.fullText,
              }),
          }
        : {}),
      gate: toolGate,
    });

    const loopTools: AgentLoopTool[] = allTools.map((toolDef) => ({
      name: toolDef.name,
      description: toolDef.description,
      parameters: toolDef.parameters,
      execute: async (args: any): Promise<any> => {
        const result = await toolRuntime.execute(toolDef, args, {
          taskId,
          step: currentStep,
          env: options.taskEnv,
          userId: options.userId,
          sandbox: options.taskSandbox,
          ...(options.activeTools ? { activeTools: options.activeTools } : {}),
        });
        // 看板滞后检测：planner_ 系执行本身就是显式申报；真实工具成功才计推进
        if (/^planner_/.test(toolDef.name)) {
          boardLagRounds = 0;
        } else if (
          result.status === 'ok' &&
          !/^(memory_|router_|observability_)/.test(toolDef.name)
        ) {
          roundRealToolSuccess = true;
        }
        return result.output;
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
    const buildEfficiency = (stepsCount: number): TaskEfficiency => {
      const stats = toolRuntime.getStats();
      return {
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
      };
    };

    // prepareStep 策略链（AI SDK v5，每一步模型调用前触发）：
    // 路由扩容 → 任务内压缩 → 看板催促 → 治理提示 → 后台通知 → 用户追加消息
    // → 发送前预算护栏/检查点。顺序是契约：压缩必须在提示注入之前，提示才不会被
    // 蒸馏掉；发送前护栏必须在最后，兜住提示注入重新顶爆窗口的极端情况。
    // 子 agent 走自己的短链（见 plugin-subagent/runner.ts），共享同一管线形状。
    const prepareMiddlewares: PrepareMiddleware[] = [];

    if (routedTools) {
      prepareMiddlewares.push(async (ctx) => {
        const recentText = (ctx.messages || [])
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
          ctx.adjust.activeTools = Array.from(mountedNames);
          toolsMounted = ctx.adjust.activeTools.length;
        }
      });
    }

    prepareMiddlewares.push(async (ctx) => {
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
        const compacted = await this.compactConversation(ctx.messages, options, 'in-loop', compactThreshold);
        if (compacted) ctx.messages = compacted;
      } catch {
        // 压缩失败继续用原消息
      }
    });

    prepareMiddlewares.push(async (ctx) => {
      // 看板滞后催促(压缩之后注入,与治理提示同点位防被蒸馏):上轮真实
      // 工具成功而模型未申报看板 → 滞后轮数累计;达阈值注入一条同步提醒
      // (文本由规划器给出,带当前步骤上下文)并清零计数 —— 防连环催促。
      if (roundRealToolSuccess) {
        roundRealToolSuccess = false;
        boardLagRounds++;
      }
      if (boardLagRounds >= BOARD_LAG_THRESHOLD) {
        const idleRounds = boardLagRounds;
        boardLagRounds = 0;
        try {
          const reminder = this.ctx.reflect.get('planner')?.boardLagNotice(taskId, idleRounds);
          const withReminder = appendBoardReminder(ctx.messages, reminder ?? null);
          if (withReminder) ctx.messages = withReminder;
        } catch {
          // 看板提醒获取失败不影响主流程
        }
      }
    });

    prepareMiddlewares.push(async (ctx) => {
      const getStepNotice = options.getStepNotice;
      if (!getStepNotice) return;
      try {
        const notice = await getStepNotice();
        const withNotice = appendStepNotice(ctx.messages, notice);
        if (withNotice) ctx.messages = withNotice;
      } catch {
        // 治理提示获取失败不影响主流程
      }
    });

    prepareMiddlewares.push(async (ctx) => {
      const getBackgroundNotice = options.getBackgroundNotice;
      if (!getBackgroundNotice) return;
      try {
        const bgNotice = await getBackgroundNotice();
        const withBgNotice = appendBackgroundNotice(ctx.messages, bgNotice);
        if (withBgNotice) ctx.messages = withBgNotice;
      } catch {
        // 后台通知获取失败不影响主流程(消息仍在队列里,下步重试)
      }
    });

    prepareMiddlewares.push(async (ctx) => {
      const getUserMessages = options.getUserMessages;
      if (!getUserMessages) return;
      try {
        const userText = await getUserMessages();
        const withUser = appendUserMessage(ctx.messages, userText);
        if (withUser) ctx.messages = withUser;
      } catch {
        // 追加消息获取失败不影响主流程(消息仍在队列里,下步重试)
      }
    });

    prepareMiddlewares.push(async (ctx) => {
      // 发送前预算护栏（§9.8 双保险①）：治理提示/看板催促/用户追加消息都在
      // 常规压缩之后注入,理论上能把本步重新顶爆窗口。发送前实测一次总账
      // (消息估算 vs 历史预算),超了就地再压一轮(紧急相位,阈值=预算本身);
      // 仍压不下去(全是不可压的近期文本)则如实放行 —— 溢出走诚实失败,不伪造。
      const stepToolsTokens = estimateToolsBlockTokens(
        routedTools ? allTools.filter((t) => mountedNames.has(t.name)) : allTools
      );
      const sendEstimate = (list: Array<any>) =>
        list.reduce((acc: number, m: any) => acc + estimateTextTokens(messageText(m.content)), 0);
      let outbound = ctx.messages;
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
            ctx.messages = forced;
            outbound = forced;
            outboundEst = sendEstimate(forced);
          }
        } catch {
          // 紧急压缩失败:按原消息发送,溢出由 provider 报错如实上浮
        }
      }
      lastSentMessagesEst = outboundEst;
      // 检查点采用本步实际使用的消息（含压缩重写与治理提示注入）
      try {
        this.ctx.emit('agtpilot/checkpoint', { taskId, stepNumber: ctx.stepNumber, messages: outbound });
      } catch {
        // 检查点失败不影响主流程
      }
    });

    try {
      // ---- 主循环：完全交给模型网关的内置 agent loop ----
      const loop = await runAgentLoopWithHooks({
        gateway: model,
        model: options.model,
        system: systemPrompt,
        messages: baseMessages as any,
        configOverride: options.configOverride,
        maxSteps,
        ...(options.tokenBudget !== undefined ? { tokenBudget: options.tokenBudget } : {}),
        tools: loopTools,
        activeTools: initialActiveTools,
        prepareStep: async ({ stepNumber, messages }: { stepNumber: number; messages: Array<any> }) => {
          const ctx: PrepareStepContext = {
            stepNumber,
            messages: messages || [],
            originalMessages: messages || [],
            adjust: {},
          };
          return runPreparePipeline(ctx, prepareMiddlewares);
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
      const loopResult = loop.result;
      reasoningPartsStripped += loop.reasoningPartsStripped;

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
        loop.responseMessages || [];
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

      // 计划闭环校验（生产实例 mission_..._62lt6：step_4 仍 PENDING 却因模型给出最终答复
      // 而整体落 DONE，用户体感「任务中途退出」）。非强制总结路径下，若 planner 看板仍有
      // 未完成步骤，随 done 事件上报，由前端保持任务激活并提示剩余步骤，而非直接标 DONE。
      let planUnfinished = false;
      let openTasks: Array<{ id: string; title: string; status: 'pending' | 'in_progress' }> = [];
      if (!needsWrapUp) {
        try {
          const plannerSvc = this.ctx.reflect.get('planner') as PlannerNotifier | undefined;
          openTasks = plannerSvc?.getOpenTasks(taskId) ?? [];
          planUnfinished = openTasks.length > 0;
        } catch {
          openTasks = [];
          planUnfinished = false;
        }
      }

      broadcast({
        type: 'done',
        payload: {
          taskId,
          stepsCount,
          finalAnswer,
          stepsExhausted: Boolean(loopResult.stepsExhausted),
          outputTruncated: cutOff,
          efficiency,
          ...(planUnfinished ? { planUnfinished: true, openTasks } : {}),
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
   * 高危工具审批：宿主侧挂起/恢复/超时全部在这里实现，ToolRuntime 只等待布尔结果。
   * 任务被主动终止时自动拒绝并释放挂起，避免永久悬挂。
   */
  private requestApproval(
    request: ApprovalRequest,
    abortSignal: AbortSignal | undefined,
    broadcast: (event: AgentEvent) => void,
  ): Promise<boolean> {
    broadcast({
      type: 'approval_request',
      payload: request,
      timestamp: Date.now(),
    });

    return new Promise<boolean>((resolve) => {
      let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
      const settle = (value: boolean) => {
        if (timeoutTimer) clearTimeout(timeoutTimer);
        this.pendingApprovals.delete(request.id);
        resolve(value);
      };
      this.pendingApprovals.set(request.id, settle);
      const onAbort = () => {
        if (this.pendingApprovals.has(request.id)) settle(false);
      };
      if (abortSignal?.aborted) {
        onAbort();
      } else {
        abortSignal?.addEventListener('abort', onAbort, { once: true });
      }
      if (APPROVAL_TIMEOUT_MS > 0) {
        timeoutTimer = setTimeout(() => {
          broadcast({
            type: 'approval_resolved',
            payload: { id: request.id, approved: false, reason: 'timeout' },
            timestamp: Date.now(),
          });
          settle(false);
        }, APPROVAL_TIMEOUT_MS);
      }
    });
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
    phase: 'task-end' | 'in-loop' | 'wrap-up' | 'round-start' = 'task-end',
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
            '你是会话压缩器。把以下历史工具调用与结果流水蒸馏成结构化纪要，供后续对话作为上下文使用。要求：\n' +
            '1) 完整覆盖被压缩的历史，保留精确标识（文件名、路径、URL、命令、报错码、数值、版本号、ID），不要笼统概括；\n' +
            '2) 记录关键结论与数据，忽略重复步骤与无信息量的细节；\n' +
            '3) 若某条结果标注「全文已落盘 ref=…」，在纪要中保留该 ref 与内容要点，后续可 read_tool_output 续读，不要写成“需重新获取”；\n' +
            '格式：\n【已确立事实】\n【关键结论与数据】\n【重要链接与引用】\n【未决事项】\n总长不超过 800 字。',
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
        // 相位文案走平铺映射(四相位嵌套三目不可读)
        const phaseLabel: Record<string, string> = {
          'in-loop': '任务执行中',
          'wrap-up': '强制总结前',
          'task-end': '任务收尾',
          'round-start': '续聊开始',
        };
        this.ctx.agent.emitEvent({
          type: 'thought',
          payload: {
            text: `${
              phaseLabel[phase] ?? phase
            }检测到会话上下文约 ${totalTokens} tokens，超过压缩阈值，正在把 ${entries} 条历史工具记录蒸馏为纪要…`,
          },
          timestamp: Date.now(),
        });
      },
    });
  }
}

export type { TaskOptions, TaskResult, TaskEfficiency };
