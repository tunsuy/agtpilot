import { NextResponse } from 'next/server';
import { getAgentBackend } from '@/lib/agent-backend';
import { auth } from '@/auth';
import { getUserMissions } from '@/lib/user-store';

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
  if (userId) {
    const persistedMissions = getUserMissions(userId);
    const activeMemoryMissions = backend.state.missions.filter((m) => m.userId === userId);
    const activeIds = new Set(activeMemoryMissions.map((m) => m.id));
    scopedMissions = [
      ...activeMemoryMissions,
      ...persistedMissions.filter((m) => !activeIds.has(m.id)),
    ];
  }

  const activeMissionId = userId
    ? (scopedMissions.find((m) => m.id === backend.state.activeMissionId) ? backend.state.activeMissionId : (scopedMissions[0]?.id || null))
    : null;

  const userScopedState = {
    ...backend.state,
    missions: scopedMissions,
    activeMissionId,
    terminalLogs: userId ? backend.state.terminalLogs : [],
    // 挂起审批按归属过滤，与 events 路由同规则，避免串台/泄露
    approvalRequests: userId
      ? backend.state.approvalRequests.filter((r) => !r.userId || r.userId === userId)
      : [],
    // 授权建议卡片按用户过滤（id 形如 `${userId}::${connectorId}`）
    connectorSuggestions: userId
      ? backend.state.connectorSuggestions.filter((s) => s.id.startsWith(`${userId}::`))
      : [],
  };

  return NextResponse.json({
    success: true,
    state: userScopedState,
  });
}
