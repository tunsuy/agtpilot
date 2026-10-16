import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import { interjectRunnerTask } from '@/lib/runner-bridge';
import { summarizeRunnerTask } from '@/lib/runner-dispatch';

/**
 * POST /api/runner/tasks/interject(会话侧)
 * 用户中途插话(执行中纠偏,如纠正 git 用户名/邮箱写错):
 * - dispatched/running(在飞)→ 写入 pendingInterjects 队列,由设备保活轮询
 *   下发 interject 动作,runner 注入正在执行的 claude 会话后上报 interject_ack
 *   清队(两阶段,与 cancel 同构;at-least-once 下行,runner 按 id 去重);
 * - 其余状态(排队中没人执行/审批中/终态)一律 400 —— 没有会话可注入。
 * 正文防线与协议清洗同源(bridge 内过 normalizeDeviceAction):
 * trim 后非空、≤2000 字、拒控制字符(换行合法,多行插话可发)。
 */
const TASK_ID_RE = /^rtask_[\w-]{1,128}$/;

const ERROR_MESSAGES: Record<string, string> = {
  not_found: '任务不存在',
  not_interjectable: '当前状态不可插话(仅本地执行中的任务可插话;排队中/审批中/已结束均无会话可注入)',
  invalid_text: '插话内容不合法:trim 后须非空、≤2000 字、不含控制字符',
  queue_full: '待送达插话已满(10 条):请等 runner 确认送达后再发',
};

export async function POST(req: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ success: false, error: 'Unauthorized: 请先登录' }, { status: 401 });
    }
    const body = await req.json().catch(() => ({}));
    const taskId = typeof body?.taskId === 'string' ? body.taskId : '';
    const text = typeof body?.text === 'string' ? body.text : '';
    if (!TASK_ID_RE.test(taskId)) {
      return NextResponse.json({ success: false, error: '参数不合法:taskId' }, { status: 400 });
    }
    if (!text.trim()) {
      return NextResponse.json({ success: false, error: ERROR_MESSAGES.invalid_text }, { status: 400 });
    }
    const r = interjectRunnerTask(session.user.id, taskId, text, Date.now());
    if (!r.ok) {
      const status = r.error === 'not_found' ? 404 : 400;
      const message = ERROR_MESSAGES[r.error ?? ''] ?? '插话失败';
      return NextResponse.json({ success: false, error: message }, { status });
    }
    return NextResponse.json({ success: true, task: r.task ? summarizeRunnerTask(r.task) : null });
  } catch (e: any) {
    return NextResponse.json({ success: false, error: e?.message || String(e) }, { status: 500 });
  }
}
