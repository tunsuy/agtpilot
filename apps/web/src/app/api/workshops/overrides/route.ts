import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { getWorkshopOverrides, workshopOverridesDir } from '@/workshops/overrides';

/**
 * 预览诚实:客户端预览渲染打包模板;本端点暴露哪些工坊存在服务端覆盖版本,
 * 预览处据此提示「服务端存在覆盖版本,以实际发送为准」—— 不隐藏分歧。
 */
export async function GET() {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
    }
    const { byId } = getWorkshopOverrides();
    return NextResponse.json({ success: true, overridden: Object.keys(byId) });
  } catch (err: any) {
    // 名单拿不到不阻塞预览:按「无覆盖」处理并留日志
    console.warn('[WORKSHOP-OVERRIDES] 读取覆盖名单失败(dir=%s):', workshopOverridesDir(), err?.message || err);
    return NextResponse.json({ success: true, overridden: [] });
  }
}
