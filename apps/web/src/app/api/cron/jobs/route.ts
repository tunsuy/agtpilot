import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import { getUserCronJobs, saveUserCronJob, deleteUserCronJob } from '@/lib/user-store';
import { getNextCronRun, isValidCronPattern } from '@/lib/cron-utils';
import { getAgentBackend } from '@/lib/agent-backend';

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
      const newJob = {
        id: `cron_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        name: name.trim(),
        pattern: trimmedPattern,
        prompt: prompt.trim(),
        runCount: 0,
        status: 'active',
        nextRun,
      };
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
      backend.unregisterUserCronJob(id);
      const jobs = deleteUserCronJob(userId, id);
      return NextResponse.json({ success: true, jobs });
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
