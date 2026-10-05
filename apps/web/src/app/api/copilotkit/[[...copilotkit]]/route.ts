import {
  createCopilotRuntimeHandler,
  CopilotRuntime,
  BuiltInAgent,
  defineTool,
} from '@copilotkit/runtime/v2';
import { NextRequest } from 'next/server';
import { Context } from '@deepseek-ai/cordis';
import { AgentService, OrchestratorService } from '@agtpilot/core';
import * as BrowserPlugin from '@agtpilot/plugin-browser';
import * as SandboxPlugin from '@agtpilot/plugin-sandbox';
import * as SearchPlugin from '@agtpilot/plugin-search';
import * as MCPPlugin from '@agtpilot/plugin-mcp';
import * as ArtifactPlugin from '@agtpilot/plugin-artifact';
import * as PlannerPlugin from '@agtpilot/plugin-planner';
import * as MemoryPlugin from '@agtpilot/plugin-memory';
import * as CronPlugin from '@agtpilot/plugin-cron';
import * as ObservabilityPlugin from '@agtpilot/plugin-observability';

// 1. 初始化并缓存单例 Cordis 微内核底座
let cordisContext: Context | null = null;
let initializedToolsPromise: Promise<any[]> | null = null;

async function getCordisTools() {
  if (!initializedToolsPromise) {
    initializedToolsPromise = (async () => {
      const ctx = new Context();
      new AgentService(ctx);
      new OrchestratorService(ctx);

      // 加载全套原子插件：浏览器、执行沙箱、互联网搜索引擎、Anthropic MCP 协议、产物画布、任务看板、长期记忆、定时巡检、可观测性
      await ctx.plugin(BrowserPlugin, { headless: true });
      await ctx.plugin(SandboxPlugin);
      await ctx.plugin(SearchPlugin);
      await ctx.plugin(MCPPlugin);
      await ctx.plugin(ArtifactPlugin);
      await ctx.plugin(PlannerPlugin);
      await ctx.plugin(MemoryPlugin);
      await ctx.plugin(CronPlugin);
      await ctx.plugin(ObservabilityPlugin);

      cordisContext = ctx;

      const registered = ctx.agent.getTools();
      return registered.map((tool) =>
        (defineTool as any)({
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters as any,
          execute: async (args: any) => {
            return tool.execute(args, { source: 'copilotkit-web' });
          },
        })
      );
    })();
  }
  return initializedToolsPromise;
}

// 2. 配置大模型调用凭证 (优先选用 DEEPSEEK 或 OPENAI)
const apiKey = process.env.DEEPSEEK_API_KEY || process.env.OPENAI_API_KEY || 'dummy-key';
const modelName = process.env.DEEPSEEK_API_KEY ? 'openai/deepseek-chat' : 'openai/gpt-4o';

let runtimeHandler: ((req: Request) => Promise<Response>) | null = null;

async function getHandler() {
  if (!runtimeHandler) {
    const tools = await getCordisTools();

    const runtime = new CopilotRuntime({
      agents: {
        default: new BuiltInAgent({
          model: modelName,
          apiKey,
          prompt:
            '你是由 DeepSeek Harness 官方 Cordis 插件微内核驱动的个人全自主智能体驾驶舱助手 (agtpilot)。你可以自主规划多步任务，并按需调用原子工具：互联网实时检索 (search_web, search_exa, search_tavily)、持久化浏览器与 Firecrawl 深度蒸馏 (browser_navigate, browser_firecrawl_scrape)、隔离代码与 E2B 微虚拟机沙箱 (sandbox_run_code, sandbox_e2b_run_python)、终端命令 (sandbox_run_command)、工作区文件操作 (sandbox_read_file, sandbox_write_file) 以及通过 Anthropic MCP 协议挂载任意外部工具 (mcp_connect_stdio, mcp_connect_sse)。',
          tools,
        }),
      },
    });

    runtimeHandler = createCopilotRuntimeHandler({
      runtime,
      basePath: '/api/copilotkit',
    });
  }
  return runtimeHandler;
}

export const GET = async (req: NextRequest) => {
  const handler = await getHandler();
  return handler(req);
};

export const POST = async (req: NextRequest) => {
  const handler = await getHandler();
  return handler(req);
};

export const OPTIONS = async (req: NextRequest) => {
  const handler = await getHandler();
  return handler(req);
};
