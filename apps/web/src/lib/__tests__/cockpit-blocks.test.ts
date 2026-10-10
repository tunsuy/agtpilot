import { describe, it, expect } from 'vitest';
import {
  splitStepsIntoBlocks,
  groupBlocksIntoTurns,
  findRetryPrompt,
  isEfficiencyStep,
  EFFICIENCY_STEP_PREFIX,
} from '../cockpit-blocks';
import type { MissionStep } from '../../types/agent';

const step = (over: Partial<MissionStep> & { id: string }): MissionStep => ({
  title: over.title || '',
  status: 'DONE',
  ...over,
} as MissionStep);

const userStep = (id: string, prompt: string): MissionStep =>
  step({ id, role: 'user', userPrompt: prompt, title: prompt });

const finalAnswer = (id: string, answer: string): MissionStep =>
  step({ id, role: 'assistant', messageKind: 'final', answer, title: '最终答复' });

const toolStep = (id: string, tool: string): MissionStep =>
  step({ id, role: 'tool', tool, title: `${tool} 调用` });

const effStep = (id: string, title = '执行效率: 3 步 · 工具调用 2 次'): MissionStep =>
  step({ id: id.startsWith(EFFICIENCY_STEP_PREFIX) ? id : `${EFFICIENCY_STEP_PREFIX}${id}`, title });

describe('splitStepsIntoBlocks · 基础分块', () => {
  it('用户 → 工具链 → 最终回复:三种块按序产出', () => {
    const { blocks, effNotes } = splitStepsIntoBlocks([
      userStep('u1', '查一下天气'),
      toolStep('t1', 'web_search'),
      toolStep('t2', 'browser_open'),
      finalAnswer('a1', '今天晴'),
    ]);
    expect(blocks.map((b) => b.type)).toEqual(['user', 'tools', 'assistant']);
    const tools = blocks[1] as { type: 'tools'; steps: MissionStep[] };
    expect(tools.steps.map((s) => s.id)).toEqual(['t1', 't2']);
    expect(effNotes).toEqual([]);
  });

  it('连续工具被同一轮用户输入分隔成两个聚合块', () => {
    const { blocks } = splitStepsIntoBlocks([
      userStep('u1', '问题一'),
      toolStep('t1', 'web_search'),
      finalAnswer('a1', '答一'),
      userStep('u2', '问题二'),
      toolStep('t2', 'sandbox_run'),
      finalAnswer('a2', '答二'),
    ]);
    expect(blocks.map((b) => b.type)).toEqual(['user', 'tools', 'assistant', 'user', 'tools', 'assistant']);
  });

  it('旧任务兼容:无 messageKind 时每个用户轮次最后一条已完成文本视作最终答复', () => {
    const legacyMid = step({ id: 'm1', role: 'assistant', answer: '中间分析', status: 'DONE' });
    const legacyFinal = step({ id: 'm2', role: 'assistant', answer: '最终结论', status: 'DONE' });
    const { blocks } = splitStepsIntoBlocks([userStep('u1', '问题'), legacyMid, legacyFinal]);
    expect(blocks.map((b) => b.type)).toEqual(['user', 'tools', 'assistant']);
    expect((blocks[2] as { step: MissionStep }).step.id).toBe('m2');
  });
});

