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
   * 运行完整的自研 ReAct 任务循环 (带死循环熔断、安全审批、标准化事件广播)
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

    const messages: Array<{ role: 'user' | 'assistant' | 'tool'; content: any }> = options.historyMessages && options.historyMessages.length > 0
      ? [...options.historyMessages, { role: 'user', content: options.prompt }]
      : [{ role: 'user', content: options.prompt }];

    let currentStep = 0;
    let finalAnswer = '';
    // 死循环熔断状态：只统计【连续】相同调用（滑动窗口），与防护意图一致
    let lastSignature = '';
    let repeatCount = 0;

    try {
      while (currentStep < maxSteps) {
        if (options.abortSignal?.aborted) {
          throw new Error('任务已被主动终止 (Cancelled)');
        }
        currentStep++;

        // 1. 调用模型单步驱动 (方案 A: 严格单步)
        const stepResult: ModelStepResult = await (this.ctx as any).model.invokeStep({
          model: options.model,
          system: options.system || '你是一个专业高效的自主执行智能体。你可以根据用户需求灵活调用浏览器等原子工具来完成任务。',
          messages: messages as any,
          configOverride: options.configOverride,
        });

        // 2. 捕获思考/回复
        if (stepResult.text) {
          broadcast({
            type: 'thought',
            payload: { step: currentStep, text: stepResult.text },
            timestamp: Date.now(),
          });
        }

        // 3. 判断是否需要调用工具
        if (!stepResult.toolCalls || stepResult.toolCalls.length === 0) {
          // 没有工具调用，任务完成
          finalAnswer = stepResult.text;
          broadcast({
            type: 'done',
            payload: { taskId, stepsCount: currentStep, finalAnswer },
            timestamp: Date.now(),
          });
          return {
            taskId,
            success: true,
            stepsCount: currentStep,
            finalAnswer,
            events,
            messages: [...messages, { role: 'assistant', content: finalAnswer }],
          };
        }

        // 为本轮每个工具调用预生成稳定的 toolCallId（模型未提供时兜底），
        // 确保 assistant 的 tool-call 与 tool-result 严格配对，避免 provider 协议错误
        const resolvedCalls = stepResult.toolCalls.map((tc: any, idx: number) => ({
          ...tc,
          resolvedId: tc.toolCallId || `call_${currentStep}_${idx}_${Date.now()}`,
        }));

        // 把模型的助手的思考/调用指令存入上下文 (包含 tool-call parts 以保证 OpenAI / Vercel AI SDK 规范)
        const assistantParts: any[] = [];
        if (stepResult.text) {
          assistantParts.push({ type: 'text', text: stepResult.text });
        }
        for (const tc of resolvedCalls) {
          assistantParts.push({
            type: 'tool-call',
            toolCallId: tc.resolvedId,
            toolName: tc.toolName,
            args: tc.args,
          });
        }
        messages.push({
          role: 'assistant' as any,
          content: assistantParts.length > 0 ? assistantParts : (stepResult.text || ''),
        });

        // 统一回填 tool-result（符合 AI SDK CoreToolMessage 规范；超长结果截断，防上下文膨胀）
        const pushToolResult = (tc: any, result: string) => {
          messages.push({
            role: 'tool' as any,
            content: [
              {
                type: 'tool-result',
                toolCallId: tc.resolvedId,
                toolName: tc.toolName,
                result:
                  result.length > TOOL_OUTPUT_LIMIT
                    ? `${result.slice(0, TOOL_OUTPUT_LIMIT)}\n...[结果过长已截断，原始长度 ${result.length} 字符]`
                    : result,
              },
            ] as any,
          });
        };

        // 4. 逐一执行工具并进行安全防护
        for (const tc of resolvedCalls) {
          const toolDef = this.ctx.agent.getTool(tc.toolName);

          // 死循环检测 (Loop Detector): 同一工具+同一参数【连续】3 次才熔断；
          // 熔断降级为跳过本次调用并注入提醒，让模型换思路，而非终止整个任务
          const toolSignature = `${tc.toolName}:${JSON.stringify(tc.args)}`;
          if (toolSignature === lastSignature) {
            repeatCount++;
          } else {
            lastSignature = toolSignature;
            repeatCount = 1;
          }
          if (repeatCount >= 3) {
            pushToolResult(
              tc,
              JSON.stringify({
                skipped: true,
                message: `[Loop Detector] 该工具已连续 ${repeatCount} 次以完全相同的参数调用，本次已被跳过。请更换思路（调整参数、改用其他工具，或基于已有信息直接总结给出最终回答），不要重复相同调用。`,
              })
            );
            continue;
          }

          if (!toolDef) {
            pushToolResult(tc, JSON.stringify({ error: `工具 [${tc.toolName}] 不存在或未注册。` }));
            continue;
          }

          // 安全审批拦截 (Human-in-the-Loop)
          if (toolDef.dangerLevel === 'high') {
            const approvalId = `approval_${Date.now()}`;
            const approvalReq: ApprovalRequest = {
              id: approvalId,
              action: tc.toolName,
              description: `Agent 正在尝试执行高危操作: ${toolDef.description}`,
              dangerLevel: 'high',
              params: tc.args,
            };

            broadcast({
              type: 'approval_request',
              payload: approvalReq,
              timestamp: Date.now(),
            });

            // 状态机冻结挂起，等待外部审批
            const approved = await new Promise<boolean>((resolve) => {
              this.pendingApprovals.set(approvalId, resolve);
            });

            if (!approved) {
              pushToolResult(
                tc,
                JSON.stringify({ rejected: true, message: `用户拒绝了执行工具 [${tc.toolName}] 的请求。` })
              );
              continue;
            }
          }

          // 广播工具执行开始
          broadcast({
            type: 'tool_call',
            payload: { tool: tc.toolName, args: tc.args },
            timestamp: Date.now(),
          });

          // 真实调用工具
          let output: any;
          try {
            output = await toolDef.execute(tc.args, { taskId, step: currentStep });
          } catch (err: any) {
            output = { error: err.message };
          }

          // 广播工具执行结果
          broadcast({
            type: 'tool_result',
            payload: { tool: tc.toolName, output },
            timestamp: Date.now(),
          });

          // 回填给大模型上下文作为 tool_result
          pushToolResult(tc, typeof output === 'string' ? output : JSON.stringify(output));
        }
      }

      // 步数用尽：不再直接报错终止，而是追加一轮【禁用工具】的强制总结，尽力交付结论
      broadcast({
        type: 'thought',
        payload: { step: currentStep, text: `已达步数上限（${maxSteps} 步），正在做最终总结…` },
        timestamp: Date.now(),
      });
      try {
        const wrapResult: ModelStepResult = await (this.ctx as any).model.invokeStep({
          model: options.model,
          system: `${options.system || '你是一个专业高效的自主执行智能体。'}\n\n【重要】可用步数已全部用完，禁止再调用任何工具。请立即基于以上已收集的信息输出最终总结：已完成什么、未能完成什么、结论与交付物。`,
          messages: messages as any,
          configOverride: options.configOverride,
          disableTools: true,
        });
        finalAnswer = wrapResult.text || finalAnswer;
      } catch {
        // 总结调用失败时，回退到已有的最后一段文本
      }
      if (!finalAnswer) {
        finalAnswer = `任务达到步数上限（${maxSteps} 步），未能生成完整结论。建议将任务拆小后重试。`;
      }
      broadcast({
        type: 'done',
        payload: { taskId, stepsCount: currentStep, finalAnswer, stepsExhausted: true },
        timestamp: Date.now(),
      });
      return {
        taskId,
        success: true,
        stepsCount: currentStep,
        finalAnswer,
        events,
        messages: [...messages, { role: 'assistant', content: finalAnswer }],
      };
    } catch (err: any) {
      broadcast({
        type: 'error',
        payload: { taskId, error: err.message },
        timestamp: Date.now(),
      });
      return {
        taskId,
        success: false,
        stepsCount: currentStep,
        finalAnswer,
        events,
        error: err.message,
      };
    }
  }
}

export const name = 'agtpilot-core';

export function apply(ctx: Context) {
  new AgentService(ctx);
  new OrchestratorService(ctx);
}
