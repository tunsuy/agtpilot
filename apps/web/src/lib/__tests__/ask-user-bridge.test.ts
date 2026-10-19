import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  buildAskUserTool,
  buildConfirmPlanTool,
  resolveUserQuestion,
  resolveQuestionForMission,
  hasPendingQuestionForMission,
  abortQuestionsForMission,
  MAX_QUESTIONS_PER_CALL,
} from '@/lib/ask-user-bridge';

/**
 * ask_user / confirm_plan 卡桥验收(先问后猜 + 计划确认门,多问打包版):
 * 1. 声明面:baseline(穿透工坊白名单)/readOnly(等待不占独占锁)/low;
 * 2. 参数校验:假选项(不足 2 个/缺 label)/超过问题数上限打回,不弹卡;
 * 3. 答题往返:question_request 事件 → resolveUserQuestion(逐问 items)→ { answers, via };
 *    覆盖校验:缺答任一问打回(半张卡对模型是残缺输入);
 * 4. 推荐项兜底:模型忘标 recommended 时默认第一项;
 * 5. 超时:到点未答各问按推荐项自动继续(timeout:true),任务不悬挂;
 *    多选取全部推荐项顿号拼接;preview/multiSelect 归一化透传;
 * 6. steering:resolveQuestionForMission 以自由文本统答解冻(等待期用户直接打字);
 * 7. abort:任务终止立即解冻 + abortQuestionsForMission 清场;
 * 8. 同任务并发提问去重:已有卡在等时第二问打回(两种工具混算);
 * 9. confirm_plan:计划卡(kind='plan'+planTasks)、放行/修改意见/超时放行、参数校验。
 */

const SESSION = { taskId: 'mission_test', step: 1, userId: 'u1' } as any;

function setup() {
  const events: Array<{ type: string; payload: any }> = [];
  const controller = new AbortController();
  const deps = {
    emit: (e: any) => events.push({ type: e.type, payload: e.payload }),
    getAbortSignal: (mid: string) => (mid === SESSION.taskId ? controller.signal : undefined),
  };
  const tool = buildAskUserTool(deps);
  const planTool = buildConfirmPlanTool(deps);
  return { events, controller, tool, planTool };
}

/** 单问卡(最常见形状):questions 数组包一问 */
const validArgs = () => ({
  questions: [
    {
      question: '资料整理成什么形式?',
      options: [
        { label: '汇总成一篇综述', recommended: true },
        { label: '按主题分列清单' },
      ],
    },
  ],
});

/** 多问打包卡:方向 + 范围两问一次问清 */
const multiArgs = () => ({
  questions: [
    {
      question: '资料整理成什么形式?',
      options: [
        { label: '汇总成一篇综述', recommended: true },
        { label: '按主题分列清单' },
      ],
    },
    {
      question: '覆盖什么范围?',
      options: [
        { label: '近一周', description: '时效优先', recommended: true },
        { label: '近一个月' },
        { label: '不限时间' },
      ],
    },
  ],
});

beforeEach(() => {
  delete process.env.AGTPILOT_QUESTION_TIMEOUT_MS;
});

afterEach(() => {
  // 清场:防挂起 promise 泄漏到下个用例
  abortQuestionsForMission(SESSION.taskId);
  delete process.env.AGTPILOT_QUESTION_TIMEOUT_MS;
});

describe('ask_user 工具声明', () => {
  it('baseline 常驻 + 只读并行道 + 低危(等待不占独占锁、穿透工坊白名单)', () => {
    const { tool } = setup();
    expect(tool.name).toBe('ask_user');
    expect(tool.baseline).toBe(true);
    expect(tool.readOnly).toBe(true);
    expect(tool.dangerLevel).toBe('low');
  });
});

