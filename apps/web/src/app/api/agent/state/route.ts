import { NextResponse } from 'next/server';
import { getAgentBackend } from '@/lib/agent-backend';
import { auth } from '@/auth';
import { getUserMissions } from '@/lib/user-store';
import { splitMissionsForWire } from '@/lib/mission-wire';

export async function GET() {
  const session = await auth();
  const userId = session?.user?.id;

  const backend = getAgentBackend();

  // runner_publish 审批重灌(M3):卡片是内存态、审批单持久在 runner 存储,
  // 服务重启后这里按登录用户重新灌入(silent 不广播,幂等去重)
  if (userId) {
    try {
      const { listPendingRunnerApprovalRequests } = await import('@/lib/runner-bridge');
      for (const req of listPendingRunnerApprovalRequests(userId)) {
        backend.registerRunnerApproval(req, { silent: true });
      }
    } catch {
      // runner 存储不可读不阻塞主状态返回
    }
  }

  let scopedMissions: any[] = [];
  let cronRuns: any[] = [];
  let cronDeliverables: any[] = [];
  if (userId) {
    const persistedMissions = getUserMissions(userId);
    const activeMemoryMissions = backend.state.missions.filter((m) => m.userId === userId);
    const activeIds = new Set(activeMemoryMissions.map((m) => m.id));
    // 首屏瘦身(lib/mission-wire.ts):终态历史会话只发摘要,选中再懒回水;
    // conversationMessages 一律不下发(前端零消费,续聊回水走服务端持久化库)。
    // 巡航会话分流(docs/design/cruise-session-split.md):工作台 missions 只装
    // 手动会话;巡航拆成执行历史行 + 交付物摘要两路轻量投影
    const split = splitMissionsForWire([
      ...activeMemoryMissions,
      ...persistedMissions.filter((m) => !activeIds.has(m.id)),
    ]);
    scopedMissions = split.missions;
    cronRuns = split.cronRuns;
    cronDeliverables = split.cronDeliverables;
  }

  const activeMissionId = userId
    ? (scopedMissions.find((m) => m.id === backend.state.activeMissionId) ? backend.state.activeMissionId : (scopedMissions[0]?.id || null))
    : null;

  const userScopedState = {
    ...backend.state,
    missions: scopedMissions,
    activeMissionId,
    // 巡航会话分流下行(docs/design/cruise-session-split.md):执行历史行 +
    // 交付物摘要,巡航中心与交付库/素材选择器各自消费
    cronRuns,
    cronDeliverables,
    terminalLogs: userId ? backend.state.terminalLogs : [],
    // 挂起审批按归属过滤，与 events 路由同规则，避免串台/泄露
    approvalRequests: userId
      ? backend.state.approvalRequests.filter((r) => !r.userId || r.userId === userId)
      : [],
    // 授权建议卡片按用户过滤（id 形如 `${userId}::${connectorId}`）
    connectorSuggestions: userId
      ? backend.state.connectorSuggestions.filter((s) => s.id.startsWith(`${userId}::`))
      : [],
    // ask_user 问题卡按归属过滤(刷新页面卡片不丢,与审批卡同级保证)
    pendingQuestions: userId
      ? backend.state.pendingQuestions.filter((q) => !q.userId || q.userId === userId)
      : [],
  };

  return NextResponse.json({
    success: true,
    state: userScopedState,
  });
}
