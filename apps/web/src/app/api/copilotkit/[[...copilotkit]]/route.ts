import {
  createCopilotRuntimeHandler,
  CopilotRuntime,
  BuiltInAgent,
  defineTool,
} from '@copilotkit/runtime/v2';
import { NextRequest } from 'next/server';
import { getAgentBackend } from '@/lib/agent-backend';

let runtimeHandler: ((req: Request) => Promise<Response>) | null = null;

async function getHandler() {
  if (!runtimeHandler) {
    const backend = getAgentBackend();
    await backend.whenReady();

    const registered = backend.ctx.agent.getTools();
    const tools = registered.map((tool) =>
      (defineTool as any)({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters as any,
        execute: async (args: any) => {
          return tool.execute(args, { source: 'copilotkit-web' });
        },
      })
    );

    // 动态根据 ACTIVE_MODEL_ID 选取生效模型与对应 Key 与 BaseURL
    const activeModelId = process.env.ACTIVE_MODEL_ID || (process.env.DEEPSEEK_API_KEY ? 'deepseek' : 'openai');

    let apiKey = 'dummy-key';
    let modelName = 'openai/deepseek-chat';
    let baseUrl: string | undefined = undefined;

    if (activeModelId === 'custom_llm') {
      apiKey = process.env.CUSTOM_LLM_API_KEY || 'dummy-key';
      const rawModel = process.env.CUSTOM_LLM_MODEL_NAME || 'gpt-4o';
      modelName = rawModel.includes('/') ? rawModel : `openai/${rawModel}`;
      baseUrl = process.env.CUSTOM_LLM_BASE_URL || undefined;
    } else if (activeModelId === 'openai') {
      apiKey = process.env.OPENAI_API_KEY || 'dummy-key';
      const rawModel = process.env.OPENAI_MODEL_NAME || 'gpt-4o';
      modelName = rawModel.includes('/') ? rawModel : `openai/${rawModel}`;
      baseUrl = process.env.OPENAI_BASE_URL || undefined;
    } else {
      // deepseek
      apiKey = process.env.DEEPSEEK_API_KEY || 'dummy-key';
      const rawModel = process.env.DEEPSEEK_MODEL_NAME || 'deepseek-chat';
      modelName = rawModel.includes('/') ? rawModel : `openai/${rawModel}`;
      baseUrl = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/v1';
    }

    const agentConfig: any = {
      model: modelName,
      apiKey,
      prompt:
        '你是由 DeepSeek Harness 官方 Cordis 插件微内核驱动的个人全自主智能体驾驶舱助手 (agtpilot)。你可以自主规划多步任务，并按需调用原子工具：互联网实时检索 (search_web, search_exa, search_tavily)、持久化浏览器与 Firecrawl 深度蒸馏 (browser_navigate, browser_screenshot, browser_click)、隔离代码与 E2B 微虚拟机沙箱 (sandbox_run_code, sandbox_run_command)、工作区文件操作 (sandbox_read_file, sandbox_write_file) 以及通过 Anthropic MCP 协议挂载任意外部工具。',
      tools,
    };

    if (baseUrl) {
      agentConfig.baseUrl = baseUrl;
    }

    const runtime = new CopilotRuntime({
      agents: {
        default: new BuiltInAgent(agentConfig),
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
  // 保持 handler 随模型环境更新
  runtimeHandler = null;
  const handler = await getHandler();
  return handler(req);
};

export const OPTIONS = async (req: NextRequest) => {
  const handler = await getHandler();
  return handler(req);
};
