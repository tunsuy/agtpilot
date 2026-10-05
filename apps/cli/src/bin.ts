import { Context } from '@deepseek-ai/cordis';
import { AgentService } from '@agtpilot/core';
import * as BrowserPlugin from '@agtpilot/plugin-browser';

async function main() {
  console.log('🚀 启动 agtpilot (基于 DeepSeek Harness 官方 Cordis 插件微内核)...');

  // 1. 初始化 Cordis 微内核上下文
  const ctx = new Context();

  // 2. 注入 AgentService 核心服务 (提供 registerTool, getTools 等能力)
  new AgentService(ctx);

  // 3. 动态加载原子能力插件 (等待其 Fiber 依赖生命周期完成)
  await ctx.plugin(BrowserPlugin, { headless: true });

  console.log('\n✅ agtpilot 底座启动成功！已动态装载的原子工具:');
  const tools = ctx.agent.getTools();
  tools.forEach((t) => {
    console.log(` - 🛠️ [${t.name}]: ${t.description}`);
  });

  console.log('\n✨ 调度执行 browser_navigate 原子工具:');
  const navigateTool = ctx.agent.getTool('browser_navigate');
  if (navigateTool) {
    const res = await navigateTool.execute({ url: 'https://news.ycombinator.com' }, null);
    console.log('执行结果:', res);
  }

  console.log('\n🎉 DeepSeek Harness 插件化架构装配验证通过！');
}

main().catch(console.error);
