/**
 * 驾驶舱对话流分块(纯函数,便于单测)。
 *
 * 把 mission.steps 切成渲染块:
 * - user:用户提问气泡;
 * - assistant:流式/最终回复与思考块(messageKind==='final',或旧任务的
 *   每轮最后一条已完成文本回复);
 * - tools:过程步骤聚合块 —— 渲染为时间线活动行(逐行叙述,无统计汇总头、
 *   无入参出参详情;行内叙述与右侧「动态」tab 同源 narrateStep)。组内无
 *   真实动作(带工具)且无失败步骤时不产出,不出空壳;
 * - 执行效率摘要步骤(step_eff_ 前缀)不进任何块 —— 单独收集为 effNotes,
 *   仅在动态区以小字呈现。
 */
import type { MissionStep } from '../types/agent';

export const EFFICIENCY_STEP_PREFIX = 'step_eff_';

export type CockpitBlock =
  | { type: 'user'; step: MissionStep }
  | { type: 'tools'; steps: MissionStep[]; key: string }
  | { type: 'assistant'; step: MissionStep };

export interface CockpitBlocks {
  blocks: CockpitBlock[];
  /** 执行效率摘要文案(step.title),按出现顺序 */
  effNotes: string[];
}

export function isEfficiencyStep(step: MissionStep): boolean {
  return Boolean(step.id?.startsWith(EFFICIENCY_STEP_PREFIX));
}

export function splitStepsIntoBlocks(steps: MissionStep[]): CockpitBlocks {
  const blocks: CockpitBlock[] = [];
  const effNotes: string[] = [];

  // 兼容旧任务:每个用户轮次中最后一条已完成 assistant 文本视作最终答复。
  const legacyFinalAssistantIds = new Set<string>();
  let legacyCandidate: string | undefined;
  for (const step of steps) {
    const beginsNewTurn = step.role === 'user' || Boolean(step.userPrompt);
    if (beginsNewTurn) {
      if (legacyCandidate) legacyFinalAssistantIds.add(legacyCandidate);
      legacyCandidate = undefined;
    } else if (step.role === 'assistant' && step.status === 'DONE' && step.answer && !step.messageKind) {
      legacyCandidate = step.id;
    }
  }
  if (legacyCandidate) legacyFinalAssistantIds.add(legacyCandidate);

  let currentTools: MissionStep[] = [];
  const flushTools = () => {
    if (currentTools.length > 0) {
      // 空壳组过滤：组内既无真实工具步骤、也无失败步骤（失败提示有信息量，保留）
      // —— 只剩元步骤（已完成一轮推理/看板占位）时整组不产出，否则渲染出
      // 「已完成 0 项任务活动」的空壳条。历史落盘数据里旧版「整体覆盖 steps」
      // bug 会把工具步骤抹掉只留看板步骤，靠这层兜底吃掉残骸。
      const hasRealAction = currentTools.some((s) => s.tool || s.status === 'FAILED');
      if (hasRealAction) {
        blocks.push({
          type: 'tools',
          steps: currentTools,
          key: `tools_group_${blocks.length}_${currentTools[0].id}`,
        });
      }
      currentTools = [];
    }
  };

  steps.forEach((st) => {
    if (isEfficiencyStep(st)) {
      // 效率摘要不参与对话流分块;flush 保证它前后的工具链不被错误合并
      flushTools();
      if (st.title) effNotes.push(st.title);
      return;
    }

    const isUser = st.role === 'user' || Boolean(st.userPrompt);
    const isAssistant = (st.role === 'assistant' || Boolean(st.answer)) && !isUser;
    const isFinalAssistant =
      isAssistant && (st.messageKind === 'final' || (!st.messageKind && legacyFinalAssistantIds.has(st.id)));
    // 流式块(打字机卡):正在输出的 live step、中断但已有文本的步骤、以及
    // 【已收尾但带思考内容的轮次】都走流内独立块 —— 思考卡在工具调用把轮次
    // 收拢后原地变为可折叠的「思考过程」行,不折叠进活动块突然消失(生产实测:
    // 思考中 → 跳变「已完成 N 项活动」→ 又跳回思考中,观感即来源于此)。
    // 仅带正文(answer)的收尾轮仍归活动块:正文属过程叙述,且历史落盘数据里
    // 它与最终答复卡内容重复(done 收尾顺序 bug 的残骸),不再重复展示。
    const isLiveAssistant =
      isAssistant &&
      st.role === 'assistant' &&
      st.messageKind !== 'final' &&
      (st.status === 'RUNNING' ||
        Boolean(st.reasoning && st.messageKind === 'progress') ||
        (st.status === 'FAILED' && Boolean(st.answer || st.reasoning)));
    // 中间模型轮次是执行过程,不再作为平级大回复;与工具调用一起归入活动块。
    const isTool = !isUser && (!isAssistant || (!isFinalAssistant && !isLiveAssistant));

    if (isTool) {
      currentTools.push(st);
    } else {
      flushTools();
      if (isUser) {
        blocks.push({ type: 'user', step: st });
      } else if (isAssistant) {
        blocks.push({ type: 'assistant', step: st });
      }
    }
  });
  flushTools();

  return { blocks, effNotes };
}

/** 失败回复的「重新生成」入口:取失败步骤之前最近一条用户输入(整段原文重发) */
export function findRetryPrompt(steps: MissionStep[], failedStepId: string): string | null {
  const failedIdx = steps.findIndex((s) => s.id === failedStepId);
  const end = failedIdx >= 0 ? failedIdx : steps.length;
  for (let i = end - 1; i >= 0; i--) {
    const s = steps[i];
    if (s.role === 'user' || s.userPrompt) {
      const prompt = (s.userPrompt || s.title || '').trim();
      return prompt || null;
    }
  }
  return null;
}

/**
 * 轮次分组(Claude Code 式平铺流的轻量轮锚):
 * 用户气泡独立成轮;两条用户消息之间的连续 agent 块(活动链/思考流/正式回复)
 * 归为同一个 agent 轮 —— 渲染时轮首一个小标记 + 左竖线 rail 串起同轮块,
 * 块本身平铺在流里(不再包进整轮大卡),多轮任务每轮回复各自成段。
 */
export type CockpitTurn =
  | { type: 'user'; step: MissionStep }
  | { type: 'agent'; key: string; items: CockpitBlock[] };

export function groupBlocksIntoTurns(blocks: CockpitBlock[]): CockpitTurn[] {
  const turns: CockpitTurn[] = [];
  let items: CockpitBlock[] = [];
  const flush = () => {
    if (items.length > 0) {
      turns.push({ type: 'agent', key: `agent_turn_${turns.length}`, items });
      items = [];
    }
  };
  for (const b of blocks) {
    if (b.type === 'user') {
      flush();
      turns.push({ type: 'user', step: b.step });
    } else {
      items.push(b);
    }
  }
  flush();
  return turns;
}
