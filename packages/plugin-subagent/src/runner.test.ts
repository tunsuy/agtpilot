import { afterEach, describe, expect, it } from 'vitest';
import type { AgentLoopOptions, AgentLoopResult, ToolDefinition, ToolSession } from '@agtpilot/core';
import {
  buildTaskPrompt,
  clampSteps,
  SUBAGENT_SYSTEM_PROMPT,
  SubagentEngine,
  type SubagentEventPayload,
  type SubagentModel,
  type SubagentStepResult,
} from './runner';

// ---- 测试脚手架 ----

function mkTool(name: string, extra: Partial<ToolDefinition> = {}): ToolDefinition {
  return {
    name,
    description: name,
    parameters: { type: 'object', properties: {} },
    execute: async () => 'ok',
    ...extra,
  };
}

function resultOf(partial: Partial<AgentLoopResult> = {}): AgentLoopResult {
  return {
    text: '最终报告',
    finishReason: 'stop',
    stepsCount: 3,
    stepsExhausted: false,
    responseMessages: [],
    usage: { promptTokens: 100, completionTokens: 50 },
    ...partial,
  };
}

type LoopImpl = (o: AgentLoopOptions) => Promise<AgentLoopResult> | AgentLoopResult;
type StepImpl = (o: any) => Promise<SubagentStepResult> | SubagentStepResult;

function makeFakeModel(loopImpl?: LoopImpl, stepImpl?: StepImpl) {
  const calls = { loop: [] as AgentLoopOptions[], step: [] as any[] };
  const model: SubagentModel = {
    runAgentLoop: async (o) => {
      calls.loop.push(o);
      return loopImpl ? loopImpl(o) : resultOf();
    },
    invokeStep: async (o) => {
      calls.step.push(o);
      return stepImpl ? stepImpl(o) : { text: '收敛报告' };
    },
  };
  return { model, calls };
}

const baseSession: ToolSession = { taskId: 'task-1', step: 0, userId: 'u1' };

function makeEngine(
  model: SubagentModel | undefined,
  tools: ToolDefinition[] = [mkTool('search_web', { readOnly: true })],
  cfg: Partial<ConstructorParameters<typeof SubagentEngine>[1]> = {},
) {
  const events: SubagentEventPayload[] = [];
  const engine = new SubagentEngine(
    { getModel: () => model, listTools: () => tools, emit: (p) => events.push(p) },
    {
      maxSteps: 8,
      maxTokens: 60000,
      timeoutMs: 5000,
      maxConcurrent: 2,
      reportLimit: 8000,
      ...cfg,
    },
  );
  return { engine, events };
}

// ---- 1. 正常路径 + 边界 ----

