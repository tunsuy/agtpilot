import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import {
  getUserScenarioProfiles,
  saveUserScenarioProfile,
  deleteUserScenarioProfile,
} from '@/lib/user-store';
import { normalizeScenarioProfile } from '@/lib/scenario-profile';

/**
 * GET /api/scenario-profiles
 * 获取当前登录用户的全部工坊场景档案(前端按 scenarioKey 自取)
 */
export async function GET() {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json(
        { success: false, error: 'Unauthorized: 请先登录' },
        { status: 401 }
      );
    }

    const profiles = getUserScenarioProfiles(session.user.id);
    return NextResponse.json({ success: true, total: Object.keys(profiles).length, profiles });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}

/**
 * POST /api/scenario-profiles
 * body.action = 'upsert'(带 profile)/ 'delete'(带 scenarioKey)
 */
export async function POST(req: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json(
        { success: false, error: 'Unauthorized: 请先登录' },
        { status: 401 }
      );
    }

    const userId = session.user.id;
    const body = await req.json();
    const { action } = body;

    if (action === 'upsert') {
      const scenarioKey = typeof body.scenarioKey === 'string' ? body.scenarioKey.trim() : '';
      if (!scenarioKey) {
        return NextResponse.json({ success: false, error: '缺少 scenarioKey' }, { status: 400 });
      }
      const profile = normalizeScenarioProfile(scenarioKey, body.profile);
      if (!profile) {
        return NextResponse.json(
          { success: false, error: '档案缺少必填项(赛道与目标人群)' },
          { status: 400 }
        );
      }
      const profiles = saveUserScenarioProfile(userId, profile);
      return NextResponse.json({ success: true, profile, profiles });
    }

    if (action === 'delete') {
      const scenarioKey = typeof body.scenarioKey === 'string' ? body.scenarioKey.trim() : '';
      if (!scenarioKey) {
        return NextResponse.json({ success: false, error: '缺少 scenarioKey' }, { status: 400 });
      }
      const profiles = deleteUserScenarioProfile(userId, scenarioKey);
      return NextResponse.json({ success: true, profiles });
    }

    return NextResponse.json({ success: false, error: '未知 action' }, { status: 400 });
  } catch (err: any) {
    console.error('Error in POST /api/scenario-profiles:', err);
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
