import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { getUserCronJobs, getUserGoals } from '@/lib/user-store';
import { getNextCronRun } from '@/lib/cron-utils';
import { listActiveMemories } from '@/lib/memory-service';
import { getConnectorStatusList } from '@/lib/connectors-catalog';
import { buildStatusList } from '@/lib/mcp-status';

/**
 * GET /api/bootstrap —— 首屏聚合接口
 *
 * 工作台打开时首页/导航徽标需要 connectors、MCP 就绪数、memories、cronJobs、
 * goals 五类数据。此前各打一个接口 = 5 次 RTT + 5 次 auth() 解码 + 5 次
 * 用户 profile 读盘。这里合并成一次：单次 auth、单次 profile 读（配合
 * user-store 的 TTL 缓存），并行装配后一次返回。
 *
 * agent 运行态（missions/viewport/...）不走这里 —— 它由 SSE init 全量下发。
 */
export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ success: false, error: 'Unauthorized: 请先登录' }, { status: 401 });
  }

  const userId = session.user.id;

  const connectors = getConnectorStatusList(userId);
  const mcpConnectors = buildStatusList(userId);

  const cronJobs = getUserCronJobs(userId).map((j: any) => {
    if (j.status === 'active') {
      const next = getNextCronRun(j.pattern);
      if (next) j.nextRun = next;
    }
    return j;
  });

  return NextResponse.json({
    success: true,
    connectors,
    mcpConnectedCount: mcpConnectors.filter((c) => c.status === 'connected').length,    memories: listActiveMemories(userId),
    cronJobs,
    goals: getUserGoals(userId),
  });
}