describe('正常路径(spec §9.1/§9.8)', () => {
  it('独立子数组只含子任务一条消息,系统提示/configOverride/maxSteps 正确', async () => {
    const { model, calls } = makeFakeModel();
    const { engine, events } = makeEngine(model, undefined, {
      configOverride: { activeModelId: 'deepseek', modelName: 'deepseek-chat' },
    });
    const res = await engine.run({ query: '调研 Go agent 框架格局' }, baseSession);

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.report).toBe('最终报告');
    expect(res.meta.subTaskId).toBe('task-1:sub:1');
    expect(res.meta.stepsCount).toBe(3);
    expect(res.meta.finishReason).toBe('stop');
    expect(res.meta.usage).toEqual({ promptTokens: 100, completionTokens: 50 });

    expect(calls.loop).toHaveLength(1);
    const opt = calls.loop[0];
    expect(opt.system).toBe(SUBAGENT_SYSTEM_PROMPT);
    expect(opt.configOverride).toEqual({ activeModelId: 'deepseek', modelName: 'deepseek-chat' });
    expect(opt.maxSteps).toBe(8);
    expect(opt.messages).toHaveLength(1);
    expect(opt.messages[0].role).toBe('user');
    expect(opt.messages[0].content).toContain('调研 Go agent 框架格局');
    // 内部工具集 = 白名单 ∩ readOnly
    expect(opt.tools!.map((t) => t.name)).toEqual(['search_web']);

    expect(events.map((e) => e.phase)).toEqual(['started', 'finished']);
    expect(events[0].parentTaskId).toBe('task-1');
    expect(events[0].queryDigest).toBe('调研 Go agent 框架格局');
  });

  it('边界红线:返回值只有 report + 小 meta,子数组噪音零泄漏', async () => {
    const { model } = makeFakeModel((o) => {
      o.messages.push({ role: 'assistant', content: '中间检索噪音ABC'.repeat(100) });
      return resultOf({ responseMessages: [{ role: 'assistant', content: '中间检索噪音ABC' }] });
    });
    const { engine } = makeEngine(model);
    const res = await engine.run({ query: 'q' }, baseSession);
    expect(Object.keys(res).sort()).toEqual(['meta', 'ok', 'report']);
    expect(JSON.stringify(res)).not.toContain('中间检索噪音ABC');
  });

  it('query 为空 → internal-error,不触模型', async () => {
    const { model, calls } = makeFakeModel();
    const { engine } = makeEngine(model);
    const res = await engine.run({ query: '  ' }, baseSession);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.meta.reason).toBe('internal-error');
    expect(calls.loop).toHaveLength(0);
  });

  it('模型服务缺失 → internal-error', async () => {
    const { engine } = makeEngine(undefined);
    const res = await engine.run({ query: 'q' }, baseSession);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.meta.reason).toBe('internal-error');
  });
});

// ---- 2. 强制收敛 ----

describe('强制收敛(spec §9.2)', () => {
  it('stepsExhausted → invokeStep(disableTools) 要最终报告,usage 累加', async () => {
    const { model, calls } = makeFakeModel(
      () =>
        resultOf({
          text: '',
          stepsExhausted: true,
          finishReason: 'tool-calls',
          stepsCount: 8,
          usage: { promptTokens: 10, completionTokens: 10 },
          responseMessages: [{ role: 'assistant', content: '还在查' }],
        }),
      () => ({ text: '收敛报告', usage: { promptTokens: 5, completionTokens: 7 } }),
    );
    const { engine } = makeEngine(model);
    const res = await engine.run({ query: 'q' }, baseSession);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.report).toBe('收敛报告');
    expect(res.meta.stepsCount).toBe(9);
    expect(res.meta.usage).toEqual({ promptTokens: 15, completionTokens: 17 });

    expect(calls.step).toHaveLength(1);
    expect(calls.step[0].disableTools).toBe(true);
    expect(calls.step[0].system).toContain('【重要】');
    // 收敛消息 = baseMessages(1) + responseMessages(1)
    expect(calls.step[0].messages).toHaveLength(2);
  });

  it('收敛调用自身抛错不推翻已有文本', async () => {
    const { model } = makeFakeModel(
      () => resultOf({ text: '部分结论', stepsExhausted: true, stepsCount: 8 }),
      () => {
        throw new Error('wrap failed');
      },
    );
    const { engine } = makeEngine(model);
    const res = await engine.run({ query: 'q' }, baseSession);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.report).toBe('部分结论');
  });
});

// ---- 3. 三重预算闸 ----

