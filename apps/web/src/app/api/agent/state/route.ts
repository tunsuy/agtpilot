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
  };

  return NextResponse.json({
    success: true,
    state: userScopedState,
  });
}
