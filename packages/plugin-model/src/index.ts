import { Context, Service } from '@deepseek-ai/cordis';
import { generateText, stepCountIs, jsonSchema, CoreMessage, ModelMessage, tool } from 'ai';
import { createDeepSeek } from '@ai-sdk/deepseek';
import { createOpenAI } from '@ai-sdk/openai';
import { z } from 'zod';
import { ModelStepResult } from '@agtpilot/protocol';
import '@agtpilot/core';

export const name = 'agtpilot-plugin-model';
export const inject = ['agent'];

declare module '@deepseek-ai/cordis' {
  interface Context {
    model: ModelService;
  }
}

export type { ModelStepResult };

export interface ModelInvokeOptions {
  model?: string;
  system?: string;
  messages: CoreMessage[];
  temperature?: number;
  /** 本次调用禁用全部工具声明（用于步数耗尽后的强制纯文本总结收尾） */
  disableTools?: boolean;
  configOverride?: {
    activeModelId?: string;
    apiKey?: string;
    baseURL?: string;
    modelName?: string;
  };
}

/** 交给内置 agent loop 执行的工具（真实 execute 由上层编排器包装注入） */
export interface AgentLoopTool {
  name: string;
  description: string;
  /** 工具的 JSON Schema 参数定义，透传给模型（缺失时退化为自由参数） */
  parameters?: Record<string, any>;
  execute: (args: any) => Promise<any>;
}

/**
 * 把工具注册时声明的 JSON Schema 参数定义透传给模型。
 * 之前用空 Schema 兜底导致模型看不到参数名/必填项，只能盲猜参数、
 * 失败重试，白白烧掉步数。无 Schema 时退化为 passthrough（自由参数）。
 * 附带轻量校验：缺少必填参数时在触达真实 execute 前拦截为 tool-error，
 * 模型可当步自纠，也避免非法参数触发副作用。
 */
function toInputSchema(params?: Record<string, any>) {
  if (params && typeof params === 'object' && params.type === 'object') {
    const required: string[] = Array.isArray(params.required) ? params.required : [];
    return jsonSchema(params as any, {
      validate: (value: any) => {
        if (typeof value !== 'object' || value === null) {
          return { success: false, error: new Error('工具参数必须是 JSON 对象') };
        }
        const missing = required.filter((k) => value[k] === undefined);
        if (missing.length > 0) {
          return { success: false, error: new Error(`缺少必填参数: ${missing.join(', ')}`) };
        }
        return { success: true, value };
      },
    });
  }
  return z.object({}).passthrough();
}

export interface AgentLoopStepInfo {
  stepNumber: number;
  text: string;
  toolCalls: Array<{ toolCallId: string; toolName: string; args: Record<string, any> }>;
  toolResults: Array<{ toolCallId: string; toolName: string; result: any }>;
  finishReason: string;
}

export interface AgentLoopOptions {
  model?: string;
  system?: string;
  messages: CoreMessage[];
  temperature?: number;
  /** 多步循环的最大步数（stopWhen: stepCountIs(N)） */
  maxSteps?: number;
  tools?: AgentLoopTool[];
  /** 本次调用只向模型声明的工具子集（其余仍可执行但不进上下文），缺省为全量 */
  activeTools?: string[];
  abortSignal?: AbortSignal;
  configOverride?: ModelInvokeOptions['configOverride'];
  /** 每步完成回调（模型文本 + 工具调用/结果），供上层做事件广播 */
  onStepFinish?: (info: AgentLoopStepInfo) => void;
}

export interface AgentLoopResult {
  /** 最后一步的文本输出 */
  text: string;
  finishReason: string;
  /** 实际执行步数 */
  stepsCount: number;
  /** 是否因触达步数上限而停止（此时模型可能仍想继续调工具） */
  stepsExhausted: boolean;
  /** 循环期间产生的标准 assistant/tool 消息（可拼回会话历史） */
  responseMessages: ModelMessage[];
  usage?: { promptTokens: number; completionTokens: number };
}

export class ModelService extends Service {
  private deepseekProvider: ReturnType<typeof createDeepSeek>;
  private openaiProvider: ReturnType<typeof createOpenAI>;

  constructor(ctx: Context) {
    super(ctx, 'model');

    const deepseekApiKey = process.env.DEEPSEEK_API_KEY || 'dummy_key';
    const openaiApiKey = process.env.OPENAI_API_KEY || 'dummy_key';

    this.deepseekProvider = createDeepSeek({
      apiKey: deepseekApiKey,
    });

    this.openaiProvider = createOpenAI({
      apiKey: openaiApiKey,
    });
  }

  /**
   * 单步无状态调用（AI SDK v5 generateText，stopWhen 固定为 1 步）。
   * 工具仅作为元定义声明给模型，本方法【不执行】任何工具；
   * 用于步数耗尽后的强制总结收尾等纯文本场景。
   */
  async invokeStep(options: ModelInvokeOptions): Promise<ModelStepResult> {
    const selectedModel = this.resolveActiveModel(options.model, options.configOverride);

    const toolsMap: Record<string, any> = {};
    if (!options.disableTools) {
      for (const t of this.ctx.agent.getTools()) {
        toolsMap[t.name] = tool({
          description: t.description,
          inputSchema: toInputSchema(t.parameters), // 透传真实参数定义
        });
      }
    }

    const response = await generateText({
      model: selectedModel,
      system: options.system,
      messages: options.messages,
      tools: Object.keys(toolsMap).length > 0 ? toolsMap : undefined,
      temperature: options.temperature ?? 0.7,
      stopWhen: stepCountIs(1), // 严格单步，绝不越权包含循环
    });

    return {
      text: response.text,
      toolCalls: response.toolCalls.map((tc) => ({
        toolCallId: tc.toolCallId,
        toolName: tc.toolName,
        args: (tc as any).input as Record<string, any>,
      })),
      finishReason: response.finishReason,
      usage: {
        promptTokens: response.usage?.inputTokens ?? 0,
        completionTokens: response.usage?.outputTokens ?? 0,
      },
    };
  }

