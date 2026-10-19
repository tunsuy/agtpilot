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
    let finalDelivery: import('@/workshops/types').DeliveryContract | undefined;
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
      // 逐字段交付契约:随权威渲染透传(override 分支已在 server-render 显式丢弃)
      finalDelivery = run.delivery;
    }

    if (!finalPrompt) {
      return NextResponse.json({ success: false, error: 'Prompt is required' }, { status: 400 });
    }

    const backend = getAgentBackend();
    const mission = await backend.runMission(finalPrompt, {
      title: finalTitle,
      userId: session.user.id,
      missionId,
      // 工坊标识贯穿到任务记录:记忆蒸馏层据此把首条消息识别为表单参数,
      // 不把单次选择(文章类型/风格等)沉淀为用户的长期定位
      workshopId: typeof workshop?.id === 'string' ? workshop.id : undefined,
      // 逐字段交付契约:声明后挂载 workshop_deliver_field 工具并写投影
      delivery: finalDelivery,
    });

    return NextResponse.json({
      success: true,
      mission,
    });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
