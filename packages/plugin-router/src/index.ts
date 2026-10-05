import { Context, Service } from '@deepseek-ai/cordis';
import '@agtpilot/core';

export const name = 'agtpilot-plugin-router';
export const inject = ['agent'];

export type ModelTier = 'reasoning' | 'fast' | 'local';

export class ModelRouterService extends Service {
  private activeTier: ModelTier = 'fast';
  private maxTokensBudget: number = 200000;
  private usedTokens: number = 18450;
  private maxCostUsd: number = 2.0;

  constructor(ctx: Context) {
    super(ctx, 'router');
  }

  setTier(tier: ModelTier) {
    this.activeTier = tier;
  }

  getTier(): ModelTier {
    return this.activeTier;
  }

  setBudget(maxTokens?: number, maxCost?: number) {
    if (maxTokens) this.maxTokensBudget = maxTokens;
    if (maxCost) this.maxCostUsd = maxCost;
  }

  getStatus() {
    return {
      activeTier: this.activeTier,
      activeModel:
        this.activeTier === 'reasoning'
          ? 'DeepSeek-R1 / OpenAI o1'
          : this.activeTier === 'fast'
          ? 'DeepSeek-V3 / GPT-4o-mini'
          : 'Ollama:Qwen2.5-Coder (Local Offline)',
      usedTokens: this.usedTokens,
      maxTokensBudget: this.maxTokensBudget,
      maxCostUsd: `$${this.maxCostUsd.toFixed(2)}`,
      budgetRemainingPercent: Math.round(((this.maxTokensBudget - this.usedTokens) / this.maxTokensBudget) * 100),
    };
  }
}

export function apply(ctx: Context) {
  const routerService = new ModelRouterService(ctx);

  // 1. router_select_tier: 动态切换大模型能级梯度
  ctx.agent.registerTool({
    name: 'router_select_tier',
    description: '根据当前任务复杂性动态切换模型能级：reasoning (复杂架构与长推理，走 DeepSeek-R1/o1)、fast (日常极速响应，走 DeepSeek-V3/GPT-4o-mini)、local (完全离线与敏感隐私，走本地 Ollama)。',
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
      routerService.setTier(tier as ModelTier);
      const status = routerService.getStatus();
      return {
        success: true,
        activeTier: tier,
        activeModel: status.activeModel,
        message: `模型路由能级已成功切换为 [${tier}] (${status.activeModel})。`,
      };
    },
  });

  // 2. router_get_budget_status: 获取当前 Token 消耗与成本限额
  ctx.agent.registerTool({
    name: 'router_get_budget_status',
    description: '查看当前任务与会话的模型能级分配、Token 消耗统计以及剩余预算百分比。',
    parameters: {
      type: 'object',
      properties: {},
    },
    execute: async () => {
      const status = routerService.getStatus();
      return {
        success: true,
        ...status,
      };
    },
  });

  // 3. router_set_budget_limit: 设定 Token 预算与安全熔断上限
  ctx.agent.registerTool({
    name: 'router_set_budget_limit',
    description: '设置单次长链路任务的最大 Token 预算上限或花费限额，防止模型陷入失控计费。',
    parameters: {
      type: 'object',
      properties: {
        maxTokens: { type: 'number', description: '最大允许消耗的 Token 总量 (如: 100000)' },
        maxCostUsd: { type: 'number', description: '最大花费限制金额美元 (如: 1.5)' },
      },
    },
    execute: async ({ maxTokens, maxCostUsd }) => {
      routerService.setBudget(maxTokens, maxCostUsd);
      return {
        success: true,
        message: `Token 预算上限已更新为: ${maxTokens || '未变更'}，成本红线: $${maxCostUsd || '未变更'}。`,
      };
    },
  });
}
