import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import { claimNextTask, enqueueTask, getDeviceActions, getRunnerTasks } from '@/lib/runner-bridge';
import { authenticateRunnerRequest } from '@/lib/runner-route-auth';

/**
 * GET /api/runner/tasks(设备侧,X-Runner-Id + Bearer 认证)
 * runner 轮询端点(HTTPS 出站-only,3-5s;不用 WebSocket,§3.1):
 * - 缺省:纯心跳(authenticate 顺带节流落盘 lastSeenAt),返回该用户任务概览;
 * - ?claim=1:FIFO 领取最老 queued 任务 → dispatched;
 * - actions:M3 审批结果下行(publish 携带批准时刻固化的命令集 / cancel 拒绝确认),
 *   由任务状态推导,runner 事件到达前每次轮询幂等重发。
 * query 可携带 hostname/platform/runnerVersion/protocolVersion 更新设备元信息。
 *
 * POST /api/runner/tasks(会话侧)
 * 入队一个任务包(清洗失败 400;M2 起由机会卡「派发到本地」弹窗调用)。
 */
export async function GET(req: NextRequest) {
  try {
    const authed = authenticateRunnerRequest(req);
    if (!authed.ok) return authed.response;

    const url = new URL(req.url);
    const claim = url.searchParams.get('claim') === '1';
    const task = claim ? claimNextTask(authed.userId, authed.device.deviceId) : null;

    return NextResponse.json({
      success: true,
      serverTime: Date.now(),
      claimed: task ? { taskId: task.taskId, pack: task.pack } : null,
      // 心跳回带队列概览(仅本设备归属用户;状态+id,不含任务包细节,省流量)
      queue: getRunnerTasks(authed.userId).map((t) => ({ taskId: t.taskId, state: t.state })),
      // 审批结果动作(只下发绑定到本设备的任务)
      actions: getDeviceActions(authed.userId, authed.device.deviceId),
    });
  } catch (e: any) {
    return NextResponse.json({ success: false, error: e?.message || String(e) }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ success: false, error: 'Unauthorized: 请先登录' }, { status: 401 });
    }
    const body = await req.json().catch(() => ({}));
    const record = enqueueTask(session.user.id, body?.pack ?? body);
    if (!record) {
      return NextResponse.json(
        { success: false, error: '任务包清洗失败(核心字段缺失/畸形)或 taskId 已存在' },
        { status: 400 }
      );
    }
    return NextResponse.json({ success: true, taskId: record.taskId, state: record.state });
  } catch (e: any) {
    return NextResponse.json({ success: false, error: e?.message || String(e) }, { status: 500 });
  }
}
