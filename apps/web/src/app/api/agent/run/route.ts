import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import { getAgentBackend } from '@/lib/agent-backend';
import { renderWorkshopRunServer } from '@/workshops/server-render';

export async function POST(req: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json(
        { success: false, error: 'Unauthorized: 需登录后方可派发智能体任务' },
        { status: 401 }
      );
    }

    const { prompt, title, missionId, workshop } = await req.json();

    // 工坊任务可选携带 {workshopId, params}:服务端权威渲染(注册表 + 档案现读 +
    // 覆盖目录热修),该请求忽略客户端拼好的 prompt;普通手输 prompt 不受影响。
    let finalPrompt = typeof prompt === 'string' ? prompt.trim() : '';
    let finalTitle = title;
    if (workshop && typeof workshop.id === 'string') {
      const run = renderWorkshopRunServer(session.user.id, workshop.id, workshop.params);
      if (!run) {
        return NextResponse.json(
          { success: false, error: `未知工坊: ${workshop.id}` },
          { status: 400 }
        );
      }
      finalPrompt = run.prompt;
      finalTitle = run.title;
    }

    if (!finalPrompt) {
      return NextResponse.json({ success: false, error: 'Prompt is required' }, { status: 400 });
    }

    const backend = getAgentBackend();
    const mission = await backend.runMission(finalPrompt, {
      title: finalTitle,
      userId: session.user.id,
      missionId,
    });

    return NextResponse.json({
      success: true,
      mission,
    });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
