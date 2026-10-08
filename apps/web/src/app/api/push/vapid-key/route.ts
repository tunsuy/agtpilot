import { NextResponse } from 'next/server';
import { getVapidKeys } from '@/lib/vapid';

/**
 * GET /api/push/vapid-key
 * 返回 VAPID 公钥，供前端 PushManager.subscribe 使用。
 * 公钥本身不敏感，无需登录即可获取。
 */
export async function GET() {
  try {
    const { publicKey } = getVapidKeys();
    return NextResponse.json({ success: true, publicKey });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