describe('预算闸(spec §9.3)', () => {
  it('token 自记账超限 → 下一步收工具 + 注入收敛提示 + budgetHit', async () => {
    let adjustment: any;
    const bigMessages = Array.from({ length: 40 }, () => ({
      role: 'user',
      content: 'x'.repeat(2000), // 合计约 20000 tokens
    }));
    const { model, calls } = makeFakeModel((o) => {
      adjustment = o.prepareStep!({ stepNumber: 2, messages: bigMessages });
      return resultOf({ text: '预算内报告' });
    });
    const { engine } = makeEngine(model, undefined, { maxTokens: 100 });
    const res = await engine.run({ query: 'q' }, baseSession);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.meta.budgetHit).toBe(true);
    expect(adjustment.activeTools).toEqual([]);
    expect(adjustment.messages).toHaveLength(41);
    expect(adjustment.messages[40].content).toContain('预算');
    // 自然收口拿到报告 → 无需强制总结
    expect(calls.step).toHaveLength(0);
  });

  it('预算触顶且无报告文本,强制收敛仍为空 → reason budget', async () => {
    const { model } = makeFakeModel(
      (o) => {
        o.prepareStep!({
          stepNumber: 2,
          messages: [{ role: 'user', content: 'x'.repeat(4000) }],
        });
        return resultOf({ text: '' });
      },
      () => ({ text: '' }),
    );
    const { engine } = makeEngine(model, undefined, { maxTokens: 10 });
    const res = await engine.run({ query: 'q' }, baseSession);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.meta.reason).toBe('budget');
  });

  it('maxTokens=0 表示不限,超大消息也不触发', async () => {
    let adjustment: any = 'not-called';
    const { model } = makeFakeModel((o) => {
      adjustment = o.prepareStep!({
        stepNumber: 2,
        messages: [{ role: 'user', content: 'x'.repeat(400000) }],
      });
      return resultOf();
    });
    const { engine } = makeEngine(model, undefined, { maxTokens: 0 });
    const res = await engine.run({ query: 'q' }, baseSession);
    expect(res.ok).toBe(true);
    expect(adjustment).toBeUndefined();
  });

  it('墙钟超时 → abort → reason timeout,事件 failed', async () => {
    const { model } = makeFakeModel(
      (o) =>
        new Promise<AgentLoopResult>((_, reject) => {
          o.abortSignal!.addEventListener('abort', () => reject(new Error('Aborted')));
        }),
    );
    const { engine, events } = makeEngine(model, undefined, { timeoutMs: 30 });
    const res = await engine.run({ query: 'q' }, baseSession);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.meta.reason).toBe('timeout');
    expect(events.map((e) => e.phase)).toEqual(['started', 'failed']);
    expect(events[1].reason).toBe('timeout');
  });

  it('步数钳制 2..20', async () => {
    const { model, calls } = makeFakeModel();
    const { engine } = makeEngine(model);
    await engine.run({ query: 'q', max_steps: 100 }, baseSession);
    await engine.run({ query: 'q', max_steps: 0 }, baseSession);
    await engine.run({ query: 'q' }, baseSession);
    expect(calls.loop.map((o) => o.maxSteps)).toEqual([20, 2, 8]);
    expect(clampSteps(5, 8)).toBe(5);
    expect(clampSteps(undefined, 8)).toBe(8);
    expect(clampSteps('abc', 8)).toBe(8);
  });
});

// ---- 3.5 reasoning 剥离(子循环闸,token 文档 §9.2 范围注记项)----

