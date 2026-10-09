import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import { getDeletionLedger, readMemoryAudit } from '@/lib/user-store';
import {
  listActiveMemories,
  listSoftDeletedMemories,
  softDeleteUserMemory,
  restoreUserMemory,
  upsertManualMemory,
} from '@/lib/memory-service';

/**
 * GET /api/memories
 * 获取当前登录用户沉淀的个人长期记忆与偏好(治理视角:默认只返回活跃条目,
 * 软删/被取代/授权纪元降级的记忆不出现)。
 * ?deleted=1 返回软删保留期内的条目与删除台账;?audit=1 返回最近审计日志。
 */
export async function GET(req: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json(
        { success: false, error: 'Unauthorized: 请先登录' },
        { status: 401 }
      );
    }

    const userId = session.user.id;
    const url = new URL(req.url);

    if (url.searchParams.get('audit')) {
      const limit = Math.min(500, Number(url.searchParams.get('limit')) || 100);
      return NextResponse.json({
        success: true,
        audit: readMemoryAudit(userId, limit),
        ledger: getDeletionLedger(userId),
      });
    }

    if (url.searchParams.get('deleted')) {
      return NextResponse.json({
        success: true,
        deleted: listSoftDeletedMemories(userId),
        ledger: getDeletionLedger(userId),
      });
    }

    const memories = listActiveMemories(userId);
    return NextResponse.json({
      success: true,
      total: memories.length,
      memories,
    });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}

/**
 * POST /api/memories
 * 存储、(软)删除、恢复或修改当前登录用户的个人记忆偏好。
 * 删除是软删除:进删除台账、传导衍生记忆、保留期内可 restore(治理回退弧 §3.2)。
 */
export async function POST(req: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json(
        { success: false, error: 'Unauthorized: 请先登录' },
        { status: 401 }
      );
    }

    const userId = session.user.id;
    const body = await req.json();

    if (body.action === 'delete' && typeof body.id === 'string') {
      const res = softDeleteUserMemory(userId, body.id, {
        requestedBy: 'user',
        reason: typeof body.reason === 'string' ? body.reason : undefined,
        actor: 'user',
      });
      if (!res.ok) {
        return NextResponse.json(
          { success: false, error: res.rejected === 'not-found' ? '记忆不存在或已删除' : '受保护条目不可删除' },
          { status: 404 }
        );
      }
      return NextResponse.json({
        success: true,
        message: `Memory ${body.id} soft-deleted (recoverable).`,
        ledgerId: res.ledgerId,
        propagatedCount: res.propagatedCount,
        memories: listActiveMemories(userId),
      });
    }

    if (body.action === 'restore' && typeof body.id === 'string') {
      const res = restoreUserMemory(userId, body.id, 'user');
      if (!res.ok) {
        return NextResponse.json(
          { success: false, error: res.error === 'expired' ? '已超过软删保留期,无法恢复' : '记忆不存在' },
          { status: 404 }
        );
      }
      return NextResponse.json({
        success: true,
        message: `Memory ${body.id} restored.`,
        memories: listActiveMemories(userId),
      });
    }

    if (body.action === 'clear') {
      // 全量清空同样走软删(逐条留台账),不做不可追溯的物理清空
      const active = listActiveMemories(userId);
      let deleted = 0;
      for (const m of active) {
        const res = softDeleteUserMemory(userId, m.id, {
          requestedBy: 'user',
          reason: '用户一键清空记忆库',
          actor: 'user',
        });
        if (res.ok) deleted++;
      }
      return NextResponse.json({
        success: true,
        message: `All memories cleared (${deleted} soft-deleted, recoverable).`,
        memories: [],
      });
    }

    const { title, content, category, id } = body;
    const memoryPayload = body.memory || { title, content, category, id };

    if (!memoryPayload.title || !memoryPayload.content) {
      return NextResponse.json({ success: false, error: 'Title and content are required' }, { status: 400 });
    }

    // 会话自动提炼走 memory-service 直接落库;本路由收到的均为用户手动操作,
    // 统一经 upsertManualMemory 构建六维治理元数据(grantedBy=user-manual,
    // rule 类自动 protected)并留审计
    const newMemory = upsertManualMemory(userId, {
      id: memoryPayload.id,
      title: String(memoryPayload.title),
      content: String(memoryPayload.content),
      category: memoryPayload.category,
      subject: memoryPayload.subject === 'agent' ? 'agent' : 'user',
      confidence: memoryPayload.confidence,
    });

    return NextResponse.json({
      success: true,
      memory: newMemory,
      memories: listActiveMemories(userId),
    });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
