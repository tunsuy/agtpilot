import { NextRequest, NextResponse } from 'next/server';
import { getAgentBackend } from '@/lib/agent-backend';
import { auth } from '@/auth';

/**
 * ask_user 问题卡答题路由:用户在问题卡上点选项或提交自由文本,
 * 解冻挂起中的工具,回答作为 tool result 回填主循环原地续跑。
 * 撤卡/状态恢复由工具侧 question_resolved 事件统一收口(SSE 广播)。
 */
export async function POST(req: NextRequest) {
  try {
    const session = await auth();
    const userId = session?.user?.id;
    if (!userId) {
      return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
    }

    const { questionId, answers } = await req.json();
    // 逐问回答:index 对应卡内 questions 序,覆盖校验(必须答全)在桥内做
    if (
      !questionId ||
      !Array.isArray(answers) ||
      answers.length === 0 ||
      answers.some((a: any) => typeof a?.answer !== 'string' || !a.answer.trim())
    ) {
      return NextResponse.json({ success: false, error: 'Invalid answer request' }, { status: 400 });
    }
    const items = answers.map((a: any) => ({
      index: Number(a.index),
      answer: String(a.answer).trim(),
      via: a.via === 'free_text' ? ('free_text' as const) : ('option' as const),
    }));

    const backend = getAgentBackend();
    const success = backend.submitAnswer(questionId, items, {
      userId, // 归属校验:防跨用户答题
    });

    return NextResponse.json({
      success,
      message: success ? `Question ${questionId} answered.` : 'Question not found or already resolved.',
    });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