describe('splitStepsIntoBlocks · 执行效率摘要步骤(「已完成1项任务活动」空壳条修复)', () => {
  it('结尾的 step_eff_ 步骤不进块,不再产生尾随工具活动条', () => {
    const { blocks, effNotes } = splitStepsIntoBlocks([
      userStep('u1', '问题'),
      toolStep('t1', 'web_search'),
      finalAnswer('a1', '答复'),
      effStep('e1', '执行效率: 5 步 · 工具调用 4 次'),
    ]);
    expect(blocks.map((b) => b.type)).toEqual(['user', 'tools', 'assistant']);
    expect(effNotes).toEqual(['执行效率: 5 步 · 工具调用 4 次']);
  });

  it('纯对话(无工具)也不因 eff 步骤多出活动块', () => {
    const { blocks, effNotes } = splitStepsIntoBlocks([
      userStep('u1', '你好'),
      finalAnswer('a1', '你好!'),
      effStep('e1'),
    ]);
    expect(blocks.map((b) => b.type)).toEqual(['user', 'assistant']);
    expect(effNotes).toHaveLength(1);
  });

  it('eff 步骤夹在中间时,前后工具链不被错误合并', () => {
    const { blocks } = splitStepsIntoBlocks([
      userStep('u1', '问题'),
      toolStep('t1', 'web_search'),
      effStep('e1'),
      toolStep('t2', 'sandbox_run'),
      finalAnswer('a1', '答复'),
    ]);
    expect(blocks.map((b) => b.type)).toEqual(['user', 'tools', 'tools', 'assistant']);
  });

  it('多轮会话每条 eff 摘要按序收集', () => {
    const { effNotes } = splitStepsIntoBlocks([
      userStep('u1', '一'),
      finalAnswer('a1', '答一'),
      effStep('e1', '执行效率: 1'),
      userStep('u2', '二'),
      finalAnswer('a2', '答二'),
      effStep('e2', '执行效率: 2'),
    ]);
    expect(effNotes).toEqual(['执行效率: 1', '执行效率: 2']);
  });

  it('isEfficiencyStep 只认 step_eff_ 前缀', () => {
    expect(isEfficiencyStep(effStep('x'))).toBe(true);
    expect(isEfficiencyStep(toolStep('t1', 'web_search'))).toBe(false);
    expect(isEfficiencyStep(step({ id: 'step_assistant_1', role: 'assistant' }))).toBe(false);
  });
});

describe('splitStepsIntoBlocks · 执行期思考过程可见性', () => {
  it('RUNNING 的中间 assistant(live step)走正式回复卡,不再收进工具块', () => {
    const live = step({
      id: 'step_live_m1_1',
      role: 'assistant',
      messageKind: 'progress',
      status: 'RUNNING',
      answer: '正在分析搜索结果…',
      title: '智能体回复',
    });
    const { blocks } = splitStepsIntoBlocks([
      userStep('u1', '问题'),
      toolStep('t1', 'web_search'),
      live,
    ]);
    expect(blocks.map((b) => b.type)).toEqual(['user', 'tools', 'assistant']);
    expect((blocks[2] as { step: MissionStep }).step.id).toBe('step_live_m1_1');
  });

  it('DONE 的中间推理仍归入活动块(避免过程叙述刷屏)', () => {
    const mid = step({ id: 'm1', role: 'assistant', messageKind: 'progress', status: 'DONE', answer: '阶段小结' });
    const { blocks } = splitStepsIntoBlocks([userStep('u1', '问题'), mid, finalAnswer('a1', '答')]);
    expect(blocks.map((b) => b.type)).toEqual(['user', 'tools', 'assistant']);
    expect((blocks[1] as { steps: MissionStep[] }).steps[0].id).toBe('m1');
  });

  it('FAILED 且已有部分文本 → 回复卡(中断标记+重新生成入口);空壳 FAILED 留在活动块', () => {
    const failedWithText = step({
      id: 'step_live_f1',
      role: 'assistant',
      messageKind: 'progress',
      status: 'FAILED',
      answer: '流出一半的文本',
    });
    const failedEmpty = step({
      id: 'step_live_f2',
      role: 'assistant',
      messageKind: 'progress',
      status: 'FAILED',
      title: '回复中断',
    });
    const withText = splitStepsIntoBlocks([userStep('u1', '问题'), failedWithText]);
    expect(withText.blocks.map((b) => b.type)).toEqual(['user', 'assistant']);
    const empty = splitStepsIntoBlocks([userStep('u1', '问题'), failedEmpty]);
    expect(empty.blocks.map((b) => b.type)).toEqual(['user', 'tools']);
  });

  it('live step 打断了工具链:前后工具各自成块', () => {
    const live = step({
      id: 'step_live_x',
      role: 'assistant',
      messageKind: 'progress',
      status: 'RUNNING',
      title: '正在思考…',
    });
    const { blocks } = splitStepsIntoBlocks([
      userStep('u1', '问题'),
      toolStep('t1', 'web_search'),
      live,
      toolStep('t2', 'sandbox_run'),
    ]);
    expect(blocks.map((b) => b.type)).toEqual(['user', 'tools', 'assistant', 'tools']);
  });
});

