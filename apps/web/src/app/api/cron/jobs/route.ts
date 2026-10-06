import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import { getUserCronJobs, saveUserCronJob, deleteUserCronJob } from '@/lib/user-store';

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
    const jobs = getUserCronJobs(userId);
    return NextResponse.json({ success: true, jobs });
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

    if (action === 'create') {
      if (!name || !pattern || !prompt) {
        return NextResponse.json({ success: false, error: '缺少必填字段 (name, pattern, prompt)' }, { status: 400 });
      }
      const newJob = {
        id: `cron_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        name,
        pattern,
        prompt,
        runCount: 0,
        status: 'active',
        nextRun: new Date(Date.now() + 3600 * 1000).toISOString(),
      };
      const jobs = saveUserCronJob(userId, newJob);
      return NextResponse.json({ success: true, newJob, jobs });
    }

    if (action === 'toggle') {
      if (!id) {
        return NextResponse.json({ success: false, error: '缺少任务 ID' }, { status: 400 });
      }
      const existing = getUserCronJobs(userId).find((j: any) => j.id === id);
      if (existing) {
        existing.status = existing.status === 'active' ? 'paused' : 'active';
        saveUserCronJob(userId, existing);
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
      if (name) existing.name = name;
      if (pattern) existing.pattern = pattern;
      if (prompt) existing.prompt = prompt;
      saveUserCronJob(userId, existing);
      const jobs = getUserCronJobs(userId);
      return NextResponse.json({ success: true, updatedJob: existing, jobs });
    }

    if (action === 'cancel' || action === 'delete') {
      if (!id) {
        return NextResponse.json({ success: false, error: '缺少任务 ID' }, { status: 400 });
      }
      const jobs = deleteUserCronJob(userId, id);
      return NextResponse.json({ success: true, jobs });
    }

    return NextResponse.json({ success: false, error: '未知 action' }, { status: 400 });
  } catch (err: any) {
    console.error('Error in POST /api/cron/jobs:', err);
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