describe('reasoning 剥离(子循环闸)', () => {
  afterEach(() => {
    delete process.env.AGTPILOT_STRIP_REASONING;
  });

  const reasoningAssistant = () => ({
    role: 'assistant',
    content: [
      { type: 'reasoning', text: '深度思考中'.repeat(50) },
      { type: 'text', text: '我来查一下' },
      { type: 'tool-call', toolCallId: 'c1', toolName: 'search_web', input: {} },
    ],
  });

  it('prepareStep 剥离 assistant reasoning,text/tool-call 保留、原数组不被改动', async () => {
    let adjustment: any;
    const { model } = makeFakeModel((o) => {
      const msgs: any[] = [
        { role: 'user', content: 'q' },
        reasoningAssistant(),
        { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'c1', output: 'ok' }] },
      ];
      const before = JSON.stringify(msgs);
      adjustment = o.prepareStep!({ stepNumber: 2, messages: msgs });
      expect(JSON.stringify(msgs)).toBe(before); // 纯函数:不改原对象
      return resultOf();
    });
    const { engine } = makeEngine(model);
    const res = await engine.run({ query: 'q' }, baseSession);
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const assistant = adjustment.messages.find((m: any) => m.role === 'assistant');
    expect(assistant.content.some((p: any) => p.type === 'reasoning')).toBe(false);
    expect(assistant.content.map((p: any) => p.type)).toEqual(['text', 'tool-call']);
    expect(res.meta.reasoningPartsStripped).toBe(1);
  });

  it('幂等:已剥消息再进 prepareStep → undefined(不干预),计数不重复', async () => {
    let adj1: any;
    let adj2: any;
    const { model } = makeFakeModel((o) => {
      adj1 = o.prepareStep!({ stepNumber: 2, messages: [{ role: 'user', content: 'q' }, reasoningAssistant()] });
      adj2 = o.prepareStep!({ stepNumber: 3, messages: adj1.messages });
      return resultOf();
    });
    const { engine } = makeEngine(model);
    const res = await engine.run({ query: 'q' }, baseSession);
    expect(adj1).toBeDefined();
    expect(adj2).toBeUndefined();
    if (res.ok) expect(res.meta.reasoningPartsStripped).toBe(1);
  });

  it('强制收敛 invokeStep 消息同剥(orchestrator 闸3 同款语义)', async () => {
    const { model, calls } = makeFakeModel(
      () =>
        resultOf({
          text: '',
          stepsExhausted: true,
          stepsCount: 8,
          responseMessages: [{ role: 'user', content: 'q' }, reasoningAssistant()],
        }),
      () => ({ text: '收敛报告' }),
    );
    const { engine } = makeEngine(model);
    const res = await engine.run({ query: 'q' }, baseSession);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const assistant = calls.step[0].messages.find((m: any) => m.role === 'assistant');
    expect(assistant.content.some((p: any) => p.type === 'reasoning')).toBe(false);
    expect(res.meta.reasoningPartsStripped).toBe(1);
  });

  it('剥离先于 token 闸:思考文本不再虚占预算(剥完低于闸 → 不触顶)', async () => {
    let adjustment: any;
    const { model } = makeFakeModel((o) => {
      // 大体积全部在 reasoning 部件里;剥掉后消息体积远低于闸值
      adjustment = o.prepareStep!({ stepNumber: 2, messages: [{ role: 'user', content: 'q' }, reasoningAssistant()] });
      return resultOf({ text: '预算内报告' });
    });
    const { engine } = makeEngine(model, undefined, { maxTokens: 100 });
    const res = await engine.run({ query: 'q' }, baseSession);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(adjustment.activeTools).toBeUndefined(); // 未触顶:不收工具
    expect(res.meta.budgetHit).toBeUndefined();
    expect(res.meta.reasoningPartsStripped).toBe(1);
  });

  it('保险丝 AGTPILOT_STRIP_REASONING=0 → 不剥,收敛消息保留 reasoning,meta 无字段', async () => {
    process.env.AGTPILOT_STRIP_REASONING = '0';
    let adjustment: any = 'not-set';
    const { model, calls } = makeFakeModel(
      (o) => {
        adjustment = o.prepareStep!({ stepNumber: 2, messages: [{ role: 'user', content: 'q' }, reasoningAssistant()] });
        return resultOf({
          text: '',
          stepsExhausted: true,
          stepsCount: 8,
          responseMessages: [reasoningAssistant()],
        });
      },
      () => ({ text: '收敛报告' }),
    );
    const { engine } = makeEngine(model);
    const res = await engine.run({ query: 'q' }, baseSession);
    expect(adjustment).toBeUndefined(); // prepareStep 不干预
    const raw = JSON.stringify(calls.step[0].messages);
    expect(raw).toContain('深度思考中'); // reasoning 原样回传(旧行为)
    if (res.ok) expect(res.meta && 'reasoningPartsStripped' in res.meta).toBe(false);
  });

  it('transcript 落盘保持无损:剥离不进观测记录(reasoning 原文仍在)', async () => {
    const entries: any[] = [];
    const { model } = makeFakeModel(() =>
      resultOf({ responseMessages: [reasoningAssistant()] }),
    );
    const { engine } = makeEngine(model, undefined, { appendTranscript: (e) => entries.push(e) });
    await engine.run({ query: 'q' }, baseSession);
    expect(entries).toHaveLength(1);
    expect(JSON.stringify(entries[0].messages)).toContain('深度思考中');
  });
});

// ---- 3.6 工坊白名单对齐(session.activeTools 交集)----

