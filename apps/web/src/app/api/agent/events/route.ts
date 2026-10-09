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
        // 如果未登录，终端日志与视口状态保持清空
        terminalLogs: userId ? backend.state.terminalLogs : [],
        approvalRequests: userId ? backend.state.approvalRequests : [],
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
          // 记忆库更新（会话结束自动沉淀）按用户过滤
          if (event.type === 'memories_updated') {
            if (!userId || event.data?.userId !== userId) {
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
