import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import { loadScriptSkills, scanSkillPacks, skillPackDirs } from '@agtpilot/plugin-skill';
import { listSkillCards } from '@/lib/skill-cards';
import {
  listInstalledPacks,
  deleteSkillCard,
  uninstallSkillPack,
  isSkillMarketEnabled,
} from '@/lib/skill-center';

/**
 * GET /api/skills
 * 技能中心清单:我的技能卡(TRS 蒸馏)+ 已引用生态技能包(用户安装域)+
 * 内置技能(flow 声明式浏览器流程 + global pack 沙箱技能包,只读展示)。
 */
export async function GET() {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ success: false, error: 'Unauthorized: 请先登录' }, { status: 401 });
    }
    const userId = session.user.id;

    const cards = listSkillCards(userId).map((c) => ({
      id: c.id,
      trigger: c.trigger,
      steps: c.steps,
      avoid: c.avoid,
      check: c.check,
      risk: c.risk,
      keywords: c.keywords,
      hitCount: c.hitCount || 0,
      sourceMissionId: c.sourceMissionId,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
    }));

    // 内置 flow(声明式浏览器技能;含 gate 状态由前端只读展示,开关在工坊/托管页)
    const flows = loadScriptSkills().skills.map((s) => ({
      form: 'flow' as const,
      name: s.name,
      description: s.description,
    }));
    // 内置 pack(全局沙箱技能包,/opt/skills 或 env 覆盖)
    const builtinPacks = scanSkillPacks(skillPackDirs(), 'global').map((p) => ({
      form: 'pack' as const,
      name: p.name,
      description: p.description,
      hasScripts: p.hasScripts,
    }));

    const installed = listInstalledPacks(userId).map((p) => ({
      name: p.name,
      description: p.description,
      dirName: p.dirName,
      hasScripts: p.hasScripts,
      importedAt: p.importedAt,
      fileCount: p.provenance?.fileCount,
      source: p.provenance?.source,
      contentHash: p.provenance?.contentHash,
    }));

    return NextResponse.json({
      success: true,
      marketEnabled: isSkillMarketEnabled(),
      cards,
      builtin: { flows, packs: builtinPacks },
      installed,
    });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}

/**
 * POST /api/skills
 * 技能中心写操作:
 * - {action:'delete-card', id}      删除技能卡(台账留痕)
 * - {action:'uninstall-pack', name} 解除引用生态技能包(删目录 + 台账)
 */
export async function POST(req: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ success: false, error: 'Unauthorized: 请先登录' }, { status: 401 });
    }
    const userId = session.user.id;
    const body = await req.json();

    if (body.action === 'delete-card' && typeof body.id === 'string') {
      const res = deleteSkillCard(userId, body.id);
      if (!res.ok) {
        return NextResponse.json({ success: false, error: res.error }, { status: 404 });
      }
      return NextResponse.json({ success: true, message: '技能卡已删除', trigger: res.trigger });
    }

    if (body.action === 'uninstall-pack' && typeof body.name === 'string') {
      const res = uninstallSkillPack(userId, body.name);
      if (!res.ok) {
        const status = res.error.startsWith('not-found') ? 404 : 400;
        return NextResponse.json({ success: false, error: res.error }, { status });
      }
      return NextResponse.json({ success: true, message: `已解除引用「${res.name}」`, installed: listInstalledPacks(userId).map((p) => p.dirName) });
    }

    return NextResponse.json({ success: false, error: `未知操作: ${String(body.action).slice(0, 50)}` }, { status: 400 });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
