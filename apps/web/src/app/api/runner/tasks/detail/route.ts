import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import { getRunnerTask } from '@/lib/runner-bridge';
import { summarizeRunnerTask, taskEventTimeline } from '@/lib/runner-dispatch';

/**
 * GET /api/runner/tasks/detail?taskId=…(会话侧)
 * 单任务概览 + 事件时间线(设备页任务列表展开时拉取,5s 随轮询刷新)。
 * 时间线行由 taskEventTimeline 服务端整型:只透出展示文本,payload 大字段
 * (diffstat/testTail/prFinal 等)不进此接口 —— 产出细节走审批卡。
 */
const TASK_ID_RE = /^rtask_[\w-]{1,128}$/;

export async function GET(req: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ success: false, error: 'Unauthorized: 请先登录' }, { status: 401 });
    }
    const taskId = req.nextUrl.searchParams.get('taskId') ?? '';
    if (!TASK_ID_RE.test(taskId)) {
      return NextResponse.json({ success: false, error: '参数不合法:taskId' }, { status: 400 });
    }
    const task = getRunnerTask(session.user.id, taskId);
    if (!task) {
      return NextResponse.json({ success: false, error: '任务不存在' }, { status: 404 });
    }
    return NextResponse.json({
      success: true,
      task: summarizeRunnerTask(task),
      timeline: taskEventTimeline(task.events),
    });
  } catch (e: any) {
    return NextResponse.json({ success: false, error: e?.message || String(e) }, { status: 500 });
  }
}
