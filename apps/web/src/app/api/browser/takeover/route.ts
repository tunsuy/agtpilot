import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import { getAgentBackend } from '@/lib/agent-backend';
import {
  startTakeover,
  subscribeTakeoverEvents,
  sendTakeoverInput,
  stopTakeover,
  getTakeoverSession,
  type TakeoverDeps,
  type TakeoverEvent,
  type TakeoverInput,
  type TakeoverPageLike,
} from '@/lib/browser-takeover';

export const dynamic = 'force-dynamic';

/** 真实环境依赖:plugin-browser 的 ctx.browser(与登录/任务工具共享同一 Page) */
async function realDeps(): Promise<TakeoverDeps> {
  const backend = getAgentBackend();
  await backend.whenReady();
  const browser = backend.ctx?.browser as
    | { acquirePage(userId?: string): Promise<TakeoverPageLike> }
    | undefined;
  if (!browser) {
    throw new Error('浏览器服务未就绪(plugin-browser 未加载或未启动完成)');
  }
  return { browser };
}

/** POST:发起接管会话(?url= 可选初始导航;同用户已有会话 → 409 带既有 sessionId) */
export async function POST(req: NextRequest) {
  try {
    const session = await auth();
    const userId = session?.user?.id;
    if (!userId) {
      return NextResponse.json({ success: false, error: 'Unauthorized: 请先登录' }, { status: 401 });
    }

    let deps: TakeoverDeps;
    try {
      deps = await realDeps();
    } catch (err: any) {
      return NextResponse.json({ success: false, error: err.message }, { status: 503 });
    }

    // 软避让:该用户有进行中的任务时不硬拦,但提示共享同一 Page 的风险
    const backend = getAgentBackend();
    const hasActiveMission = backend.state.missions.some(
      (m) => m.userId === userId && m.status === 'ACTIVE'
    );

    const url = req.nextUrl.searchParams.get('url') || undefined;
    const result = startTakeover(userId, deps, { url });
    if ('conflict' in result) {
      return NextResponse.json(
        { success: false, error: '已有进行中的接管会话', sessionId: result.sessionId },
        { status: 409 }
      );
    }
    return NextResponse.json({ success: true, sessionId: result.sessionId, hasActiveMission });
  } catch (err: any) {
    console.error('Error in POST /api/browser/takeover:', err);
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}

/** GET:接管会话的 SSE 事件流(?sessionId=;晚连自动补放最近 nav + 最近一帧) */
export async function GET(req: NextRequest) {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) {
    return NextResponse.json({ success: false, error: 'Unauthorized: 请先登录' }, { status: 401 });
  }

  const sessionId = req.nextUrl.searchParams.get('sessionId') || '';
  const info = getTakeoverSession(sessionId);
  if (!info || info.userId !== userId) {
    return NextResponse.json({ success: false, error: '接管会话不存在或无权访问' }, { status: 404 });
  }

  const encoder = new TextEncoder();
  let teardown: (() => void) | null = null;

  const stream = new ReadableStream({
    start(controller) {
      let closed = false;
      const send = (e: TakeoverEvent) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`));
          if (e.type === 'done') {
            closed = true;
            // 终态必发后关流(SSE 契约)
            setTimeout(() => {
              try {
                controller.close();
              } catch {}
              teardown?.();
            }, 100);
          }
        } catch {
          closed = true;
        }
      };

      const unsubscribe = subscribeTakeoverEvents(sessionId, send);
      if (!unsubscribe) {
        // 会话恰好在订阅前被清理:补发 done 收口,流不悬空
        send({ type: 'done', outcome: 'stopped', detail: '会话已结束', ts: Date.now() });
        return;
      }

      // 保活注释帧(防中间层掐断空闲连接)
      const keepalive = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(': keepalive\n\n'));
        } catch {
          closed = true;
        }
      }, 15000);

      teardown = () => {
        clearInterval(keepalive);
        unsubscribe();
      };
    },
    cancel() {
      // 订阅方断开(关页/离开);会话本体保留(idle 看门狗兜底,可断线重连)
      teardown?.();
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

/** PUT:转发一条输入事件(body: { sessionId, input }) */
export async function PUT(req: NextRequest) {
  try {
    const session = await auth();
    const userId = session?.user?.id;
    if (!userId) {
      return NextResponse.json({ success: false, error: 'Unauthorized: 请先登录' }, { status: 401 });
    }

    const body = await req.json().catch(() => null);
    const sessionId = body?.sessionId;
    const input = body?.input as TakeoverInput | undefined;
    if (!sessionId || !input || typeof input.type !== 'string') {
      return NextResponse.json({ success: false, error: '参数缺失' }, { status: 400 });
    }

    const info = getTakeoverSession(sessionId);
    if (!info || info.userId !== userId) {
      return NextResponse.json({ success: false, error: '接管会话不存在或无权访问' }, { status: 404 });
    }

    const r = await sendTakeoverInput(sessionId, input);
    return NextResponse.json(r, { status: r.ok ? 200 : 400 });
  } catch (err: any) {
    console.error('Error in PUT /api/browser/takeover:', err);
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}

/** DELETE:结束接管(?sessionId=;浏览器与页面状态保留,后续任务/接管复用) */
export async function DELETE(req: NextRequest) {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) {
    return NextResponse.json({ success: false, error: 'Unauthorized: 请先登录' }, { status: 401 });
  }
  const sessionId = req.nextUrl.searchParams.get('sessionId') || '';
  const info = getTakeoverSession(sessionId);
  if (!info || info.userId !== userId) {
    return NextResponse.json({ success: false, error: '接管会话不存在或无权访问' }, { status: 404 });
  }
  const ok = stopTakeover(sessionId);
  return NextResponse.json({ success: ok, message: ok ? '已结束接管' : '会话已结束' });
}
