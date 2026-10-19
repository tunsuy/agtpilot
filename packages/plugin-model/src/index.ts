import { Context, Service } from '@deepseek-ai/cordis';
import { generateText, streamText, stepCountIs, jsonSchema, tool } from 'ai';
import { createDeepSeek } from '@ai-sdk/deepseek';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { z } from 'zod';
import { ModelStepResult } from '@agtpilot/protocol';
import type {
  ModelGateway,
  ModelInvokeOptions,
  AgentLoopOptions,
  AgentLoopResult,
  AgentLoopStepInfo,
  ModelStreamTelemetry,
} from '@agtpilot/core';
import '@agtpilot/core';
import { thinkingProviderOptions, resolveThinkingEffort } from './thinking';
import { effortFallbackFetch } from './effort-fallback';

export const name = 'agtpilot-plugin-model';
export const inject = ['agent'];

export type { ModelStepResult };

/**
 * 上层 prepareStep 返回值 → AI SDK 的适配(按本次调用工具表过滤 + 空数组语义透传)。
 *
 * 关键语义:`activeTools: []`(显式空数组)是**合法收敛信号** ——
 * plugin-subagent token 预算闸的「收掉全部工具 + 注入收敛提示」依赖它强制子循环
 * 停止检索;按 falsy 丢弃会让收敛闸在生产静默失效(存量 bug,2026-10-18 修复,
 * 此前只有注入的收敛提示消息在起作用,工具照挂)。
 * 非空声明但名字全部不在本次工具表 = 无效输入,不输出 activeTools 维持现状
 * (不得误发空数组把工具全收掉)。导出供单测。
 */
export function adaptPrepareStepResult(
  result: { activeTools?: string[]; messages?: any[] } | undefined | null,
  toolsMap: Record<string, unknown>,
): { activeTools?: string[]; messages?: any[] } | undefined {
  if (!result) return undefined;
  const out: { activeTools?: string[]; messages?: any[] } = {};
  if (result.activeTools) {
    if (result.activeTools.length === 0) {
      out.activeTools = [];
    } else {
      const filtered = result.activeTools.filter((n) => n in toolsMap);
      if (filtered.length > 0) out.activeTools = filtered;
    }
  }
  if (result.messages?.length) out.messages = result.messages;
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * 模型调用错误信息增稠。APICallError 的顶层 message 常是「Failed to
 * process successful response」这类无操作性的文案(HTTP 200 但响应体解析
 * 失败),真实死因 —— 自定义中转/兼容端点返回的错误体(配额耗尽、速率
 * 限制、上下文超长)、状态码、底层解析异常 —— 都在 statusCode/
 * responseBody/cause 字段里。orchestrator 与任务错误步骤只透传 message,
 * 不增稠的话这些字段全被丢弃,生产排障只能靠猜。
 * 就地改写 err.message(保留原错误对象,abort 语义与 instanceof 判断不受影响)。
 */
function enrichModelError(err: any): void {
  if (!(err instanceof Error)) return;
  const extras: string[] = [];
  if (typeof (err as any).statusCode === 'number') extras.push(`HTTP ${(err as any).statusCode}`);
  const body = typeof (err as any).responseBody === 'string' ? (err as any).responseBody.trim() : '';
  if (body) extras.push(`响应体: ${body.slice(0, 500)}`);
  // cause 逐层带出(限深 3 层防循环引用;message 已含的不重复拼)
  let cause = (err as { cause?: unknown }).cause;
  for (let depth = 0; cause instanceof Error && depth < 3; depth++) {
    const m = cause.message || String(cause);
    if (m && !err.message.includes(m)) extras.push(`原因: ${m.slice(0, 300)}`);
    cause = (cause as { cause?: unknown }).cause;
  }
  if (extras.length > 0) err.message = `${err.message}｜${extras.join(' | ')}`;
}

/**
 * 模型流静默看门狗阈值（毫秒，环境变量可覆盖）：
 * - 静默 ≥ WARN（默认 2 分钟）→ 终端日志告警（等首字=上游排队/重试退避；中途静默=流可能中断）
 * - 静默 ≥ ABORT（默认 10 分钟）→ 主动断流，任务以「模型连接中断」明确失败收尾，
 *   不再无限卡 RUNNING（生产实测：自定义端点 SSE 假死，无 in-stream 超时兜底）
 * 工具执行与 prepareStep（含任务内压缩）期间不算静默 —— 长工具/长压缩是合法静默。
 */
const numEnv = (v: string | undefined, d: number) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : d;
};
const STALL_WARN_MS = numEnv(process.env.MODEL_STALL_WARN_MS, 120_000);
const STALL_ABORT_MS = numEnv(process.env.MODEL_STALL_ABORT_MS, 600_000);
/** 看门狗巡检间隔 */
const STALL_CHECK_MS = 15_000;

