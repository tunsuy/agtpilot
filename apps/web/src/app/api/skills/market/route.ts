import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import { fetchMarketIndex, fetchMarketSkillDetail } from '@/lib/skill-center';

/**
 * GET /api/skills/market
 * 生态技能市场索引(服务端拉 registry 源:GitHub trees / 魔搭 openapi / SkillHub
 * api.skillhub.cn,内存缓存 10min;?refresh=1 强刷;?search= 搜索态 —— 魔搭与
 * SkillHub 走服务端搜索,github 源本地过滤,不读不写缓存)。
 * ?repo=&path=&ref= 返回单个技能的 SKILL.md 详情预览;?platform=modelscope|skillhub
 * 时 repo=平台技能 id(魔搭 id / SkillHub canonicalName @handle/slug)、path 可省
 * (恒为仓库根目录);skillhub 详情可携带 security 字段(腾讯安全扫描摘要,
 * best-effort),原样透传。
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
    const platformParam = url.searchParams.get('platform');
    const platform =
      platformParam === 'modelscope' || platformParam === 'skillhub' ? platformParam : 'github';

    if (repo && (skillPath || platform !== 'github')) {
      const detail = await fetchMarketSkillDetail(
        repo,
        skillPath || '',
        url.searchParams.get('ref') || 'HEAD',
        platform
      );
      if (!detail.ok) {
        return NextResponse.json({ success: false, error: detail.error }, { status: 502 });
      }
      return NextResponse.json({ success: true, detail });
    }

    const index = await fetchMarketIndex(
      url.searchParams.get('refresh') === '1',
      url.searchParams.get('search') || undefined
    );
    return NextResponse.json({ success: true, ...index });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
