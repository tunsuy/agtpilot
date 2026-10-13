import { NextRequest, NextResponse } from 'next/server';
import { redeemPairCode } from '@/lib/runner-bridge';
import { normalizeDeviceMeta } from '@agtpilot/protocol';

/**
 * POST /api/runner/pair(设备侧,无会话)
 * runner 本地 `agtpilot-runner pair --server … --code …` 的核销端点:
 * 配对码 + 设备元信息 → 一次性核销,产出 deviceId/deviceSecret(只出现这一次)。
 * 错误映射:未知码 404 / 过期 410 / 已核销 409 / 协议版本不符 426 / 元信息畸形 400
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const meta = normalizeDeviceMeta(body);
    if (!meta) {
      return NextResponse.json(
        { success: false, error: '设备元信息缺失或畸形(hostname/runnerVersion/protocolVersion 必填)' },
        { status: 400 }
      );
    }
    const result = redeemPairCode(body?.code, meta);
    if (!result.ok) {
      const status =
        result.error === 'invalid_code'
          ? 404
          : result.error === 'expired'
            ? 410
            : result.error === 'already_redeemed'
              ? 409
              : 426;
      const message =
        result.error === 'protocol_unsupported'
          ? `协议版本不兼容(设备上报 ${meta.protocolVersion}),请升级 runner 后重试`
          : result.error === 'expired'
            ? '配对码已过期(5 分钟有效),请在设备页重新生成'
            : result.error === 'already_redeemed'
              ? '配对码已被核销(一次性),请在设备页重新生成'
              : '配对码无效';
      return NextResponse.json({ success: false, error: message, code: result.error }, { status });
    }
    return NextResponse.json({
      success: true,
      deviceId: result.deviceId,
      deviceSecret: result.deviceSecret,
      serverTime: Date.now(),
    });
  } catch (e: any) {
    return NextResponse.json({ success: false, error: e?.message || String(e) }, { status: 500 });
  }
}
