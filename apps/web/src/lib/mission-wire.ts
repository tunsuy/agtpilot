/**
 * 首屏瘦身:mission 下行投影(线上载荷 vs 持久化全量)。
 *
 * 背景(工作台首屏性能):/api/agent/state 与 SSE init 曾把最多 50 条历史
 * 会话的【完整对象】(conversationMessages 全量 LLM 对话 + steps 全部步骤
 * 输出 + terminalLogs 每会话 300 条 + viewport 截图)一次性下发,首屏要传
 * 数 MB~数十 MB;SSE init 又是单帧事件,整帧下载完前端才渲染 —— 用户
 * 首次进入工作台长时间只见「历史会话(0)」。
 *
 * 投影规则:
 * - conversationMessages 任何情况都不下发:前端零消费(全仓 grep 实证),
 *   续聊回水在服务端直接读持久化库(agent-backend restoreSession);
 * - 终态会话(DONE/INTERRUPTED)只发摘要:元信息 + artifact(交付库页
 *   跨会话消费)+ stepCount/hasErrorStep(列表 chip 判定),steps/
 *   terminalLogs/viewport 置空,选中时经 /api/agent/mission/[id] 懒回水;
 * - 活跃会话(ACTIVE/QUEUED/WAITING_APPROVAL)保留 steps/terminalLogs/
 *   viewport(实时渲染需要),仅剥 conversationMessages。
 *
 * 纪律:本模块只做【只读投影】,绝不修改传入的 mission 对象(可能是
 * backend.state.missions 的内存活引用),一律浅拷贝后删减。
 */

/** 终态状态集:与 Mission['status'] 枚举对齐(DONE/INTERRUPTED 不再变化) */
const TERMINAL_STATUSES = new Set(['DONE', 'INTERRUPTED']);

/** 剥掉会话历史(前端零消费;SSE live 帧与懒加载接口共用) */
export function stripConversation<T>(m: T): T {
  if (!m || typeof m !== 'object' || !('conversationMessages' in (m as any))) return m;
  const { conversationMessages: _drop, ...rest } = m as any;
  return rest as T;
}

/**
 * state/init 下行投影:终态 → 摘要(stripped 标记),活跃 → 全量减会话历史。
 * 返回新对象,不改原引用。
 */
export function toWireMission(m: any): any {
  if (!m || typeof m !== 'object') return m;
  if (!TERMINAL_STATUSES.has(m.status)) return stripConversation(m);

  const {
    conversationMessages: _c,
    steps,
    terminalLogs: _t,
    viewport: _v,
    ...rest
  } = m;
  return {
    ...rest,
    steps: [],
    /** 原始步骤数(占位展示/调试可观测) */
    stepCount: Array.isArray(steps) ? steps.length : 0,
    /**
     * 失败尾步判定前置计算:子任务 chip 的「失败」态靠 step_err_ 尾步识别
     * (childStatusMeta),摘要没有 steps,stripped 时改读本字段。
     */
    hasErrorStep: Array.isArray(steps)
      ? steps.some((s: any) => typeof s?.id === 'string' && s.id.startsWith('step_err_'))
      : false,
    stripped: true,
  };
}