describe('参数校验(假选项/问卷化不弹卡)', () => {
  it('缺 question / 选项不足 2 个 / 缺 label 都打回,错误带问题序号', async () => {
    const { tool, events } = setup();
    const r1 = await tool.execute({ questions: [{ question: '', options: [{ label: 'a' }, { label: 'b' }] }] }, SESSION);
    expect(r1.error).toBeTruthy();
    const r2 = await tool.execute({ questions: [{ question: 'q?', options: [{ label: '只有一个' }] }] }, SESSION);
    expect(String(r2.error)).toContain('2-4');
    const r3 = await tool.execute({ questions: [{ question: 'q?', options: [{ label: 'a' }, {}] }] }, SESSION);
    expect(r3.error).toBeTruthy();
    // 多问时第二问出错也要带序号定位
    const r4 = await tool.execute(
      { questions: [validArgs().questions[0], { question: '范围?', options: [{ label: '只有一个' }] }] },
      SESSION
    );
    expect(String(r4.error)).toContain('第 2 问');
    expect(events).toHaveLength(0); // 一律不弹卡
  });

  it('questions 空数组 / 超过上限打回(防问卷化)', async () => {
    const { tool, events } = setup();
    const r1: any = await tool.execute({ questions: [] }, SESSION);
    expect(r1.error).toBeTruthy();
    const many = Array.from({ length: MAX_QUESTIONS_PER_CALL + 1 }, () => validArgs().questions[0]);
    const r2: any = await tool.execute({ questions: many }, SESSION);
    expect(String(r2.error)).toContain(String(MAX_QUESTIONS_PER_CALL));
    expect(events).toHaveLength(0);
  });
});

describe('答题往返', () => {
  it('question_request 事件带归属三件套,单问选项回答原样回填', async () => {
    const { tool, events } = setup();
    const pending = tool.execute(validArgs(), SESSION);
    // 先挂 pending 再发事件(用户秒点时 resolve 不落空)
    expect(hasPendingQuestionForMission(SESSION.taskId)).toBe(true);
    const req = events.find((e) => e.type === 'question_request');
    expect(req).toBeTruthy();
    expect(req!.payload.taskId).toBe(SESSION.taskId);
    expect(req!.payload.userId).toBe('u1');
    expect(req!.payload.missionId).toBe(SESSION.taskId);
    expect(req!.payload.questions).toHaveLength(1);
    expect(req!.payload.questions[0].options).toHaveLength(2);
    expect(req!.payload.expiresAt).toBeGreaterThan(Date.now());

    const ok = resolveUserQuestion(req!.payload.id, [{ index: 0, answer: '按主题分列清单', via: 'option' }]);
    expect(ok).toBe(true);
    const result: any = await pending;
    expect(result.answers).toEqual([{ question: '资料整理成什么形式?', answer: '按主题分列清单', via: 'option' }]);
    expect(result.via).toBe('option');

    const resolved = events.find((e) => e.type === 'question_resolved');
    expect(resolved!.payload.outcome).toBe('answered');
    expect(resolved!.payload.answer).toContain('按主题分列清单');
    expect(hasPendingQuestionForMission(SESSION.taskId)).toBe(false);
  });

  it('多问打包:逐问回答一次提交,answers 按问题原文对号入座', async () => {
    const { tool, events } = setup();
    const pending = tool.execute(multiArgs(), SESSION);
    const req = events.find((e) => e.type === 'question_request')!;
    expect(req.payload.questions).toHaveLength(2);

    const ok = resolveUserQuestion(req.payload.id, [
      { index: 0, answer: '汇总成一篇综述', via: 'option' },
      { index: 1, answer: '近一个月', via: 'option' },
    ]);
    expect(ok).toBe(true);
    const result: any = await pending;
    expect(result.via).toBe('option');
    expect(result.answers).toHaveLength(2);
    expect(result.answers[0]).toMatchObject({ question: '资料整理成什么形式?', answer: '汇总成一篇综述' });
    expect(result.answers[1]).toMatchObject({ question: '覆盖什么范围?', answer: '近一个月' });
  });

  it('覆盖校验:缺答任一问打回,卡继续等待', async () => {
    const { tool, events } = setup();
    const pending = tool.execute(multiArgs(), SESSION);
    const req = events.find((e) => e.type === 'question_request')!;
    // 只答第一问 → 打回,pending 仍在
    expect(resolveUserQuestion(req.payload.id, [{ index: 0, answer: '汇总成一篇综述', via: 'option' }])).toBe(false);
    expect(hasPendingQuestionForMission(SESSION.taskId)).toBe(true);
    // 空答案也打回
    expect(
      resolveUserQuestion(req.payload.id, [
        { index: 0, answer: '汇总成一篇综述', via: 'option' },
        { index: 1, answer: '  ', via: 'free_text' },
      ])
    ).toBe(false);
    // 答全后放行
    expect(
      resolveUserQuestion(req.payload.id, [
        { index: 0, answer: '汇总成一篇综述', via: 'option' },
        { index: 1, answer: '近一周', via: 'option' },
      ])
    ).toBe(true);
    await pending;
  });

  it('模型忘标 recommended 时第一项兜底为推荐', async () => {
    process.env.AGTPILOT_QUESTION_TIMEOUT_MS = '20'; // execute 前设:定时器注册时读取
    const { tool, events } = setup();
    const pending = tool.execute(
      { questions: [{ question: 'q?', options: [{ label: '甲' }, { label: '乙' }] }] },
      SESSION
    );
    const req = events.find((e) => e.type === 'question_request');
    expect(req!.payload.questions[0].options[0].recommended).toBe(true);
    // 直接等超时验证推荐兜底路径
    const result: any = await pending;
    expect(result.via).toBe('timeout');
    expect(result.answers[0].answer).toBe('甲');
  });
});

