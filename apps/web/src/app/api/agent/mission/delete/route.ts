import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import { getAgentBackend } from '@/lib/agent-backend';
import { deleteUserMission } from '@/lib/user-store';

/**
 * POST /api/agent/mission/delete
 * 删除一条历史会话(持久化库 + 内存态一并清掉)。
 *
 * 守卫:
 * - 只能删自己的任务(内存态按 userId 归属校验;持久化库本身按 userId 隔离);
 * - ACTIVE / WAITING_APPROVAL / QUEUED 的任务执行回路还在跑、还会写回
 *   checkpoint(saveUserMission),删了会被重新落盘 —— 先停止再删除。
 */
const DELETABLE_STATUSES = new Set(['DONE', 'INTERRUPTED']);

export async function POST(req: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json(
        { success: false, error: 'Unauthorized: 需登录后方可删除会话' },
        { status: 401 }
      );
    }
    const userId = session.user.id;

    const body = await req.json().catch(() => ({}));
    const missionId = typeof body.missionId === 'string' ? body.missionId : '';
    if (!missionId) {
      return NextResponse.json({ success: false, error: 'missionId is required' }, { status: 400 });
    }

    const backend = getAgentBackend();
    const memoryMission = backend.state.missions.find((m) => m.id === missionId);

    // 执行中/等审批/排队中的任务拒绝删除(执行回路还在写盘,删不干净)
    if (memoryMission && !DELETABLE_STATUSES.has(memoryMission.status)) {
      return NextResponse.json(
        {
          success: false,
          error: `任务处于 ${memoryMission.status === 'ACTIVE' ? '执行中' : '等待中'}状态,请先停止任务再删除`,
        },
        { status: 409 }
      );
    }
    // 内存态里存在但不属于当前用户 → 按不存在处理,不泄露他人任务的存在性
    if (memoryMission && memoryMission.userId !== userId) {
      return NextResponse.json({ success: false, error: '会话不存在' }, { status: 404 });
    }

    // 持久化库按 userId 隔离,直接删;内存态兜底清掉同 id(归属上面已校验)
    deleteUserMission(userId, missionId);
    backend.state.missions = backend.state.missions.filter((m) => m.id !== missionId);
    if (backend.state.activeMissionId === missionId) {
      backend.state.activeMissionId = null;
    }

    return NextResponse.json({ success: true, missionId });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