describe('groupBlocksIntoTurns · 一轮作答一张卡(单头像)', () => {
  it('用户块独立成轮;活动链与回复卡并入同一 agent 轮', () => {
    const { blocks } = splitStepsIntoBlocks([
      userStep('u1', '问题'),
      toolStep('t1', 'web_search'),
      finalAnswer('a1', '答复'),
    ]);
    const turns = groupBlocksIntoTurns(blocks);
    expect(turns.map((t) => t.type)).toEqual(['user', 'agent']);
    const agent = turns[1] as { type: 'agent'; items: ReturnType<typeof splitStepsIntoBlocks>['blocks'] };
    expect(agent.items.map((b) => b.type)).toEqual(['tools', 'assistant']);
  });

  it('live step 打断工具链后仍是同一个 agent 轮(不会出现两个头像)', () => {
    const live = step({
      id: 'step_live_1',
      role: 'assistant',
      messageKind: 'progress',
      status: 'RUNNING',
      answer: '思考中…',
    });
    const { blocks } = splitStepsIntoBlocks([
      userStep('u1', '问题'),
      toolStep('t1', 'web_search'),
      live,
      toolStep('t2', 'sandbox_run'),
      finalAnswer('a1', '答复'),
    ]);
    const turns = groupBlocksIntoTurns(blocks);
    expect(turns.map((t) => t.type)).toEqual(['user', 'agent']);
    const agent = turns[1] as { type: 'agent'; items: ReturnType<typeof splitStepsIntoBlocks>['blocks'] };
    expect(agent.items.map((b) => b.type)).toEqual(['tools', 'assistant', 'tools', 'assistant']);
  });

  it('两轮问答产出两个 agent 轮;key 互不相同', () => {
    const { blocks } = splitStepsIntoBlocks([
      userStep('u1', '问一'),
      finalAnswer('a1', '答一'),
      userStep('u2', '问二'),
      finalAnswer('a2', '答二'),
    ]);
    const turns = groupBlocksIntoTurns(blocks);
    expect(turns.map((t) => t.type)).toEqual(['user', 'agent', 'user', 'agent']);
    const keys = turns.filter((t) => t.type === 'agent').map((t) => (t as { key: string }).key);
    expect(new Set(keys).size).toBe(2);
  });

  it('自动巡航等无用户提问的会话:开头块也包成 agent 轮', () => {
    const { blocks } = splitStepsIntoBlocks([toolStep('t1', 'cron_trigger'), finalAnswer('a1', '巡航报告')]);
    const turns = groupBlocksIntoTurns(blocks);
    expect(turns.map((t) => t.type)).toEqual(['agent']);
  });

  it('空输入不崩溃', () => {
    expect(groupBlocksIntoTurns([])).toEqual([]);
  });
});

describe('findRetryPrompt · 失败重试取词', () => {
  it('取失败步骤之前最近一条用户输入原文', () => {
    const steps = [
      userStep('u1', '第一个问题'),
      finalAnswer('a1', '答一'),
      userStep('u2', '第二个问题'),
      step({ id: 'a2', role: 'assistant', status: 'FAILED', answer: 'partial' }),
    ];
    expect(findRetryPrompt(steps, 'a2')).toBe('第二个问题');
  });

  it('失败步骤不存在于列表时退回全局最后一条用户输入', () => {
    const steps = [userStep('u1', '唯一问题'), finalAnswer('a1', '答')];
    expect(findRetryPrompt(steps, 'ghost')).toBe('唯一问题');
  });

  it('没有任何用户输入 → null(不渲染重试按钮)', () => {
    expect(findRetryPrompt([finalAnswer('a1', '自动巡航产物')], 'a1')).toBeNull();
  });

  it('用户步骤只有 title 无 userPrompt 时用 title 兜底;空白输入不算', () => {
    const byTitle = [step({ id: 'u1', role: 'user', title: '标题即问题' }), finalAnswer('a1', '答')];
    expect(findRetryPrompt(byTitle, 'a1')).toBe('标题即问题');
    const blank = [userStep('u1', '   '), userStep('u2', '有效问题'), finalAnswer('a1', '答')];
    expect(findRetryPrompt(blank, 'a1')).toBe('有效问题');
  });
});
