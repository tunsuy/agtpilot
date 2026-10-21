/**
 * POST /api/workshops/deliver —— 工坊「文档+脚本」直连投递入口。
 *
 * 卡片按钮(确认弹窗放行后)把 { platform, missionId, args } 发到这里,
 * 服务端直调既有落稿工具(公众号草稿箱/知乎托管/小红书托管),定稿正文
 * 全程不过模型;成功后合成一条与真实工具步骤同形的 DONE 步骤回写 mission
 * (防重复投递台账 + 活动流叙述,刷新后按钮终态照旧从步骤推导)。
 *
 * 安全:会话鉴权 → mission 归属校验(只能投自己的任务)→ 平台/参数白名单
 * (lib/direct-delivery.ts)。HIL 边界:前端确认弹窗等价旧编排审批门。
 */
import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import { getAgentBackend } from '@/lib/agent-backend';
import { getUserMissions, saveUserMission } from '@/lib/user-store';
import {
  executeDirectDelivery,
  buildDeliveryStep,
  appendDeliveryStepToMission,
  type DirectDeliveryPlatform,
} from '@/lib/direct-delivery';

export const dynamic = 'force-dynamic';

const PLATFORMS: DirectDeliveryPlatform[] = ['wechat_mp', 'zhihu', 'xhs'];

export async function POST(req: NextRequest) {
  try {
    const session = await auth();
    const userId = session?.user?.id;
    if (!userId) {
      return NextResponse.json({ success: false, error: 'Unauthorized: 请先登录' }, { status: 401 });
    }

    const body = await req.json().catch(() => null);
    const platform = body?.platform;
    const missionId = typeof body?.missionId === 'string' ? body.missionId : undefined;
    const args = body?.args;
    if (typeof platform !== 'string' || !PLATFORMS.includes(platform as DirectDeliveryPlatform)) {
      return NextResponse.json({ success: false, error: '未知投递平台' }, { status: 400 });
    }
    if (!args || typeof args !== 'object') {
      return NextResponse.json({ success: false, error: '投递参数缺失' }, { status: 400 });
    }

    // 服务端托管浏览器(知乎/小红书写工具注入必需;公众号封面检索用)
    const backend = getAgentBackend();
    await backend.whenReady();
    const browser = backend.ctx?.browser;

    // mission 查找限定当前用户(内存态优先,落盘兜底);缺省 missionId = 裸投递
    let mission;
    if (missionId) {
      mission =
        backend.state.missions.find((m) => m.id === missionId && m.userId === userId) ||
        (getUserMissions(userId) || []).find((m: any) => m.id === missionId);
      if (!mission) {
        return NextResponse.json({ success: false, error: '任务不存在或无权访问' }, { status: 404 });
      }
    }

    const result = await executeDirectDelivery({
      platform,
      userId,
      args,
      mission,
      browser,
    });

    if (result.success && mission) {
      // 投递台账:合成工具步骤回写 mission + 落盘 + 广播(在线 UI 即时刷新)
      try {
        const step = buildDeliveryStep({
          toolName: result.tool,
          args: result.args,
          result: result.result,
        });
        await appendDeliveryStepToMission({
          mission,
          step,
          userId,
          save: saveUserMission,
          broadcast: backend.broadcast.bind(backend),
        });
      } catch (e) {
        // 台账回写失败不影响投递事实(草稿已在平台侧);仅记录,不回滚
        console.error('direct-delivery: 步骤回写失败', e);
      }
    }

    return NextResponse.json(result, { status: result.success ? 200 : 400 });
  } catch (err: any) {
    console.error('Error in POST /api/workshops/deliver:', err);
    return NextResponse.json({ success: false, error: err?.message || '投递失败' }, { status: 500 });
  }
}
