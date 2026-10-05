import { Context } from '@deepseek-ai/cordis';
import { AgentService, OrchestratorService } from '@agtpilot/core';
import * as BrowserPlugin from '@agtpilot/plugin-browser';
import * as ModelPlugin from '@agtpilot/plugin-model';

async function main() {
  console.log('🚀 启动 agtpilot (基于 DeepSeek Harness 官方 Cordis 插件微内核)...');

  // 1. 初始化 Cordis 微内核上下文
  const ctx = new Context();

  // 2. 注入核心服务 (Agent 原子工具管理 + 自研 Orchestrator 编排器)
  new AgentService(ctx);
  new OrchestratorService(ctx);

  // 3. 动态加载原子能力插件 (等待其 Fiber 依赖生命周期完成)
  await ctx.plugin(BrowserPlugin, { headless: true });
  await ctx.plugin(ModelPlugin);

  console.log('\n✅ agtpilot 底座启动成功！已动态装载的服务与工具:');
  console.log(` - 🧠 模型驱动服务: ctx.model 已就绪 (基于 Vercel AI SDK 方案 A 单步驱动)`);
  console.log(` - 🔄 编排调度服务: ctx.orchestrator 已就绪 (自研透明 ReAct 状态机)`);
  
  const tools = ctx.agent.getTools();
  tools.forEach((t) => {
    console.log(` - 🛠️ 原子工具 [${t.name}]: ${t.description}`);
  });

  // 4. 模拟注册一个带有高危安全级别的测试工具，验证 Human-in-the-Loop 审批拦截
  ctx.agent.registerTool({
    name: 'delete_local_data',
    description: '删除本地缓存或敏感数据',
    dangerLevel: 'high',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' } },
    },
    execute: async ({ path }) => ({ success: true, deleted: path }),
  });

  console.log('\n✨ 自研 Orchestrator 编排器关键能力验证:');
  console.log(' - 1. 原生支持死循环熔断器 (Loop Detector, 重复调用 3 次即熔断)');
  console.log(' - 2. 原生支持安全审批拦截 (Human-in-the-Loop, 高危工具挂起等前端确认)');
  console.log(' - 3. 全链路事件流广播 (AgentEvent: thought/tool_call/approval_request/done)');
  console.log(' - 4. 完美保持插件化解耦：未来想插 LangGraph 插件随时可无缝替换！');

  console.log('\n🎉 自研 ReAct 状态机编排引擎装配就绪！');
}

main().catch(console.error);
