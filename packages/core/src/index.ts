import { Context, Service } from '@deepseek-ai/cordis';
import { AgentEvent, ApprovalRequest, ModelStepResult } from '@agtpilot/protocol';

/** 默认步数上限（一步 = 一轮模型调用）。可用环境变量 AGTPILOT_MAX_STEPS 或单任务 maxSteps 覆盖。 */
const DEFAULT_MAX_STEPS = Math.max(1, Number(process.env.AGTPILOT_MAX_STEPS) || 40);
/** 单个工具结果回填模型上下文的字符上限，超长截断，防止上下文膨胀导致模型退化。 */
const TOOL_OUTPUT_LIMIT = 16 * 1024;

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
  abortSignal?: AbortSignal;
  configOverride?: any;
  historyMessages?: Array<{ role: 'user' | 'assistant' | 'tool'; content: any }>;
  onEvent?: (event: AgentEvent) => void;
}

export interface TaskResult {
  taskId: string;
  success: boolean;
  stepsCount: number;
  finalAnswer: string;
  events: AgentEvent[];
  messages?: Array<{ role: 'user' | 'assistant' | 'tool'; content: any }>;
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

    // 死循环熔断状态：只统计【连续】相同调用（滑动窗口）
    let lastSignature = '';
    let repeatCount = 0;
    // 当前步序号（1-based，供工具会话上下文使用）
    let currentStep = 1;

    // ---- 工具包装层：熔断 + 审批门 + 事件广播 + 结果截断 ----
    const loopTools = this.ctx.agent.getTools().map((toolDef) => ({
      name: toolDef.name,
      description: toolDef.description,
      execute: async (args: any): Promise<any> => {
        // 死循环检测 (Loop Detector): 同一工具+同一参数【连续】3 次才熔断；
        // 熔断降级为跳过本次调用并返回提醒，让模型换思路，而非终止整个任务
        const toolSignature = `${toolDef.name}:${JSON.stringify(args)}`;
        if (toolSignature === lastSignature) {
          repeatCount++;
        } else {
          lastSignature = toolSignature;
          repeatCount = 1;
        }
        if (repeatCount >= 3) {
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

    try {
      // ---- 主循环：完全交给 AI SDK v5 内置 agent loop ----
      const loopResult = await (this.ctx as any).model.runAgentLoop({
        model: options.model,
        system:
          options.system ||
          '你是一个专业高效的自主执行智能体。你可以根据用户需求灵活调用浏览器等原子工具来完成任务。',
        messages: baseMessages as any,
        configOverride: options.configOverride,
        maxSteps,
        tools: loopTools,
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

      broadcast({
        type: 'done',
        payload: { taskId, stepsCount, finalAnswer, stepsExhausted: Boolean(loopResult.stepsExhausted) },
        timestamp: Date.now(),
      });

      return {
        taskId,
        success: true,
        stepsCount,
        finalAnswer,
        events,
        messages: conversation,
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
