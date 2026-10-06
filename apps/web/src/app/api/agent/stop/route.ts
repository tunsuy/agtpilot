import { NextRequest, NextResponse } from 'next/server';
import { getAgentBackend } from '@/lib/agent-backend';

/**
 * POST /api/agent/stop
 * 终止指定任务，或在用户退出登录时终止所有活跃任务
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const backend = getAgentBackend();

    if (body.missionId && typeof body.missionId === 'string') {
      backend.stopMission(body.missionId);
      return NextResponse.json({
        success: true,
        message: `Mission ${body.missionId} stopped.`,
      });
    }

    // 默认终止所有进行中的任务（例如退出登录时）
    backend.stopAllMissions();
    return NextResponse.json({
      success: true,
      message: 'All active missions stopped.',
    });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
