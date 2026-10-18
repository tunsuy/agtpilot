import { describe, it, expect } from 'vitest';
import { Context } from '@deepseek-ai/cordis';
import { AgentService, OrchestratorService } from './index';
import type { ModelGateway, PlannerNotifier, ToolDefinition, ToolSession } from './index';

/**
 * ToolSession.activeTools 透传(子 agent 工坊白名单对齐的基础接线):
 * TaskOptions.activeTools(工坊四层声明)设置时 → 工具 execute 收到的 session
 * 原样携带同一列表(plugin-subagent 据此做交集,匹配语义复用
 * resolveExplicitTools);缺省 → 字段不写(闲聊/关键词路由任务,子系统维持
 * 自身白名单语义,零行为变化)。
 * harness 复用 orchestrator-spill.test.ts 的 cordis stub 模式。
 */

function buildHarness() {
  const ctx = new Context();
  new AgentService(ctx);
  const orch = new OrchestratorService(ctx);
  const sessions: ToolSession[] = [];

  ctx.agent.registerTool({
    name: 'probe_tool',
    description: 'probe',
    parameters: { type: 'object', properties: {} },
    execute: async (_a: any, s: ToolSession) => {
      sessions.push(s);
      return 'ok';
    },
  } as ToolDefinition);

  const stubModel: ModelGateway = {
    setPreferredModel: () => {},
    setBudget: () => {},
    runAgentLoop: async (o: any) => {
      const tools = o.tools as Array<{ name: string; execute: (args: any) => Promise<any> }>;
      await tools.find((t) => t.name === 'probe_tool')!.execute({});
      return {
        text: '完成',
        finishReason: 'stop',
        stepsCount: 1,
        stepsExhausted: false,
        responseMessages: [],
      };
    },
    invokeStep: async () => ({
      text: '总结',
      toolCalls: [],
      finishReason: 'stop',
      usage: { promptTokens: 0, completionTokens: 0 },
    }),
  };
  ctx.reflect.provide('model', stubModel);
  ctx.reflect.provide('planner', { boardLagNotice: () => null } as PlannerNotifier);

  return {
    sessions,
    run: (opts: Record<string, any> = {}) =>
      orch.runTask({ taskId: 'task_sess_1', prompt: '测试任务', maxSteps: 5, ...opts }),
  };
}

describe('ToolSession.activeTools 透传', () => {
  it('TaskOptions.activeTools → session.activeTools 原样携带(含前缀通配条目)', async () => {
    const h = buildHarness();
    const declared = ['github_scan', 'mcp_deepwiki_*'];
    const r = await h.run({ activeTools: declared });
    expect(r.success).toBe(true);
    expect(h.sessions).toHaveLength(1);
    expect(h.sessions[0].activeTools).toEqual(declared);
  });

  it('缺省不写字段:无工坊约束时 session 与改造前逐字段一致', async () => {
    const h = buildHarness();
    await h.run();
    expect(h.sessions).toHaveLength(1);
    expect(h.sessions[0] && 'activeTools' in h.sessions[0]).toBe(false);
  });
});
