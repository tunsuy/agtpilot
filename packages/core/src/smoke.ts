/**
 * 手动冒烟回归脚本（不依赖真实模型，stub 驱动）：
 *   npx tsx packages/core/src/smoke.ts
 * 验证 harness 三大能力：
 * 1. 滑动窗口熔断器能否抓住 A→B→A→B 交替空转（旧版"连续相同"检测器抓不住）
 * 2. 看板自动推进（工具成功即推进，模型零汇报调用）
 * 3. 会话压缩（超阈值历史 → 纪要替换旧工具消息，近期窗口保留）
 */
import { Context } from '@deepseek-ai/cordis';
import { AgentService, OrchestratorService, ToolDefinition } from './index';
import type { ModelGateway, PlannerNotifier } from './index';

async function main() {
  const ctx = new Context();
  new AgentService(ctx);
  const orch = new OrchestratorService(ctx);

  // ---- stub 模型网关（实现 ModelGateway 契约，编译期防契约漂移）：
  // 驱动 A/B 交替空转，然后给最终文本 ----
  // 每轮先走 prepareStep（模拟 AI SDK v5 每步前的准备回调），验证任务内压缩
  let round = 0;
  let midLoopCompacted = false;
  let midLoopMessagesBefore = 0;
  let longOutputTruncated = false;
  let longOutputKeepsTail = false;
  let longOutputKeepsHead = false;
  const stubModel: ModelGateway = {
    setPreferredModel: () => {},
    setBudget: () => {},
    runAgentLoop: async (opts: any) => {
      const tools = opts.tools as Array<{ name: string; execute: (args: any) => Promise<any> }>;
      const find = (n: string) => tools.find((t) => t.name === n)!;
      const seq = ['tool_a', 'tool_b', 'tool_a', 'tool_b', 'tool_a', 'tool_b', 'tool_a', 'tool_b', 'sandbox_run_command'];
      const responseMessages: any[] = [];
      let loopMessages: any[] = [...opts.messages];
      while (round < seq.length) {
        // 模拟 SDK：每步调用前触发 prepareStep，可重写本步消息（任务内压缩挂载点）
        const adjust = await opts.prepareStep?.({ stepNumber: round + 1, messages: loopMessages });
        if (adjust?.messages) {
          midLoopCompacted = true;
          midLoopMessagesBefore = loopMessages.length;
          loopMessages = adjust.messages;
          console.log(`   [in-loop] 第 ${round + 1} 步前触发压缩: ${midLoopMessagesBefore} -> ${loopMessages.length} 条消息`);
        }
        const name = seq[round];
        const out = await find(name).execute({});
        if (name === 'sandbox_run_command') {
          longOutputTruncated = typeof out === 'string' && out.includes('中间省略');
          longOutputKeepsTail = typeof out === 'string' && out.includes('TAIL_SENTINEL');
          longOutputKeepsHead = typeof out === 'string' && out.includes('HEAD_SENTINEL');
        }
        responseMessages.push({
          role: 'assistant',
          content: [{ type: 'tool-call', toolCallId: `c${round}`, toolName: name, input: {} }],
        });
        responseMessages.push({
          role: 'tool',
          content: [{ type: 'tool-result', toolCallId: `c${round}`, output: out }],
        });
        round++;
      }
      return { text: '最终答复', finishReason: 'stop', stepsCount: seq.length, stepsExhausted: false, responseMessages };
    },
    invokeStep: async () => ({
      text: '【已确立事实】\n- 测试蒸馏事实',
      toolCalls: [],
      finishReason: 'stop',
      usage: { promptTokens: 0, completionTokens: 0 },
    }),
  };
  // 以 'model' 服务名注册（内核经 ctx.reflect.get('model') 类型化读取）
  ctx.reflect.provide('model', stubModel);

  // ---- stub 规划器（实现 PlannerNotifier 契约）：验证 noteToolResult 自动推进 ----
  const plan = {
    goal: 'g',
    tasks: [
      { id: 't1', title: 'a', status: 'in_progress' },
      { id: 't2', title: 'b', status: 'pending' },
      { id: 't3', title: 'c', status: 'pending' },
    ],
    currentTaskId: 't1',
  };
  let advances = 0;
  const stubPlanner: PlannerNotifier = {
    noteToolResult: (_taskId: string, toolName: string) => {
      const cur = plan.tasks.find((t: any) => t.id === plan.currentTaskId && t.status === 'in_progress');
      if (cur) {
        cur.status = 'completed';
        const next = plan.tasks.find((t: any) => t.status === 'pending');
        if (next) {
          next.status = 'in_progress';
          plan.currentTaskId = next.id;
        }
        advances++;
      }
    },
  };
  ctx.reflect.provide('planner', stubPlanner);

  const seenEvents: string[] = [];
  ctx.on('agtpilot/event', (e: any) => seenEvents.push(e.type));

  ctx.agent.registerTool({
    name: 'tool_a',
    description: 'a',
    parameters: { type: 'object', properties: {} },
    execute: async () => ({ ok: true }),
  } as ToolDefinition);
  ctx.agent.registerTool({
    name: 'tool_b',
    description: 'b',
    parameters: { type: 'object', properties: {} },
    execute: async () => ({ ok: true }),
  } as ToolDefinition);
  // 超长输出工具（sandbox_ 前缀 → 尾优先头尾混合截断）：头部与尾部各埋哨兵
  ctx.agent.registerTool({
    name: 'sandbox_run_command',
    description: 'run',
    parameters: { type: 'object', properties: {} },
    execute: async () =>
      `HEAD_SENTINEL 命令开始\n${'中间正文内容。'.repeat(3000)}\n命令结束 TAIL_SENTINEL`,
  } as ToolDefinition);

  // ---- 构造超长历史（30 组工具配对，约 4 万 tokens）触发压缩 ----
  const history: Array<{ role: 'user' | 'assistant' | 'tool'; content: any }> = [
    { role: 'user', content: '最初的任务意图' },
  ];
  for (let i = 0; i < 30; i++) {
    history.push({
      role: 'assistant',
      content: [{ type: 'tool-call', toolCallId: `h${i}`, toolName: 'tool_a', input: { q: `历史调用 ${i}` } }],
    });
    history.push({ role: 'tool', content: '历史工具结果内容。'.repeat(150) + i });
  }
  history.push({ role: 'assistant', content: '历史最终答复' });

  const result = await orch.runTask({ prompt: '测试任务', historyMessages: history, maxSteps: 20 });

  console.log('== 1. 熔断（A/B 交替空转，旧检测器抓不住）==');
  console.log('   skippedCalls =', result.efficiency?.skippedCalls, '(期望 2：两工具各自第 4 次同签名出现时开始跳过)');
  console.log('   toolCalls =', result.efficiency?.toolCalls, '(期望 9，含 1 次超长输出)');

  console.log('== 2. 看板自动推进 ==');
  console.log('   advances =', advances, '(期望 3：3 个计划步骤全部由工具成功推进，模型 0 次 planner_update_task)');

  console.log('== 3. 超长输出头尾混合截断（sandbox_ 类尾优先）==');
  console.log(
    `   含截断标记: ${longOutputTruncated}, 保留头部哨兵: ${longOutputKeepsHead}, 保留尾部哨兵: ${longOutputKeepsTail}`,
    '(期望 true/true/true：约 21K 字符输出 → 头 30% + 尾 70%，中间省略)'
  );

  console.log('== 4. 任务内压缩（prepareStep 每步检查）==');
  console.log('   in-loop 压缩触发:', midLoopCompacted, '(期望 true：超阈值历史在第 1 步前就被就地压缩)');

  console.log('== 5. 收尾压缩（会话历史供下一轮继承）==');
  const compacted = result.messages!;
  const toolRoleCount = compacted.filter((m) => m.role === 'tool').length;
  const hasDigest = compacted.some((m) => typeof m.content === 'string' && m.content.includes('历史会话纪要'));
  const keepsOriginalIntent = compacted[0]?.content === '最初的任务意图';
  const tailKept = compacted[compacted.length - 1]?.content === '最终答复';
  console.log(`   消息数: ${history.length + 18} -> ${compacted.length}; tool 消息: ${toolRoleCount} (近期窗口内); 含纪要: ${hasDigest}; 保留原始意图: ${keepsOriginalIntent}; 保留最终答复: ${tailKept}`);

  console.log('== 效率统计 ==', JSON.stringify(result.efficiency));

  // 断言汇总
  const failures: string[] = [];
  if (result.efficiency?.skippedCalls !== 2) failures.push(`skippedCalls 期望 2，实际 ${result.efficiency?.skippedCalls}`);
  if (result.efficiency?.toolCalls !== 9) failures.push(`toolCalls 期望 9，实际 ${result.efficiency?.toolCalls}`);
  if (advances !== 3) failures.push(`advances 期望 3，实际 ${advances}`);
  if (!longOutputTruncated || !longOutputKeepsHead || !longOutputKeepsTail)
    failures.push(`头尾混合截断异常: 标记=${longOutputTruncated} 头=${longOutputKeepsHead} 尾=${longOutputKeepsTail}`);
  if (!midLoopCompacted) failures.push('任务内压缩未触发');
  if (!hasDigest) failures.push('压缩纪要缺失');
  if (!keepsOriginalIntent) failures.push('原始意图消息丢失');
  if (!tailKept) failures.push('最终答复消息丢失');
  if (toolRoleCount > 10) failures.push(`近期窗口外仍有 tool 消息: ${toolRoleCount}`);
  if (failures.length === 0) {
    console.log('\n✅ 全部断言通过');
  } else {
    console.log('\n❌ 断言失败:', failures.join('; '));
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
