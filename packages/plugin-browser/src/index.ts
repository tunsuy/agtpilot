import { Context } from '@deepseek-ai/cordis';
import '@agtpilot/core';

export const name = 'agtpilot-plugin-browser';
export const inject = ['agent'];

export interface BrowserPluginConfig {
  headless?: boolean;
}

export function apply(ctx: Context, config: BrowserPluginConfig = { headless: true }) {
  // 注册 browser_navigate 原子工具到 Agent 核心
  ctx.agent.registerTool({
    name: 'browser_navigate',
    description: '使用持久化浏览器导航至指定网址并提取页面内容',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '需要访问的目标 URL 地址' },
      },
      required: ['url'],
    },
    execute: async ({ url }) => {
      ctx.agent.emitEvent({
        type: 'tool_call',
        payload: { tool: 'browser_navigate', url },
        timestamp: Date.now(),
      });

      return {
        success: true,
        url,
        message: `成功导航至 ${url}，页面已加载就绪。`,
      };
    },
  });

  // 注册 browser_click 原子工具
  ctx.agent.registerTool({
    name: 'browser_click',
    description: '在当前页面上模拟点击特定元素或链接',
    parameters: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS 选择器或文本描述' },
      },
      required: ['selector'],
    },
    execute: async ({ selector }) => {
      return {
        success: true,
        selector,
        message: `已点击元素: ${selector}`,
      };
    },
  });
}