  /**
   * 完整 agent loop：多步循环、消息拼装、tool-call/result 配对、provider 协议细节
   * 全部交给 Vercel AI SDK v5 内置循环（stopWhen: stepCountIs）。
   * 上层（core OrchestratorService）只需注入包装好的工具（审批门/熔断/广播）。
   */
  async runAgentLoop(options: AgentLoopOptions): Promise<AgentLoopResult> {
    const selectedModel = this.resolveActiveModel(options.model, options.configOverride);
    const maxSteps = Math.max(1, options.maxSteps ?? 10);

    const toolsMap: Record<string, any> = {};
    for (const t of options.tools ?? []) {
      toolsMap[t.name] = tool({
        description: t.description,
        inputSchema: toInputSchema(t.parameters), // 透传真实参数定义
        execute: async (args: any) => t.execute(args),
      });
    }

    // activeTools 只保留真实存在的名字，防止 SDK 校验报错
    const activeTools = options.activeTools?.length
      ? options.activeTools.filter((n) => n in toolsMap)
      : undefined;

    let stepCounter = 0;
    const response = await generateText({
      model: selectedModel,
      system: options.system,
      messages: options.messages,
      tools: Object.keys(toolsMap).length > 0 ? toolsMap : undefined,
      activeTools: activeTools && activeTools.length > 0 ? activeTools : undefined,
      temperature: options.temperature ?? 0.7,
      stopWhen: stepCountIs(maxSteps),
      abortSignal: options.abortSignal,
      onStepFinish: (step) => {
        stepCounter++;
        if (!options.onStepFinish) return;
        options.onStepFinish({
          stepNumber: (step as any).stepNumber ?? stepCounter,
          text: step.text ?? '',
          toolCalls: (step.toolCalls ?? []).map((tc) => ({
            toolCallId: tc.toolCallId,
            toolName: tc.toolName,
            args: (tc as any).input as Record<string, any>,
          })),
          toolResults: (step.toolResults ?? []).map((tr) => ({
            toolCallId: tr.toolCallId,
            toolName: tr.toolName,
            result: (tr as any).output,
          })),
          finishReason: step.finishReason,
        });
      },
    });

    return {
      text: response.text,
      finishReason: response.finishReason,
      stepsCount: response.steps?.length ?? stepCounter,
      // finishReason 仍为 tool-calls 说明是 stopWhen 截停（模型还想继续调工具）
      stepsExhausted: response.finishReason === 'tool-calls',
      responseMessages: (response.response?.messages ?? []) as ModelMessage[],
      usage: {
        promptTokens: response.usage?.inputTokens ?? 0,
        completionTokens: response.usage?.outputTokens ?? 0,
      },
    };
  }

  private resolveActiveModel(
    modelOverride?: string,
    configOverride?: { activeModelId?: string; apiKey?: string; baseURL?: string; modelName?: string }
  ) {
    const activeModelId =
      configOverride?.activeModelId ||
      modelOverride ||
      process.env.ACTIVE_MODEL_ID ||
      (process.env.CUSTOM_LLM_API_KEY
        ? 'custom_llm'
        : process.env.DEEPSEEK_API_KEY
        ? 'deepseek'
        : 'openai');

    if (activeModelId === 'custom_llm') {
      const apiKey = configOverride?.apiKey || process.env.CUSTOM_LLM_API_KEY || 'dummy_key';
      const baseURL = configOverride?.baseURL || process.env.CUSTOM_LLM_BASE_URL || undefined;
      const modelName = configOverride?.modelName || process.env.CUSTOM_LLM_MODEL_NAME || 'gpt-4o';
      const provider = createOpenAI({
        apiKey,
        baseURL,
      });
      return provider(modelName);
    }

    if (activeModelId === 'openai') {
      const apiKey = configOverride?.apiKey || process.env.OPENAI_API_KEY || 'dummy_key';
      const baseURL = configOverride?.baseURL || process.env.OPENAI_BASE_URL || undefined;
      const modelName = configOverride?.modelName || process.env.OPENAI_MODEL_NAME || 'gpt-4o';
      const provider = createOpenAI({
        apiKey,
        baseURL,
      });
      return provider(modelName);
    }

    // deepseek
    const apiKey = configOverride?.apiKey || process.env.DEEPSEEK_API_KEY || 'dummy_key';
    const baseURL = configOverride?.baseURL || process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/v1';
    const modelName = configOverride?.modelName || process.env.DEEPSEEK_MODEL_NAME || 'deepseek-chat';
    const provider = createDeepSeek({
      apiKey,
      baseURL,
    });
    return provider(modelName);
  }
}

export function apply(ctx: Context) {
  new ModelService(ctx);
}
