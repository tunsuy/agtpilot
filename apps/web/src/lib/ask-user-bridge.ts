import type { ToolDefinition } from '@agtpilot/core';
import type { UserQuestion, QuestionItem, QuestionOption, QuestionAnswerItem } from '@agtpilot/protocol';

/**
 * ask_user / confirm_plan:模糊需求「先问后猜」+ 大任务「先确认后动手」桥
 * (范式对齐 connector-bridge.ts 的中途授权)
 *
 * 场景一(ask_user):用户 query 存在多种合理解读且不同解读导致明显不同的
 * 交付方向时,模型弹出问题卡(一次可打包 1-3 个相关问题,每问 2-4 个选项 +
 * 推荐徽章 + 多选 + 选项 preview 对照 + 自由输入),工具在 execute 内挂起
 * 等待 —— 用户答完提交/直接打字(steering 路径)即解冻,回答作为 tool
 * result 回填,主循环原地续跑。多问打包省模型往返(对齐 Claude Code
 * AskUserQuestion 的 questions[] 设计,也符合步数经济准则)。
 *
 * 场景二(confirm_plan):大任务建好看板后、动手执行前,把计划概要 + 任务
 * 清单给用户过目确认(对齐 Claude Code ExitPlanMode 的方案批准门,与提问
 * 分轨:提问是参数级澄清、可多次;确认是方案级批准、每任务至多一次)。
 * 复用同一张卡基建(kind='plan'),超时同样按推荐项(开始执行)自动继续。
 *
 * 兜底纪律(与审批门/授权卡同款):
 * - 超时(默认 5 分钟,AGTPILOT_QUESTION_TIMEOUT_MS 可覆盖)按各问推荐项
 *   自动继续,任务不中断 —— 无人值守时问题卡不能变成悬挂点;
 * - abortSignal(用户点「停止」)立即返回 aborted,不阻塞收尾;
 * - readOnly 声明:等待发生在只读并行道,不占 ToolGate 独占锁(审批门
 *   「不拿锁等人工」的同款纪律);
 * - 同任务同时最多一张卡:并发重复调用(两种工具混算)直接打回,防刷屏。
 *
 * cron 无人值守任务与 IM 通道任务不挂载这两个工具(agent-backend 按 unattended 门控)。
 *
 * pending 注册表是模块级单例(Next dev/prod 下 lib 模块同进程共享):
 * 答题 API 路由 / steering 排队路径两个入口都能命中同一个 promise。
 */

export type QuestionOutcome = 'answered' | 'timeout' | 'aborted';

/** 单问回答(工具回填给模型的形状,带问题原文方便模型对号入座) */
export interface ResolvedAnswer {
  question: string;
  answer: string;
  via: 'option' | 'free_text';
}

export interface QuestionAnswer {
  answers: ResolvedAnswer[];
  /** 整卡口径:option=全部点选,free_text=打字统答,timeout=按推荐项,aborted=任务终止 */
  via: 'option' | 'free_text' | 'timeout' | 'aborted';
  timeout?: boolean;
}

/** 一次调用的问题数上限(对齐 Claude Code AskUserQuestion 的收敛口径,防问卷化) */
export const MAX_QUESTIONS_PER_CALL = 3;

