import { getAgentBackend } from '@/lib/agent-backend';

export const dynamic = 'force-dynamic';

export async function GET() {
  const backend = getAgentBackend();
  const encoder = new TextEncoder();

  let unsubscribe: (() => void) | null = null;

  const stream = new ReadableStream({
    start(controller) {
      // 1. 发送初始化状态
      const initialPayload = `event: init\ndata: ${JSON.stringify(backend.state)}\n\n`;
      controller.enqueue(encoder.encode(initialPayload));

      // 2. 订阅后续实时增量事件
      unsubscribe = backend.subscribe((event) => {
        try {
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
