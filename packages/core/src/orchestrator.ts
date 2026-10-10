import { Context, Service } from '@deepseek-ai/cordis';
import { AgentEvent, ApprovalRequest, ModelStepResult } from '@agtpilot/protocol';
import {
  ToolDefinition,
  ModelGateway,
  PlannerNotifier,
  AgentLoopTool,
} from './contracts';
import {
  selectActiveTools,
  stableStringify,
  estimateTextTokens,
} from './routing';
import { messageText, truncateToolOutput, TOOL_OUTPUT_LIMIT } from './text';
import { compactConversationMessages } from './compaction';
import { appendStepNotice } from './notice';
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

/** 高危操作审批等待上限（毫秒），超时自动拒绝并释放任务，杜绝永久悬挂。0 = 永不超时 */
const APPROVAL_TIMEOUT_MS = Math.max(0, Number(process.env.AGTPILOT_APPROVAL_TIMEOUT_MS) || 5 * 60_000);

const DEFAULT_SYSTEM_PROMPT =
  '你是一个专业高效的自主执行智能体。你可以根据用户需求灵活调用已接入的原子工具来完成任务。\n' +
  '当缺少某个平台的专用工具或连接器未授权时，优先使用可用的网页浏览类工具直接在网页上完成操作作为兜底，而不是放弃任务。\n' +
  '多个互相独立的工具调用请在同一轮并行发出；任务看板由系统随工具执行自动推进，无需调用 planner_update_task 汇报进度。';

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
    const loopTools: AgentLoopTool[] = allTools.map((toolDef) => ({
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
          output = await toolDef.execute(args, {
            taskId,
            step: currentStep,
            env: options.taskEnv,
            userId: options.userId,
            sandbox: options.taskSandbox,
          });
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
              this.ctx.reflect.get('planner')?.noteToolResult(taskId, toolDef.name);
            } catch {
              // 看板推进失败不影响主流程
            }
          }
        }

        // 广播工具执行结果（compensation 透传：持久化层随步骤快照落盘回滚把手，
        // 治理不变量 I5 —— 每个行动都要留下可回滚/可追责的元数据）
        broadcast({
          type: 'tool_result',
          payload: toolDef.compensation
            ? { tool: toolDef.name, output, compensation: toolDef.compensation }
            : { tool: toolDef.name, output },
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

    // 工具按需挂载：显式指定 > 阈值门（未超线全量）> 插件注册的关键词规则 > 全量兜底
    // 路由依据 = 本次 prompt + 历史中的近期用户消息（多轮任务里"继续/打开刚才那个链接"
    // 这类跟进指令本身没有关键词，但历史里有）；system 提示词刻意不参与——
    // 它通篇提到各工具名，参与匹配会让路由永远退化为全量。
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
      // ---- 主循环：完全交给模型网关的内置 agent loop ----
      const loopResult = await model.runAgentLoop({
        model: options.model,
        system: options.system || DEFAULT_SYSTEM_PROMPT,
        messages: baseMessages as any,
        configOverride: options.configOverride,
        maxSteps,
        tools: loopTools,
        activeTools: routedTools,
        // 每步准备回调（AI SDK v5 prepareStep，每一步模型调用前触发）：
        // 1) 动态路由（仅初始路由已启用时生效）：用近期消息（含工具结果——
        //    搜索结果里出现 URL 自然该把浏览器工具组挂进来）重算本步可见工具，
        //    解决"路由在任务开始时一次性冻结、中途需要的工具永远声明不到"的问题；
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
            const next = selectActiveTools(recentText, allTools, this.ctx.agent.getToolRoutes());
            if (next) adjust.activeTools = next;
          }
          try {
            const compacted = await this.compactConversation(messages, options, 'in-loop');
            if (compacted) adjust.messages = compacted;
          } catch {
            // 压缩失败继续用原消息
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
          // 检查点采用本步实际使用的消息（含压缩重写与治理提示注入）
          const finalMessages = adjust.messages ?? messages;
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

      // 用量上报（plugin-router 的预算统计消费）
      if (loopResult.usage) {
        this.ctx.emit('agtpilot/usage', { ...loopResult.usage, taskId });
      }

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
        // 强制总结走非流式 invokeStep，先广播 step_started 让"正在思考"
        // 指示覆盖这 10-60s 的总结窗口
        broadcast({
          type: 'step_started',
          payload: { reason: 'wrap-up' },
          timestamp: Date.now(),
        });
        try {
          const wrapResult: ModelStepResult = await model.invokeStep({
            model: options.model,
            system: `${options.system || DEFAULT_SYSTEM_PROMPT}\n\n【重要】可用步数已全部用完，禁止再调用任何工具。请立即基于以上已收集的信息输出最终总结：已完成什么、未能完成什么、结论与交付物。`,
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
        finalMessages =
          ((await this.compactConversation(conversation, options)) as typeof conversation) ?? conversation;
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
   * 会话压缩（compaction.ts 纯函数的网关注入包装）：
   * 两个触发相位：'in-loop'（prepareStep 每步检查，长任务不等收尾就地压缩）、
   * 'task-end'（任务收尾时压缩会话历史，供下一轮继承）。
   * 返回 null 表示无需压缩（保持调用方原消息不变）。
   */
  private async compactConversation(
    messages: Array<{ role: string; content: any }>,
    options: TaskOptions,
    phase: 'task-end' | 'in-loop' = 'task-end'
  ): Promise<Array<{ role: string; content: any }> | null> {
    const model = this.ctx.reflect.get('model');
    return compactConversationMessages(messages, {
      summarize: async (digest) => {
        if (!model) return '';
        const result: ModelStepResult = await model.invokeStep({
          system:
            '你是会话压缩器。把以下历史工具调用与结果流水蒸馏成简洁的结构化纪要，供后续对话作为上下文使用。格式：\n【已确立事实】\n【关键结论与数据】\n【重要链接】\n【未决事项】\n只保留对继续当前任务有信息量的内容，忽略重复与失败细节，总长不超过 800 字。',
          messages: [{ role: 'user', content: digest }] as any,
          disableTools: true,
          configOverride: options.configOverride,
        });
        return result?.text || '';
      },
      onProgress: ({ totalTokens, entries }) => {
        this.ctx.agent.emitEvent({
          type: 'thought',
          payload: {
            text: `${
              phase === 'in-loop' ? '任务执行中' : '任务收尾'
            }检测到会话上下文约 ${totalTokens} tokens，超过压缩阈值，正在把 ${entries} 条历史工具记录蒸馏为纪要…`,
          },
          timestamp: Date.now(),
        });
      },
    });
  }
}

export type { TaskOptions, TaskResult, TaskEfficiency };
