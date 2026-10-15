import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import { countTodaySkillRuns } from '@agtpilot/plugin-skill';
import {
  getFanqieManaged,
  getBrowserAudit,
  saveFanqieManaged,
  type FanqieManagedRecord,
} from '@/lib/user-store';

export const dynamic = 'force-dynamic';

/** 番茄存草稿工具名(限频计数按审计里的同名条目) */
const FANQIE_TOOL = 'fanqie_save_chapter_draft';

/** 番茄每日存草稿上限(可用 env 调整;与 skill 清单缺省值同源语义) */
function fanqieDailyLimit(): number {
  const n = Number(process.env.AGTPILOT_FANQIE_DRAFT_DAILY_LIMIT);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 3;
}

/** GET:托管状态 + 今日用量 + 最近审计(登录徽标/风险明示回显) */
export async function GET() {
  try {
    const session = await auth();
    const userId = session?.user?.id;
    if (!userId) {
      return NextResponse.json({ success: false, error: 'Unauthorized: 请先登录' }, { status: 401 });
    }

    const record = getFanqieManaged(userId);
    const audit = getBrowserAudit(userId, 20);
    return NextResponse.json({
      success: true,
      record: record || null,
      dailyLimit: fanqieDailyLimit(),
      todayCount: countTodaySkillRuns(getBrowserAudit(userId), FANQIE_TOOL),
      audit,
    });
  } catch (err: any) {
    console.error('Error in GET /api/fanqie-managed:', err);
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}

/**
 * POST:enable / disable(与知乎/小红书托管同规则)。
 * enable 强制要求 riskAcknowledged(前端风险明示的确认勾选),
 * 且要求已登录过(登录态是托管写操作的前提;登录本身走 /api/browser/login?platform=fanqie)。
 * 注意:番茄存草稿经用户拍板不做逐次审批 —— 这里的一次性风险确认即全部授权,
 * 之后 fanqie_save_chapter_draft 以 dangerLevel low 直接执行(限频/审计/发布围栏照旧)。
 */
export async function POST(req: NextRequest) {
  try {
    const session = await auth();
    const userId = session?.user?.id;
    if (!userId) {
      return NextResponse.json({ success: false, error: 'Unauthorized: 请先登录' }, { status: 401 });
    }

    const body = await req.json().catch(() => ({}));
    const action = String(body.action || '');

    if (action === 'enable') {
      if (!body.riskAcknowledged) {
        return NextResponse.json(
          { success: false, error: '开启托管模式前必须确认风险说明' },
          { status: 400 }
        );
      }
      const existing = getFanqieManaged(userId);
      if (!existing?.lastLoginAt) {
        return NextResponse.json(
          { success: false, error: '请先完成番茄网页版扫码登录,再开启托管模式' },
          { status: 400 }
        );
      }
      const record: FanqieManagedRecord = {
        enabled: true,
        enabledAt: existing.enabledAt || Date.now(),
        riskAckAt: Date.now(),
        lastLoginAt: existing.lastLoginAt,
      };
      saveFanqieManaged(userId, record);
      return NextResponse.json({ success: true, record });
    }

    if (action === 'disable') {
      const existing = getFanqieManaged(userId) || { enabled: false };
      saveFanqieManaged(userId, { ...existing, enabled: false });
      return NextResponse.json({ success: true, record: getFanqieManaged(userId) || null });
    }

    return NextResponse.json({ success: false, error: '未知 action' }, { status: 400 });
  } catch (err: any) {
    console.error('Error in POST /api/fanqie-managed:', err);
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
