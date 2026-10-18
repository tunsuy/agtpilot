import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Context } from '@deepseek-ai/cordis';
import { AgentService, OrchestratorService } from './index';
import type { ModelGateway, PlannerNotifier, ToolDefinition, ToolRoute } from './index';

/**
 * 层0 目录卡片(菜单点菜制 B v1)编排器集成行为
 * (docs/design/token-consumption-and-tool-loading.md §9.4):
 * - 自由任务(路由已启用、无工坊白名单、非闲聊短路):未挂载的 catalogable
 *   工具以一行卡片进系统提示【按需工具目录】,load_tools 元工具任务级注入;
 * - 模型点名 → loadedToolNames → 下一步 prepareStep 并入挂载面(schema 上线),
 *   与 widen「只扩不缩」共用同一次写回(前缀缓存至多破一次);
 * - 观测:每次点名发 agtpilot/tool-catalog(命中分布样本);
 * - 不注入档:工坊白名单 / 全量挂载档 / 闲聊短路 / 无 catalogable / 保险丝
 *   AGTPILOT_TOOL_CATALOG=0。
 * harness 复用 orchestrator-outputcap.test.ts 的 cordis stub 模式。
 */

function buildHarness(opts: {
  prompt?: string;
  activeTools?: string[];
  routes?: ToolRoute[];
  withCatalogable?: boolean;
} = {}) {
  const ctx = new Context();
  new AgentService(ctx);
  const orch = new OrchestratorService(ctx);

  ctx.agent.registerTool({
    name: 'memory_store',
    description: '把重要结论写入长期记忆,后续任务可检索复用,支持标签与正文两段式',
    baseline: true,
    parameters: { type: 'object', properties: {} },
    execute: async () => ({ ok: true }),
  } as ToolDefinition);

  if (opts.withCatalogable !== false) {
    ctx.agent.registerTool({
      name: 'mcp_demo_alpha',
      description: '[MCP连接器: demo] 查询阿尔法服务器的资料数据,支持关键词检索与详情读取',
      catalogable: true,
      catalogGroup: 'demo',
      dangerLevel: 'medium',
      parameters: { type: 'object', properties: {} },
      execute: async () => ({ ok: 'alpha' }),
    } as ToolDefinition);
    ctx.agent.registerTool({
      name: 'mcp_demo_beta',
      description: '[MCP连接器: demo] 拉取贝塔服务器的热榜列表,返回标题与热度',
      catalogable: true,
      catalogGroup: 'demo',
      dangerLevel: 'medium',
      parameters: { type: 'object', properties: {} },
      execute: async () => ({ ok: 'beta' }),
    } as ToolDefinition);
  }

  for (const r of opts.routes || []) ctx.agent.registerToolRoute(r);

  const loopOpts: any[] = [];
  const catalogEvents: any[] = [];
  ctx.on('agtpilot/tool-catalog', (p: any) => catalogEvents.push(p));

  const stubModel: ModelGateway = {
    setPreferredModel: () => {},
    setBudget: () => {},
    runAgentLoop: async (o: any) => {
      loopOpts.push(o);
      return {
        text: '最终答复',
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
    run: () =>
      orch.runTask({
        taskId: 'task_catalog_1',
        prompt: opts.prompt ?? '帮我处理一下这批数据',
        maxSteps: 5,
        ...(opts.activeTools ? { activeTools: opts.activeTools } : {}),
      }),
    loopOpts,
    catalogEvents,
  };
}

beforeEach(() => {
  // 阈值门压到 102 tokens:三把测试工具的声明体积足以启用路由
  process.env.AGTPILOT_CONTEXT_WINDOW = '1024';
});

afterEach(() => {
  delete process.env.AGTPILOT_CONTEXT_WINDOW;
  delete process.env.AGTPILOT_TOOL_CATALOG;
  delete process.env.AGTPILOT_ROUTE_FALLBACK;
  delete process.env.AGTPILOT_TOOL_ROUTING;
});

describe('层0 目录卡片 · 注入面', () => {
  it('零命中自由任务:目录+load_tools 注入,MCP schema 不挂载', async () => {
    const h = buildHarness();
    const r = await h.run();
    expect(r.success).toBe(true);
    const o = h.loopOpts[0];
    expect(o.system).toContain('【按需工具目录】');
    expect(o.system).toContain('## demo');
    expect(o.system).toContain('- mcp_demo_alpha: 查询阿尔法服务器的资料数据');
    expect(o.system).toContain('- mcp_demo_beta:');
    // 卡片行剥掉 [MCP连接器: demo] 标签(分组头已带)
    expect(o.system).not.toContain('- mcp_demo_alpha: [MCP连接器');
    // 初始挂载面 = 零命中 lean(baseline) + load_tools 尾部追加;MCP schema 缺席
    expect(o.activeTools).toEqual(['memory_store', 'load_tools']);
    expect(o.tools.map((t: any) => t.name)).toContain('load_tools');
    // 效率统计口径:toolsTotal 不含任务级合成的 load_tools
    expect((r as any).efficiency?.toolsTotal).toBe(3);
    expect((r as any).efficiency?.toolsMounted).toBe(2);
  });

  it('关键词命中档:命中组照常挂载,组外 catalogable 进目录', async () => {
    const h = buildHarness({
      prompt: '调用阿尔法查一下',
      routes: [{ id: 'demo_alpha', prefixes: ['mcp_demo_alpha'], test: /阿尔法/ }],
    });
    await h.run();
    const o = h.loopOpts[0];
    expect(o.activeTools).toContain('mcp_demo_alpha');
    expect(o.activeTools).not.toContain('mcp_demo_beta');
    expect(o.system).toContain('- mcp_demo_beta:');
    expect(o.system).not.toContain('- mcp_demo_alpha:');
    expect(o.activeTools[o.activeTools.length - 1]).toBe('load_tools');
  });

  it('工坊白名单任务:确定性挂载照旧,不注入目录与 load_tools', async () => {
    const h = buildHarness({ activeTools: ['memory_store'] });
    await h.run();
    const o = h.loopOpts[0];
    expect(o.system).not.toContain('【按需工具目录】');
    expect(o.tools.map((t: any) => t.name)).not.toContain('load_tools');
    expect(o.activeTools).toEqual(['memory_store']);
  });

  it('闲聊短路档:只挂 baseline,不注入目录', async () => {
    const h = buildHarness({ prompt: '你是谁' });
    await h.run();
    const o = h.loopOpts[0];
    expect(o.system).not.toContain('【按需工具目录】');
    expect(o.activeTools).toEqual(['memory_store']);
  });

  it('全量挂载档(阈值门未过):人人有 schema,无需目录', async () => {
    process.env.AGTPILOT_CONTEXT_WINDOW = '1000000';
    const h = buildHarness();
    await h.run();
    const o = h.loopOpts[0];
    expect(o.activeTools).toBeUndefined();
    expect(o.system).not.toContain('【按需工具目录】');
    expect(o.tools.map((t: any) => t.name)).not.toContain('load_tools');
  });

  it('目录里没有 catalogable 工具:不注入 load_tools', async () => {
    const h = buildHarness({ withCatalogable: false });
    await h.run();
    const o = h.loopOpts[0];
    expect(o.system).not.toContain('【按需工具目录】');
    expect(o.tools.map((t: any) => t.name)).not.toContain('load_tools');
    // 只剩一把 baseline 工具,声明体积跌破阈值门 → 全量挂载档(routedTools undefined)
    expect(o.activeTools).toBeUndefined();
  });

  it('保险丝 AGTPILOT_TOOL_CATALOG=0:回到止血 A 现状', async () => {
    process.env.AGTPILOT_TOOL_CATALOG = '0';
    const h = buildHarness();
    await h.run();
    const o = h.loopOpts[0];
    expect(o.system).not.toContain('【按需工具目录】');
    expect(o.tools.map((t: any) => t.name)).not.toContain('load_tools');
    expect(o.activeTools).toEqual(['memory_store']);
  });
});

describe('层0 目录卡片 · 点菜流程', () => {
  it('load_tools 点名 → 下一步 prepareStep schema 上线 + 观测事件', async () => {
    const h = buildHarness();
    // stub 循环体捕获 opts 后即返回;点菜与 prepareStep 由测试驱动
    await h.run();
    const o = h.loopOpts[0];
    const lt = o.tools.find((t: any) => t.name === 'load_tools')!;
    const loadOut = await lt.execute({ tools: ['mcp_demo_alpha', 'mcp_ghost'] });
    const adjust1 = await o.prepareStep({ stepNumber: 2, messages: [] });
    const adjust2 = await o.prepareStep({ stepNumber: 3, messages: [] });

    // 未超限额时包装管道原样返回对象(超限才截断/落盘为字符串)
    const parsed = loadOut as any;
    expect(parsed.loaded).toEqual(['mcp_demo_alpha']);
    expect(parsed.unknown).toEqual(['mcp_ghost']);
    expect(parsed.success).toBe(false); // 含目录外名字 → 如实报不成功

    // 下一步挂载面并入点名工具(与 widen 同一次写回)
    expect(adjust1.activeTools).toEqual(['memory_store', 'load_tools', 'mcp_demo_alpha']);
    // 已扩容后的后续步:无新增不写回(adjust 为空时 prepareStep 返回 undefined)
    expect(adjust2).toBeUndefined();

    // 观测事件:命中分布样本(含 unknown,校准路由规则用)
    expect(h.catalogEvents).toHaveLength(1);
    expect(h.catalogEvents[0]).toMatchObject({
      taskId: 'task_catalog_1',
      loaded: ['mcp_demo_alpha'],
      unknown: ['mcp_ghost'],
    });
  });

  it('重复点名已挂载工具:alreadyMounted 回报,不重复记账', async () => {
    const h = buildHarness();
    await h.run();
    const o = h.loopOpts[0];
    const lt = o.tools.find((t: any) => t.name === 'load_tools')!;
    const first: any = await lt.execute({ tools: ['mcp_demo_alpha'] });
    expect(first.loaded).toEqual(['mcp_demo_alpha']);
    // 换参数签名(load_tools 是 readOnly,同签名会被只读复用缓存拦截——
    // 那是既有治理,不是点菜语义):alpha 已点名 → alreadyMounted,beta 新挂
    const second: any = await lt.execute({ tools: ['mcp_demo_alpha', 'mcp_demo_beta'] });
    expect(second.loaded).toEqual(['mcp_demo_beta']);
    expect(second.alreadyMounted).toEqual(['mcp_demo_alpha']);
    const adjust = await o.prepareStep({ stepNumber: 2, messages: [] });
    expect(adjust.activeTools).toEqual([
      'memory_store',
      'load_tools',
      'mcp_demo_alpha',
      'mcp_demo_beta',
    ]);
    // 事件仍每次一条(观测不丢样本),但已挂载的不进 loaded 账
    expect(h.catalogEvents).toHaveLength(2);
    expect(h.catalogEvents[1]).toMatchObject({ loaded: ['mcp_demo_beta'], unknown: [] });
  });

  it('load_tools 走统一包装管道:tool_call/tool_result 照常广播', async () => {
    const ctx = new Context();
    new AgentService(ctx);
    const orch = new OrchestratorService(ctx);
    ctx.agent.registerTool({
      name: 'memory_store',
      description: '记忆存储工具,把重要结论写入长期记忆供后续任务检索复用,支持标签分类与全文检索两种召回方式',
      baseline: true,
      parameters: { type: 'object', properties: {} },
      execute: async () => ({ ok: true }),
    } as ToolDefinition);
    ctx.agent.registerTool({
      name: 'mcp_demo_alpha',
      description: '[MCP连接器: demo] 阿尔法资料查询工具,支持关键词检索、详情读取与批量导出,返回结构化字段',
      catalogable: true,
      catalogGroup: 'demo',
      parameters: { type: 'object', properties: {} },
      execute: async () => ({ ok: 'alpha' }),
    } as ToolDefinition);
    const broadcasts: any[] = [];
    ctx.on('agtpilot/event', (e: any) => broadcasts.push(e));
    let captured: any;
    ctx.reflect.provide('model', {
      setPreferredModel: () => {},
      setBudget: () => {},
      runAgentLoop: async (o: any) => {
        captured = o;
        return { text: 'done', finishReason: 'stop', stepsCount: 1, stepsExhausted: false, responseMessages: [] };
      },
      invokeStep: async () => ({ text: 's', toolCalls: [], finishReason: 'stop', usage: { promptTokens: 0, completionTokens: 0 } }),
    } as ModelGateway);
    ctx.reflect.provide('planner', { boardLagNotice: () => null } as PlannerNotifier);
    await orch.runTask({ taskId: 'task_catalog_2', prompt: '处理数据', maxSteps: 3 });
    const lt = captured.tools.find((t: any) => t.name === 'load_tools')!;
    await lt.execute({ tools: ['mcp_demo_alpha'] });
    const calls = broadcasts.filter((b) => b.type === 'tool_call' && b.payload.tool === 'load_tools');
    const results = broadcasts.filter((b) => b.type === 'tool_result' && b.payload.tool === 'load_tools');
    expect(calls).toHaveLength(1);
    expect(results).toHaveLength(1);
    // callId 双通道对应(前端步骤记录精确关联)
    expect(results[0].payload.callId).toBe(calls[0].payload.callId);
  });
});
