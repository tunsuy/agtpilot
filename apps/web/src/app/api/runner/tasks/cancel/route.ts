import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import { cancelRunnerTask } from '@/lib/runner-bridge';
import { summarizeRunnerTask } from '@/lib/runner-dispatch';

/**
 * POST /api/runner/tasks/cancel(会话侧)
 * 用户终止任务(执行中止损):
 * - queued → 云端直接落 cancelled(runner 永远领不到);
 * - dispatched/running → 置 cancelRequested 标记,由设备轮询下发 cancel 动作,
 *   runner 杀掉本地 claude 进程后上报 cancelled 落终态(两阶段,与审批拒绝同构);
 * - awaiting_approval 不支持(审批卡「拒绝」即终止路径);终态一律 400。
 * 返回最新 summary,前端可立即刷新「终止中…」状态。
 */
const TASK_ID_RE = /^rtask_[\w-]{1,128}$/;

export async function POST(req: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ success: false, error: 'Unauthorized: 请先登录' }, { status: 401 });
    }
    const body = await req.json().catch(() => ({}));
    const taskId = typeof body?.taskId === 'string' ? body.taskId : '';
    if (!TASK_ID_RE.test(taskId)) {
      return NextResponse.json({ success: false, error: '参数不合法:taskId' }, { status: 400 });
    }
    const r = cancelRunnerTask(session.user.id, taskId, Date.now());
    if (!r.ok) {
      const status = r.error === 'not_found' ? 404 : 400;
      const message = r.error === 'not_found' ? '任务不存在' : '当前状态不可终止(终态/等待审批中请用审批卡拒绝)';
      return NextResponse.json({ success: false, error: message }, { status });
    }
    return NextResponse.json({ success: true, task: r.task ? summarizeRunnerTask(r.task) : null });
  } catch (e: any) {
    return NextResponse.json({ success: false, error: e?.message || String(e) }, { status: 500 });
  }
}
