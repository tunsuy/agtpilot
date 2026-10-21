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

/** 巡航会话标题前缀(agent-backend 两条巡航触发路径统一拼装) */
export const CRUISE_TITLE_PREFIX = '【自动巡航】';

/**
 * 巡航会话判定(docs/design/cruise-session-split.md):结构化标记 cronJobId
 * 为唯一事实源;旧数据无该字段,按标题前缀兜底识别(零迁移)。
 * 纯谓词,服务端(下行分流/持久化分窗)与客户端(列表过滤/广播路由)共用。
 */
export function isCronMission(m: any): boolean {
  if (!m || typeof m !== 'object') return false;
  if (typeof m.cronJobId === 'string' && m.cronJobId.trim()) return true;
  return typeof m.title === 'string' && m.title.startsWith(CRUISE_TITLE_PREFIX);
}

/**
 * 巡航会话 → 执行历史行(state/init 的 cronRuns 下行)。
 * 与 toWireMission 的终态摘要不同:任何状态都只发元信息(不带 steps/artifact
 * 正文),巡航中心列表渲染够用,详情走 /api/agent/mission/[id] 懒回水。
 * hasErrorStep 复用 toWireMission 同款尾步判定(已算好的 stripped 行直接沿用)。
 */
export function toCronRunMeta(m: any): any {
  const hasErrorStep =
    typeof m?.hasErrorStep === 'boolean'
      ? m.hasErrorStep
      : Array.isArray(m?.steps) &&
        m.steps.some((s: any) => typeof s?.id === 'string' && s.id.startsWith('step_err_'));
  return {
    id: m.id,
    ...(m.cronJobId ? { jobId: m.cronJobId } : {}),
    title: m.title,
    status: m.status,
    startedAt: m.startedAt,
    hasErrorStep,
    hasArtifact: Boolean(m.artifact?.content),
  };
}

/** 巡航执行历史行下行上限(纯元信息,轻量) */
export const CRON_RUNS_WIRE_CAP = 100;
/** 巡航交付物摘要行下行上限(含 artifact 正文,交付库/素材选择器跨会话消费) */
export const CRON_DELIVERABLES_WIRE_CAP = 50;

/**
 * state/init 下行分流(docs/design/cruise-session-split.md):merged 为内存 +
 * 持久化合并去重后的该用户全量会话。手动会话 → toWireMission 进工作台
 * missions;巡航会话不再进工作台,拆成两路轻量投影:
 * - cronRuns:执行历史行(巡航中心任务卡「最近执行」消费);
 * - cronDeliverables:终态且带交付物正文的摘要行(交付库/工坊素材消费)。
 *   ACTIVE 巡航会话的交付物随会话演进,不进静态索引,DONE 后经广播补入。
 */
export function splitMissionsForWire(merged: any[]): {
  missions: any[];
  cronRuns: any[];
  cronDeliverables: any[];
} {
  const manual: any[] = [];
  const cron: any[] = [];
  for (const m of merged) {
    if (isCronMission(m)) cron.push(m);
    else manual.push(m);
  }
  cron.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
  return {
    missions: manual.map(toWireMission),
    cronRuns: cron.slice(0, CRON_RUNS_WIRE_CAP).map(toCronRunMeta),
    cronDeliverables: cron
      .filter((m) => TERMINAL_STATUSES.has(m.status) && m.artifact?.content)
      .slice(0, CRON_DELIVERABLES_WIRE_CAP)
      .map(toWireMission),
  };
}
