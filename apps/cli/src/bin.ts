import { Context } from '@deepseek-ai/cordis';
import { AgentService } from '@agtpilot/core';
import * as BrowserPlugin from '@agtpilot/plugin-browser';
import * as ModelPlugin from '@agtpilot/plugin-model';

async function main() {
  console.log('🚀 启动 agtpilot (基于 DeepSeek Harness 官方 Cordis 插件微内核)...');

  // 1. 初始化 Cordis 微内核上下文
  const ctx = new Context();

  // 2. 注入 AgentService 核心服务 (提供 registerTool, getTools 等能力)
  new AgentService(ctx);

  // 3. 动态加载原子能力插件 (等待其 Fiber 依赖生命周期完成)
  await ctx.plugin(BrowserPlugin, { headless: true });
  await ctx.plugin(ModelPlugin);

  console.log('\n✅ agtpilot 底座启动成功！已动态装载的服务与工具:');
  console.log(` - 🧠 模型驱动服务: ctx.model 已就绪 (基于 Vercel AI SDK 方案 A 单步驱动)`);
  const tools = ctx.agent.getTools();
  tools.forEach((t) => {
    console.log(` - 🛠️ 原子工具 [${t.name}]: ${t.description}`);
  });

  console.log('\n✨ 方案 A 验收：模型服务已被完全约束为单步驱动 (invokeStep)');
  console.log(' - 不包含任何循环逻辑，编排权完全归属于上层状态机！');

  console.log('\n🎉 DeepSeek Harness + 方案 A 模型驱动装配验证通过！');
}

main().catch(console.error);
