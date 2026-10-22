import { NextResponse } from 'next/server';
import { getAgentBackend } from '@/lib/agent-backend';
import { auth } from '@/auth';
import { getUserMissions } from '@/lib/user-store';
import { stripConversation, toArtifactSummary, isTerminalMission } from '@/lib/mission-wire';

/**
 * 单条会话懒回水(首屏瘦身配套,lib/mission-wire.ts):
 * state/init 只发终态历史会话的摘要(stripped),用户选中某条会话时前端
 * 打这里回填。分两档:
 *
 * - 缺省(core):元信息 + steps + plan 等中栏会话流所需字段。终态会话的
 *   右栏重字段不随行 —— artifact 长正文降级摘要投影、terminalLogs/viewport
 *   (截图数百 KB)整个不带,响应里的 parts 标记声明各分片是否在位;
 *   活跃会话仍回全量(实时渲染需要,且 SSE 增量随时到达,分片无意义)。
 * - ?parts=artifact,terminal,viewport(按需分片):只回请求的重字段 +
 *   parts 就位标记,前端合并进会话对象。右栏切到对应 tab 才触发,
 *   高延迟链路下会话详情的首拉不再为用不到的截图/日志/全文买单。
 *
 * 取数顺序:内存活引用优先(含最新进度,比如刚被续聊唤醒的会话),
 * 其次持久化库。两路都做归属校验(只回本人会话)。
 * conversationMessages 不下发:前端零消费,续聊回水走服务端持久化库。
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) {
    return NextResponse.json({ success: false, error: 'unauthorized' }, { status: 401 });
  }

  const { id } = await params;
  if (!id) {
    return NextResponse.json({ success: false, error: 'missing id' }, { status: 400 });
  }

  const backend = getAgentBackend();
  let mission = backend.state.missions.find((m) => m.id === id && m.userId === userId);
  if (!mission) {
    // 持久化库路径:getUserMissions 已按 userId 取,天然只有本人数据
    mission = getUserMissions(userId).find((m) => m.id === id);
  }
  if (!mission) {
    return NextResponse.json({ success: false, error: 'not found' }, { status: 404 });
  }

  const url = new URL(req.url);
  const partsParam = url.searchParams.get('parts');

  // ---- 按需分片:只回请求的重字段(全文/日志/截图),前端合并后置位 ----
  if (partsParam) {
    const wanted = new Set(
      partsParam.split(',').map((s) => s.trim()).filter(Boolean)
    );
    const out: any = { id: mission.id, parts: {} as Record<string, boolean> };
    if (wanted.has('artifact')) {
      // 全文原样下发(不截断);无产物也置位,客户端不再重复取
      if (mission.artifact) out.artifact = mission.artifact;
      out.parts.artifact = true;
    }
    if (wanted.has('terminal')) {
      out.terminalLogs = mission.terminalLogs || [];
      out.parts.terminal = true;
    }
    if (wanted.has('viewport')) {
      out.viewport = mission.viewport || null;
      out.parts.viewport = true;
    }
    return NextResponse.json({ success: true, mission: out });
  }

  // ---- core:中栏会话流字段;终态会话剥右栏重字段并声明 parts 标记 ----
  // stripConversation 返回浅拷贝,不会把内存活引用的 conversationMessages 摘掉
  const core: any = stripConversation(mission);
  if (isTerminalMission(mission)) {
    const { terminalLogs: _t, viewport: _v, ...rest } = core;
    const artifact = rest.artifact ? toArtifactSummary(rest.artifact) : rest.artifact;
    return NextResponse.json({
      success: true,
      mission: {
        ...rest,
        ...(artifact !== undefined && artifact !== null ? { artifact } : {}),
        parts: {
          artifact: !artifact?.contentTruncated,
          terminal: false,
          viewport: false,
        },
      },
    });
  }
  return NextResponse.json({ success: true, mission: core });
}
