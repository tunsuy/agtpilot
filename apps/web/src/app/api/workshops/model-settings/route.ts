import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import { getWorkshopModelSettings, saveWorkshopModelSetting, deleteWorkshopModelSetting } from '@/lib/user-store';
import { getWorkshop } from '@/workshops/registry';

/**
 * 工坊模型设置(每用户 × 每工坊,工坊卡片持久生效)。
 *
 * 思考深度档位:任务级(工坊)> 连接器全局 > env > 分支缺省 —— 重产出轻推理的
 * 工坊(小说日更等)单独压档,连接器设置退化为全局缺省。巡航触发时服务端现读,
 * 存量巡航任务无需重建。
 *
 * GET  /api/workshops/model-settings            → 全部设置(workshopId → setting)
 * POST /api/workshops/model-settings            → body.action = 'upsert' | 'delete'
 *   upsert: { action, workshopId, reasoningEffort?: 'low'|'medium'|'high' }
 *           reasoningEffort 空/缺省 = 清档跟随连接器(与 delete 等价,语义更直观)
 */
const VALID_EFFORTS = new Set(['low', 'medium', 'high']);

export async function GET() {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ success: false, error: 'Unauthorized: 请先登录' }, { status: 401 });
    }
    const settings = getWorkshopModelSettings(session.user.id);
    return NextResponse.json({ success: true, settings });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ success: false, error: 'Unauthorized: 请先登录' }, { status: 401 });
    }
    const userId = session.user.id;
    const body = await req.json();
    const { action } = body;

    const workshopId = typeof body.workshopId === 'string' ? body.workshopId.trim() : '';
    if (!workshopId) {
      return NextResponse.json({ success: false, error: '缺少 workshopId' }, { status: 400 });
    }
    // 工坊白名单:不在注册表的 id 一律拒绝,防止往 user-store 写无效键
    if (!getWorkshop(workshopId as any)) {
      return NextResponse.json({ success: false, error: `未知工坊: ${workshopId}` }, { status: 400 });
    }

    if (action === 'upsert') {
      // 入参净化:''/undefined/非法值 = 清档跟随连接器;合法档位 = 写档
      const effort = typeof body.reasoningEffort === 'string' ? body.reasoningEffort.trim() : '';
      if (!effort) {
        const settings = deleteWorkshopModelSetting(userId, workshopId);
        return NextResponse.json({ success: true, settings });
      }
      if (!VALID_EFFORTS.has(effort)) {
        return NextResponse.json({ success: false, error: `非法思考深度: ${effort}` }, { status: 400 });
      }
      const settings = saveWorkshopModelSetting(userId, workshopId, {
        reasoningEffort: effort as 'low' | 'medium' | 'high',
        updatedAt: Date.now(), // 函数内会再刷一次,这里满足类型必填
      });
      return NextResponse.json({ success: true, settings });
    }

    if (action === 'delete') {
      const settings = deleteWorkshopModelSetting(userId, workshopId);
      return NextResponse.json({ success: true, settings });
    }

    return NextResponse.json({ success: false, error: '未知 action' }, { status: 400 });
  } catch (err: any) {
    console.error('Error in POST /api/workshops/model-settings:', err);
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
