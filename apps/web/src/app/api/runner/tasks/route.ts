import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import { claimNextTask, enqueueTask, getDeviceActions, getRunnerTasks } from '@/lib/runner-bridge';
import { authenticateRunnerRequest } from '@/lib/runner-route-auth';

/**
 * GET /api/runner/tasks(设备侧,X-Runner-Id + Bearer 认证)
 * runner 轮询端点(HTTPS 出站-only,3-5s;不用 WebSocket,§3.1):
 * - 缺省:纯心跳(authenticate 顺带节流落盘 lastSeenAt),返回该用户任务概览
 *   (队列项携 targetDeviceId,runner 据此只把「无绑定或绑定本机」的任务计为待领);
 * - ?claim=1:FIFO 领取最老的可领 queued 任务(无绑定 或 绑定到本设备)→ dispatched;
 * - actions:M3 审批结果下行(publish 携带批准时刻固化的命令集 / cancel 拒绝确认),
 *   由任务状态推导,runner 事件到达前每次轮询幂等重发。
 * query 可携带 hostname/platform/runnerVersion/protocolVersion 更新设备元信息。
 *
 * POST /api/runner/tasks(会话侧)
 * 入队一个任务包(清洗失败 400;M2 起由机会卡「派发到本地」弹窗调用)。
 * body.deviceId 可选:派发时指定目标设备(须为本用户未吊销的配对设备,否则 400);
 * 缺省 = 任意在线设备 FIFO 领取(存量语义)。
 * body.missionId 可选:派发时所处的驾驶舱会话 id(设备任务 ↔ 会话互跳关联键;
 * 畸形 400,会话不存在不阻断 —— 删除过的会话只是跳转失效)。
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
      // 心跳回带队列概览(仅本设备归属用户;状态+id+目标设备,不含任务包细节,省流量)
      queue: getRunnerTasks(authed.userId).map((t) => ({
        taskId: t.taskId,
        state: t.state,
        ...(t.targetDeviceId ? { targetDeviceId: t.targetDeviceId } : {}),
      })),
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
    const deviceId = body?.deviceId;
    if (deviceId !== undefined && typeof deviceId !== 'string') {
      return NextResponse.json({ success: false, error: 'deviceId 须为字符串(目标设备 id)' }, { status: 400 });
    }
    const missionId = body?.missionId;
    if (missionId !== undefined && (typeof missionId !== 'string' || missionId.length > 128 || missionId.length === 0)) {
      return NextResponse.json({ success: false, error: 'missionId 须为非空字符串(≤128 字符)' }, { status: 400 });
    }
    const record = enqueueTask(session.user.id, body?.pack ?? body, Date.now(), {
      ...(deviceId ? { targetDeviceId: deviceId } : {}),
      ...(missionId ? { missionId } : {}),
    });
    if (!record) {
      return NextResponse.json(
        {
          success: false,
          error: deviceId
            ? '任务包清洗失败、taskId 已存在,或目标设备无效(不存在/已吊销/不属于当前用户)'
            : '任务包清洗失败(核心字段缺失/畸形)或 taskId 已存在',
        },
        { status: 400 }
      );
    }
    return NextResponse.json({ success: true, taskId: record.taskId, state: record.state });
  } catch (e: any) {
    return NextResponse.json({ success: false, error: e?.message || String(e) }, { status: 500 });
  }
}
