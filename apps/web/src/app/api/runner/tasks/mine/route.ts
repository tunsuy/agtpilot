import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { getRunnerTasks } from '@/lib/runner-bridge';
import { summarizeRunnerTask } from '@/lib/runner-dispatch';

/**
 * GET /api/runner/tasks/mine(会话侧)
 * 当前用户的任务概览(机会卡状态徽章 + 派发弹窗 + 设备页任务列表刷新用)。
 * 只回摘要字段 + 最近一条进展(runner 上行事件的单行摘要),完整事件
 * 时间线走 /api/runner/tasks/detail(列表场景省流量)。
 */
export async function GET() {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ success: false, error: 'Unauthorized: 请先登录' }, { status: 401 });
    }
    const tasks = getRunnerTasks(session.user.id).map(summarizeRunnerTask);
    return NextResponse.json({ success: true, tasks });
  } catch (e: any) {
    return NextResponse.json({ success: false, error: e?.message || String(e) }, { status: 500 });
  }
}
