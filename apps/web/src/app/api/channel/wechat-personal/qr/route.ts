import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import { getChannelManager } from '@/lib/channel-service';

/**
 * 微信个人号(iLink)扫码授权运维流。
 * POST      → 取登录二维码:{handle, qrContent}(qrContent 渲染成二维码图给负责人扫)
 * GET ?handle → 轮询授权状态;confirmed 时 bot_token 落 channel-store 并热挂载通道,
 *              token 绝不回显给前端(只返回状态)。
 */
export async function POST() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }
  try {
    const { handle, qrContent } = await getChannelManager().startWechatPersonalQr();
    return NextResponse.json({ success: true, handle, qrContent });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err?.message || '获取二维码失败' }, { status: 502 });
  }
}

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }
  const handle = req.nextUrl.searchParams.get('handle') || '';
  if (!handle) {
    return NextResponse.json({ success: false, error: 'handle 必填' }, { status: 400 });
  }
  try {
    const result = await getChannelManager().pollWechatPersonalQr(handle);
    return NextResponse.json({ success: true, ...result });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err?.message || '轮询失败' }, { status: 502 });
  }
}
