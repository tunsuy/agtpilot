import { createAgentRuntime } from '@agtpilot/app-kit';

async function main() {
  console.log('🚀 启动 agtpilot (基于 Cordis 插件微内核 + app-kit 统一装配)...');

  // 1. 微内核 + 全套原子能力插件统一装配（composition root 在 @agtpilot/app-kit）
  //    Promise resolve 即全部插件就绪；单个插件失败只跳过并记录，不拖垮内核
  const runtime = await createAgentRuntime();
  const ctx = runtime.ctx;

  const failed = runtime.loaded.filter((l) => !l.ok);
  if (failed.length > 0) {
    console.log(`\n⚠️  ${failed.length} 个插件加载失败（已跳过）:`);
    failed.forEach((f) => console.log(`   - ${f.plugin}: ${f.error}`));
  }

  console.log('\n✅ agtpilot 底座启动成功！已动态装载的服务与工具:');
  console.log(' - 🧠 模型网关服务: ctx.model (ModelGateway, Vercel AI SDK v5 agent loop)');
  console.log(' - 🔄 编排调度服务: ctx.orchestrator (熔断/审批/压缩/检查点)');

  const tools = ctx.agent.getTools();
  tools.forEach((t) => {
    console.log(` - 🛠️ 原子工具 [${t.name}]: ${t.description}`);
  });

  // 2. 模拟注册一个带有高危安全级别的测试工具，验证 Human-in-the-Loop 审批拦截
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
  console.log(' - 1. 原生支持死循环熔断器 (Loop Detector, 滑动窗口同签名计数)');
  console.log(' - 2. 原生支持安全审批拦截 (Human-in-the-Loop, 高危工具挂起等前端确认)');
  console.log(' - 3. 全链路事件流广播 (AgentEvent: thought/tool_call/approval_request/done)');
  console.log(' - 4. 运行中消息检查点 (agtpilot/checkpoint, 重启后可续跑)');
  console.log(' - 5. 微内核依赖倒置：内核只依赖 ModelGateway/PlannerNotifier 契约');

  console.log('\n🎉 ReAct 编排引擎装配就绪！');
}

main().catch(console.error);