describe('工坊白名单对齐(session.activeTools 交集)', () => {
  const webTool = mkTool('search_web', { readOnly: true });
  const ragTool = mkTool('rag_search', { readOnly: true });
  const memTool = mkTool('memory_recall', { readOnly: true, baseline: true });
  const ghTool = mkTool('mcp_github_mcp_search_issues', { readOnly: true });
  const dwTool = mkTool('mcp_deepwiki_ask_question', {}); // 无 readOnly 声明:走逃生口前缀放行

  const mountedNames = (o: AgentLoopOptions) => o.tools!.map((t) => t.name);

  it('主循环无白名单(session 缺省)→ 维持自身双层白名单,行为不变', async () => {
    const { model, calls } = makeFakeModel();
    const { engine } = makeEngine(model, [webTool, ragTool, ghTool], { mcpServers: ['github_mcp'] });
    await engine.run({ query: 'q' }, baseSession);
    expect(mountedNames(calls.loop[0])).toEqual(['search_web', 'rag_search', 'mcp_github_mcp_search_issues']);
  });

  it('精确名交集:白名单外的只读工具被剔除;白名单里零命中的名字静默跳过', async () => {
    const { model, calls } = makeFakeModel();
    const { engine } = makeEngine(model, [webTool, ragTool], {});
    await engine.run({ query: 'q' }, { ...baseSession, activeTools: ['search_web', 'github_scan'] });
    expect(mountedNames(calls.loop[0])).toEqual(['search_web']);
  });

  it('GitHub 整台禁入传导:主循环白名单没有 github → 子循环同样禁入;精确名声明 → 保留', async () => {
    const { model, calls } = makeFakeModel();
    const { engine } = makeEngine(model, [webTool, ghTool], { mcpServers: ['github_mcp'] });
    await engine.run({ query: 'q' }, { ...baseSession, activeTools: ['search_web'] });
    expect(mountedNames(calls.loop[0])).toEqual(['search_web']);
    await engine.run({ query: 'q' }, { ...baseSession, activeTools: ['search_web', 'mcp_github_mcp_search_issues'] });
    expect(mountedNames(calls.loop[1])).toEqual(['search_web', 'mcp_github_mcp_search_issues']);
  });

  it('前缀通配同语义:mcp_deepwiki_* 整组放行(逃生口进来的工具同样过交集)', async () => {
    const { model, calls } = makeFakeModel();
    const { engine } = makeEngine(model, [webTool, dwTool], { mcpAllowTools: ['mcp_deepwiki_'] });
    await engine.run({ query: 'q' }, { ...baseSession, activeTools: ['mcp_deepwiki_*'] });
    expect(mountedNames(calls.loop[0])).toEqual(['mcp_deepwiki_ask_question']);
  });

  it('baseline 自动并入:未声明的 memory_recall 仍挂载(与主循环 resolveExplicitTools 同款)', async () => {
    const { model, calls } = makeFakeModel();
    const { engine } = makeEngine(model, [webTool, memTool], {});
    await engine.run({ query: 'q' }, { ...baseSession, activeTools: ['search_web'] });
    expect(mountedNames(calls.loop[0])).toEqual(['search_web', 'memory_recall']);
  });

  it('交集为空 → 无法派发,错误信息如实说明白名单交集,不触模型', async () => {
    const { model, calls } = makeFakeModel();
    const { engine } = makeEngine(model, [webTool], {});
    const res = await engine.run({ query: 'q' }, { ...baseSession, activeTools: ['ppt_publish_deck'] });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.meta.reason).toBe('internal-error');
    expect(res.error).toContain('白名单交集');
    expect(calls.loop).toHaveLength(0);
  });
});

// ---- 4. 失败语义 ----

describe('失败语义(spec §9.4)', () => {
  it('模型抛错 → 返回 ok:false 而非 throw,错误原文保留', async () => {
    const { model } = makeFakeModel(() => {
      throw new Error('upstream 500');
    });
    const { engine, events } = makeEngine(model);
    const res = await engine.run({ query: 'q' }, baseSession);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.meta.reason).toBe('model-error');
    expect(res.error).toContain('upstream 500');
    expect(events.map((e) => e.phase)).toEqual(['started', 'failed']);
  });
});

