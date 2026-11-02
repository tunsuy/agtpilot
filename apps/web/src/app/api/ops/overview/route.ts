/**
 * 运营看板数据出口(admin 门禁)。
 *
 * GET /api/ops/overview?days=30
 * 读 ops 流水(必要时惰性回灌一次,标记文件防重)→ aggregateOps 纯函数聚合 → JSON。
 *
 * 鉴权双重校验:session.user.role==='admin'(jwt 回调按 env 名单盖章,UI 入口
 * 同源)或 userId 命中 AGTPILOT_OPS_ADMINS —— 伪造前端状态拿不到数据,
 * 非 admin 一律 403(不泄露看板存在性之外的任何信息)。
 */
import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { isOpsAdmin } from '@/lib/ops-admin';
import { backfillOpsFromMissions, readOpsEvents } from '@/lib/ops-ledger';
import { aggregateOps } from '@/lib/ops-aggregate';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const session = await auth();
  const userId = session?.user?.id;
  const isAdmin = (session?.user as any)?.role === 'admin' || isOpsAdmin(userId);
  if (!userId || !isAdmin) {
    return NextResponse.json({ success: false, error: 'forbidden' }, { status: 403 });
  }

  const days = Math.max(1, Math.min(365, Number(new URL(request.url).searchParams.get('days')) || 30));

  // 惰性回灌兜底:instrumentation 启动已触发过一次;标记文件在,这里立即
  // 返回 0(幂等),仅覆盖 instrumentation 未跑到/数据目录晚就绪的边缘情况
  try {
    backfillOpsFromMissions();
  } catch {
    // best-effort,回灌失败不影响读现有流水
  }

  const events = readOpsEvents();
  const ops = aggregateOps(events, Date.now(), days);
  return NextResponse.json({ success: true, days, eventCount: events.length, ops });
}
