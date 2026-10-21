import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { getAgentBackend } from '@/lib/agent-backend';
import { getUserMissions } from '@/lib/user-store';
import { findLatestTopicPicks, hasRunningTopicMission } from '@/workshops/xhs/topic-picks';

export const dynamic = 'force-dynamic';

/**
 * 小红书「本周选题」服务端查询(docs/design/cruise-session-split.md)。
 *
 * 此前选题锚点在前端跑:工坊弹窗拿标题标记「小红书每周选题」在 state/init
 * 下发的会话列表里搜最新已完成选题任务再解析步骤正文。两个结构性问题:
 * 1. 终态会话下发行是 stripped 摘要(steps 已剥),刷新页面后前端根本解析
 *    不到清单 —— 只有选题任务恰好还在飞的窗口期能看到(半残);
 * 2. 巡航会话不再进工作台下行后,前端列表里连锚点行都没有了。
 *
 * 改服务端直查:持久化库 + 内存活引用里的会话带全量 steps,解析永远可用;
 * 纯函数(parseTopicPicks/findLatestTopicPicks)原样复用,契约测试不动。
 *
 * GET → { success, picks, fallback, missionId, running }
 */
export async function GET() {
  try {
    const session = await auth();
    const userId = session?.user?.id;
    if (!userId) {
      return NextResponse.json({ success: false, error: 'Unauthorized: 请先登录' }, { status: 401 });
    }

    // 内存活引用优先(刚跑完还没落盘窗口的最新状态),持久化库兜底;按 id 去重
    const backend = getAgentBackend();
    const memory = backend.state.missions.filter((m) => m.userId === userId);
    const seen = new Set(memory.map((m) => m.id));
    const all = [...memory, ...getUserMissions(userId).filter((m: any) => !seen.has(m.id))];

    const latest = findLatestTopicPicks(all);
    return NextResponse.json({
      success: true,
      picks: latest?.result.picks ?? [],
      fallback: latest?.result.fallback ?? null,
      missionId: latest?.missionId ?? null,
      running: hasRunningTopicMission(all),
    });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err?.message || String(err) }, { status: 500 });
  }
}