// ---- 5. 内部工具包装 ----

describe('内部工具包装(spec §4.3)', () => {
  it('合成子 session(userId/env 继承,taskId 带 :sub: 前缀)', async () => {
    let captured: ToolSession | undefined;
    const tools = [
      mkTool('search_web', {
        readOnly: true,
        execute: async (_a, s) => {
          captured = s;
          return 'result';
        },
      }),
    ];
    const { model } = makeFakeModel(async (o) => {
      await o.tools![0].execute({ q: 1 });
      return resultOf();
    });
    const { engine } = makeEngine(model, tools);
    await engine.run(
      { query: 'q' },
      { ...baseSession, env: { FOO: 'bar' }, step: 7 },
    );
    expect(captured).toBeDefined();
    expect(captured!.taskId).toMatch(/^task-1:sub:\d+$/);
    expect(captured!.userId).toBe('u1');
    expect(captured!.env).toEqual({ FOO: 'bar' });
  });

  it('工具抛错 → { error } 对象回填,不 throw;超大输出 16KB 截断', async () => {
    const tools = [
      mkTool('search_web', { readOnly: true, execute: async () => 'z'.repeat(20000) }),
      mkTool('rag_search', {
        readOnly: true,
        execute: async () => {
          throw new Error('net down');
        },
      }),
    ];
    let outputs: any[] = [];
    const { model } = makeFakeModel(async (o) => {
      outputs = [];
      for (const t of o.tools!) outputs.push(await t.execute({ q: 1 }));
      return resultOf();
    });
    const { engine } = makeEngine(model, tools);
    const res = await engine.run({ query: 'q' }, baseSession);
    expect(res.ok).toBe(true);
    expect(typeof outputs[0]).toBe('string');
    expect(outputs[0].length).toBeLessThan(20000);
    expect(outputs[0]).toContain('输出过长已截断');
    expect(outputs[1]).toEqual({ error: 'net down' });
  });

  it('工具声明 outputCap → 子循环限额与主循环同源(min(cap, 16KB),effectiveOutputLimit)', async () => {
    const tools = [
      // cap 2000:5000 字符输出在子循环内即按 2000 截断(MCP 连接器形态)
      mkTool('search_web', { readOnly: true, outputCap: 2000, execute: async () => 'z'.repeat(5000) }),
      // cap 超 16KB 被压顶:与未声明的 20000 字符输出同样按 TOOL_OUTPUT_LIMIT 治理
      mkTool('rag_search', { readOnly: true, outputCap: 999_999, execute: async () => 'y'.repeat(20000) }),
    ];
    let outputs: any[] = [];
    const { model } = makeFakeModel(async (o) => {
      outputs = [];
      for (const t of o.tools!) outputs.push(await t.execute({ q: 1 }));
      return resultOf();
    });
    const { engine } = makeEngine(model, tools);
    const res = await engine.run({ query: 'q' }, baseSession);
    expect(res.ok).toBe(true);
    expect(outputs[0].length).toBeLessThan(2400); // 2000 + 截断标记
    expect(outputs[0]).toContain('输出过长已截断');
    expect(outputs[0]).toContain('5000');
    expect(outputs[1].length).toBeLessThan(17 * 1024);
    expect(outputs[1]).toContain('输出过长已截断');
  });

  it('requiredEnv 缺 Key 的白名单工具不挂;全缺 → internal-error', async () => {
    const tools = [
      mkTool('search_exa', { readOnly: true, requiredEnv: ['__AGTPILOT_TEST_NO_SUCH_KEY__'] }),
    ];
    const { model, calls } = makeFakeModel();
    const { engine } = makeEngine(model, tools);
    const res = await engine.run({ query: 'q' }, baseSession);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.meta.reason).toBe('internal-error');
    expect(calls.loop).toHaveLength(0);

    // 任务级 env 提供 Key 后即可挂载
    const res2 = await engine.run(
      { query: 'q' },
      { ...baseSession, env: { __AGTPILOT_TEST_NO_SUCH_KEY__: 'x' } },
    );
    expect(res2.ok).toBe(true);
    expect(calls.loop[0].tools!.map((t) => t.name)).toEqual(['search_exa']);
  });

  it('config.whitelist 覆盖名单(仍受 readOnly 硬校验)', async () => {
    const tools = [
      mkTool('search_web', { readOnly: true }),
      mkTool('memory_list', { readOnly: true }),
      mkTool('sandbox_exec', {}),
    ];
    const { model, calls } = makeFakeModel();
    const { engine } = makeEngine(model, tools, {
      whitelist: ['memory_list', 'sandbox_exec'],
    });
    await engine.run({ query: 'q' }, baseSession);
    expect(calls.loop[0].tools!.map((t) => t.name)).toEqual(['memory_list']);
  });
});

