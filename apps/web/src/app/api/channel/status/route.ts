import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { getChannelManager } from '@/lib/channel-service';

/** 通道状态(运维/设置页):适配器连接状态 + 最近传输错误(已由适配器做密钥卫生)。 */
export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }
  const { ready, adapters, recentErrors } = getChannelManager().status();
  return NextResponse.json({ success: true, ready, adapters, recentErrors });
}
