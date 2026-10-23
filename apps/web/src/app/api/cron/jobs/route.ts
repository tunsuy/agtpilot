import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import {
  getUserCronJobs,
  saveUserCronJob,
  deleteUserCronJob,
  getUserMissions,
  deleteUserMission,
} from '@/lib/user-store';
import { getNextCronRun, isValidCronPattern } from '@/lib/cron-utils';
import { getAgentBackend } from '@/lib/agent-backend';
import { normalizeCronScenario } from '@/lib/cron-scenario';
import { CRUISE_TITLE_PREFIX } from '@/lib/mission-wire';

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
    // 确保后台调度器已经完成激活与挂载
    const backend = getAgentBackend();
    backend.initCronScheduler();

    const jobs = getUserCronJobs(userId);
    // 动态同步更新 active 状态下的下一次触发时间
    const updatedJobs = jobs.map((j: any) => {
      if (j.status === 'active') {
        const next = getNextCronRun(j.pattern);
        if (next) j.nextRun = next;
      }
      return j;
    });
    return NextResponse.json({ success: true, jobs: updatedJobs });
  } catch (err: any) {
    console.error('Error in GET /api/cron/jobs:', err);
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}

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
    const { action, id, name, pattern, prompt } = body;
    const backend = getAgentBackend();

    if (action === 'create') {
      if (!name || !pattern || !prompt) {
        return NextResponse.json({ success: false, error: '缺少必填字段 (name, pattern, prompt)' }, { status: 400 });
      }
      const trimmedPattern = pattern.trim();
      if (!isValidCronPattern(trimmedPattern)) {
        return NextResponse.json({ success: false, error: '无效的 Cron 表达式，请检查格式' }, { status: 400 });
      }

      const nextRun = getNextCronRun(trimmedPattern) || new Date(Date.now() + 3600 * 1000).toISOString();
      // scenario 订阅标记(白名单;触发时按最新档案重建 prompt,prompt 字段仅作展示快照)
      const scenario = normalizeCronScenario(body.scenario);
      const newJob: any = {
        id: `cron_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        name: name.trim(),
        pattern: trimmedPattern,
        prompt: prompt.trim(),
        runCount: 0,
        status: 'active',
        nextRun,
      };
      if (scenario) newJob.scenario = scenario;
      // 显式技能包引用:仅普通任务(场景订阅 = 内置 SOP,永不携带);
      // 白名单收敛为 canonical name,永不信任客户端
      if (!scenario && Array.isArray(body.skillPacks) && body.skillPacks.length) {
        const { sanitizeSkillPackRefs } = await import('@/lib/skill-center');
        const packs = sanitizeSkillPackRefs(userId, body.skillPacks);
        if (packs.length) newJob.skillPacks = packs;
      }
      const jobs = saveUserCronJob(userId, newJob);
      // 同步注册到后台 Node.js 内存定时调度器
      backend.registerUserCronJob(userId, newJob);

      return NextResponse.json({ success: true, newJob, jobs });
    }

    if (action === 'toggle') {
      if (!id) {
        return NextResponse.json({ success: false, error: '缺少任务 ID' }, { status: 400 });
      }
      const existing = getUserCronJobs(userId).find((j: any) => j.id === id);
      if (existing) {
        existing.status = existing.status === 'active' ? 'paused' : 'active';
        if (existing.status === 'active') {
          existing.nextRun = getNextCronRun(existing.pattern) || existing.nextRun;
          saveUserCronJob(userId, existing);
          backend.registerUserCronJob(userId, existing);
        } else {
          saveUserCronJob(userId, existing);
          backend.unregisterUserCronJob(id);
        }
      }
      const jobs = getUserCronJobs(userId);
      return NextResponse.json({ success: true, jobs });
    }

    if (action === 'update') {
      if (!id) {
        return NextResponse.json({ success: false, error: '缺少任务 ID' }, { status: 400 });
      }
      const existing = getUserCronJobs(userId).find((j: any) => j.id === id);
      if (!existing) {
        return NextResponse.json({ success: false, error: '任务不存在' }, { status: 404 });
      }
      if (pattern) {
        const trimmed = pattern.trim();
        if (!isValidCronPattern(trimmed)) {
          return NextResponse.json({ success: false, error: '无效的 Cron 表达式，请检查格式' }, { status: 400 });
        }
        existing.pattern = trimmed;
        existing.nextRun = getNextCronRun(trimmed) || existing.nextRun;
      }
      if (name) existing.name = name.trim();
      if (prompt) existing.prompt = prompt.trim();
      // 技能包引用:显式数组 = 覆盖(编辑表单是 prefill UI,[]=清空);
      // 清空赋 undefined 而非 delete —— saveUserCronJob 是 merge-spread,缺键不清旧值。
      // 场景任务忽略该字段(内置 SOP 永不携带)
      if (Array.isArray(body.skillPacks) && !existing.scenario) {
        const { sanitizeSkillPackRefs } = await import('@/lib/skill-center');
        const packs = sanitizeSkillPackRefs(userId, body.skillPacks);
        existing.skillPacks = packs.length ? packs : undefined;
      }
      saveUserCronJob(userId, existing);

      if (existing.status === 'active') {
        backend.registerUserCronJob(userId, existing);
      } else {
        backend.unregisterUserCronJob(id);
      }

      const jobs = getUserCronJobs(userId);
      return NextResponse.json({ success: true, updatedJob: existing, jobs });
    }

    if (action === 'cancel' || action === 'delete') {
      if (!id) {
        return NextResponse.json({ success: false, error: '缺少任务 ID' }, { status: 400 });
      }
      // 级联清理要按任务名回退匹配旧数据(无 cronJobId 的历史巡航会话),先留住任务记录
      const existing = getUserCronJobs(userId).find((j: any) => j.id === id);
      backend.unregisterUserCronJob(id);
      const jobs = deleteUserCronJob(userId, id);

      // 级联清理该任务产生的巡航会话(持久化 + 内存态):只删终态(DONE/INTERRUPTED)
      // —— 执行中的回路还在写盘,删了会被 checkpoint 重新落盘,让它跑完(任务卡已删,
      // 不会再展示;下轮触发也不会再来,调度已注销)。旧数据无 cronJobId 时按
      // 「【自动巡航】+任务名」精确回退匹配(与前端 runsOf 同口径,不误删手动会话)
      const deletedRunIds: string[] = [];
      if (existing) {
        const cruiseTitle = `${CRUISE_TITLE_PREFIX}${existing.name}`;
        const DELETABLE = new Set(['DONE', 'INTERRUPTED']);
        const owned = (m: any) =>
          m && (m.cronJobId === id || (!m.cronJobId && m.title === cruiseTitle));
        for (const m of getUserMissions(userId) || []) {
          if (!owned(m) || !DELETABLE.has(m.status)) continue;
          deleteUserMission(userId, m.id);
          deletedRunIds.push(m.id);
        }
        backend.state.missions = backend.state.missions.filter(
          (m) => !(m.userId === userId && owned(m) && DELETABLE.has(m.status))
        );
      }

      return NextResponse.json({ success: true, jobs, deletedRunIds });
    }

    if (action === 'trigger') {
      if (!id) {
        return NextResponse.json({ success: false, error: '缺少任务 ID' }, { status: 400 });
      }
      const existing = getUserCronJobs(userId).find((j: any) => j.id === id);
      if (!existing) {
        return NextResponse.json({ success: false, error: '任务不存在' }, { status: 404 });
      }
      backend.triggerUserCronJob(userId, id);
      const jobs = getUserCronJobs(userId);
      return NextResponse.json({ success: true, message: '已触发立即执行', jobs });
    }

    return NextResponse.json({ success: false, error: '未知 action' }, { status: 400 });
  } catch (err: any) {
    console.error('Error in POST /api/cron/jobs:', err);
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
