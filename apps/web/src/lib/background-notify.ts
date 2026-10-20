import type { MissionStep } from '@/types/agent';

/**
 * 后台子任务完成/失败回注(docs/design/background-child-missions.md §4)。
 *
 * 纯逻辑抽薄:AgentBackend 在 orchestrator done/error 事件里组好 deps 调
 * deliverChildOutcome;本模块只做去重、截断、通知文本/气泡形态与
 * 「父在飞 → 入队步边界注入 / 父已结束 → 唤醒续轮」的路由决策,
 * 可脱离后端单测。前缀【后台任务通知】不在这里拼:注入通道由 core 的
 * appendBackgroundNotice 加,唤醒派发由 agent-backend 加(与轮末兜底一致)。
 */

/** done 通知的结果摘要上限:末尾单条 user 消息约 1-1.5k token,尾部追加只破一次前缀缓存(治理提示同点位已生产验证);v1 没有读子会话全文的通道,再薄模型没法整合 */
export const BG_SUMMARY_LIMIT = 2000;
/** failed 通知的错误信息上限(错误摘要够路由决策,不需长文) */
export const BG_ERROR_LIMIT = 200;

export interface ChildOutcome {
  childMissionId: string;
  childTitle: string;
  parentMissionId: string;
  outcome: 'done' | 'failed';
  /** finalAnswer(done)/ errorMsg(failed)原文,未截断 */
  detail?: string;
}

export interface BackgroundNotifyDeps {
  /** 父 mission 是否有在飞轮次(runInflight 为事实源) */
  isParentRunning: (parentId: string) => boolean;
  /** 父在飞:塞进父的 bgNotices 队列,下一个 prepareStep 边界注入。返回 false = 运行时把手已删(收尾竞态),调用方转唤醒 */
  enqueueNotice: (parentId: string, text: string) => boolean;
  /** 父不在飞(或入队失败):派发唤醒续轮(skipUserStep,复用轮末兜底模式) */
  wakeParent: (parentId: string, text: string) => void;
  /** 父会话插通知气泡并广播落库(幂等:step id 含 childMissionId) */
  appendBubble: (o: ChildOutcome, summary?: string) => void;
  /** 解锁父任务的 DONE push 去重(整合了子任务结果的下一次父完成值得再推) */
  unlockParentPush: (parentId: string) => void;
  log?: (msg: string) => void;
}

/** 结果摘要截断(done 2000 / failed 200);空文本返回 undefined */
export function truncateChildDetail(detail: string | undefined, outcome: 'done' | 'failed'): string | undefined {
  const text = (detail || '').trim();
  if (!text) return undefined;
  const limit = outcome === 'done' ? BG_SUMMARY_LIMIT : BG_ERROR_LIMIT;
  return text.length > limit ? `${text.slice(0, limit)}…(已截断)` : text;
}

/** 回注给模型的通知文本(不带前缀,由注入通道/唤醒派发处加) */
export function buildChildNoticeText(o: ChildOutcome, summary?: string): string {
  if (o.outcome === 'done') {
    return `子任务「${o.childTitle}」已完成。结果摘要:\n${summary || '(无文本结果,子任务详情可在会话中查看)'}\n请把上述结果整合进当前任务继续;不要重复派发同一子任务。`;
  }
  return `子任务「${o.childTitle}」执行失败。错误信息:${summary || '未知错误'}\n请视情况改用其他方案继续或向用户说明失败原因;不要原样重复派发。`;
}

/** 父会话通知气泡步骤形态:无 role/tool/answer,不会被 legacy-final 判定误收;id 含 childMissionId 幂等 */
export function buildBgNoticeStep(o: ChildOutcome, summary?: string): MissionStep {
  return {
    id: `step_bg_${o.childMissionId}`,
    title: o.outcome === 'done' ? `后台任务已完成: ${o.childTitle}` : `后台任务失败: ${o.childTitle}`,
    status: o.outcome === 'done' ? 'DONE' : 'FAILED',
    bgNotice: {
      childMissionId: o.childMissionId,
      childTitle: o.childTitle,
      outcome: o.outcome,
      summary,
    },
  };
}

/**
 * 投递一次子任务收尾。notifiedChildren 由调用方(AgentBackend 单例)持有,
 * 终生按 childMissionId 去重(仿 pushedDoneMissions):done/error 双路可能对
 * 同一子任务重复到达,只投第一次。
 *
 * 顺序讲究:先气泡(此刻 push 去重集仍含父 id,父已 DONE 时气泡广播不会
 * 触发误推)→ 再解锁 push → 最后路由:父在飞 → 入队步边界注入(把手已删
 * 则转唤醒,runMission 在飞判定会把它收进 steering 队列,天然收敛);
 * 父不在飞 → 唤醒续轮。JS 单线程,deps 各步之间无 await,无入队/删把手竞态。
 */
export function deliverChildOutcome(
  o: ChildOutcome,
  deps: BackgroundNotifyDeps,
  notifiedChildren: Set<string>
): void {
  if (notifiedChildren.has(o.childMissionId)) return;
  notifiedChildren.add(o.childMissionId);
  // 控制集合大小(仿 pushedDoneMissions :1125-1127):保留最近 250 条
  if (notifiedChildren.size > 500) {
    for (const id of [...notifiedChildren].slice(0, notifiedChildren.size - 250)) {
      notifiedChildren.delete(id);
    }
  }

  const summary = truncateChildDetail(o.detail, o.outcome);
  deps.appendBubble(o, summary);
  deps.unlockParentPush(o.parentMissionId);
  const text = buildChildNoticeText(o, summary);

  if (deps.isParentRunning(o.parentMissionId) && deps.enqueueNotice(o.parentMissionId, text)) {
    deps.log?.(
      `[Background] 子任务「${o.childTitle}」${o.outcome === 'done' ? '完成' : '失败'},通知已入队待父任务步边界注入`
    );
    return;
  }
  deps.wakeParent(o.parentMissionId, text);
  deps.log?.(`[Background] 子任务「${o.childTitle}」${o.outcome === 'done' ? '完成' : '失败'},已派发父任务唤醒轮`);
}