/** 等待上限:默认 5 分钟(与 connector_authorize 惯例一致),env 可覆盖便于测试 */
export function questionTimeoutMs(): number {
  const raw = Number(process.env.AGTPILOT_QUESTION_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 5 * 60 * 1000;
}

interface PendingQuestion {
  resolve: (answer: QuestionAnswer) => void;
  timer: ReturnType<typeof setTimeout>;
  missionId?: string;
  userId?: string;
  /** 归一化后的问题列表(index → 问题原文,答题回填用) */
  questions: QuestionItem[];
}

const pendingQuestions = new Map<string, PendingQuestion>();

/**
 * 答题入口(POST /api/agent/answer):按问题卡 id 解冻等待中的工具。
 * items 必须覆盖全部问题(index 0..n-1),缺答打回 —— 半张卡的回答对模型
 * 是残缺输入,不如让前端强制答完再提交。
 */
export function resolveUserQuestion(questionId: string, items: QuestionAnswerItem[]): boolean {
  const pending = pendingQuestions.get(questionId);
  if (!pending) return false;
  if (!Array.isArray(items) || items.length === 0) return false;
  const covered = new Set(items.map((it) => Number(it?.index)));
  for (let i = 0; i < pending.questions.length; i++) {
    if (!covered.has(i)) return false;
  }
  const answers: ResolvedAnswer[] = pending.questions.map((q, i) => {
    const item = items.find((it) => Number(it.index) === i);
    return {
      question: q.question,
      answer: String(item?.answer ?? '').trim(),
      via: item?.via === 'free_text' ? 'free_text' : 'option',
    };
  });
  if (answers.some((a) => !a.answer)) return false;
  clearTimeout(pending.timer);
  pendingQuestions.delete(questionId);
  pending.resolve({
    answers,
    via: answers.every((a) => a.via === 'option') ? 'option' : 'free_text',
  });
  return true;
}

/**
 * steering 打通:等待回答期间用户直接打字 → 整段文本作为所有问题的
 * 自由文本统答(模型自行从中解析各问答案),不打断在飞轮次。
 * 计划确认卡等待期打字 = 修改意见,同一入口送达。
 */
export function resolveQuestionForMission(missionId: string, text: string): number {
  let resolved = 0;
  for (const [id, pending] of pendingQuestions) {
    if (pending.missionId === missionId) {
      clearTimeout(pending.timer);
      pendingQuestions.delete(id);
      pending.resolve({
        answers: pending.questions.map((q) => ({ question: q.question, answer: text, via: 'free_text' as const })),
        via: 'free_text',
      });
      resolved += 1;
    }
  }
  return resolved;
}

/** 该任务是否有等待回答的卡(问题卡/计划确认卡混算;runMission 在飞排队路径据此改走答题) */
export function hasPendingQuestionForMission(missionId: string): boolean {
  for (const pending of pendingQuestions.values()) {
    if (pending.missionId === missionId) return true;
  }
  return false;
}

/** 任务终止时的清场:拒绝所有挂起卡,避免残留弹窗(stopMission 调用) */
export function abortQuestionsForMission(missionId: string): number {
  let aborted = 0;
  for (const [id, pending] of pendingQuestions) {
    if (pending.missionId === missionId) {
      clearTimeout(pending.timer);
      pendingQuestions.delete(id);
      pending.resolve({ answers: [], via: 'aborted' });
      aborted += 1;
    }
  }
  return aborted;
}

export interface AskUserDeps {
  /** 事件出口:走 ctx.agent.emitEvent → agent-backend.handleEvent → SSE */
  emit: (event: { type: string; payload: Record<string, any>; timestamp: number }) => void;
  /** 取该任务的中止信号(ToolSession 不带 abortSignal;用户点「停止」时立即解冻) */
  getAbortSignal?: (missionId: string) => AbortSignal | undefined;
}

/** 归一化 + 校验单问;返回错误文案(null = 通过) */
function normalizeQuestion(raw: any, pos: number): { item?: QuestionItem; error?: string } {
  if (!raw?.question || typeof raw.question !== 'string') {
    return { error: `第 ${pos + 1} 问缺 question 正文` };
  }
  const opts = Array.isArray(raw.options) ? raw.options : [];
  if (opts.length < 2 || opts.length > 4) {
    return { error: `第 ${pos + 1} 问「${raw.question}」的 options 必须是 2-4 个具体选项;不足 2 个说明没有真分歧,自行拍板即可` };
  }
  if (opts.some((o: any) => !o?.label || typeof o.label !== 'string')) {
    return { error: `第 ${pos + 1} 问的每个选项都需要 label 文案` };
  }
  const normalized: QuestionOption[] = opts.map((o: any) => ({
    value: String(o.value ?? o.label),
    label: String(o.label),
    description: o.description ? String(o.description) : undefined,
    recommended: Boolean(o.recommended),
    preview: o.preview ? String(o.preview) : undefined,
  }));
  // 推荐项兜底:模型忘标时默认第一个(超时兜底需要一个确定的续跑方向)
  if (!normalized.some((o) => o.recommended)) normalized[0].recommended = true;
  return {
    item: {
      question: String(raw.question),
      context: raw.context ? String(raw.context) : undefined,
      options: normalized,
      multiSelect: Boolean(raw.multi_select),
      allowFreeText: raw.allow_free_text !== false,
    },
  };
}

/** 单问的超时兜底答案:单选取推荐项;多选取全部推荐项(顿号拼接) */
function recommendedAnswer(q: QuestionItem): string {
  const picks = q.options.filter((o) => o.recommended);
  return (picks.length ? picks : [q.options[0]]).map((o) => o.label).join('、');
}

/**
 * 共享的「挂卡等待」流程(ask_user / confirm_plan 同款):
 * 先挂 pending 再发事件(connector-bridge 同款教训:用户秒点时 resolve 不能落空)→
 * 超时按推荐项 / abort 立即解冻 → 解冻后统一发 question_resolved 收口。
 */
async function awaitUserCard(params: {
  payload: UserQuestion;
  /** 超时兜底答案(每问推荐项) */
  timeoutAnswers: ResolvedAnswer[];
  missionId?: string;
  userId?: string;
  deps: AskUserDeps;
}): Promise<QuestionAnswer> {
  const { payload, timeoutAnswers, missionId, userId, deps } = params;
  const { emit, getAbortSignal } = deps;
  const questionId = payload.id;

  const timeoutAnswer: QuestionAnswer = { answers: timeoutAnswers, via: 'timeout', timeout: true };

  const waitPromise = new Promise<QuestionAnswer>((resolve) => {
    const timer = setTimeout(() => {
      pendingQuestions.delete(questionId);
      resolve(timeoutAnswer);
    }, questionTimeoutMs());
    pendingQuestions.set(questionId, {
      resolve,
      timer,
      missionId,
      userId,
      questions: payload.questions,
    });
  });

  // abort(用户点「停止」)立即解冻,不阻塞任务收尾
  const abortSignal = missionId ? getAbortSignal?.(missionId) : undefined;
  if (abortSignal) {
    if (abortSignal.aborted) {
      const pending = pendingQuestions.get(questionId);
      if (pending) {
        clearTimeout(pending.timer);
        pendingQuestions.delete(questionId);
      }
      return { answers: [], via: 'aborted' };
    }
    abortSignal.addEventListener(
      'abort',
      () => {
        const pending = pendingQuestions.get(questionId);
        if (pending) {
          clearTimeout(pending.timer);
          pendingQuestions.delete(questionId);
          pending.resolve({ answers: [], via: 'aborted' });
        }
      },
      { once: true }
    );
  }

  emit({ type: 'question_request', payload: { ...payload }, timestamp: Date.now() });

  const result = await waitPromise;

  emit({
    type: 'question_resolved',
    payload: {
      id: questionId,
      outcome: result.via === 'timeout' ? 'timeout' : result.via === 'aborted' ? 'aborted' : 'answered',
      // 事件里只带摘要(截断),全文走 tool result 给模型
      answer: result.answers.map((a) => a.answer).join(' | ').slice(0, 200),
      taskId: missionId,
      userId,
    },
    timestamp: Date.now(),
  });

  return result;
}

/**
 * 构建任务级 ask_user 工具(taskTools 注入,不进全局注册表)。
 * baseline 声明穿透工坊白名单与关键词路由(工具按需挂载 P2 同款理由:
 * 「该不该问」无法靠关键词预判,漏挂会把模型逼回逐个方向试探的老路)。
 */
export function buildAskUserTool(deps: AskUserDeps): ToolDefinition {
  return {
    name: 'ask_user',
    description:
      '当用户需求存在多种合理解读、且不同解读会导致明显不同的交付方向/范围/平台时调用:' +
      '向用户弹出一张问题卡,一次可打包 1-3 个相关问题(如方向、范围、形式一起问清),每问 2-4 个具体选项并标注推荐项,可附自由输入;可并行勾选的问用 multi_select,需要看着对比才能决策的问(版式/结构等)给选项附 preview 对照物;工具等待用户回答(最长 5 分钟)。' +
      '返回 { answers: [{ question, answer, via }] } —— via=timeout 表示超时未答、各问已按推荐项给出 answer,应直接按它继续。' +
      '【不要】用它问可以自行查证的细节或不影响方向的琐事;同一任务最多问 2 次;一次调用一张卡,不要并发提问。',
    dangerLevel: 'low',
    // 只读声明:等待发生在只读并行道,不占 ToolGate 独占锁(审批门同款纪律)
    readOnly: true,
    // 常驻声明:任何工坊/路由下都可见 —— 模糊需求的出口不能按需挂载
    baseline: true,
    parameters: {
      type: 'object',
      properties: {
        questions: {
          type: 'array',
          description: `1-${MAX_QUESTIONS_PER_CALL} 个相关问题;单问也用数组。能一次问清就不要拆多轮`,
          minItems: 1,
          maxItems: MAX_QUESTIONS_PER_CALL,
          items: {
            type: 'object',
            properties: {
              question: { type: 'string', description: '面向用户的一句话问题(中文,具体不含糊)' },
              context: { type: 'string', description: '可选:为什么需要问(一句话背景,展示在问题下方)' },
              options: {
                type: 'array',
                description: '2-4 个具体选项;恰有一个 recommended=true(你建议的默认方向)',
                minItems: 2,
                maxItems: 4,
                items: {
                  type: 'object',
                  properties: {
                    label: { type: 'string', description: '选项文案(一行,动词开头更佳)' },
                    description: { type: 'string', description: '可选:该选项的含义/后果一句话' },
                    recommended: { type: 'boolean', description: '推荐项标记(每问至多一个 true)' },
                    preview: {
                      type: 'string',
                      description:
                        '可选:该选项的对照物(markdown:布局示意/代码片段/图表),仅在用户需要看着对比才能决策时提供(如选版式/配色/结构);是否类问题不要带',
                    },
                  },
                  required: ['label'],
                },
              },
              multi_select: { type: 'boolean', description: '该问是否多选(答案按选中项拼接);缺省 false 单选' },
              allow_free_text: { type: 'boolean', description: '该问是否允许自由文本回答(默认 true)' },
            },
            required: ['question', 'options'],
          },
        },
      },
      required: ['questions'],
    },
    execute: async ({ questions }, session): Promise<Record<string, any>> => {
      // 参数校验:打回比弹窗更重要 —— 假选项/问卷式滥问对用户没有决策价值
      const rawList = Array.isArray(questions) ? questions : [];
      if (rawList.length === 0) {
        return { error: 'questions 必填(至少 1 个问题)' };
      }
      if (rawList.length > MAX_QUESTIONS_PER_CALL) {
        return { error: `一次最多 ${MAX_QUESTIONS_PER_CALL} 个问题;合并相关问,只留影响交付方向的` };
      }
      const items: QuestionItem[] = [];
      for (let i = 0; i < rawList.length; i++) {
        const { item, error } = normalizeQuestion(rawList[i], i);
        if (error) return { error };
        items.push(item!);
      }

      const missionId = session?.taskId;
      // 同任务并发提问去重:已有一张卡在等答案时打回,防卡片刷屏
      if (missionId && hasPendingQuestionForMission(missionId)) {
        return { error: '该任务已有一张卡在等待用户回答,不要并发提问;等上一个结果返回后再决定' };
      }

      const payload: UserQuestion = {
        id: `q_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        kind: 'question',
        questions: items,
        taskId: missionId,
        userId: session?.userId,
        missionId,
        expiresAt: Date.now() + questionTimeoutMs(),
      };

      const result = await awaitUserCard({
        payload,
        timeoutAnswers: items.map((q) => ({ question: q.question, answer: recommendedAnswer(q), via: 'option' })),
        missionId,
        userId: session?.userId,
        deps,
      });

      if (result.via === 'aborted') {
        return { aborted: true, message: '任务已被用户终止,问题未获回答。' };
      }
      if (result.via === 'timeout') {
        return {
          answers: result.answers,
          via: 'timeout',
          timeout: true,
          hint: `用户 ${Math.round(questionTimeoutMs() / 60000)} 分钟内未响应,各问已按推荐项给出回答。请直接按它们继续,不要再次提问。`,
        };
      }
      return {
        answers: result.answers,
        via: result.via,
        hint:
          result.via === 'free_text'
            ? '用户以自由文本回答,以其原话为准;多问打包时请自行从原话中解析各问答案,缺失的按推荐项处理,不要追问。'
            : undefined,
      };
    },
  };
}

/** 计划确认卡的固定选项(值即语义,前端按 value 上图标) */
const PLAN_GO = 'go';
const PLAN_ADJUST = 'adjust';

/**
 * 构建任务级 confirm_plan 工具(计划确认门,对齐 Claude Code ExitPlanMode):
 * 大任务建好看板后、动手执行前,把计划概要与任务清单给用户过目 ——
 * 「开始执行」放行 /「先调整一下」或直接打字给修改意见 / 超时按放行处理
 * (与提问卡同款不悬挂纪律)。与 ask_user 分轨:提问是参数级澄清、可多次,
 * 确认是方案级批准、每任务至多一次;两者共享同一张卡基建与 pending 注册表
 * (同任务同时最多一张卡)。
 */
export function buildConfirmPlanTool(deps: AskUserDeps): ToolDefinition {
  return {
    name: 'confirm_plan',
    description:
      '大任务计划确认门:建好看板计划后、开始执行前调用,把计划概要(summary)与任务清单(tasks)弹给用户确认,等待放行(最长 5 分钟)。' +
      '返回 { approved: true } 表示用户放行(或超时未答按计划继续),直接开始执行第一个任务;' +
      '{ approved: false, adjustment? } 表示用户给了修改意见 —— 按意见改计划后直接执行,不要再次确认。' +
      '【不要】对小任务(预计三五步内完成)、闲聊或纯查询调用;同一任务至多确认一次;用户已明确说「直接做/不用确认」时严禁调用。',
    dangerLevel: 'low',
    readOnly: true,
    baseline: true,
    parameters: {
      type: 'object',
      properties: {
        summary: {
          type: 'string',
          description: '给用户看的计划概要(2-5 句话或 markdown 要点:做什么、怎么做、交付什么)',
        },
        tasks: {
          type: 'array',
          description: '任务清单(与看板一致,每条一行短句;至多 12 条)',
          maxItems: 12,
          items: { type: 'string' },
        },
        question: { type: 'string', description: '可选:确认问句(缺省「按这个计划执行吗?」)' },
      },
      required: ['summary', 'tasks'],
    },
    execute: async (args, session): Promise<Record<string, any>> => {
      const summary = typeof args?.summary === 'string' ? args.summary.trim() : '';
      const tasks = Array.isArray(args?.tasks) ? args.tasks.filter((t: any) => typeof t === 'string' && t.trim()).slice(0, 12) : [];
      if (!summary) {
        return { error: 'summary 必填:给用户看的计划概要' };
      }
      if (tasks.length === 0) {
        return { error: 'tasks 必填:至少 1 条任务清单条目(与看板一致)' };
      }

      const missionId = session?.taskId;
      if (missionId && hasPendingQuestionForMission(missionId)) {
        return { error: '该任务已有一张卡在等待用户回答,不要并发弹卡;等上一个结果返回后再决定' };
      }

      const questionText = typeof args?.question === 'string' && args.question.trim() ? args.question.trim() : '按这个计划执行吗?';
      const items: QuestionItem[] = [
        {
          question: questionText,
          context: summary,
          options: [
            { value: PLAN_GO, label: '开始执行', description: '按计划开始,过程中可随时打字调整', recommended: true },
            { value: PLAN_ADJUST, label: '先调整一下', description: '在下方输入修改意见' },
          ],
          allowFreeText: true,
        },
      ];

      const payload: UserQuestion = {
        id: `q_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        kind: 'plan',
        questions: items,
        planTasks: tasks.map((t: string) => t.trim()),
        taskId: missionId,
        userId: session?.userId,
        missionId,
        expiresAt: Date.now() + questionTimeoutMs(),
      };

      const result = await awaitUserCard({
        payload,
        timeoutAnswers: [{ question: questionText, answer: '开始执行', via: 'option' }],
        missionId,
        userId: session?.userId,
        deps,
      });

      if (result.via === 'aborted') {
        return { aborted: true, message: '任务已被用户终止,计划未获确认。' };
      }
      if (result.via === 'timeout') {
        return {
          approved: true,
          via: 'timeout',
          timeout: true,
          hint: `用户 ${Math.round(questionTimeoutMs() / 60000)} 分钟内未响应,已按计划放行。直接开始执行第一个任务,不要再次确认。`,
        };
      }
      const answer = result.answers[0];
      if (answer.via === 'free_text') {
        return {
          approved: false,
          adjustment: answer.answer,
          via: 'free_text',
          hint: '用户以自由文本回应,以其原话为准:是修改意见就改完计划直接执行;是同意(如「行/开始吧」)就直接开工。不要再次确认。',
        };
      }
      if (answer.answer === '开始执行') {
        return { approved: true, via: 'option' };
      }
      return {
        approved: false,
        via: 'option',
        hint: '用户点了「先调整一下」但没给具体意见。结合此前对话推断最可能的调整点给出修订版计划(正文说明改了什么),然后直接执行,不要再次弹卡确认。',
      };
    },
  };
}
