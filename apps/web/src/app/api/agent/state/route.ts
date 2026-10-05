import { NextResponse } from 'next/server';
import { getAgentBackend } from '@/lib/agent-backend';

export async function GET() {
  const backend = getAgentBackend();
  return NextResponse.json({
    success: true,
    state: backend.state,
  });
}
