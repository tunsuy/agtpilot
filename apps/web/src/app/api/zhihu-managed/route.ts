import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import {
  getZhihuManaged,
  getBrowserAudit,
  saveZhihuManaged,
  type ZhihuManagedRecord,
} from '@/lib/user-store';
import { countTodayDraftSaves, dailyDraftLimit } from '@/lib/zhihu-managed';

export const dynamic = 'force-dynamic';

/** GET:托管状态 + 今日用量 + 最近审计(登录徽标/风险明示回显) */
export async function GET() {
  try {
    const session = await auth();
    const userId = session?.user?.id;
    if (!userId) {
      return NextResponse.json({ success: false, error: 'Unauthorized: 请先登录' }, { status: 401 });
    }

    const record = getZhihuManaged(userId);
    const audit = getBrowserAudit(userId, 20);
    return NextResponse.json({
      success: true,
      record: record || null,
      dailyLimit: dailyDraftLimit(),
      todayCount: countTodayDraftSaves(getBrowserAudit(userId)),
      audit,
    });
  } catch (err: any) {
    console.error('Error in GET /api/zhihu-managed:', err);
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}

/**
 * POST:enable / disable(与小红书托管同规则)。
 * enable 强制要求 riskAcknowledged(前端风险明示的确认勾选),
 * 且要求已登录过(登录态是托管写操作的前提;登录本身走 /api/browser/login?platform=zhihu)。
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
      const existing = getZhihuManaged(userId);
      if (!existing?.lastLoginAt) {
        return NextResponse.json(
          { success: false, error: '请先完成知乎网页版扫码登录,再开启托管模式' },
          { status: 400 }
        );
      }
      const record: ZhihuManagedRecord = {
        enabled: true,
        enabledAt: existing.enabledAt || Date.now(),
        riskAckAt: Date.now(),
        lastLoginAt: existing.lastLoginAt,
      };
      saveZhihuManaged(userId, record);
      return NextResponse.json({ success: true, record });
    }

    if (action === 'disable') {
      const existing = getZhihuManagedSafe(userId);
      saveZhihuManaged(userId, { ...existing, enabled: false });
      return NextResponse.json({ success: true, record: getZhihuManaged(userId) || null });
    }

    return NextResponse.json({ success: false, error: '未知 action' }, { status: 400 });
  } catch (err: any) {
    console.error('Error in POST /api/zhihu-managed:', err);
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}

function getZhihuManagedSafe(userId: string): ZhihuManagedRecord {
  return getZhihuManaged(userId) || { enabled: false };
}
