import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import { getBrowserAudit, getUserConnectors, saveUserConnector } from '@/lib/user-store';
import {
  WECHAT_MP_CRED_KEY,
  checkWechatMpCredential,
  countTodayWechatDrafts,
  dailyWechatDraftLimit,
  parseWechatMpCredential,
  resetWechatMpTokenCache,
} from '@/lib/wechat-mp';

export const dynamic = 'force-dynamic';

/**
 * 公众号工坊凭证专用 route(scenario-loop:凭证彻底搬离连接器页)。
 * 绕开 /api/connectors 的 ALLOWED_ENV_VARS(白名单由 CONNECTOR_DEFS 生成,
 * 删 wechat_mp 卡片后该 Key 不在白名单,写入必须由本 route 承接)。
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

/**
 * POST action:save / check / clear。
 * save 只存不验(格式校验前置),check 单独调用(真实打微信接口);
 * clear 清 token 缓存 + 空值保存(触发权限纪元 bump,撤销 in-flight 授权)。
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

    if (action === 'save') {
      const credential = String(body.credential || '').trim();
      const parsed = parseWechatMpCredential(credential);
      if (!parsed) {
        return NextResponse.json(
          { success: false, error: '凭证格式应为 AppID:AppSecret(公众平台 → 设置与开发 → 基本配置)' },
          { status: 400 }
        );
      }
      resetWechatMpTokenCache(userId);
      saveUserConnector(userId, WECHAT_MP_CRED_KEY, credential);
      return NextResponse.json({ success: true, appId: parsed.appId });
    }

    if (action === 'check') {
      const result = await checkWechatMpCredential(userId);
      return NextResponse.json({ success: true, ...result });
    }

    if (action === 'clear') {
      resetWechatMpTokenCache(userId);
      // 空值保存即删除 + bumpAuthorityEpoch(in-flight 任务的 session.env 同步移除该 Key)
      saveUserConnector(userId, WECHAT_MP_CRED_KEY, '');
      return NextResponse.json({ success: true, configured: false });
    }

    return NextResponse.json({ success: false, error: '未知 action' }, { status: 400 });
  } catch (err: any) {
    console.error('Error in POST /api/wechat-mp:', err);
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
