import type { Mission, MissionStep } from '../types/agent';

/**
 * 流式 live assistant step 状态机（纯函数，便于单测）。
 *
 * live step = id 前缀 `step_live_` 且 status==='RUNNING'、role==='assistant'
 * 的步骤（每 mission 至多一个，从尾向前扫描）：
 * - step_started 事件创建（"正在思考…"占位）；
 * - assistant_delta 事件按 kind 累积 answer（正文）/ reasoning（思考过程）；
 * - tool_call / error / done 等边界事件收尾（closeLiveStep / finalizeWithAnswer）。
 * 稳定的 step_live_ id 让 React 复用同一 DOM 节点 —— 打字机卡片原地变终稿卡片，
 * 不产生重复的智能体回复块。
 */
export const LIVE_STEP_ID_PREFIX = 'step_live_';

export function findLiveStep(mission: Mission): MissionStep | undefined {
  for (let i = mission.steps.length - 1; i >= 0; i--) {
    const st = mission.steps[i];
    if (st.id?.startsWith(LIVE_STEP_ID_PREFIX) && st.status === 'RUNNING' && st.role === 'assistant') {
      return st;
    }
  }
  return undefined;
}

/** 确保存在 live step；无则追加一个 RUNNING 占位（"正在思考…"） */
export function ensureLiveStep(mission: Mission, stepNumber?: number, reason?: string): MissionStep {
  const existing = findLiveStep(mission);
  if (existing) return existing;
  const step: MissionStep = {
    id: `${LIVE_STEP_ID_PREFIX}${mission.id}_${stepNumber ?? 'x'}_${Date.now()}_${Math.random().toString(36).slice(2, 5)}`,
    role: 'assistant',
    messageKind: 'progress',
    title: reason === 'wrap-up' ? '正在做最终总结…' : '正在思考…',
    status: 'RUNNING',
    answer: '',
    startedAt: Date.now(),
  };
  mission.steps.push(step);
  return step;
}

/** 追加流式增量：kind='text' → answer（首个文本时改标题），kind='reasoning' → reasoning */
export function applyDelta(mission: Mission, delta: string, kind: 'text' | 'reasoning' = 'text'): void {
  const live = findLiveStep(mission) ?? ensureLiveStep(mission);
  if (kind === 'reasoning') {
    live.reasoning = (live.reasoning || '') + delta;
    if (!live.answer) live.title = '深度思考中…';
  } else {
    live.answer = (live.answer || '') + delta;
    live.title = '智能体回复';
  }
}

/**
 * 收尾 open 的 live step（工具开始 / 执行异常）。
 * answer 为空时 DONE → "已完成一轮推理"（纯思考段无正文产出）。
 * 返回是否真的关闭了一个 live step。
 */
export function closeLiveStep(
  mission: Mission,
  opts: { status: 'DONE' | 'FAILED'; finalTitle?: string } = { status: 'DONE' }
): boolean {
  const live = findLiveStep(mission);
  if (!live) return false;
  live.status = opts.status;
  if (opts.finalTitle) {
    live.title = opts.finalTitle;
  } else if (!live.answer) {
    live.title = opts.status === 'DONE' ? '已完成一轮推理' : '回复中断';
  }
  live.duration = `${Math.max(0, Date.now() - (live.startedAt || Date.now()))}ms`;
  return true;
}

/**
 * done 收尾：用权威最终回答覆盖 live step（绝不与已流出部分拼接）。
 * 返回是否合并 —— 调用方仅在 false（无 live step，如纯工具任务）时才
 * 追加独立的 step_assistant_* 步骤，避免重复回复块。
 */
export function finalizeWithAnswer(mission: Mission, finalAnswer: string): boolean {
  const live = findLiveStep(mission);
  if (!live) return false;
  live.answer = finalAnswer;
  live.status = 'DONE';
  live.messageKind = 'final';
  live.title = '最终答复';
  live.duration = `${Math.max(0, Date.now() - (live.startedAt || Date.now()))}ms`;
  return true;
}

/**
 * 事件归属（P0 串台修复的纯函数本体）：优先事件自带的 taskId
 * （orchestrator 对每个事件盖章 payload.taskId，多任务并发/切换会话时
 * 步骤不再挂错），找不到再兜底当前 activeMission。
 */
export function resolveMission(
  missions: Mission[],
  activeMissionId: string | null | undefined,
  payload?: Record<string, any> | null
): Mission | undefined {
  const taskId = payload?.taskId;
  if (taskId) {
    const byTask = missions.find((m) => m.id === taskId);
    if (byTask) return byTask;
  }
  if (activeMissionId) {
    return missions.find((m) => m.id === activeMissionId);
  }
  return undefined;
}
