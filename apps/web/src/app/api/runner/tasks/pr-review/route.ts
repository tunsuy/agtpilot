import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { fetchPrReviewContext } from '@/lib/pr-review';

/**
 * GET /api/runner/tasks/pr-review?prUrl=<PR 直达链接>(会话侧)
 *
 * 「响应 review」跟进派发前,云端替用户拉取该 PR 的 review 评论(公开 REST API,
 * 匿名可读,零用户凭据;未认证限流 60 次/时/IP,超限如实报错)。渲染好的上下文
 * 文本回填派发弹窗,用户可增删后再派发(人工取舍是派发门的设计意图)。
 */
export async function GET(req: Request) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ success: false, error: 'Unauthorized: 请先登录' }, { status: 401 });
    }
    const prUrl = new URL(req.url).searchParams.get('prUrl') ?? '';
    if (!prUrl || prUrl.length > 500) {
      return NextResponse.json({ success: false, error: '缺少 prUrl 参数' }, { status: 400 });
    }
    const r = await fetchPrReviewContext(prUrl);
    if (!r.ok) {
      // 拉取失败不 500:弹窗要拿着错误文案给「手工粘贴」降级路径
      return NextResponse.json({ success: false, error: r.error });
    }
    return NextResponse.json({ success: true, context: r.context, stats: r.stats });
  } catch (e: any) {
    return NextResponse.json({ success: false, error: e?.message || String(e) }, { status: 500 });
  }
}
