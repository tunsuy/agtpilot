import { NextRequest, NextResponse } from 'next/server';
import { getAgentBackend } from '@/lib/agent-backend';

export async function POST(req: NextRequest) {
  try {
    const { approvalId, approved } = await req.json();

    if (!approvalId || typeof approved !== 'boolean') {
      return NextResponse.json({ success: false, error: 'Invalid approval request' }, { status: 400 });
    }

    const backend = getAgentBackend();
    const success = backend.submitApproval(approvalId, approved);

    return NextResponse.json({
      success,
      message: `Approval ${approvalId} ${approved ? 'authorized' : 'rejected'}.`,
    });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
