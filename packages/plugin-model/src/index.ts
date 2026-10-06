import { Context, Service } from '@deepseek-ai/cordis';
import { generateText, CoreMessage, tool } from 'ai';
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
  configOverride?: {
    activeModelId?: string;
    apiKey?: string;
    baseURL?: string;
    modelName?: string;
  };
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

  // 严格执行【方案 A】：单步无状态调用驱动，绝不越权包含循环
  async invokeStep(options: ModelInvokeOptions): Promise<ModelStepResult> {
    const selectedModel = this.resolveActiveModel(options.model, options.configOverride);

    // 将 ctx.agent 中动态注册的所有原子工具转换为 Vercel AI SDK 的标准 tool 映射
    const toolsMap: Record<string, any> = {};
    const registeredTools = this.ctx.agent.getTools();

    for (const t of registeredTools) {
      toolsMap[t.name] = tool({
        description: t.description,
        parameters: z.object({}).passthrough(), // 兼容动态参数验证
        execute: async (args) => {
          // 仅作为元定义传递给大模型，实际执行由上层状态机编排器控制
          return null;
        },
      });
    }

    // 单步调用 generateText (坚决不传 maxSteps)
    const response = await generateText({
      model: selectedModel,
      system: options.system,
      messages: options.messages,
      tools: Object.keys(toolsMap).length > 0 ? toolsMap : undefined,
      temperature: options.temperature ?? 0.7,
    });

    return {
      text: response.text,
      toolCalls: response.toolCalls.map((tc) => ({
        toolCallId: tc.toolCallId,
        toolName: tc.toolName,
        args: tc.args,
      })),
      finishReason: response.finishReason,
      usage: response.usage,
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
