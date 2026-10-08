import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import { addUserPushSubscription, removeUserPushSubscription } from '@/lib/user-store';

/**
 * POST /api/push/subscribe
 * 保存当前登录用户的 Push 订阅（PWA 添加到主屏幕后由前端采集）。
 * body: { subscription: PushSubscriptionJSON } 或 { action: 'unsubscribe', endpoint }
 */
export async function POST(req: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ success: false, error: 'Unauthorized: 请先登录' }, { status: 401 });
    }
    const userId = session.user.id;
    const body = await req.json();

    if (body?.action === 'unsubscribe' && body?.endpoint) {
      const subs = removeUserPushSubscription(userId, body.endpoint);
      return NextResponse.json({ success: true, total: subs.length });
    }

    const sub = body?.subscription;
    if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) {
      return NextResponse.json({ success: false, error: 'Invalid subscription payload' }, { status: 400 });
    }

    const subs = addUserPushSubscription(userId, {
      endpoint: sub.endpoint,
      keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth },
      userAgent: (req.headers.get('user-agent') || '').slice(0, 200),
      createdAt: Date.now(),
    });

    return NextResponse.json({ success: true, total: subs.length });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
