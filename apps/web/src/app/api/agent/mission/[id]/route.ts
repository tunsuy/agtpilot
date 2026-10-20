import { NextResponse } from 'next/server';
import { getAgentBackend } from '@/lib/agent-backend';
import { auth } from '@/auth';
import { getUserMissions } from '@/lib/user-store';
import { stripConversation } from '@/lib/mission-wire';

/**
 * 单条会话全量懒回水(首屏瘦身配套,lib/mission-wire.ts):
 * state/init 只发终态历史会话的摘要(stripped),用户选中某条会话时前端
 * 打这里拿全量 steps/terminalLogs/viewport 回填。
 *
 * 取数顺序:内存活引用优先(含最新进度,比如刚被续聊唤醒的会话),
 * 其次持久化库。两路都做归属校验(只回本人会话)。
 * conversationMessages 不下发:前端零消费,续聊回水走服务端持久化库。
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) {
    return NextResponse.json({ success: false, error: 'unauthorized' }, { status: 401 });
  }

  const { id } = await params;
  if (!id) {
    return NextResponse.json({ success: false, error: 'missing id' }, { status: 400 });
  }

  const backend = getAgentBackend();
  let mission = backend.state.missions.find((m) => m.id === id && m.userId === userId);
  if (!mission) {
    // 持久化库路径:getUserMissions 已按 userId 取,天然只有本人数据
    mission = getUserMissions(userId).find((m) => m.id === id);
  }
  if (!mission) {
    return NextResponse.json({ success: false, error: 'not found' }, { status: 404 });
  }

  // stripConversation 返回浅拷贝,不会把内存活引用的 conversationMessages 摘掉
  return NextResponse.json({ success: true, mission: stripConversation(mission) });
}