describe('超时兜底', () => {
  it('到点未答各问按推荐项自动继续,timeout:true + 不再提问提示', async () => {
    process.env.AGTPILOT_QUESTION_TIMEOUT_MS = '30';
    const { tool, events } = setup();
    const result: any = await tool.execute(multiArgs(), SESSION);
    expect(result.timeout).toBe(true);
    expect(result.via).toBe('timeout');
    // 多问打包:每问各自取推荐项
    expect(result.answers).toEqual([
      { question: '资料整理成什么形式?', answer: '汇总成一篇综述', via: 'option' },
      { question: '覆盖什么范围?', answer: '近一周', via: 'option' },
    ]);
    expect(String(result.hint)).toContain('不要再次提问');
    const resolved = events.find((e) => e.type === 'question_resolved');
    expect(resolved!.payload.outcome).toBe('timeout');
  });
});

describe('steering 打通', () => {
  it('等待期用户直接打字 → resolveQuestionForMission 以自由文本统答解冻', async () => {
    const { tool } = setup();
    const pending = tool.execute(multiArgs(), SESSION);
    const n = resolveQuestionForMission(SESSION.taskId, '英文版,近一周就行');
    expect(n).toBe(1);
    const result: any = await pending;
    expect(result.via).toBe('free_text');
    // 统答:同一段原话回填到每一问,由模型自行解析(hint 说明规则)
    expect(result.answers).toHaveLength(2);
    expect(result.answers.every((a: any) => a.answer === '英文版,近一周就行' && a.via === 'free_text')).toBe(true);
    expect(String(result.hint)).toContain('自行从原话中解析');
  });
});

describe('abort 清场', () => {
  it('任务终止(abort)立即解冻,不阻塞收尾', async () => {
    const { tool, controller } = setup();
    const pending = tool.execute(validArgs(), SESSION);
    controller.abort();
    const result: any = await pending;
    expect(result.aborted).toBe(true);
    expect(hasPendingQuestionForMission(SESSION.taskId)).toBe(false);
  });

  it('abortQuestionsForMission 批量清场(stopMission 幂等兜底)', async () => {
    const { tool } = setup();
    const pending = tool.execute(validArgs(), SESSION);
    expect(abortQuestionsForMission(SESSION.taskId)).toBe(1);
    const result: any = await pending;
    expect(result.aborted).toBe(true);
  });
});

describe('并发提问去重', () => {
  it('同任务已有一张卡在等答案时,第二问打回不弹卡', async () => {
    const { tool, events } = setup();
    const first = tool.execute(validArgs(), SESSION);
    const second: any = await tool.execute(validArgs(), SESSION);
    expect(String(second.error)).toContain('等待用户回答');
    expect(events.filter((e) => e.type === 'question_request')).toHaveLength(1);
    // 收尾:解冻第一问
    const req = events.find((e) => e.type === 'question_request')!;
    resolveUserQuestion(req.payload.id, [{ index: 0, answer: '汇总成一篇综述', via: 'option' }]);
    await first;
  });
});

describe('多选与 preview 归一化', () => {
  it('multi_select / preview 透传到卡面,多选超时兜底拼接全部推荐项', async () => {
    process.env.AGTPILOT_QUESTION_TIMEOUT_MS = '20';
    const { tool, events } = setup();
    const result: any = await tool.execute(
      {
        questions: [
          {
            question: '覆盖哪些主题?',
            multi_select: true,
            options: [
              { label: '大模型动态', recommended: true, preview: '## 周报框架\n- 论文发布\n- 开源模型' },
              { label: '智能体产品', recommended: true },
              { label: '芯片硬件' },
            ],
          },
        ],
      },
      SESSION
    );
    const req = events.find((e) => e.type === 'question_request')!;
    expect(req.payload.questions[0].multiSelect).toBe(true);
    expect(req.payload.questions[0].options[0].preview).toContain('周报框架');
    // 未标 recommended 的第三项不进入兜底;两个推荐项顿号拼接
    expect(result.via).toBe('timeout');
    expect(result.answers[0].answer).toBe('大模型动态、智能体产品');
  });
});

