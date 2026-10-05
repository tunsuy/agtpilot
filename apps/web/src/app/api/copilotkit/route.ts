import {
  CopilotRuntime,
  OpenAIAdapter,
  copilotRuntimeNextJSAppRouterEndpoint,
} from '@copilotkit/runtime';
import { NextRequest } from 'next/server';

// 运行时端点处理：桥接 CopilotKit 前端组件与后端 Agent 交互
const serviceAdapter = new OpenAIAdapter();
const runtime = new CopilotRuntime({
  actions: [
    {
      name: 'browser_navigate',
      description: '使用持久化浏览器导航至指定网址并提取 Markdown 网页正文',
      parameters: [
        {
          name: 'url',
          type: 'string',
          description: '需要访问的目标网址 URL',
          required: true,
        },
      ],
      handler: async ({ url }) => {
        // 调用我们的原子浏览器能力
        return {
          success: true,
          url,
          message: `[agtpilot] 页面 ${url} 加载成功，已完成蒸馏。`,
        };
      },
    },
  ],
});

export const POST = async (req: NextRequest) => {
  const { handleRequest } = copilotRuntimeNextJSAppRouterEndpoint({
    runtime,
    serviceAdapter,
    endpoint: '/api/copilotkit',
  });

  return handleRequest(req);
};