/**
 * 模型驱动服务：实现内核的 ModelGateway 契约（@agtpilot/core contracts）。
 *
 * 依赖方向：内核只依赖 ModelGateway 接口，本插件提供实现并以 'model'
 * 服务名注册 —— Context.model 的类型声明在 core（依赖倒置），
 * 本包不再做模块增强。
 */
export class ModelService extends Service implements ModelGateway {
  /**
   * 运行时偏好模型（setPreferredModel 写入口保留给未来服务端选型;当前无调用方。
   * 原 plugin-router 的模型自选能级切换已删除——用户连接器部署下 configOverride
   * 永远压过 preferred,切换实际无效）。modelName 按 provider 分域存储：切换到
   * openai 时不会带着 deepseek 的模型名（旧实现整包 merge 会泄漏导致 404）。
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
    const { model: selectedModel, branch } = this.resolveActiveModel(options.model, options.configOverride);

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
      // 思考深度:连接器级配置 > 全局 env > 分支缺省(resolveThinkingEffort 收口)
      providerOptions: thinkingProviderOptions(
        branch,
        resolveThinkingEffort(options.configOverride?.reasoningEffort)
      ),
      stopWhen: stepCountIs(1), // 严格单步，绝不越权包含循环
    }).catch((err: any) => {
      enrichModelError(err);
      throw err;
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
    const { model: selectedModel, branch } = this.resolveActiveModel(options.model, options.configOverride);
    const maxSteps = Math.max(1, options.maxSteps ?? 10);

    // ---- 流健康遥测状态（打点见 contracts.ModelStreamTelemetry）----
    const telemetry = (info: ModelStreamTelemetry) => options.onTelemetry?.(info);
    const runStartedAt = Date.now();
    // 任意流部件（含 start-step/tool 事件）都算"流还活着"；首 token 单独标记
    let lastActivityAt = runStartedAt;
    let firstTokenAt: number | null = null;
    let lastWarnSilentMs = 0;
    // 工具执行 / prepareStep（含压缩）期间的静默是合法的，看门狗不计时
    let activeToolRuns = 0;
    let preparingStep = false;

    const toolsMap: Record<string, any> = {};
    for (const t of options.tools ?? []) {
      toolsMap[t.name] = tool({
        description: t.description,
        inputSchema: toInputSchema(t.parameters), // 透传真实参数定义
        // 长工具（浏览器自动化等）执行期间无流增量是常态 —— 计入活跃期，
        // 看门狗只盯「模型流本身」的静默
        execute: async (args: any) => {
          activeToolRuns++;
          lastActivityAt = Date.now();
          try {
            return await t.execute(args);
          } finally {
            activeToolRuns--;
            lastActivityAt = Date.now();
          }
        },
      });
    }

    // activeTools 只保留真实存在的名字，防止 SDK 校验报错
    const activeTools = options.activeTools?.length
      ? options.activeTools.filter((n) => n in toolsMap)
      : undefined;

    let stepCounter = 0;
    // 用户中止信号中继：与看门狗共用一条传给 SDK 的信号，任一触发即断流；
    // 中止后语义分流 —— 用户中止走既有 Cancelled 路径，看门狗走模型连接中断
    const userSignal = options.abortSignal;
    const streamController = new AbortController();
    const relayUserAbort = () => streamController.abort();
    if (userSignal?.aborted) streamController.abort();
    else userSignal?.addEventListener('abort', relayUserAbort);
    let watchdogAbortMs = 0; // >0 = 看门狗已触发（记录触发时的静默时长）
    const watchdog = setInterval(() => {
      if (watchdogAbortMs || userSignal?.aborted) return;
      if (activeToolRuns > 0 || preparingStep) return;
      const silentMs = Date.now() - lastActivityAt;
      if (silentMs >= STALL_ABORT_MS) {
        watchdogAbortMs = silentMs;
        telemetry({ kind: 'stream-abort', ms: silentMs });
        streamController.abort();
        return;
      }
      if (silentMs >= STALL_WARN_MS && silentMs - lastWarnSilentMs >= STALL_WARN_MS) {
        lastWarnSilentMs = silentMs;
        telemetry({ kind: 'stall-warn', ms: silentMs, awaitingFirstToken: firstTokenAt === null });
      }
    }, STALL_CHECK_MS);
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
      // 思考深度旋钮：单轮输出上限由思考与答复/工具调用共用，思考不设防会
      // 把额度吃光导致 tool_call 写到一半被截（见 thinkingProviderOptions 注释）;
      // 档位解析:连接器级配置 > 全局 env > 分支缺省(resolveThinkingEffort 收口)
      providerOptions: thinkingProviderOptions(
        branch,
        resolveThinkingEffort(options.configOverride?.reasoningEffort)
      ),
      // 步数上限 + Token 预算双闸门：任一触达即停止循环（预算由 setBudget 设置）
      stopWhen: ({ steps }: { steps: any[] }) =>
        steps.length >= maxSteps || this.isBudgetExceeded(),
      abortSignal: streamController.signal,
      // 每步动态路由 + 任务内压缩：上层可重算本步可见工具（初始 activeTools 仍作默认），
      // 也可重写本步消息（超阈值时压缩历史）；两者都缺省时返回 undefined 不干预
      prepareStep: options.prepareStep
        ? async ({ stepNumber, messages }: any) => {
            // 压缩/路由耗时期间无流部件是合法静默，看门狗跳过
            preparingStep = true;
            try {
              const result = await options.prepareStep!({ stepNumber, messages });
              // 适配(含 activeTools: [] 收敛信号透传)抽为纯函数,见 adaptPrepareStepResult
              return adaptPrepareStepResult(result, toolsMap);
            } finally {
              preparingStep = false;
              lastActivityAt = Date.now();
            }
          }
        : undefined,
      // 流管道报错回调（含重试耗尽后的 RetryError）：在最终失败事件之外先留一条
      // 中间痕迹（何时出错、错的是什么），否则静默重试期间的等待无迹可寻
      onError: ({ error }: { error: unknown }) => {
        const err = error as any;
        telemetry({ kind: 'stream-error', error: err?.message || String(error) });
      },
      onStepFinish: (step) => {
        stepCounter++;
        // 预算实时记账：每步用量即时累计，stopWhen 下一轮即可感知 ——
        // 旧实现只在整循环结束后记账，循环内预算闸门永远看不见当次消耗
        const stepUsage = (step as any).usage;
        let usage: { promptTokens: number; completionTokens: number } | undefined;
        if (stepUsage) {
          this.recordUsage(stepUsage.inputTokens ?? 0, stepUsage.outputTokens ?? 0);
          // 透传上层（orchestrator 逐步入账 mission.usage → 前端实时成本展示）
          usage = { promptTokens: stepUsage.inputTokens ?? 0, completionTokens: stepUsage.outputTokens ?? 0 };
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
          ...(usage ? { usage } : {}),
        } satisfies AgentLoopStepInfo);
      },
    });

    // ---- 消费流：驱动工具执行 + 转发增量（start-step 无 stepNumber 字段，自维护计数） ----
    let streamStepNumber = 0;
    const stallError = () =>
      new Error(
        `模型连接中断：已 ${Math.round(watchdogAbortMs / 1000)}s 无任何输出（上游流假死或网络中断），本次调用已由看门狗中止`
      );
    try {
      for await (const part of result.fullStream) {
        // 任何部件送达都证明流活着（含 start-step / 工具事件），静默计时清零
        lastActivityAt = Date.now();
        // 中止后不再转发尾部增量（上层收尾走 error 路径，无需残段）
        if (userSignal?.aborted) break;
        switch (part.type) {
          case 'start-step':
            streamStepNumber++;
            options.onStepStart?.({ stepNumber: streamStepNumber });
            break;
          case 'text-delta':
            if (firstTokenAt === null) {
              firstTokenAt = Date.now();
              telemetry({ kind: 'ttft', ms: firstTokenAt - runStartedAt });
            }
            options.onTextDelta?.(part.text);
            break;
          case 'reasoning-delta':
            if (firstTokenAt === null) {
              firstTokenAt = Date.now();
              telemetry({ kind: 'ttft', ms: firstTokenAt - runStartedAt });
            }
            options.onReasoningDelta?.(part.text);
            break;
          case 'error':
            telemetry({
              kind: 'stream-error',
              error: (part.error as any)?.message || String(part.error),
            });
            throw part.error;
          default:
            break;
        }
      }
    } catch (err: any) {
      // 看门狗中止：转抛明确语义（区别于用户主动终止），orchestrator → 任务 FAILED
      if (watchdogAbortMs) throw stallError();
      // abort 时流以 abort part 正常收尾而不抛错 —— 显式转抛，保持与
      // generateText 相同的中止语义（orchestrator catch → 任务已被主动终止）
      if (options.abortSignal?.aborted) throw new Error('Aborted');
      enrichModelError(err);
      throw err;
    } finally {
      clearInterval(watchdog);
      userSignal?.removeEventListener('abort', relayUserAbort);
    }
    if (watchdogAbortMs) throw stallError();
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
   * 设置偏好模型（运行时切换入口;原调用方 plugin-router 已删除,契约保留备用）。
   * 优先级：configOverride > 显式 model 参数 > 本偏好 > 环境变量默认。
   * modelName 按 provider 分域：切到 openai 只影响 openai 分支的模型名。
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
  ): { model: any; branch: string } {
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
      // 用 openai-compatible 而非 openai:中转/自建端点常按 DeepSeek-R1 惯例
      // 在 SSE chunk 的 delta.reasoning_content 里流式输出思考过程,
      // @ai-sdk/openai 的 chat 解析不了它(思考过程整段丢失);
      // @ai-sdk/openai-compatible 同时识别 reasoning_content 与 reasoning,
      // 才能把思考增量转成 reasoning-delta 走 onReasoningDelta 回调
      const provider = createOpenAICompatible({
        name: 'custom-llm',
        apiKey,
        baseURL: baseURL || 'https://api.openai.com/v1',
        // 中转对 reasoning_effort 档位校验不一(实测有多渠道网关随机 400 拒
        // medium),fetch 层降级重试一次兜底,任务不因思考参数中断
        fetch: effortFallbackFetch,
      });
      return { model: provider(modelName), branch: 'custom_llm' };
    }

    if (activeModelId === 'local_llm') {
      // 本地推理（Ollama 等 OpenAI 兼容端点）：敏感数据不出机,无需真实 Key。
      // 同样走 openai-compatible:本地部署的推理模型(qwen3 等)也会经
      // delta.reasoning / reasoning_content 吐思考过程,openai 识别不了
      const apiKey = configOverride?.apiKey || process.env.LOCAL_LLM_API_KEY || 'ollama';
      const baseURL = configOverride?.baseURL || process.env.OLLAMA_BASE_URL || 'http://localhost:11434/v1';
      const modelName =
        configOverride?.modelName ||
        this.preferred.modelNames['local_llm'] ||
        process.env.LOCAL_LLM_MODEL_NAME ||
        'qwen2.5:14b';
      const provider = createOpenAICompatible({
        name: 'local-llm',
        apiKey,
        baseURL,
        fetch: effortFallbackFetch, // 本地部署对未知参数容忍度参差,同款兜底
      });
      return { model: provider(modelName), branch: 'local_llm' };
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
        fetch: effortFallbackFetch, // OPENAI_BASE_URL 指中转时同样可能拒思考参数
      });
      return { model: provider(modelName), branch: 'openai' };
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
      fetch: effortFallbackFetch, // DEEPSEEK_BASE_URL 指中转时同样可能拒思考参数
    });
    return { model: provider(modelName), branch: 'deepseek' };
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

export { thinkingProviderOptions, resolveThinkingEffort } from './thinking';
export { effortFallbackFetch, fetchWithEffortFallback } from './effort-fallback';
