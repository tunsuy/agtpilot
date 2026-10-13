import { NextRequest, NextResponse } from 'next/server';
import { recordRunnerEvents } from '@/lib/runner-bridge';
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
 * M3 接线点:stateChanges 里出现 awaiting_approval → 创建 ApprovalRequest
 * (action 'runner_publish', dangerLevel high)+ Web Push;done → PR 回流 Mission 卡。
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
    return NextResponse.json({ success: true, ...result });
  } catch (e: any) {
    return NextResponse.json({ success: false, error: e?.message || String(e) }, { status: 500 });
  }
}
