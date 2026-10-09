import { Context, Service } from '@deepseek-ai/cordis';
import { generateText, stepCountIs, jsonSchema, tool } from 'ai';
import { createDeepSeek } from '@ai-sdk/deepseek';
import { createOpenAI } from '@ai-sdk/openai';
import { z } from 'zod';
import { ModelStepResult } from '@agtpilot/protocol';
import type {
  ModelGateway,
  ModelInvokeOptions,
  AgentLoopOptions,
  AgentLoopResult,
  AgentLoopStepInfo,
} from '@agtpilot/core';
import '@agtpilot/core';

export const name = 'agtpilot-plugin-model';
export const inject = ['agent'];

export type { ModelStepResult };

/**
 * 模型驱动服务：实现内核的 ModelGateway 契约（@agtpilot/core contracts）。
 *
 * 依赖方向：内核只依赖 ModelGateway 接口，本插件提供实现并以 'model'
 * 服务名注册 —— Context.model 的类型声明在 core（依赖倒置），
 * 本包不再做模块增强。
 */
export class ModelService extends Service implements ModelGateway {
  private deepseekProvider: ReturnType<typeof createDeepSeek>;
  private openaiProvider: ReturnType<typeof createOpenAI>;

  /** 运行时偏好模型（plugin-router 的能级切换写入；优先级高于环境变量默认） */
  private preferred: { activeModelId?: string; modelName?: string; reason?: string } = {};
  /** Token 预算（超出时 agent loop 主动收尾）；0 = 未设置 */
  private budgetMaxTokens = 0;
  /** 进程内累计 token 用量（runAgentLoop 每次上报） */
  private usedTokens = 0;

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
      // 工具循环默认低温：高温会降低工具选择与 JSON 参数生成的稳定性，
      // 引发无效参数报错 → 重试烧步数（这是"2 步任务跑很多步"的隐形推手）
      temperature: options.temperature ?? 0,
      stopWhen: stepCountIs(1), // 严格单步，绝不越权包含循环
    });

    this.recordUsage(response.usage?.inputTokens ?? 0, response.usage?.outputTokens ?? 0);

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
      // 工具循环默认低温：高温会降低工具选择与 JSON 参数生成的稳定性，
      // 引发无效参数报错 → 重试烧步数（这是"2 步任务跑很多步"的隐形推手）
      temperature: options.temperature ?? 0,
      // 步数上限 + Token 预算双闸门：任一触达即停止循环（预算由 setBudget 设置）
      stopWhen: ({ steps }: { steps: any[] }) =>
        steps.length >= maxSteps || this.isBudgetExceeded(),
      abortSignal: options.abortSignal,
      // 每步动态路由 + 任务内压缩：上层可重算本步可见工具（初始 activeTools 仍作默认），
      // 也可重写本步消息（超阈值时压缩历史）；两者都缺省时返回 undefined 不干预
      prepareStep: options.prepareStep
        ? async ({ stepNumber, messages }: any) => {
            const result = await options.prepareStep!({ stepNumber, messages });
            if (!result) return undefined;
            const out: { activeTools?: string[]; messages?: any[] } = {};
            if (result.activeTools?.length) {
              const filtered = result.activeTools.filter((n) => n in toolsMap);
              if (filtered.length > 0) out.activeTools = filtered;
            }
            if (result.messages?.length) out.messages = result.messages;
            return Object.keys(out).length > 0 ? out : undefined;
          }
        : undefined,
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
        } satisfies AgentLoopStepInfo);
      },
    });

    this.recordUsage(response.usage?.inputTokens ?? 0, response.usage?.outputTokens ?? 0);

    return {
      text: response.text,
      finishReason: response.finishReason,
      stepsCount: response.steps?.length ?? stepCounter,
      // finishReason 仍为 tool-calls 说明是 stopWhen 截停（模型还想继续调工具）
      stepsExhausted: response.finishReason === 'tool-calls',
      responseMessages: response.response?.messages ?? [],
      usage: {
        promptTokens: response.usage?.inputTokens ?? 0,
        completionTokens: response.usage?.outputTokens ?? 0,
      },
    };
  }

  /**
   * 设置偏好模型（plugin-router 能级切换入口）。
   * 优先级：configOverride > 显式 model 参数 > 本偏好 > 环境变量默认。
   */
  setPreferredModel(pref: { activeModelId?: string; modelName?: string; reason?: string }): void {
    this.preferred = { ...this.preferred, ...pref };
  }

  /** 设置 Token 预算：超出后 agent loop 主动收尾，防止失控计费 */
  setBudget(budget: { maxTokens?: number; maxCostUsd?: number }): void {
    if (budget.maxTokens && budget.maxTokens > 0) this.budgetMaxTokens = budget.maxTokens;
    // maxCostUsd 保留接口位：成本换算依赖具体模型定价，当前按 token 预算约束
  }

  getUsage() {
    return { usedTokens: this.usedTokens, budgetMaxTokens: this.budgetMaxTokens };
  }

  private isBudgetExceeded(): boolean {
    return this.budgetMaxTokens > 0 && this.usedTokens >= this.budgetMaxTokens;
  }

  private recordUsage(promptTokens: number, completionTokens: number) {
    this.usedTokens += promptTokens + completionTokens;
  }

  private resolveActiveModel(
    modelOverride?: string,
    configOverride?: { activeModelId?: string; apiKey?: string; baseURL?: string; modelName?: string }
  ) {
    // 优先级：用户级覆盖 > 任务显式指定 > 运行时偏好（router 能级切换）> 环境变量默认
    const activeModelId =
      configOverride?.activeModelId ||
      modelOverride ||
      this.preferred.activeModelId ||
      (process.env.CUSTOM_LLM_API_KEY
        ? 'custom_llm'
        : process.env.DEEPSEEK_API_KEY
        ? 'deepseek'
        : 'openai');

    if (activeModelId === 'custom_llm') {
      const apiKey = configOverride?.apiKey || process.env.CUSTOM_LLM_API_KEY || 'dummy_key';
      const baseURL = configOverride?.baseURL || process.env.CUSTOM_LLM_BASE_URL || undefined;
      const modelName =
        configOverride?.modelName || process.env.CUSTOM_LLM_MODEL_NAME || 'gpt-4o';
      const provider = createOpenAI({
        apiKey,
        baseURL,
      });
      return provider(modelName);
    }

    if (activeModelId === 'local_llm') {
      // 本地推理（Ollama 等 OpenAI 兼容端点）：敏感数据不出机
      const apiKey = configOverride?.apiKey || process.env.LOCAL_LLM_API_KEY || 'ollama';
      const baseURL = configOverride?.baseURL || process.env.OLLAMA_BASE_URL || 'http://localhost:11434/v1';
      const modelName =
        configOverride?.modelName || this.preferred.modelName || process.env.LOCAL_LLM_MODEL_NAME || 'qwen2.5:14b';
      const provider = createOpenAI({ apiKey, baseURL });
      return provider(modelName);
    }

    if (activeModelId === 'openai') {
      const apiKey = configOverride?.apiKey || process.env.OPENAI_API_KEY || 'dummy_key';
      const baseURL = configOverride?.baseURL || process.env.OPENAI_BASE_URL || undefined;
      const modelName =
        configOverride?.modelName || this.preferred.modelName || process.env.OPENAI_MODEL_NAME || 'gpt-4o';
      const provider = createOpenAI({
        apiKey,
        baseURL,
      });
      return provider(modelName);
    }

    // deepseek（默认）
    const apiKey = configOverride?.apiKey || process.env.DEEPSEEK_API_KEY || 'dummy_key';
    const baseURL = configOverride?.baseURL || process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/v1';
    const modelName =
      configOverride?.modelName ||
      this.preferred.modelName ||
      process.env.DEEPSEEK_MODEL_NAME ||
      'deepseek-chat';
    const provider = createDeepSeek({
      apiKey,
      baseURL,
    });
    return provider(modelName);
  }
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

export function apply(ctx: Context) {
  new ModelService(ctx);
}
