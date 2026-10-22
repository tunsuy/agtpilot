import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import { fetchMarketIndex, fetchMarketSkillDetail } from '@/lib/skill-center';

/**
 * GET /api/skills/market
 * 生态技能市场索引(服务端拉 GitHub registry 源,内存缓存 10min;?refresh=1 强刷)。
 * ?repo=&path=&ref= 返回单个技能的 SKILL.md 详情预览(raw 拉取,不占 API 限额)。
 * 单源失败显式带 error 字段(反模式 #14:失败真实,不静默)。
 */
export async function GET(req: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ success: false, error: 'Unauthorized: 请先登录' }, { status: 401 });
    }
    const url = new URL(req.url);
    const repo = url.searchParams.get('repo');
    const skillPath = url.searchParams.get('path');

    if (repo && skillPath) {
      const detail = await fetchMarketSkillDetail(repo, skillPath, url.searchParams.get('ref') || 'HEAD');
      if (!detail.ok) {
        return NextResponse.json({ success: false, error: detail.error }, { status: 502 });
      }
      return NextResponse.json({ success: true, detail });
    }

    const index = await fetchMarketIndex(url.searchParams.get('refresh') === '1');
    return NextResponse.json({ success: true, ...index });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
