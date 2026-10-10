import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import { getAgentBackend } from '@/lib/agent-backend';
import { markXhsLoginAt } from '@/lib/user-store';
import {
  LOGIN_POLL_INTERVAL_MS,
  LOGIN_TIMEOUT_MS,
  startBrowserLogin,
  subscribeLoginEvents,
  cancelBrowserLogin,
  getLoginSession,
  type LoginDeps,
  type LoginEvent,
} from '@/lib/browser-login';

export const dynamic = 'force-dynamic';

/** 真实环境依赖:plugin-browser 的 ctx.browser + user-store 登录时间落盘 */
async function realDeps(): Promise<LoginDeps> {
  const backend = getAgentBackend();
  await backend.whenReady();
  const browser = backend.ctx?.browser as LoginDeps['browser'];
  if (!browser) {
    throw new Error('浏览器服务未就绪(plugin-browser 未加载或未启动完成)');
  }
  return {
    browser,
    onLoginSuccess: (userId) => {
      markXhsLoginAt(userId);
    },
    pollIntervalMs: LOGIN_POLL_INTERVAL_MS,
    timeoutMs: LOGIN_TIMEOUT_MS,
  };
}

/** POST:发起登录会话(同用户已有进行中会话 → 409 带既有 sessionId) */
export async function POST() {
  try {
    const session = await auth();
    const userId = session?.user?.id;
    if (!userId) {
      return NextResponse.json({ success: false, error: 'Unauthorized: 请先登录' }, { status: 401 });
    }

    let deps: LoginDeps;
    try {
      deps = await realDeps();
    } catch (err: any) {
      return NextResponse.json({ success: false, error: err.message }, { status: 503 });
    }

    // 软避让:该用户有进行中的任务时不硬拦,但在首个 status 里提示风险(共享同一 Page)
    const backend = getAgentBackend();
    const hasActiveMission = backend.state.missions.some(
      (m) => m.userId === userId && m.status === 'ACTIVE'
    );

    const result = startBrowserLogin(userId, deps);
    if ('conflict' in result) {
      return NextResponse.json(
        { success: false, error: '已有进行中的登录会话', sessionId: result.sessionId },
        { status: 409 }
      );
    }
    return NextResponse.json({ success: true, sessionId: result.sessionId, hasActiveMission });
  } catch (err: any) {
    console.error('Error in POST /api/browser/login:', err);
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}

/** GET:登录会话的 SSE 事件流(?sessionId=;晚连自动补放历史 status + 最近一帧) */
export async function GET(req: NextRequest) {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) {
    return NextResponse.json({ success: false, error: 'Unauthorized: 请先登录' }, { status: 401 });
  }

  const sessionId = req.nextUrl.searchParams.get('sessionId') || '';
  const info = getLoginSession(sessionId);
  if (!info || info.userId !== userId) {
    return NextResponse.json({ success: false, error: '登录会话不存在或无权访问' }, { status: 404 });
  }

  const encoder = new TextEncoder();
  let teardown: (() => void) | null = null;

  const stream = new ReadableStream({
    start(controller) {
      let closed = false;
      const send = (e: LoginEvent) => {
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
          // 连接已关闭
          closed = true;
        }
      };

      const unsubscribe = subscribeLoginEvents(sessionId, send);
      if (!unsubscribe) {
        // 会话恰好在订阅前被清理:补发 done 收口,流不悬空
        send({ type: 'done', outcome: 'timeout', detail: '会话已结束', ts: Date.now() });
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
      // 订阅方断开(关弹窗/离开页面)
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

/** DELETE:取消进行中的登录会话(?sessionId=) */
export async function DELETE(req: NextRequest) {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) {
    return NextResponse.json({ success: false, error: 'Unauthorized: 请先登录' }, { status: 401 });
  }
  const sessionId = req.nextUrl.searchParams.get('sessionId') || '';
  const info = getLoginSession(sessionId);
  if (!info || info.userId !== userId) {
    return NextResponse.json({ success: false, error: '登录会话不存在或无权访问' }, { status: 404 });
  }
  const ok = cancelBrowserLogin(sessionId);
  return NextResponse.json({ success: ok, message: ok ? '已取消登录' : '会话已结束' });
}
