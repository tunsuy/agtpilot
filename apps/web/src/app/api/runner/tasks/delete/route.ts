import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import { deleteRunnerTask } from '@/lib/runner-bridge';

/**
 * POST /api/runner/tasks/delete(会话侧)
 * 删除终态任务记录(设备页清理):完整记录与事件流移除;带 Issue 的由
 * runner-bridge 落墓碑,雷达去重黑名单照常生效(删列表 ≠ 把 Issue 放出黑名单)。
 * 非终态(在途/待审批)拒绝:先「终止」(或审批卡拒绝)落终态再删。
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
    const r = deleteRunnerTask(session.user.id, taskId, Date.now());
    if (!r.ok) {
      const status = r.error === 'not_found' ? 404 : 400;
      const message =
        r.error === 'not_found'
          ? '任务不存在'
          : '在途或审批中的任务不可删除:先「终止」(或审批卡拒绝)落终态后再删';
      return NextResponse.json({ success: false, error: message }, { status });
    }
    return NextResponse.json({ success: true });
  } catch (e: any) {
    return NextResponse.json({ success: false, error: e?.message || String(e) }, { status: 500 });
  }
}
