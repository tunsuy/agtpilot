import { Context, Service } from '@deepseek-ai/cordis';
import { AgentEvent, ApprovalRequest, ModelStepResult } from '@agtpilot/protocol';

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, any>;
  dangerLevel?: 'low' | 'medium' | 'high';
  execute: (args: any, session: any) => Promise<any>;
}

export interface TaskOptions {
  prompt: string;
  system?: string;
  model?: string;
  maxSteps?: number;
  onEvent?: (event: AgentEvent) => void;
}

export interface TaskResult {
  taskId: string;
  success: boolean;
  stepsCount: number;
  finalAnswer: string;
  events: AgentEvent[];
  error?: string;
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    agent: AgentService;
    orchestrator: OrchestratorService;
    model?: any;
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
    const taskId = `task_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const maxSteps = options.maxSteps ?? 10;
    const events: AgentEvent[] = [];

    const broadcast = (event: AgentEvent) => {
      events.push(event);
      this.ctx.agent.emitEvent(event);
      if (options.onEvent) {
        options.onEvent(event);
      }
    };

    const messages: Array<{ role: 'user' | 'assistant' | 'tool'; content: any }> = [
      { role: 'user', content: options.prompt },
    ];

    let currentStep = 0;
    let finalAnswer = '';
    const toolCallHistory: string[] = [];

    try {
      while (currentStep < maxSteps) {
        currentStep++;

        // 1. 调用模型单步驱动 (方案 A: 严格单步)
        const stepResult: ModelStepResult = await this.ctx.model.invokeStep({
          model: options.model,
          system: options.system || '你是一个专业高效的自主执行智能体。你可以根据用户需求灵活调用浏览器等原子工具来完成任务。',
          messages: messages as any,
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
          };
        }

        // 把模型的助手的思考/调用指令存入上下文
        messages.push({
          role: 'assistant',
          content: stepResult.text || '正在调用工具获取信息...',
        });

        // 4. 逐一执行工具并进行安全防护
        for (const tc of stepResult.toolCalls) {
          const toolDef = this.ctx.agent.getTool(tc.toolName);

          // 死循环检测 (Loop Detector): 连续调用相同参数的同一工具超过 3 次触发熔断
          const toolSignature = `${tc.toolName}:${JSON.stringify(tc.args)}`;
          toolCallHistory.push(toolSignature);
          const recentRepeats = toolCallHistory.filter((sig) => sig === toolSignature).length;
          if (recentRepeats >= 3) {
            throw new Error(`[Loop Detector] 检测到对工具 [${tc.toolName}] 的死循环调用，已主动熔断以防资损。`);
          }

          if (!toolDef) {
            const errorMsg = `工具 [${tc.toolName}] 不存在或未注册。`;
            messages.push({
              role: 'tool',
              content: JSON.stringify({ error: errorMsg }),
            });
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
              const rejectMsg = `用户拒绝了执行工具 [${tc.toolName}] 的请求。`;
              messages.push({
                role: 'tool',
                content: JSON.stringify({ rejected: true, message: rejectMsg }),
              });
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

          // 回填给大模型上下文
          messages.push({
            role: 'tool',
            content: typeof output === 'string' ? output : JSON.stringify(output),
          });
        }
      }

      throw new Error(`任务执行超出最大步数限制 (${maxSteps} 步)，已终止。`);
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
