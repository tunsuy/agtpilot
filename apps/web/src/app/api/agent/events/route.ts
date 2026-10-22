import { getAgentBackend } from '@/lib/agent-backend';
import { auth } from '@/auth';
import { stripConversation } from '@/lib/mission-wire';
import { buildUserScopedState } from '@/lib/state-scoping';

export const dynamic = 'force-dynamic';

export async function GET() {
  const session = await auth();
  const userId = session?.user?.id;

  const backend = getAgentBackend();
  const encoder = new TextEncoder();

  let unsubscribe: (() => void) | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  const stream = new ReadableStream({
    start(controller) {
      // 心跳保活：代理/负载均衡会掐断静默连接，EventSource 到 TCP 超时才发现
      // （可达分钟级），期间广播的审批卡片等事件全部丢失——卡片"迟到"的主因。
      // 25s 一帧「具名 ping 事件」（不是注释行）：注释行 EventSource 的 JS API
      // 听不见，客户端无法区分「没事件可推」和「连接已假死」；具名事件让客户端
      // 看门狗能据此检测静默并主动重连（生产实测：连接半死不触发 onerror，
      // 续聊的工具卡/最终答复/完成态全部丢失，页面冻在最后一帧）
      heartbeatTimer = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(`event: ping\ndata: ${Date.now()}\n\n`));
        } catch {
          // 连接已关闭，忽略
        }
      }, 25_000);

      // 1. 发送初始化状态:未登录不给任何历史数据;登录则按归属投影
      // (规则细节与 state 兜底接口同源,见 lib/state-scoping.ts)。
      // 帧内回显 userId(本连接实际认证到的身份):客户端 SSE 已改为挂载即连
      // (不等 useSession,省一个 RTT),靠它对账决定登录/登出后是否重建连接
      const userScopedState = buildUserScopedState(backend.state, userId);

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
          // token 用量实时更新（轻量事件只带 taskId + 累计 usage）：按归属用户过滤
          if (event.type === 'mission_usage') {
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
          // 产物事件按归属 mission 过滤:latestArtifact 是全局单例槽(最后一个
          // 产物,不分用户),不过滤会把 A 用户的产物弹进 B 用户的成果面板
          // (匿名连接同样收不到)。归属不明的孤儿帧(无 taskId / mission 不在
          // 内存)直接丢弃 —— 归属者仍经 mission_updated(mission.artifact)拿到
          if (event.type === 'artifact_updated') {
            const tid = event.data?.taskId;
            const owner = tid
              ? backend.state.missions.find((m) => m.id === tid)?.userId
              : undefined;
            if (!userId || !owner || owner !== userId) {
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
          // ask_user 问题卡(提问/裁决)按归属用户过滤,防串台/泄露
          if (event.type === 'question_asked' || event.type === 'question_resolved') {
            const owner = event.data?.userId as string | undefined;
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
          // live 帧瘦身:mission 全量对象含 conversationMessages(整段 LLM 对话,
          // 含工具结果),前端零消费 —— 只剥它,steps/terminalLogs/viewport 保留
          // (实时渲染需要)。落盘在 backend.broadcast() 已先行完成,不受影响
          const wireData =
            event.type === 'mission_updated' || event.type === 'mission_created'
              ? stripConversation(event.data)
              : event.data;
          const sseEvent = `event: ${event.type}\ndata: ${JSON.stringify(wireData)}\n\n`;
          controller.enqueue(encoder.encode(sseEvent));
        } catch {
          // ignore write errors on closed connection
        }
      });
    },
    cancel() {
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
      }
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
