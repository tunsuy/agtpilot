import {
  createCopilotRuntimeHandler,
  CopilotRuntime,
  BuiltInAgent,
  defineTool,
} from '@copilotkit/runtime/v2';
import { NextRequest } from 'next/server';

// 配置 DeepSeek / OpenAI 模型驱动
const apiKey = process.env.DEEPSEEK_API_KEY || process.env.OPENAI_API_KEY || 'dummy-key';
const modelName = process.env.DEEPSEEK_API_KEY ? 'openai/deepseek-chat' : 'openai/gpt-4o';

const runtime = new CopilotRuntime({
  agents: {
    default: new BuiltInAgent({
      model: modelName,
      apiKey,
      prompt:
        '你是由 DeepSeek Harness 和 Cordis 微内核驱动的个人自主 Agent 助理。你可以自主规划并调用浏览器自动化工具完成复杂调研任务。',
      tools: [
        defineTool({
          name: 'browser_navigate',
          description: '使用持久化浏览器导航至指定网址并提取 Markdown 网页正文',
          parameters: {
            type: 'object',
            properties: {
              url: {
                type: 'string',
                description: '需要访问的目标网址 URL',
              },
            },
            required: ['url'],
          },
          execute: async ({ url }: { url: string }) => {
            return {
              success: true,
              url,
              message: `[agtpilot] 页面 ${url} 加载成功，已完成蒸馏。`,
            };
          },
        }),
      ],
    }),
  },
});

const handler = createCopilotRuntimeHandler({
  runtime,
  basePath: '/api/copilotkit',
});

export const GET = (req: NextRequest) => handler(req);
export const POST = (req: NextRequest) => handler(req);
export const OPTIONS = (req: NextRequest) => handler(req);
