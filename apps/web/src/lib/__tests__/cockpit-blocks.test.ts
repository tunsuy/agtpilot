import { describe, it, expect } from 'vitest';
import {
  splitStepsIntoBlocks,
  groupBlocksIntoTurns,
  findRetryPrompt,
  isEfficiencyStep,
  processElapsedMs,
  findFinalAnswerIndex,
  turnCreatesPlan,
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
    // m2 升级为最终答复卡;m1 不再产出活动块(空壳组过滤,过程内容由活动流叙述)
    expect(blocks.map((b) => b.type)).toEqual(['user', 'assistant']);
    expect((blocks[1] as { step: MissionStep }).step.id).toBe('m2');
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

  it('DONE 的中间推理不再产出活动块(空壳组过滤:组内无工具步骤时整组吞掉)', () => {
    // 旧断言是产出 tools 块 —— 但组内只有元步骤时会渲染「已完成 0 项任务活动」
    // 空壳条(done 收尾顺序 bug 曾让每轮都留下这种 progress 形态的 live step)。
    // 元步骤内容不升级为平级回复卡(原意图不变),活动流 tab 仍会叙述它。
    const mid = step({ id: 'm1', role: 'assistant', messageKind: 'progress', status: 'DONE', answer: '阶段小结' });
    const { blocks } = splitStepsIntoBlocks([userStep('u1', '问题'), mid, finalAnswer('a1', '答')]);
    expect(blocks.map((b) => b.type)).toEqual(['user', 'assistant']);
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

describe('splitStepsIntoBlocks · 「已完成 0 项任务活动」空壳组修复', () => {
  /**
   * 生产实测(usr 落盘数据)三类 0 项组:
   * 1) 纯对话轮的 DONE progress live step(done 收尾顺序 bug 曾让它停留
   *    progress 形态,旁边还落着一条内容重复的独立 final 卡);
   * 2) 旧版「整体覆盖 steps」bug 抹掉工具步骤后只剩看板占位步骤;
   * 3) 两者混合。修复:组内无真实工具步骤且无 FAILED(错误提示有信息量)
   *    时整组不产出。
   */
  it('纯对话轮:DONE progress live step 单独成组时不再产出活动块', () => {
    const progress = step({
      id: 'step_live_m1_x_1',
      role: 'assistant',
      messageKind: 'progress',
      status: 'DONE',
      answer: '你好!我是 AgtPilot',
      title: '智能体回复',
    });
    const { blocks } = splitStepsIntoBlocks([
      userStep('u1', '你是谁'),
      progress,
      finalAnswer('a1', '你好!我是 AgtPilot'),
    ]);
    expect(blocks.map((b) => b.type)).toEqual(['user', 'assistant']);
  });

  it('看板占位步骤(无 role/tool)整组不产出 —— 旧数据残骸不再显示 0 项活动', () => {
    const kanban = (id: string, title: string): MissionStep =>
      step({ id, title, status: 'DONE' } as MissionStep);
    const { blocks } = splitStepsIntoBlocks([
      userStep('u1', '调研多模态智能体'),
      kanban('step_1', '检索最新多模态智能体架构'),
      kanban('step_2', '调研工具调用协议'),
      kanban('step_3', '汇总输出报告'),
      finalAnswer('a1', '分析报告…'),
    ]);
    expect(blocks.map((b) => b.type)).toEqual(['user', 'assistant']);
  });

  it('元步骤与工具步骤混组时块保留(工具行可见,元步骤仍是隐藏行)', () => {
    const meta = step({ id: 'm1', role: 'assistant', messageKind: 'progress', status: 'DONE', title: '已完成一轮推理' });
    const { blocks } = splitStepsIntoBlocks([
      userStep('u1', '问题'),
      meta,
      toolStep('t1', 'search_web'),
      finalAnswer('a1', '答'),
    ]);
    expect(blocks.map((b) => b.type)).toEqual(['user', 'tools', 'assistant']);
    expect((blocks[1] as { steps: MissionStep[] }).steps.map((s) => s.id)).toEqual(['m1', 't1']);
  });

  it('FAILED 空壳步骤仍留在活动块(错误提示不被吞掉)', () => {
    const failedEmpty = step({ id: 'step_live_f1', role: 'assistant', messageKind: 'progress', status: 'FAILED', title: '回复中断' });
    const { blocks } = splitStepsIntoBlocks([userStep('u1', '问题'), failedEmpty]);
    expect(blocks.map((b) => b.type)).toEqual(['user', 'tools']);
  });
});

describe('splitStepsIntoBlocks · 思考轮收尾不消失(思考中→已完成→思考中 跳变修复)', () => {
  /**
   * 轮次边界跳变根因:live 思考卡在 tool_call 收拢时被折叠进活动块瞬间消失,
   * 组头翻成「已完成 N 项活动」,下一轮 step_started 又新建思考卡。修复:
   * 带思考内容(reasoning)的收尾轮留在流内原地收拢为可折叠思考行 ——
   * 时间线只增不减,块位置不回缩(Claude Code 的思考块形态)。
   */
  it('DONE progress 带 reasoning:留在流内独立块,不再折叠进活动块消失', () => {
    const think = step({
      id: 'step_live_m1_1',
      role: 'assistant',
      messageKind: 'progress',
      status: 'DONE',
      reasoning: '拆解问题:先检索再汇总…',
      title: '已完成一轮推理',
    });
    const { blocks } = splitStepsIntoBlocks([
      userStep('u1', '问题'),
      think,
      toolStep('t1', 'search_web'),
      finalAnswer('a1', '答'),
    ]);
    expect(blocks.map((b) => b.type)).toEqual(['user', 'assistant', 'tools', 'assistant']);
    expect((blocks[1] as { step: MissionStep }).step.id).toBe('step_live_m1_1');
  });

  it('连续两轮思考 → 工具 → 再思考:块按时间追加,时间线不回缩', () => {
    const think1 = step({ id: 'th1', role: 'assistant', messageKind: 'progress', status: 'DONE', reasoning: '第一轮思考' });
    const think2 = step({ id: 'th2', role: 'assistant', messageKind: 'progress', status: 'DONE', reasoning: '第二轮思考' });
    const { blocks } = splitStepsIntoBlocks([
      userStep('u1', '问题'),
      think1,
      toolStep('t1', 'search_web'),
      think2,
      toolStep('t2', 'browser_open'),
    ]);
    expect(blocks.map((b) => b.type)).toEqual(['user', 'assistant', 'tools', 'assistant', 'tools']);
    expect((blocks[3] as { step: MissionStep }).step.id).toBe('th2');
  });

  it('DONE progress 仅带正文(无 reasoning)仍归活动块:过程叙述不刷屏、历史残骸不与最终答复重复', () => {
    const textOnly = step({ id: 'm1', role: 'assistant', messageKind: 'progress', status: 'DONE', answer: '阶段播报' });
    const { blocks } = splitStepsIntoBlocks([
      userStep('u1', '问题'),
      textOnly,
      toolStep('t1', 'search_web'),
      finalAnswer('a1', '答'),
    ]);
    expect(blocks.map((b) => b.type)).toEqual(['user', 'tools', 'assistant']);
    expect((blocks[1] as { steps: MissionStep[] }).steps.map((s) => s.id)).toEqual(['m1', 't1']);
  });

  it('空思考轮(无 reasoning 无正文)仍归活动块为隐藏行', () => {
    const emptyThink = step({ id: 'th1', role: 'assistant', messageKind: 'progress', status: 'DONE', title: '已完成一轮推理' });
    const { blocks } = splitStepsIntoBlocks([userStep('u1', '问题'), emptyThink, toolStep('t1', 'search_web')]);
    expect(blocks.map((b) => b.type)).toEqual(['user', 'tools']);
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

describe('processElapsedMs · 轮过程耗时(整轮折叠摘要行)', () => {
  const NOW = 1_700_000_000_000;

  it('墙钟口径:首步开始 → 末步结束,间隙计入(t1→t2 中间空档 8s 也在结果里)', () => {
    const steps = [
      step({ id: 't1', tool: 'web_search', startedAt: NOW, duration: '2000ms' }),
      // t2 比 t1 晚 10s 开始,组内 gap = 8s
      step({ id: 't2', tool: 'browser_open', startedAt: NOW + 10_000, duration: '4000ms' }),
    ];
    expect(processElapsedMs(steps, NOW)).toBe(14_000);
  });

  it('运行中的步骤以 now 兜底:流式收起瞬间也能给出实时读数', () => {
    const steps = [
      step({ id: 't1', tool: 'web_search', startedAt: NOW, duration: '1500ms' }),
      step({ id: 't2', tool: 'sandbox_exec', startedAt: NOW + 2_000, status: 'RUNNING' }),
    ];
    expect(processElapsedMs(steps, NOW + 6_000)).toBe(6_000);
  });

  it('全组缺 startedAt 时退回 duration 求和', () => {
    const steps = [
      step({ id: 't1', tool: 'web_search', duration: '2000ms' }),
      step({ id: 't2', tool: 'browser_open', duration: '3000ms' }),
    ];
    expect(processElapsedMs(steps, NOW)).toBe(5_000);
  });

  it('无任何时间数据 → undefined(摘要行不显示耗时段)', () => {
    expect(processElapsedMs([toolStep('t1', 'web_search')], NOW)).toBeUndefined();
    expect(processElapsedMs([], NOW)).toBeUndefined();
  });
});

describe('findFinalAnswerIndex · 整轮折叠边界(收起不完整修复)', () => {
  it('生产实测形态:中间思考卡带短叙述正文,边界必须落在最后的最终答复上', () => {
    // 上海→北京出行方案任务的落盘形态:思考 1640 字 + 叙述 16 字的中间轮
    // 后面还有 artifact_render 工具行,然后才是真正的最终答复
    const thinkCard = step({
      id: 'step_live_m1_1',
      role: 'assistant',
      messageKind: 'progress',
      status: 'DONE',
      answer: '先检索各方案价格…',
      reasoning: '(长思考)',
      title: '智能体回复',
    });
    const { blocks } = splitStepsIntoBlocks([
      userStep('u1', '上海到北京出行方案对比'),
      toolStep('t1', 'web_search'),
      thinkCard,
      toolStep('t2', 'artifact_render'),
      finalAnswer('a1', '综合对比结论…'),
    ]);
    // [user, tools, assistant(思考卡), tools, assistant(最终)]
    expect(blocks.map((b) => b.type)).toEqual(['user', 'tools', 'assistant', 'tools', 'assistant']);
    const idx = findFinalAnswerIndex(blocks);
    // 旧的 findIndex 语义会命中索引 2 的思考卡,其后的工具行/思考卡留在折叠区外
    expect(idx).toBe(4);
    // 折叠的过程区应包含思考卡与其后的 artifact_render 工具行
    const process = blocks.slice(0, idx);
    expect(process.map((b) => b.type)).toEqual(['user', 'tools', 'assistant', 'tools']);
  });

  it('流式中:live 步骤开始吐正文即成为折叠边界(它之前的过程收起)', () => {
    const live = step({
      id: 'step_live_m1_1',
      role: 'assistant',
      messageKind: 'progress',
      status: 'RUNNING',
      answer: '正在整理…',
      title: '智能体回复',
    });
    const { blocks } = splitStepsIntoBlocks([userStep('u1', '问题'), toolStep('t1', 'web_search'), live]);
    expect(findFinalAnswerIndex(blocks)).toBe(2);
  });

  it('纯思考流式(answer 为空)不触发折叠 —— 是否还要调工具未知,过程保持可见', () => {
    const live = step({
      id: 'step_live_m1_1',
      role: 'assistant',
      messageKind: 'progress',
      status: 'RUNNING',
      reasoning: '(思考中)',
      title: '智能体回复',
    });
    const { blocks } = splitStepsIntoBlocks([userStep('u1', '问题'), toolStep('t1', 'web_search'), live]);
    expect(findFinalAnswerIndex(blocks)).toBe(-1);
  });

  it('旧任务无 messageKind:带正文的收尾回复块同样可作边界', () => {
    const legacyFinal = step({ id: 'm2', role: 'assistant', answer: '最终结论', status: 'DONE' });
    const { blocks } = splitStepsIntoBlocks([userStep('u1', '问题'), toolStep('t1', 'web_search'), legacyFinal]);
    expect(findFinalAnswerIndex(blocks)).toBe(2);
  });

  it('无任何回复块 → -1(整轮保持展开)', () => {
    const { blocks } = splitStepsIntoBlocks([userStep('u1', '问题'), toolStep('t1', 'web_search')]);
    expect(findFinalAnswerIndex(blocks)).toBe(-1);
  });

  it('工坊成品豁免:清单留在中间 step、final 是泛化总结时,边界前移到成品块', () => {
    // 步数耗尽强制总结的落盘形态:机会清单在中间回复块,final 是散文总结 ——
    // 无谓词时清单块进折叠区,成品卡收尾不可见(生产回归形态)
    const list = step({
      id: 'step_live_m1_2',
      role: 'assistant',
      messageKind: 'progress',
      status: 'DONE',
      answer: '【项目】\na/b\n【机会链接】\nhttps://github.com/a/b/issues/1\n',
      reasoning: '(逐条核检思考)',
      title: '智能体回复',
    });
    const { blocks } = splitStepsIntoBlocks([
      userStep('u1', '只读调研 a/b'),
      toolStep('t1', 'github_scan'),
      list,
      finalAnswer('a1', '调研完成,看板已收尾。清单与卡片均已交付。'),
    ]);
    expect(blocks.map((b) => b.type)).toEqual(['user', 'tools', 'assistant', 'assistant']);
    expect(findFinalAnswerIndex(blocks)).toBe(3);
    // 带谓词:边界前移到成品块,成品卡与总结答复一并落在常显区
    expect(findFinalAnswerIndex(blocks, (a) => a.includes('【项目】'))).toBe(2);
  });

  it('工坊成品豁免:最终答复自身解析出成品时边界不动', () => {
    const { blocks } = splitStepsIntoBlocks([
      userStep('u1', '只读调研 a/b'),
      toolStep('t1', 'github_scan'),
      finalAnswer('a1', '【项目】\na/b\n【机会链接】\nhttps://github.com/a/b/issues/1\n'),
    ]);
    expect(findFinalAnswerIndex(blocks, (a) => a.includes('【项目】'))).toBe(2);
  });
});

describe('turnCreatesPlan · 看板卡钉挂轮判定', () => {
  it('过程块含 planner_create_plan 的轮次 → 钉挂看板卡', () => {
    const { blocks } = splitStepsIntoBlocks([
      userStep('u1', '调研并产出报告'),
      toolStep('t1', 'planner_create_plan'),
      toolStep('t2', 'web_search'),
      finalAnswer('a1', '报告'),
    ]);
    const turns = groupBlocksIntoTurns(blocks);
    const agentTurn = turns.find((t) => t.type === 'agent');
    expect(turnCreatesPlan((agentTurn as { items: any[] }).items)).toBe(true);
  });

  it('普通工具轮 → 不钉挂(不出空壳卡)', () => {
    const { blocks } = splitStepsIntoBlocks([
      userStep('u1', '查天气'),
      toolStep('t1', 'web_search'),
      finalAnswer('a1', '晴'),
    ]);
    const turns = groupBlocksIntoTurns(blocks);
    const agentTurn = turns.find((t) => t.type === 'agent');
    expect(turnCreatesPlan((agentTurn as { items: any[] }).items)).toBe(false);
  });

  it('续聊轮不含创建动作 → 不钉挂(卡片位置不漂移,状态靠 mission.plan 刷新)', () => {
    const { blocks } = splitStepsIntoBlocks([
      userStep('u1', '调研'),
      toolStep('t1', 'planner_create_plan'),
      toolStep('t2', 'web_search'),
      finalAnswer('a1', '中期结论'),
      userStep('u2', '继续'),
      toolStep('t3', 'web_search'),
      finalAnswer('a2', '最终结论'),
    ]);
    const turns = groupBlocksIntoTurns(blocks);
    const agentTurns = turns.filter((t) => t.type === 'agent');
    expect(agentTurns).toHaveLength(2);
    expect(turnCreatesPlan((agentTurns[0] as { items: any[] }).items)).toBe(true);
    expect(turnCreatesPlan((agentTurns[1] as { items: any[] }).items)).toBe(false);
  });
});
