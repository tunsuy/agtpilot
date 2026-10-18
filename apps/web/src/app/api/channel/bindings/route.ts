import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import { listBindingsForUser, deleteBinding } from '@/lib/channel-store';

/** 当前用户的 IM 身份绑定列表。 */
export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }
  return NextResponse.json({ success: true, bindings: listBindingsForUser(session.user.id) });
}

/** 解绑:body {channel, externalUserId}(仅能解自己的绑定)。 */
export async function DELETE(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }
  const { channel, externalUserId } = await req.json().catch(() => ({}));
  if (!channel || !externalUserId) {
    return NextResponse.json({ success: false, error: 'channel 与 externalUserId 必填' }, { status: 400 });
  }
  const mine = listBindingsForUser(session.user.id).some(
    (b) => b.channel === channel && b.externalUserId === externalUserId,
  );
  if (!mine) {
    return NextResponse.json({ success: false, error: '绑定不存在或不属于当前用户' }, { status: 404 });
  }
  const removed = deleteBinding(channel, externalUserId);
  return NextResponse.json({ success: removed });
}
