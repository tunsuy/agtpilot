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
    const modelId = options.model || 'deepseek:deepseek-chat';
    const selectedModel = this.resolveModel(modelId);

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

  private resolveModel(modelId: string) {
    const [provider, modelName] = modelId.includes(':')
      ? modelId.split(':')
      : ['deepseek', modelId];

    switch (provider) {
      case 'deepseek':
        return this.deepseekProvider(modelName);
      case 'openai':
        return this.openaiProvider(modelName);
      default:
        return this.deepseekProvider(modelName);
    }
  }
}

export function apply(ctx: Context) {
  new ModelService(ctx);
}
