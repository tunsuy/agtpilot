import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import { getUserMemories, saveUserMemory, deleteUserMemory, getUserData, saveUserData } from '@/lib/user-store';

/**
 * GET /api/memories
 * 获取当前登录用户沉淀的个人长期记忆与偏好
 */
export async function GET() {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json(
        { success: false, error: 'Unauthorized: 请先登录' },
        { status: 401 }
      );
    }

    const userId = session.user.id;
    const memories = getUserMemories(userId);

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
 * 存储、删除或修改当前登录用户的个人记忆偏好
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
      const updated = deleteUserMemory(userId, body.id);
      return NextResponse.json({
        success: true,
        message: `Memory ${body.id} deleted.`,
        memories: updated,
      });
    }

    if (body.action === 'clear') {
      const udata = getUserData(userId);
      udata.memories = [];
      saveUserData(udata);
      return NextResponse.json({
        success: true,
        message: 'All memories cleared.',
        memories: [],
      });
    }

    const { title, content, category, id } = body;
    const memoryPayload = body.memory || { title, content, category, id };

    if (!memoryPayload.title || !memoryPayload.content) {
      return NextResponse.json({ success: false, error: 'Title and content are required' }, { status: 400 });
    }

    const newMemory = {
      id: memoryPayload.id || `mem_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      title: String(memoryPayload.title).trim(),
      content: String(memoryPayload.content).trim(),
      category: memoryPayload.category || 'preference',
      confidence: memoryPayload.confidence ?? 1.0,
      updatedAt: Date.now(),
      // 会话自动提炼走 memory-service 直接落库；本路由收到的均为用户手动添加
      source: memoryPayload.source === 'auto' ? 'auto' : 'manual',
      subject: memoryPayload.subject === 'agent' ? 'agent' : 'user',
    };

    const updated = saveUserMemory(userId, newMemory);

    return NextResponse.json({
      success: true,
      memory: newMemory,
      memories: updated,
    });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
