import { Context, Service } from '@deepseek-ai/cordis';
import { generateText, streamText, stepCountIs, jsonSchema, tool } from 'ai';
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
  /**
   * 运行时偏好模型（plugin-router 的能级切换写入；优先级高于环境变量默认）。
   * modelName 按 provider 分域存储：切换到 openai 时不会带着 deepseek 的
   * 模型名（旧实现整包 merge，deepseek-reasoner 会泄漏进 openai 分支导致 404）。
   */
  private preferred: { activeModelId?: string; modelNames: Record<string, string>; reason?: string } = {
    modelNames: {},
  };
  /** Token 预算（超出时 agent loop 主动收尾）；0 = 未设置 */
  private budgetMaxTokens = 0;
  /** 进程内累计 token 用量（每步实时上报，循环内即生效） */
  private usedTokens = 0;

  constructor(ctx: Context) {
    super(ctx, 'model');
  }

  /**
   * 单步无状态调用（AI SDK v5 generateText，stopWhen 固定为 1 步）。
   * 工具仅作为元定义声明给模型，本方法【不执行】任何工具；
   * 用于步数耗尽后的强制总结收尾等纯文本场景。
   */
  async invokeStep(options: ModelInvokeOptions): Promise<ModelStepResult> {
    const selectedModel = this.resolveActiveModel(options.model, options.configOverride);

    // 单步无状态调用【不执行】工具，因此也【不声明】工具：
    // 声明无 execute 的工具会诱导模型产出 tool-call，随后 SDK 因无法执行而报错
    // （步数耗尽总结等收尾场景本就该纯文本输出）。
    const response = await generateText({
      model: selectedModel,
      system: options.system,
      messages: options.messages,
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
    // streamText 与 generateText options 完全同构（stopWhen/prepareStep/onStepFinish
    // 均受支持），但工具 execute 只在流被消费期间执行 —— 必须迭代 fullStream
    // 驱动循环；文本/推理增量同步转发给上层（P1 流式）。
    const result = streamText({
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
        // 预算实时记账：每步用量即时累计，stopWhen 下一轮即可感知 ——
        // 旧实现只在整循环结束后记账，循环内预算闸门永远看不见当次消耗
        const stepUsage = (step as any).usage;
        if (stepUsage) {
          this.recordUsage(stepUsage.inputTokens ?? 0, stepUsage.outputTokens ?? 0);
        }
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

    // ---- 消费流：驱动工具执行 + 转发增量（start-step 无 stepNumber 字段，自维护计数） ----
    let streamStepNumber = 0;
    try {
      for await (const part of result.fullStream) {
        // 中止后不再转发尾部增量（上层收尾走 error 路径，无需残段）
        if (options.abortSignal?.aborted) break;
        switch (part.type) {
          case 'start-step':
            streamStepNumber++;
            options.onStepStart?.({ stepNumber: streamStepNumber });
            break;
          case 'text-delta':
            options.onTextDelta?.(part.text);
            break;
          case 'reasoning-delta':
            options.onReasoningDelta?.(part.text);
            break;
          case 'error':
            throw part.error;
          default:
            break;
        }
      }
    } catch (err: any) {
      // abort 时流以 abort part 正常收尾而不抛错 —— 显式转抛，保持与
      // generateText 相同的中止语义（orchestrator catch → 任务已被主动终止）
      if (options.abortSignal?.aborted) throw new Error('Aborted');
      throw err;
    }
    if (options.abortSignal?.aborted) throw new Error('Aborted');

    // 工具已在流消费期间由 SDK 执行完毕；这里只收集结果（属性均为 Promise）
    // 用量已在 onStepFinish 按步实时记账（此处整包再记会双倍计数）
    const [text, finishReason, steps, usage, response] = await Promise.all([
      result.text,
      result.finishReason,
      result.steps,
      result.usage,
      result.response,
    ]);

    const budgetStopped =
      finishReason === 'tool-calls' && this.budgetMaxTokens > 0 && this.isBudgetExceeded();

    return {
      text,
      // 预算触顶与步数耗尽分开标识：上层与用户能分辨「为什么停」
      finishReason: budgetStopped ? 'budget-exceeded' : finishReason,
      stepsCount: steps?.length ?? stepCounter,
      // finishReason 仍为 tool-calls 说明是 stopWhen 截停（模型还想继续调工具）；
      // 预算触顶同样需要强制总结收尾
      stepsExhausted: finishReason === 'tool-calls',
      responseMessages: response?.messages ?? [],
      usage: {
        promptTokens: usage?.inputTokens ?? 0,
        completionTokens: usage?.outputTokens ?? 0,
      },
    };
  }

  /**
   * 设置偏好模型（plugin-router 能级切换入口）。
   * 优先级：configOverride > 显式 model 参数 > 本偏好 > 环境变量默认。
   * modelName 按 provider 分域：router 切到 openai 只影响 openai 分支的模型名。
   */
  setPreferredModel(pref: { activeModelId?: string; modelName?: string; reason?: string }): void {
    if (pref.activeModelId !== undefined) {
      this.preferred.activeModelId = pref.activeModelId || undefined;
    }
    if (pref.modelName) {
      const target = this.preferred.activeModelId || this.envDefaultModelId();
      this.preferred.modelNames[target] = pref.modelName;
    }
    if (pref.reason !== undefined) {
      this.preferred.reason = pref.reason;
    }
  }

  /** 设置 Token 预算：超出后 agent loop 主动收尾，防止失控计费。
   *  maxTokens: 0 为显式清零（撤销预算限制）；未传/负数不改动现有值 */
  setBudget(budget: { maxTokens?: number; maxCostUsd?: number }): void {
    if (budget.maxTokens === 0) {
      this.budgetMaxTokens = 0;
    } else if (budget.maxTokens && budget.maxTokens > 0) {
      this.budgetMaxTokens = budget.maxTokens;
    }
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

  /** 环境变量推断的默认 provider（setPreferredModel 只带 modelName 时落到这里） */
  private envDefaultModelId(): string {
    if (process.env.CUSTOM_LLM_API_KEY) return 'custom_llm';
    if (process.env.DEEPSEEK_API_KEY) return 'deepseek';
    return 'openai';
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
      this.envDefaultModelId();

    // 云端 provider 缺 API Key 时快速失败：配置错误应在入口报清楚，
    // 而不是用 'dummy_key' 裸奔到第一次请求才收到难排查的 401
    const requireApiKey = (envKey: string): string => {
      const key = configOverride?.apiKey || process.env[envKey];
      if (!key) {
        throw new Error(
          `[plugin-model] 缺少 ${envKey}：无法使用 ${activeModelId} 模型。请配置环境变量或在用户设置中填入 API Key。`
        );
      }
      return key;
    };

    if (activeModelId === 'custom_llm') {
      const apiKey = requireApiKey('CUSTOM_LLM_API_KEY');
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
      // 本地推理（Ollama 等 OpenAI 兼容端点）：敏感数据不出机，无需真实 Key
      const apiKey = configOverride?.apiKey || process.env.LOCAL_LLM_API_KEY || 'ollama';
      const baseURL = configOverride?.baseURL || process.env.OLLAMA_BASE_URL || 'http://localhost:11434/v1';
      const modelName =
        configOverride?.modelName ||
        this.preferred.modelNames['local_llm'] ||
        process.env.LOCAL_LLM_MODEL_NAME ||
        'qwen2.5:14b';
      const provider = createOpenAI({ apiKey, baseURL });
      return provider(modelName);
    }

    if (activeModelId === 'openai') {
      const apiKey = requireApiKey('OPENAI_API_KEY');
      const baseURL = configOverride?.baseURL || process.env.OPENAI_BASE_URL || undefined;
      const modelName =
        configOverride?.modelName ||
        this.preferred.modelNames['openai'] ||
        process.env.OPENAI_MODEL_NAME ||
        'gpt-4o';
      const provider = createOpenAI({
        apiKey,
        baseURL,
      });
      return provider(modelName);
    }

    if (activeModelId !== 'deepseek') {
      throw new Error(
        `[plugin-model] 未知的 activeModelId: ${activeModelId}（支持: deepseek / openai / custom_llm / local_llm）`
      );
    }

    // deepseek（默认）
    const apiKey = requireApiKey('DEEPSEEK_API_KEY');
    const baseURL = configOverride?.baseURL || process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/v1';
    const modelName =
      configOverride?.modelName ||
      this.preferred.modelNames['deepseek'] ||
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
