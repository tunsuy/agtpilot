import { createAgentRuntime } from '@agtpilot/app-kit';
import * as fs from 'fs';
import * as path from 'path';

/** CLI 单用户定时任务本地持久化（多用户场景由 Web 的 user-store + 用户级工具负责） */
const CLI_CRON_FILE = path.resolve(process.cwd(), '.cache', 'cli_cron_jobs.json');

function loadCliCronJobs(): any[] {
  try {
    return JSON.parse(fs.readFileSync(CLI_CRON_FILE, 'utf-8'));
  } catch {
    return [];
  }
}

function saveCliCronJobs(jobs: any[]) {
  fs.mkdirSync(path.dirname(CLI_CRON_FILE), { recursive: true });
  fs.writeFileSync(CLI_CRON_FILE, JSON.stringify(jobs, null, 2), 'utf-8');
}

/**
 * CLI 侧全局 cron 工具包装（应用层补齐 plugin-cron 刻意不做的三件事）：
 * 持久化到本地文件、触发时 runTask、工具暴露给模型。多用户的 Web 侧
 * 对应实现见 apps/web/src/lib/cron-service.ts（user-store + 用户级 taskTools）。
 */
function mountCliCronTools(ctx: any) {
  const sync = (jobs: any[]) => {
    // 本地文件是唯一事实源：重建调度池（幂等）
    for (const id of ctx.cron.activeIds()) ctx.cron.cancel(id);
    for (const job of jobs) {
      if (job.status === 'active') ctx.cron.register(job.id, job.pattern, () => ctx.orchestrator.runTask({
        prompt: `【定时巡检主动触发 - ${job.name}】: ${job.prompt}`,
      }));
    }
  };

  ctx.agent.registerTool({
    name: 'cron_schedule_task',
    description: '设置自主定时/周期性主动执行任务 (Cron Job)。例如："每天早上9点搜索AI论文"、"每小时检查某系统状态并告警"。Agent 会在后台无人值守自动唤醒执行。',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '定时任务名称' },
        cronPattern: { type: 'string', description: '标准 5 位 Cron 表达式 (如: "0 9 * * *")' },
        taskPrompt: { type: 'string', description: '触发时自动派发给 Agent 执行的任务指令' },
      },
      required: ['name', 'cronPattern', 'taskPrompt'],
    },
    execute: async ({ name, cronPattern, taskPrompt }: any) => {
      try {
        const jobs = loadCliCronJobs();
        const job = {
          id: `cron_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          name, pattern: cronPattern, prompt: taskPrompt, status: 'active', runCount: 0,
        };
        jobs.push(job);
        saveCliCronJobs(jobs);
        sync(jobs);
        return { success: true, jobId: job.id, nextRun: ctx.cron.nextRun(job.id), message: `定时任务 [${name}] 已创建。` };
      } catch (err: any) {
        return { success: false, error: err.message };
      }
    },
  });

  ctx.agent.registerTool({
    name: 'cron_list_tasks',
    description: '查看当前后台已激活的所有定时巡检任务列表与下一次触发时间。',
    parameters: { type: 'object', properties: {} },
    execute: async () => {
      const jobs = loadCliCronJobs().map((j: any) => ({ ...j, nextRun: ctx.cron.nextRun(j.id) }));
      return { success: true, total: jobs.length, tasks: jobs };
    },
  });

  ctx.agent.registerTool({
    name: 'cron_cancel_task',
    description: '取消已登记的定时巡检任务，停止后续自动触发。',
    parameters: {
      type: 'object',
      properties: { jobId: { type: 'string', description: '要取消的定时任务 ID' } },
      required: ['jobId'],
    },
    execute: async ({ jobId }: any) => {
      let jobs = loadCliCronJobs();
      const job = jobs.find((j: any) => j.id === jobId);
      if (!job) return { success: false, error: `未找到 ID 为 [${jobId}] 的定时任务。` };
      jobs = jobs.filter((j: any) => j.id !== jobId);
      saveCliCronJobs(jobs);
      ctx.cron.cancel(jobId);
      return { success: true, message: `任务 [${job.name}] 已取消。` };
    },
  });

  // 启动时恢复已持久化的任务
  sync(loadCliCronJobs());
}

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

  // 2. CLI 单用户 cron 工具包装（调度本体在 plugin-cron 的无头 CronService，
  //    应用层补齐持久化/执行/工具三件事 —— Web 侧对应 apps/web/src/lib/cron-service.ts）
  mountCliCronTools(ctx);

  const tools = ctx.agent.getTools();
  tools.forEach((t: any) => {
    console.log(` - 🛠️ 原子工具 [${t.name}]: ${t.description}`);
  });

  // 3. 模拟注册一个带有高危安全级别的测试工具，验证 Human-in-the-Loop 审批拦截
  ctx.agent.registerTool({
    name: 'delete_local_data',
    description: '删除本地缓存或敏感数据',
    dangerLevel: 'high',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' } },
    },
    execute: async ({ path }: any) => ({ success: true, deleted: path }),
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
