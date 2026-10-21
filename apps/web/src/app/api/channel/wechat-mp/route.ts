import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import { getUserConnectors } from '@/lib/user-store';
import { WECHAT_MP_CRED_KEY, parseWechatMpCredential } from '@/lib/wechat-mp';
import { ensureWechatMpImToken, rotateWechatMpImToken } from '@/lib/channel-store';

export const dynamic = 'force-dynamic';

/**
 * 公众号 IM 通道 · 按用户配置 route(多租户,2026-10-21)。
 *
 * 凭证本体复用连接器页那份(WECHAT_MP_CREDENTIAL,通用 /api/connectors 读写,
 * 本 route 只读状态);这里管的是通道侧专属状态:
 * - callbackPath:该用户专属回调 URL 路径(公众平台「服务器配置」用;
 *   绝对 URL 由前端按 window.location.origin 拼,避免代理头失真)
 * - token:回调签名专属 Token(首次访问自动生成、落盘;用户要贴到公众平台,
 *   所以对本人回显 —— 与绑定码同语义;对其他任何人不可读,auth 门在 handler 首行)
 *
 * GET  → { configured, appId, callbackPath, token }
 * POST → action=rotate:轮换 Token(旧值即废,公众平台需同步更新)
 */

/** GET:配置状态 + 专属回调路径 + 专属 Token(仅本人,自动生成一次后稳定) */
export async function GET(req: NextRequest) {
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
      callbackPath: `/api/wechat/callback?u=${encodeURIComponent(userId)}`,
      token: ensureWechatMpImToken(userId),
    });
  } catch (err: any) {
    console.error('Error in GET /api/channel/wechat-mp:', err);
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}

/** POST action=rotate:轮换专属 Token */
export async function POST(req: NextRequest) {
  try {
    const session = await auth();
    const userId = session?.user?.id;
    if (!userId) {
      return NextResponse.json({ success: false, error: 'Unauthorized: 请先登录' }, { status: 401 });
    }
    const body = await req.json().catch(() => ({}));
    if (String(body.action || '') !== 'rotate') {
      return NextResponse.json({ success: false, error: '未知 action' }, { status: 400 });
    }
    return NextResponse.json({ success: true, token: rotateWechatMpImToken(userId) });
  } catch (err: any) {
    console.error('Error in POST /api/channel/wechat-mp:', err);
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
