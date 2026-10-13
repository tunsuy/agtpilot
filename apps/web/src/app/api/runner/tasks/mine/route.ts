import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { getRunnerTasks } from '@/lib/runner-bridge';

/**
 * GET /api/runner/tasks/mine(会话侧)
 * 当前用户的任务概览(机会卡状态徽章 + 派发弹窗刷新用)。
 * 只回摘要字段,不回完整任务包与事件明细(列表场景省流量;明细 M4 审计视图再开)。
 */
export async function GET() {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ success: false, error: 'Unauthorized: 请先登录' }, { status: 401 });
    }
    const tasks = getRunnerTasks(session.user.id).map((t) => ({
      taskId: t.taskId,
      state: t.state,
      repo: t.pack.repo,
      issueUrl: t.pack.issueUrl,
      workBranch: t.pack.workBranch,
      prUrl: t.prUrl,
      error: t.error,
      updatedAt: t.updatedAt,
      deviceId: t.deviceId,
    }));
    return NextResponse.json({ success: true, tasks });
  } catch (e: any) {
    return NextResponse.json({ success: false, error: e?.message || String(e) }, { status: 500 });
  }
}
