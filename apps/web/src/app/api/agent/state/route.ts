import { NextResponse } from 'next/server';
import { getAgentBackend } from '@/lib/agent-backend';
import { auth } from '@/auth';
import { buildUserScopedState } from '@/lib/state-scoping';

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

  // 按归属投影(与 SSE init 帧同源同规则,见 lib/state-scoping.ts —— 此前这里
  // 手抄了一份且漏掉 terminalLogs/viewport/latestArtifact 的归属过滤,
  // 登录用户能拿到全量终端日志与他人产物)
  const userScopedState = buildUserScopedState(backend.state, userId);

  return NextResponse.json({
    success: true,
    state: userScopedState,
  });
}
