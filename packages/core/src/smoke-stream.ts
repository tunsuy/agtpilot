/**
 * 流式可见性冒烟回归脚本（不依赖真实模型，stub 驱动）：
 *   npx tsx packages/core/src/smoke-stream.ts
 * 验证「会话进行中看不到 agent 动作」修复的事件链（P0+P1）：
 * 1. 每步模型调用开始 → step_started 事件（含 taskId 盖章）
 * 2. 文本/推理增量 → assistant_delta 事件（kind 区分 text/reasoning）
 * 3. 事件顺序：step_started → assistant_delta* → tool_call → tool_result → done
 * 4. 步数耗尽 wrap-up 前也有 step_started（非流式总结窗口的"正在思考"指示）
 */
import { Context } from '@deepseek-ai/cordis';
import { AgentService, OrchestratorService, ToolDefinition } from './index';
import type { ModelGateway } from './index';

async function main() {
  const ctx = new Context();
  new AgentService(ctx);
  const orch = new OrchestratorService(ctx);

  // ---- stub 模型网关：模拟 plugin-model streamText 的回调行为 ----
  const stubModel: ModelGateway = {
    setPreferredModel: () => {},
    setBudget: () => {},
    runAgentLoop: async (opts: any) => {
      const tools = opts.tools as Array<{ name: string; execute: (args: any) => Promise<any> }>;
      // 第 1 步：思考 + 解说文字流式流出，然后调一次工具
      opts.onStepStart?.({ stepNumber: 1 });
      opts.onReasoningDelta?.('先分析问题，');
      opts.onReasoningDelta?.('再决定检索。');
      opts.onTextDelta?.('我先检索相关信息。');
      const out = await tools.find((t) => t.name === 'tool_a')!.execute({});
      // 第 2 步：直接给最终答复（流式）
      opts.onStepStart?.({ stepNumber: 2 });
      opts.onTextDelta?.('综合以上信息，');
      opts.onTextDelta?.('这是最终回答。');
      return {
        text: '综合以上信息，这是最终回答。',
        finishReason: 'stop',
        stepsCount: 2,
        stepsExhausted: false,
        responseMessages: [
          { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'c0', toolName: 'tool_a', input: {} }] },
          { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'c0', output: out }] },
          { role: 'assistant', content: '综合以上信息，这是最终回答。' },
        ],
      };
    },
    invokeStep: async () => ({
      text: '强制总结',
      toolCalls: [],
      finishReason: 'stop',
      usage: { promptTokens: 0, completionTokens: 0 },
    }),
  };
  ctx.reflect.provide('model', stubModel);

  const events: Array<{ type: string; payload: any }> = [];
  ctx.on('agtpilot/event', (e: any) => events.push({ type: e.type, payload: e.payload }));

  ctx.agent.registerTool({
    name: 'tool_a',
    description: 'a',
    parameters: { type: 'object', properties: {} },
    execute: async () => ({ ok: true }),
  } as ToolDefinition);

  const result = await orch.runTask({ taskId: 'mission_smoke', prompt: '测试流式', maxSteps: 5 });

  const seq = events.map((e) => e.type).join(',');
  const expectedSeq = 'step_started,assistant_delta,assistant_delta,assistant_delta,tool_call,tool_result,step_started,assistant_delta,assistant_delta,done';
  const allStamped = events.every((e) => e.payload?.taskId === 'mission_smoke');
  const kinds = events.filter((e) => e.type === 'assistant_delta').map((e) => e.payload.kind);
  const reasoning = events.filter((e) => e.type === 'assistant_delta' && e.payload.kind === 'reasoning').map((e) => e.payload.delta).join('');
  const text = events.filter((e) => e.type === 'assistant_delta' && e.payload.kind === 'text').map((e) => e.payload.delta).join('');

  console.log('== 事件序列 ==');
  console.log('  ', seq);
  console.log('== taskId 盖章 ==', allStamped, '(期望 true：所有事件含 payload.taskId)');
  console.log('== delta kinds ==', kinds.join(','));
  console.log('== reasoning 拼接 ==', reasoning, '(期望：先分析问题，再决定检索。)');
  console.log('== text 拼接 ==', text);
  console.log('== 最终回答 ==', result.finalAnswer);

  const failures: string[] = [];
  if (seq !== expectedSeq) failures.push(`事件序列不符:\n    期望 ${expectedSeq}\n    实际 ${seq}`);
  if (!allStamped) failures.push('存在未盖章 taskId 的事件');
  if (reasoning !== '先分析问题，再决定检索。') failures.push(`reasoning 拼接异常: ${reasoning}`);
  if (text !== '我先检索相关信息。综合以上信息，这是最终回答。') failures.push(`text 拼接异常: ${text}`);
  if (result.success !== true) failures.push('任务未成功');
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
