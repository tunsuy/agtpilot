import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import { importSkillPack } from '@/lib/skill-center';

/**
 * POST /api/skills/import
 * 引用(导入)生态技能包到当前用户安装域。
 * body: { repo, path, ref?, riskAck: true, overwrite? }
 * riskAck 必须显式为 true(第三方代码风险明示已在 UI 弹出确认)——
 * 服务端双重强制,缺省/伪造 false 一律拒绝。
 */
export async function POST(req: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ success: false, error: 'Unauthorized: 请先登录' }, { status: 401 });
    }
    const userId = session.user.id;
    const body = await req.json();

    const res = await importSkillPack(userId, {
      repo: String(body.repo || ''),
      path: String(body.path || ''),
      ref: typeof body.ref === 'string' && body.ref ? body.ref : undefined,
      riskAck: body.riskAck === true,
      overwrite: body.overwrite === true,
    });

    if (!res.ok) {
      const status = res.error.startsWith('already-installed') ? 409 : res.error.includes('不合法') ? 400 : 502;
      return NextResponse.json({ success: false, error: res.error }, { status });
    }
    return NextResponse.json({
      success: true,
      message: `已引用「${res.pack.name}」`,
      pack: {
        name: res.pack.name,
        description: res.pack.description,
        dirName: res.pack.dirName,
        hasScripts: res.pack.hasScripts,
        importedAt: res.pack.importedAt,
        fileCount: res.pack.provenance?.fileCount,
        source: res.pack.provenance?.source,
      },
    });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
