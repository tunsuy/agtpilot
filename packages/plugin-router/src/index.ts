import { Context, Service } from '@deepseek-ai/cordis';
import '@agtpilot/core';

export const name = 'agtpilot-plugin-router';
export const inject = ['agent', 'model'];

/**
 * 模型能级路由器（Model Router）：
 * - tier 切换通过 ModelGateway.setPreferredModel 真正生效（不再是装饰性状态）；
 * - Token 用量订阅内核的 agtpilot/usage 事件累计（真实数据，非模拟值）；
 * - 预算经 ModelGateway.setBudget 下发，由模型侧在 agent loop 中硬熔断。
 */
export type ModelTier = 'reasoning' | 'fast' | 'local';

/** tier → 模型解析（可经环境变量覆盖具体模型名） */
const TIER_RESOLVERS: Record<ModelTier, () => { activeModelId: string; modelName: string; label: string }> = {
  reasoning: () => ({
    activeModelId: process.env.AGTPILOT_REASONING_PROVIDER || 'deepseek',
    modelName: process.env.AGTPILOT_REASONING_MODEL || 'deepseek-reasoner',
    label: process.env.AGTPILOT_REASONING_LABEL || 'DeepSeek-R1 类推理模型',
  }),
  fast: () => ({
    activeModelId: process.env.AGTPILOT_FAST_PROVIDER || 'deepseek',
    modelName: process.env.AGTPILOT_FAST_MODEL || 'deepseek-chat',
    label: process.env.AGTPILOT_FAST_LABEL || 'DeepSeek-V3 / GPT-4o-mini 类快响应模型',
  }),
  local: () => ({
    activeModelId: 'local_llm',
    modelName: process.env.LOCAL_LLM_MODEL_NAME || 'qwen2.5:14b',
    label: `本地推理（Ollama: ${process.env.LOCAL_LLM_MODEL_NAME || 'qwen2.5:14b'}，数据不出机）`,
  }),
};

export class ModelRouterService extends Service {
  private activeTier: ModelTier = 'fast';
  private usedTokens = 0;
  private maxTokensBudget = 0; // 0 = 未设置（不限制）
  private maxCostUsd = 0;

  constructor(ctx: Context) {
    super(ctx, 'router');

    // 真实用量累计：内核在每次 agent loop 结束后广播 agtpilot/usage
    ctx.on('agtpilot/usage', (usage) => {
      this.usedTokens += (usage.promptTokens || 0) + (usage.completionTokens || 0);
    });

    // 初始化时把默认 tier 同步给模型网关（保证插件加载顺序不影响生效）
    this.applyTier(this.activeTier, '初始化默认能级');
  }

  setTier(tier: ModelTier): { tier: ModelTier; label: string } {
    this.applyTier(tier, `router_set_tier(${tier})`);
    return { tier, label: TIER_RESOLVERS[tier]().label };
  }

  getTier(): ModelTier {
    return this.activeTier;
  }

  setBudget(maxTokens?: number, maxCost?: number) {
    if (maxTokens && maxTokens > 0) this.maxTokensBudget = Math.floor(maxTokens);
    if (maxCost && maxCost > 0) this.maxCostUsd = maxCost;
    // 预算下发到模型网关，由其在 agent loop 的 stopWhen 里硬熔断
    this.ctx.model.setBudget({ maxTokens: this.maxTokensBudget || undefined, maxCostUsd: this.maxCostUsd || undefined });
  }

  getStatus() {
    const resolver = TIER_RESOLVERS[this.activeTier]();
    const budgetRemainingPercent =
      this.maxTokensBudget > 0
        ? Math.max(0, Math.round(((this.maxTokensBudget - this.usedTokens) / this.maxTokensBudget) * 100))
        : 100;
    return {
      activeTier: this.activeTier,
      activeModel: `${resolver.activeModelId} / ${resolver.modelName}`,
      activeModelLabel: resolver.label,
      usedTokens: this.usedTokens,
      maxTokensBudget: this.maxTokensBudget,
      maxCostUsd: this.maxTokensBudget > 0 ? `$${this.maxCostUsd.toFixed(2)}` : '未设置',
      budgetRemainingPercent,
      budgetExceeded: this.maxTokensBudget > 0 && this.usedTokens >= this.maxTokensBudget,
    };
  }

  /** 把当前 tier 解析成模型偏好并写入 ModelGateway（真正切换生效的链路） */
  private applyTier(tier: ModelTier, reason: string) {
    this.activeTier = tier;
    const resolved = TIER_RESOLVERS[tier]();
    this.ctx.model.setPreferredModel({
      activeModelId: resolved.activeModelId,
      modelName: resolved.modelName,
      reason,
    });
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    router: ModelRouterService;
  }
}

export function apply(ctx: Context) {
  const routerService = new ModelRouterService(ctx);

  // 1. router_select_tier: 动态切换大模型能级梯度（真实生效：写入 ModelGateway 偏好）
  ctx.agent.registerTool({
    name: 'router_select_tier',
    baseline: true,
    description:
      '根据当前任务复杂性动态切换模型能级：reasoning (复杂架构与长推理)、fast (日常极速响应)、local (完全离线与敏感隐私，走本地 Ollama)。切换立即对后续模型调用生效。',
    parameters: {
      type: 'object',
      properties: {
        tier: {
          type: 'string',
          enum: ['reasoning', 'fast', 'local'],
          description: '期望切换的模型梯度',
        },
      },
      required: ['tier'],
    },
    execute: async ({ tier }) => {
      if (!['reasoning', 'fast', 'local'].includes(tier as string)) {
        return { success: false, error: `无效的能级梯度: ${tier}（可选 reasoning/fast/local）` };
      }
      const result = routerService.setTier(tier as ModelTier);
      return {
        success: true,
        activeTier: result.tier,
        activeModel: result.label,
        message: `模型路由能级已切换为 [${result.tier}]，后续模型调用将使用 ${result.label}。`,
      };
    },
  });

  // 2. router_get_budget_status: 获取当前 Token 消耗与预算状态（真实累计值）
  ctx.agent.registerTool({
    name: 'router_get_budget_status',
    baseline: true,
    description: '查看当前会话累计的 Token 消耗、模型能级与剩余预算百分比（数据为真实用量统计）。',
    parameters: {
      type: 'object',
      properties: {},
    },
    execute: async () => {
      const status = routerService.getStatus();
      return { success: true, ...status };
    },
  });

  // 3. router_set_budget_limit: 设定 Token 预算上限（模型侧 agent loop 硬熔断）
  ctx.agent.registerTool({
    name: 'router_set_budget_limit',
    baseline: true,
    description:
      '设置本次会话累计 Token 消耗上限。达到上限后正在执行的任务循环会被强制停止并进入总结收尾，防止失控计费。',
    parameters: {
      type: 'object',
      properties: {
        maxTokens: { type: 'number', description: '最大允许消耗的 Token 总量 (如: 100000)' },
        maxCostUsd: { type: 'number', description: '最大花费限制金额美元 (如: 1.5，当前仅记录展示)' },
      },
    },
    execute: async ({ maxTokens, maxCostUsd }) => {
      routerService.setBudget(maxTokens, maxCostUsd);
      return {
        success: true,
        message: `Token 预算上限已更新为: ${maxTokens || '未变更'}，成本红线: $${maxCostUsd || '未变更'}。超限后任务循环将强制收尾。`,
      };
    },
  });
}
