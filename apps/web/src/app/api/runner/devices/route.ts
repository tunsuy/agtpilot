import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import { listDevices, revokeDevice } from '@/lib/runner-bridge';

/**
 * GET /api/runner/devices(会话侧)
 * 当前用户的已配对 runner 设备列表(在线状态由心跳窗口推导;不含任何密钥材料)。
 *
 * DELETE /api/runner/devices { deviceId }
 * 吊销设备:删密文 + 摘索引,该设备下次轮询即 401(runner 侧自毁凭据提示重新配对)。
 * docs/design/local-runner-bridge.md §4
 */
export async function GET() {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ success: false, error: 'Unauthorized: 请先登录' }, { status: 401 });
    }
    return NextResponse.json({ success: true, devices: listDevices(session.user.id) });
  } catch (e: any) {
    return NextResponse.json({ success: false, error: e?.message || String(e) }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ success: false, error: 'Unauthorized: 请先登录' }, { status: 401 });
    }
    const body = await req.json().catch(() => ({}));
    const deviceId = typeof body?.deviceId === 'string' ? body.deviceId : '';
    if (!deviceId) {
      return NextResponse.json({ success: false, error: '参数缺失: deviceId 必填' }, { status: 400 });
    }
    const revoked = revokeDevice(session.user.id, deviceId);
    if (!revoked) {
      return NextResponse.json({ success: false, error: '设备不存在或已吊销' }, { status: 404 });
    }
    return NextResponse.json({ success: true });
  } catch (e: any) {
    return NextResponse.json({ success: false, error: e?.message || String(e) }, { status: 500 });
  }
}