// ---- 6. report 上限 ----

describe('report 上限(spec §9.6)', () => {
  it('超 reportLimit → 头部截断 + truncated:true', async () => {
    const { model } = makeFakeModel(() => resultOf({ text: 'y'.repeat(20000) }));
    const { engine } = makeEngine(model, undefined, { reportLimit: 8000 });
    const res = await engine.run({ query: 'q' }, baseSession);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.meta.truncated).toBe(true);
    expect(res.report.length).toBeLessThanOrEqual(8000 + 10);
    expect(res.report.endsWith('…(截断)')).toBe(true);
  });

  it('未超限不打 truncated 标记', async () => {
    const { model } = makeFakeModel(() => resultOf({ text: 'short' }));
    const { engine } = makeEngine(model);
    const res = await engine.run({ query: 'q' }, baseSession);
    expect(res.ok && res.meta.truncated).toBeUndefined();
  });
});

// ---- 7. 并发信号量 ----

describe('并发信号量(spec §9.7)', () => {
  it('6 个并发调用时同时活跃 ≤ maxConcurrent,且槽位 handoff 不丢任务', async () => {
    let live = 0;
    let maxLive = 0;
    const { model } = makeFakeModel(async () => {
      live += 1;
      maxLive = Math.max(maxLive, live);
      await new Promise((r) => setTimeout(r, 20));
      live -= 1;
      return resultOf();
    });
    const { engine } = makeEngine(model, undefined, { maxConcurrent: 2 });
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) => engine.run({ query: `q${i}` }, baseSession)),
    );
    expect(results.every((r) => r.ok)).toBe(true);
    expect(maxLive).toBe(2);
    // subTaskId 唯一
    const ids = new Set(results.map((r) => r.meta.subTaskId));
    expect(ids.size).toBe(6);
  });

  it('失败的 run 也释放槽位(信号量不漏)', async () => {
    let count = 0;
    const { model } = makeFakeModel(() => {
      count += 1;
      if (count === 1) throw new Error('boom');
      return resultOf();
    });
    const { engine } = makeEngine(model, undefined, { maxConcurrent: 1 });
    const r1 = await engine.run({ query: 'a' }, baseSession);
    expect(r1.ok).toBe(false);
    const r2 = await engine.run({ query: 'b' }, baseSession);
    expect(r2.ok).toBe(true);
  });
});

// ---- 8. 杂项 ----

