import { NextRequest, NextResponse } from 'next/server';
import { getAgentBackend } from '@/lib/agent-backend';

export async function POST(req: NextRequest) {
  try {
    const { approvalId, approved, options } = await req.json();

    if (!approvalId || typeof approved !== 'boolean') {
      return NextResponse.json({ success: false, error: 'Invalid approval request' }, { status: 400 });
    }

    const backend = getAgentBackend();
    // options.includeClaim:runner_publish 审批的「代发认领留言」勾选(决策项 6);
    // 其他审批类型忽略该参数
    const success = backend.submitApproval(approvalId, approved, {
      includeClaim: Boolean(options?.includeClaim),
    });

    return NextResponse.json({
      success,
      message: `Approval ${approvalId} ${approved ? 'authorized' : 'rejected'}.`,
    });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
