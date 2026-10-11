import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import { getBrowserAudit, getUserConnectors } from '@/lib/user-store';
import {
  WECHAT_MP_CRED_KEY,
  checkWechatMpCredential,
  countTodayWechatDrafts,
  dailyWechatDraftLimit,
  parseWechatMpCredential,
} from '@/lib/wechat-mp';

export const dynamic = 'force-dynamic';

/**
 * 公众号工坊状态 route(scenario-loop:凭证在连接器页配置,此处只读 + 测试)。
 * 凭证读写走通用 /api/connectors(envVar=WECHAT_MP_CREDENTIAL,
 * 白名单随 CONNECTOR_DEFS 的 wechat_mp 卡片自动生效);本 route 提供:
 * GET 状态(appId/今日用量/审计)与 POST check(测试连接,真实打微信接口)。
 */

/** GET:配置状态 + 每日上限/今日用量 + 最近审计(appId 可回显,secret 永不回传) */
export async function GET() {
  try {
    const session = await auth();
    const userId = session?.user?.id;
    if (!userId) {
      return NextResponse.json({ success: false, error: 'Unauthorized: 请先登录' }, { status: 401 });
    }

    const cred = parseWechatMpCredential(getUserConnectors(userId).configs[WECHAT_MP_CRED_KEY]);
    return NextResponse.json({
      success: true,
      configured: Boolean(cred),
      appId: cred?.appId || null,
      dailyLimit: dailyWechatDraftLimit(),
      todayCount: countTodayWechatDrafts(getBrowserAudit(userId)),
      audit: getBrowserAudit(userId, 20).filter((e) => e.tool === 'wechat_mp_create_draft'),
    });
  } catch (err: any) {
    console.error('Error in GET /api/wechat-mp:', err);
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}

/** POST action:check(凭证连通性检查;换绑/清除在连接器页卡片操作) */
export async function POST(req: NextRequest) {
  try {
    const session = await auth();
    const userId = session?.user?.id;
    if (!userId) {
      return NextResponse.json({ success: false, error: 'Unauthorized: 请先登录' }, { status: 401 });
    }

    const body = await req.json().catch(() => ({}));
    const action = String(body.action || '');

    if (action === 'check') {
      const result = await checkWechatMpCredential(userId);
      return NextResponse.json({ success: true, ...result });
    }

    return NextResponse.json({ success: false, error: '未知 action' }, { status: 400 });
  } catch (err: any) {
    console.error('Error in POST /api/wechat-mp:', err);
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
