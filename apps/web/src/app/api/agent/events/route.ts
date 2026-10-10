import { getAgentBackend } from '@/lib/agent-backend';
import { auth } from '@/auth';
import { getUserMissions } from '@/lib/user-store';

export const dynamic = 'force-dynamic';

export async function GET() {
  const session = await auth();
  const userId = session?.user?.id;

  const backend = getAgentBackend();
  const encoder = new TextEncoder();

  let unsubscribe: (() => void) | null = null;

  const stream = new ReadableStream({
    start(controller) {
      // 1. 发送初始化状态（如果未登录，则不发送任何历史任务；如果已登录，合并用户专属任务与内存中的进行中任务）
      let scopedMissions: any[] = [];
      if (userId) {
        const persistedMissions = getUserMissions(userId);
        const activeMemoryMissions = backend.state.missions.filter((m) => m.userId === userId);
        
        // 合并：优先取 active 内存中的任务（包含最新进度），其余取持久化历史
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
        // 终端日志按归属过滤（未标记 userId 的全局系统日志保留）
        terminalLogs: userId
          ? backend.state.terminalLogs.filter((l) => !l.userId || l.userId === userId)
          : [],
        // 挂起审批按归属过滤，避免串台/泄露
        approvalRequests: userId
          ? backend.state.approvalRequests.filter((r) => !r.userId || r.userId === userId)
          : [],
        // 视口（浏览器/终端画面）只在无人占用或归属本人时下发，否则给空白默认
        viewport:
          !userId || (backend.state.viewportUserId && backend.state.viewportUserId !== userId)
            ? { activeTab: 'browser', url: 'about:blank', title: 'Ready', status: 'idle' as const }
            : backend.state.viewport,
        // 授权建议卡片按用户过滤（id 形如 `${userId}::${connectorId}`）
        connectorSuggestions: userId
          ? backend.state.connectorSuggestions.filter((s) => s.id.startsWith(`${userId}::`))
          : [],
      };

      const initialPayload = `event: init\ndata: ${JSON.stringify(userScopedState)}\n\n`;
      controller.enqueue(encoder.encode(initialPayload));

      // 2. 订阅后续实时增量事件（过滤只推送给当前用户或未分配的全局通知）
      unsubscribe = backend.subscribe((event) => {
        try {
          if (event.type === 'mission_created' || event.type === 'mission_updated') {
            if (event.data?.userId && event.data.userId !== userId) {
              return; // 不推送其他用户的任务
            }
          }
          // 流式增量 / 步骤开始：按任务归属用户过滤（payload 带 userId）
          if (event.type === 'assistant_delta' || event.type === 'step_started') {
            if (!userId || event.data?.userId !== userId) {
              return;
            }
          }
          // 记忆库更新（会话结束自动沉淀）按用户过滤
          if (event.type === 'memories_updated') {
            if (!userId || event.data?.userId !== userId) {
              return;
            }
          }
          // 终端日志 / 视口画面 / 挂起审批：按归属用户过滤（未标记 userId 的全局日志放行）
          if (event.type === 'terminal_log' || event.type === 'viewport_update' || event.type === 'approval_requested') {
            const owner = (event.data?.userId ?? event.data?.entry?.userId) as string | undefined;
            if (!userId || (owner && owner !== userId)) {
              return;
            }
          }
          // 连接器授权建议卡片按用户过滤（id 形如 `${userId}::${connectorId}`）
          if (event.type === 'connector_suggested' || event.type === 'connector_suggestion_resolved') {
            const sid = String(event.data?.id || '');
            if (!userId || !sid.startsWith(`${userId}::`)) {
              return;
            }
          }
          const sseEvent = `event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`;
          controller.enqueue(encoder.encode(sseEvent));
        } catch {
          // ignore write errors on closed connection
        }
      });
    },
    cancel() {
      if (unsubscribe) {
        unsubscribe();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    },
  });
}