describe('confirm_plan 计划确认门', () => {
  const planArgs = () => ({
    summary: '整理近一周 AI 资料并产出综述:\n- 检索三个角度\n- 汇总成文\n- 交付 markdown',
    tasks: ['多角度检索近一周 AI 资料', '交叉去重与筛选', '汇总成一篇综述交付'],
  });

  it('声明面与 ask_user 同款(baseline/readOnly/low),弹 kind=plan 卡带任务清单', async () => {
    const { planTool, events } = setup();
    expect(planTool.baseline).toBe(true);
    expect(planTool.readOnly).toBe(true);
    const pending = planTool.execute(planArgs(), SESSION);
    const req = events.find((e) => e.type === 'question_request')!;
    expect(req.payload.kind).toBe('plan');
    expect(req.payload.planTasks).toHaveLength(3);
    expect(req.payload.questions[0].options.map((o: any) => o.value)).toEqual(['go', 'adjust']);
    expect(req.payload.questions[0].context).toContain('综述');
    // 收尾
    resolveUserQuestion(req.payload.id, [{ index: 0, answer: '开始执行', via: 'option' }]);
    await pending;
  });

  it('用户点「开始执行」放行 → approved:true', async () => {
    const { planTool, events } = setup();
    const pending = planTool.execute(planArgs(), SESSION);
    const req = events.find((e) => e.type === 'question_request')!;
    resolveUserQuestion(req.payload.id, [{ index: 0, answer: '开始执行', via: 'option' }]);
    const result: any = await pending;
    expect(result.approved).toBe(true);
    expect(result.via).toBe('option');
    const resolved = events.find((e) => e.type === 'question_resolved');
    expect(resolved!.payload.outcome).toBe('answered');
  });

  it('自由文本修改意见 → approved:false + adjustment 原话 + 不再确认提示', async () => {
    const { planTool } = setup();
    const pending = planTool.execute(planArgs(), SESSION);
    resolveQuestionForMission(SESSION.taskId, '不要综述,按主题分列清单');
    const result: any = await pending;
    expect(result.approved).toBe(false);
    expect(result.adjustment).toBe('不要综述,按主题分列清单');
    expect(String(result.hint)).toContain('不要再次确认');
  });

  it('点「先调整一下」但没给意见 → approved:false + 推断调整点提示', async () => {
    const { planTool, events } = setup();
    const pending = planTool.execute(planArgs(), SESSION);
    const req = events.find((e) => e.type === 'question_request')!;
    resolveUserQuestion(req.payload.id, [{ index: 0, answer: '先调整一下', via: 'option' }]);
    const result: any = await pending;
    expect(result.approved).toBe(false);
    expect(result.adjustment).toBeUndefined();
    expect(String(result.hint)).toContain('推断最可能的调整点');
  });

  it('超时未答 → 按计划放行 approved:true,提示直接开工', async () => {
    process.env.AGTPILOT_QUESTION_TIMEOUT_MS = '25';
    const { planTool, events } = setup();
    const result: any = await planTool.execute(planArgs(), SESSION);
    expect(result.approved).toBe(true);
    expect(result.timeout).toBe(true);
    expect(String(result.hint)).toContain('不要再次确认');
    const resolved = events.find((e) => e.type === 'question_resolved');
    expect(resolved!.payload.outcome).toBe('timeout');
  });

  it('summary/tasks 缺失打回不弹卡;ask_user 在等时确认请求打回(混算去重)', async () => {
    const { tool, planTool, events } = setup();
    const r1: any = await planTool.execute({ summary: '', tasks: ['a'] }, SESSION);
    expect(r1.error).toBeTruthy();
    const r2: any = await planTool.execute({ summary: 'x', tasks: [] }, SESSION);
    expect(r2.error).toBeTruthy();
    expect(events).toHaveLength(0);
    // ask_user 挂起时 confirm_plan 打回(同任务同时最多一张卡,两种工具混算)
    const first = tool.execute(validArgs(), SESSION);
    const r3: any = await planTool.execute(planArgs(), SESSION);
    expect(String(r3.error)).toContain('等待用户回答');
    const req = events.find((e) => e.type === 'question_request')!;
    resolveUserQuestion(req.payload.id, [{ index: 0, answer: '汇总成一篇综述', via: 'option' }]);
    await first;
  });
});
