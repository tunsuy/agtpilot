import { Context } from '@deepseek-ai/cordis';
import type { AgentService, OrchestratorService, ModelGateway } from '@agtpilot/core';
import * as Core from '@agtpilot/core';
import * as BrowserPlugin from '@agtpilot/plugin-browser';
import * as SandboxPlugin from '@agtpilot/plugin-sandbox';
import * as SearchPlugin from '@agtpilot/plugin-search';
import * as MCPPlugin from '@agtpilot/plugin-mcp';
import * as ModelPlugin from '@agtpilot/plugin-model';
import * as ArtifactPlugin from '@agtpilot/plugin-artifact';
import * as PlannerPlugin from '@agtpilot/plugin-planner';
import * as MemoryPlugin from '@agtpilot/plugin-memory';
import * as CronPlugin from '@agtpilot/plugin-cron';
import * as ObservabilityPlugin from '@agtpilot/plugin-observability';
import * as GitPlugin from '@agtpilot/plugin-git';
import * as NotifyPlugin from '@agtpilot/plugin-notify';
import * as RagPlugin from '@agtpilot/plugin-rag';
import * as DesktopPlugin from '@agtpilot/plugin-desktop';
import * as RouterPlugin from '@agtpilot/plugin-router';

/**
 * agtpilot 装配工厂（composition root）。
 *
 * 之前 apps/cli 与 apps/web 各自维护一份"import 15 个插件 + 人肉保序加载"的
 * 列表（新增插件要改两处、顺序错了解析不到服务）。现在统一在这里装配：
 * - core 走 cordis 插件形态（ctx.plugin(Core)），消除"裸类手动 new / apply 双形态并存"；
 * - 返回的 Promise resolve 即全部插件就绪 —— 调用方不再有装配竞态；
 * - 单个插件加载失败只跳过该插件并记录错误，不拖垮整个内核
 *   （浏览器/沙箱等重依赖环境缺失时其余能力仍可用）。
 */

export interface AgentRuntime {
  /** 微内核上下文（服务已全部就绪） */
  ctx: Context;
  /** 工具注册表服务 */
  agent: AgentService;
  /** 任务编排服务 */
  orchestrator: OrchestratorService;
  /** 模型网关（plugin-model 提供） */
  model: ModelGateway;
  /** 各插件加载结果（失败项含 error） */
  loaded: Array<{ plugin: string; ok: boolean; error?: string }>;
}

export interface CreateAgentOptions {
  /** 浏览器插件配置（默认 headless: true） */
  browser?: { headless?: boolean };
  /** 跳过指定插件（按插件名，如 'plugin-browser'）——最小化部署用 */
  exclude?: string[];
}

export async function createAgentRuntime(options: CreateAgentOptions = {}): Promise<AgentRuntime> {
  const ctx = new Context();
  const loaded: AgentRuntime['loaded'] = [];

  const skip = new Set(options.exclude || []);
  const mount = async (pluginName: string, plugin: any, config?: any) => {
    if (skip.has(pluginName)) return;
    try {
      await ctx.plugin(plugin, config);
      loaded.push({ plugin: pluginName, ok: true });
    } catch (err: any) {
      // 单插件失败不拖垮内核：记录并继续（调用方可通过 loaded 检查）
      const message = err?.message || String(err);
      loaded.push({ plugin: pluginName, ok: false, error: message });
      console.error(`[app-kit] 插件 ${pluginName} 加载失败（已跳过）: ${message}`);
    }
  };

  // 1. 微内核（AgentService + OrchestratorService，经 apply 装配 —— 唯一装配形态）
  await mount('core', Core);

  // 2. 原子能力插件。顺序不敏感：插件间的依赖由 cordis inject 声明解析
  //    （如 plugin-model inject ['agent']），此处只做并列加载。
  await mount('plugin-model', ModelPlugin);
  // router 硬依赖 model 服务（inject: ['model']）：model 加载失败时跳过，避免挂起
  if (loaded.some((l) => l.plugin === 'plugin-model' && l.ok)) {
    await mount('plugin-router', RouterPlugin);
  }
  await mount('plugin-planner', PlannerPlugin);
  await mount('plugin-memory', MemoryPlugin);
  await mount('plugin-artifact', ArtifactPlugin);
  await mount('plugin-browser', BrowserPlugin, { headless: options.browser?.headless ?? true });
  await mount('plugin-sandbox', SandboxPlugin);
  await mount('plugin-search', SearchPlugin);
  await mount('plugin-git', GitPlugin);
  await mount('plugin-desktop', DesktopPlugin);
  await mount('plugin-cron', CronPlugin);
  await mount('plugin-notify', NotifyPlugin);
  await mount('plugin-rag', RagPlugin);
  await mount('plugin-mcp', MCPPlugin);
  await mount('plugin-observability', ObservabilityPlugin);

  return {
    ctx,
    agent: ctx.agent,
    orchestrator: ctx.orchestrator,
    model: ctx.model,
    loaded,
  };
}

export { Core };
