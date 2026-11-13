import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import { retryRunnerTask } from '@/lib/runner-bridge';
import { summarizeRunnerTask } from '@/lib/runner-dispatch';

/**
 * POST /api/runner/tasks/retry(会话侧,2026-11-13)
 * 重新派发终态 failed 任务:原包克隆 + 新 taskId 入队(workBranch 不变 →
 * runner 检测分支已有 WIP commit 自动续跑,已有产出不丢),targetDeviceId/
 * missionId 原样继承,发布仍走审批门。其余终态(done/no_action/cancelled/
 * expired)与非终态一律 400 —— 各有含义,不在此列。
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
    const r = retryRunnerTask(session.user.id, taskId, Date.now());
    if (!r.ok) {
      const status = r.error === 'not_found' ? 404 : 400;
      const message =
        r.error === 'not_found'
          ? '任务不存在'
          : r.error === 'pack_normalize_failed'
            ? '原任务包校验失败(字段畸形/超限),无法重派 —— 请回机会卡重新派发'
            : r.error === 'enqueue_failed'
              ? '入队失败(目标设备可能已吊销),请回机会卡重新派发'
              : '仅 failed 终态任务可重新派发';
      return NextResponse.json({ success: false, error: message }, { status });
    }
    return NextResponse.json({ success: true, task: r.task ? summarizeRunnerTask(r.task) : null });
  } catch (e: any) {
    return NextResponse.json({ success: false, error: e?.message || String(e) }, { status: 500 });
  }
}
