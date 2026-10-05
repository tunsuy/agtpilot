import { NextRequest, NextResponse } from 'next/server';
import { getAgentBackend } from '@/lib/agent-backend';

export async function POST(req: NextRequest) {
  try {
    const { prompt, title } = await req.json();

    if (!prompt || typeof prompt !== 'string') {
      return NextResponse.json({ success: false, error: 'Prompt is required' }, { status: 400 });
    }

    const backend = getAgentBackend();
    const mission = await backend.runMission(prompt.trim(), { title });

    return NextResponse.json({
      success: true,
      mission,
    });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
