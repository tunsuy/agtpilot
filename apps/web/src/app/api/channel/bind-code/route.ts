import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { createBindCode } from '@/lib/channel-store';

/**
 * 生成 IM 绑定码(6 位数字,10 分钟 TTL,单次消费)。
 * 用户在任意已接入通道(公众号/个人微信/QQ)对机器人发「绑定 <码>」完成身份绑定。
 */
export async function POST() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }
  try {
    const code = createBindCode(session.user.id);
    return NextResponse.json({
      success: true,
      code,
      expiresInMinutes: 10,
      usage: `在 IM 里对机器人发送: 绑定 ${code}`,
    });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err?.message || '生成失败' }, { status: 500 });
  }
}
