import type { AgentBackendState } from './agent-backend';
import { getUserMissions } from './user-store';
import { splitMissionsForWire } from './mission-wire';

/**
 * 把全局 backend 状态投影成「按连接用户隔离」的下行帧 —— SSE init
 * (api/agent/events) 与兜底接口 (api/agent/state) 共用,保证两处规则永远同源。
 * 此前两条路由各手抄一份,state 侧漏掉了 terminalLogs/viewport 的归属过滤
 * (登录用户能拿到全量终端日志),这类漂移正是抽公共函数的理由。
 *
 * 隔离规则:
 * - missions:内存 active 任务 + 持久化历史合并;终态会话只带摘要(stripped,
 *   选中时经 /api/agent/mission/[id] 懒回水);巡航会话分流成执行历史行
 *   (cronRuns) + 交付物摘要(cronDeliverables) 两路轻量投影
 *   (docs/design/cruise-session-split.md)
 * - terminalLogs / approvalRequests / pendingQuestions:按归属过滤,
 *   未标记 userId 的全局系统条目放行
 * - connectorSuggestions:id 形如 `${userId}::${connectorId}`,按前缀过滤
 * - viewport:浏览器自动化是单例,他人占用时下发空白默认(不泄露截图/URL)
 * - latestArtifact:全局单例槽(最后一个产物,不分用户)——按 taskId 归属
 *   mission 的 userId 判定,归属不明(无 taskId / mission 已不在内存)不下发;
 *   归属者仍能从 mission.artifact(mission_updated / 懒回水)拿到,不丢数据
 * - userId:本连接服务端实际认证到的身份回显。客户端 SSE 挂载即连
 *   (不等 useSession 解析,省一个 RTT),靠它与会话对账:不一致
 *   (页面存活期间登录/登出/换号)才拆线重建,避免首帧解析必重连、
 *   全量 init 白下载两遍
 *
 * viewportUserId 属内部字段(视口占用者身份),不随帧下发。
 */
export function buildUserScopedState(
  backendState: AgentBackendState,
  userId: string | null | undefined
) {
  let scopedMissions: any[] = [];
  let cronRuns: any[] = [];
  let cronDeliverables: any[] = [];
  if (userId) {
    const persistedMissions = getUserMissions(userId);
    const activeMemoryMissions = backendState.missions.filter((m) => m.userId === userId);
    // 合并:优先取 active 内存中的任务(包含最新进度),其余取持久化历史
    const activeIds = new Set(activeMemoryMissions.map((m) => m.id));
    const split = splitMissionsForWire([
      ...activeMemoryMissions,
      ...persistedMissions.filter((m: any) => !activeIds.has(m.id)),
    ]);
    scopedMissions = split.missions;
    cronRuns = split.cronRuns;
    cronDeliverables = split.cronDeliverables;
  }

  const activeMissionId = userId
    ? scopedMissions.find((m) => m.id === backendState.activeMissionId)
      ? backendState.activeMissionId
      : scopedMissions[0]?.id || null
    : null;

  // latestArtifact 归属判定(见文件头注释):只有 taskId 归属 mission 在内存
  // 且属于本用户时才下发
  const la = backendState.latestArtifact;
  const laMission =
    la && typeof la === 'object' && (la as any).taskId
      ? backendState.missions.find((m) => m.id === (la as any).taskId)
      : null;
  const latestArtifact = userId && laMission && laMission.userId === userId ? la : undefined;

  const { viewportUserId, latestArtifact: _la, ...rest } = backendState;

  return {
    ...rest,
    userId: userId ?? null,
    missions: scopedMissions,
    activeMissionId,
    cronRuns,
    cronDeliverables,
    terminalLogs: userId
      ? backendState.terminalLogs.filter((l) => !l.userId || l.userId === userId)
      : [],
    approvalRequests: userId
      ? backendState.approvalRequests.filter((r) => !r.userId || r.userId === userId)
      : [],
    connectorSuggestions: userId
      ? backendState.connectorSuggestions.filter((s) => s.id.startsWith(`${userId}::`))
      : [],
    pendingQuestions: userId
      ? backendState.pendingQuestions.filter((q) => !q.userId || q.userId === userId)
      : [],
    viewport:
      !userId || (viewportUserId && viewportUserId !== userId)
        ? { activeTab: 'browser' as const, url: 'about:blank', title: 'Ready', status: 'idle' as const }
        : backendState.viewport,
    latestArtifact,
  };
}
