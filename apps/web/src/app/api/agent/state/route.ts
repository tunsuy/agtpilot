import { NextResponse } from 'next/server';
import { getAgentBackend } from '@/lib/agent-backend';
import { auth } from '@/auth';
import { getUserMissions } from '@/lib/user-store';

export async function GET() {
  const session = await auth();
  const userId = session?.user?.id;

  const backend = getAgentBackend();

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
    approvalRequests: userId ? backend.state.approvalRequests : [],
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
