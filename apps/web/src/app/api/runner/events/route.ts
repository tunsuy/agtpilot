import { NextRequest, NextResponse } from 'next/server';
import { getAgentBackend } from '@/lib/agent-backend';
import { createPublishApproval, getRunnerTask, recordRunnerEvents, runnerApprovalToRequest } from '@/lib/runner-bridge';
import { authenticateRunnerRequest } from '@/lib/runner-route-auth';

/**
 * POST /api/runner/events(设备侧,X-Runner-Id + Bearer 认证)
 * 批量上行事件({ events: RunnerEvent[] },单批 ≤100 条):
 * - eventId 幂等去重(断网重发安全);
 * - type='state' 走状态机迁移校验,非法迁移拒绝;
 * - 冒名(event.deviceId ≠ 认证设备)/畸形/未知任务 → rejected。
 * 数据最小化红线(§5.3):代码文件内容与凭据永不上传,由 runner 侧 redaction
 * 与本协议 normalize 双层兜底(payload 超限整体降级为截断标记)。
 *
 * M3 接线:stateChanges 里出现 awaiting_approval → 创建持久审批单 +
 * 注册 ApprovalRequest(action 'runner_publish', dangerLevel high)→
 * SSE 审批卡 + Web Push(agent-backend 既有链路);done → PR 链接推送。
 */
export async function POST(req: NextRequest) {
  try {
    const authed = authenticateRunnerRequest(req);
    if (!authed.ok) return authed.response;

    const body = await req.json().catch(() => ({}));
    const events = Array.isArray(body?.events) ? body.events : null;
    if (!events) {
      return NextResponse.json({ success: false, error: '参数缺失: events 数组必填' }, { status: 400 });
    }
    const result = recordRunnerEvents(authed.userId, authed.device.deviceId, events);

    if (result.stateChanges.length > 0) {
      const backend = getAgentBackend();
      for (const sc of result.stateChanges) {
        if (sc.to === 'awaiting_approval') {
          const created = createPublishApproval(authed.userId, sc.taskId);
          const request = created ? runnerApprovalToRequest(created.task, authed.userId) : null;
          if (request) backend.registerRunnerApproval(request);
        }
        if (sc.to === 'done') {
          // PR 链接回流后的完成推送(复用 Web Push;失败不影响事件应答)
          try {
            const { sendPushToUser } = await import('@/lib/push');
            const task = getRunnerTask(authed.userId, sc.taskId);
            sendPushToUser(authed.userId, {
              title: '贡献完成',
              body: task?.prUrl ? `PR 已创建:${task.prUrl}` : `任务 ${sc.taskId} 已完成`,
              tag: `runner-done-${sc.taskId}`,
              url: '/',
            }).catch(() => {});
          } catch {
            // push 不可用不影响主流程
          }
        }
      }
    }

    return NextResponse.json({ success: true, ...result });
  } catch (e: any) {
    return NextResponse.json({ success: false, error: e?.message || String(e) }, { status: 500 });
  }
}
