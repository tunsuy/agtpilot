/**
 * 驾驶舱对话流分块(纯函数,便于单测)。
 *
 * 把 mission.steps 切成渲染块:
 * - user:用户提问气泡;
 * - assistant:正式回复卡(messageKind==='final',或旧任务的每轮最后一条已完成文本回复);
 * - tools:连续的过程步骤(工具调用 + 中间推理)聚合为一个折叠条;
 * - 执行效率摘要步骤(step_eff_ 前缀)不进任何块 —— 它不是任务活动,
 *   过去被错归入工具块导致每轮结尾多一个「已完成 1 项任务活动」空壳条;
 *   现单独收集为 effNotes,仅在「查看执行详情」开启时以小字呈现。
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
      blocks.push({
        type: 'tools',
        steps: currentTools,
        key: `tools_group_${blocks.length}_${currentTools[0].id}`,
      });
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
    // 正在流式输出的 live step(打字机卡)与中断但已有文本的步骤,走正式回复卡呈现
    // —— 执行期的思考过程对用户实时可见,不再被收进工具活动块只露一行摘要;
    // 已完成(DONE)的中间推理轮次仍归入活动块,避免时间线被过程叙述刷屏。
    const isLiveAssistant =
      isAssistant &&
      st.role === 'assistant' &&
      st.messageKind !== 'final' &&
      (st.status === 'RUNNING' || (st.status === 'FAILED' && Boolean(st.answer || st.reasoning)));
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
 * 轮次分组(主流 agent 产品的「一次作答一张卡」形态):
 * 用户气泡独立成轮;两条用户消息之间的连续 agent 块(活动链/思考流/正式回复)
 * 合并为同一个 agent 轮 —— 渲染时整轮包进一张回复卡、只出现一个头像,
 * 不会"一个问、两个 agent 头像答"。
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
