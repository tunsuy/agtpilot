import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { createPairCode } from '@/lib/runner-bridge';

/**
 * POST /api/runner/pair-code(会话侧)
 * 生成一次性配对码(8 位、5 分钟过期、绑定当前登录用户),
 * 设备页展示给用户复制到本地执行 `agtpilot-runner pair --server … --code …`。
 * docs/design/local-runner-bridge.md §4
 */
export async function POST() {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ success: false, error: 'Unauthorized: 请先登录' }, { status: 401 });
    }
    const { code, expiresAt } = createPairCode(session.user.id);
    return NextResponse.json({ success: true, code, expiresAt });
  } catch (e: any) {
    return NextResponse.json({ success: false, error: e?.message || String(e) }, { status: 500 });
  }
}