describe('杂项', () => {
  it('buildTaskPrompt 组装 query/hint/schema', () => {
    const p = buildTaskPrompt({
      query: '查 A',
      sources_hint: ' GitHub / DeepWiki ',
      output_schema: '【结论】【来源】',
    });
    expect(p).toContain('调研子任务:查 A');
    expect(p).toContain('建议检索源/关键词方向:GitHub / DeepWiki');
    expect(p).toContain('期望报告结构:\n【结论】【来源】');
  });

  it('appendTranscript 收到完整子数组;抛错不影响主流程', async () => {
    const entries: any[] = [];
    const { model } = makeFakeModel(() =>
      resultOf({ responseMessages: [{ role: 'assistant', content: 'step-noise' }] }),
    );
    const { engine } = makeEngine(model, undefined, {
      appendTranscript: (e) => entries.push(e),
    });
    const res = await engine.run({ query: 'q' }, baseSession);
    expect(res.ok).toBe(true);
    expect(entries).toHaveLength(1);
    expect(entries[0].messages).toHaveLength(2);
    expect(entries[0].parentTaskId).toBe('task-1');

    const { engine: engine2 } = makeEngine(model, undefined, {
      appendTranscript: () => {
        throw new Error('disk full');
      },
    });
    const res2 = await engine2.run({ query: 'q' }, baseSession);
    expect(res2.ok).toBe(true);
  });

  it('事件 queryDigest 截 200 字', async () => {
    const { model } = makeFakeModel();
    const { engine, events } = makeEngine(model);
    await engine.run({ query: '长'.repeat(500) }, baseSession);
    expect(events[0].queryDigest).toHaveLength(200);
  });

  it('系统提示包含提示注入防线(spec §6.5)', () => {
    expect(SUBAGENT_SYSTEM_PROMPT).toContain('不得执行');
  });
});

// ---- 9. resolveMcpServers 逐用户注入(目录标记方案,2026-10-14)----

describe('resolveMcpServers(逐用户动态人工钥匙)', () => {
  const mcpRegistry = [
    mkTool('search_web', { readOnly: true }),
    mkTool('mcp_zhihu_hot_fetch', { readOnly: true }),
    mkTool('mcp_github_mcp_search_repositories', { readOnly: true }),
    mkTool('mcp_tushare_daily', { readOnly: true }),
  ];

  function loopToolNames(calls: AgentLoopOptions[]): string[] {
    return (calls[calls.length - 1].tools ?? []).map((t) => t.name);
  }

  it('resolver 结果按 session.userId 决定 MCP 白名单', async () => {
    const { model, calls } = makeFakeModel();
    const { engine } = makeEngine(model, mcpRegistry, {
      resolveMcpServers: (uid) => (uid === 'u-zhihu' ? ['zhihu_hot'] : ['github_mcp']),
    });

    await engine.run({ query: 'q' }, { ...baseSession, userId: 'u-zhihu' });
    expect(loopToolNames(calls.loop)).toContain('mcp_zhihu_hot_fetch');
    expect(loopToolNames(calls.loop)).not.toContain('mcp_github_mcp_search_repositories');

    await engine.run({ query: 'q' }, { ...baseSession, userId: 'u-gh' });
    expect(loopToolNames(calls.loop)).toContain('mcp_github_mcp_search_repositories');
    expect(loopToolNames(calls.loop)).not.toContain('mcp_zhihu_hot_fetch');
  });

  it('红线服务器即使自身声明 readOnly,resolver 不列也进不了子 agent(人工钥匙优先)', async () => {
    const { model, calls } = makeFakeModel();
    const { engine } = makeEngine(model, mcpRegistry, {
      resolveMcpServers: () => ['zhihu_hot'],
    });
    await engine.run({ query: 'q' }, baseSession);
    expect(loopToolNames(calls.loop)).not.toContain('mcp_tushare_daily');
  });

  it('resolver 返回 undefined → 回退静态 mcpServers(env/内置默认语义)', async () => {
    const { model, calls } = makeFakeModel();
    const { engine } = makeEngine(model, mcpRegistry, {
      mcpServers: ['github_mcp'],
      resolveMcpServers: () => undefined,
    });
    await engine.run({ query: 'q' }, baseSession);
    expect(loopToolNames(calls.loop)).toContain('mcp_github_mcp_search_repositories');
  });

  it('resolver 抛异常 → 回退静态 mcpServers,run 仍成功(永不 throw 契约)', async () => {
    const { model, calls } = makeFakeModel();
    const { engine } = makeEngine(model, mcpRegistry, {
      mcpServers: ['zhihu_hot'],
      resolveMcpServers: () => {
        throw new Error('user-store down');
      },
    });
    const res = await engine.run({ query: 'q' }, baseSession);
    expect(res.ok).toBe(true);
    expect(loopToolNames(calls.loop)).toContain('mcp_zhihu_hot_fetch');
  });
});
