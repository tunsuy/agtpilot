import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import {
  getPolicyProposals,
  resolvePolicyProposal,
  readSandboxAudit,
  getSandboxConfig,
} from '@/lib/user-store';
import { getGovernanceBus } from '@/lib/governance-bus';

/**
 * GET /api/sandbox-proposals
 * 当前用户的沙箱权限提案(deny-log → proposal → 人工审核 → 热更新,
 * docs/design/sandbox-control-hardening.md §4.4)+ 最近拒绝审计 + 沙箱配置。
 * ?status=pending|approved|rejected 过滤;?audit=1 返回拒绝审计日志。
 */
export async function GET(req: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ success: false, error: 'Unauthorized: 请先登录' }, { status: 401 });
    }
    const userId = session.user.id;
    const url = new URL(req.url);

    if (url.searchParams.get('audit')) {
      const limit = Math.min(500, Number(url.searchParams.get('limit')) || 100);
      return NextResponse.json({ success: true, audit: readSandboxAudit(userId, limit) });
    }

    const statusParam = url.searchParams.get('status');
    const status =
      statusParam === 'pending' || statusParam === 'approved' || statusParam === 'rejected'
        ? statusParam
        : undefined;
    return NextResponse.json({
      success: true,
      proposals: getPolicyProposals(userId, status),
      config: getSandboxConfig(userId),
    });
  } catch (e: any) {
    return NextResponse.json({ success: false, error: e?.message || String(e) }, { status: 500 });
  }
}

/**
 * POST /api/sandbox-proposals
 * 人工裁决一条提案:{ proposalId, action: 'approve' | 'reject' }。
 * approve → 配置合并进 user-store(credential-binding / expose-env)并经
 * governance-bus 广播 PermissionResolved —— agent-backend 热更新该用户
 * in-flight 任务的 taskSandbox 活引用(不重启任务)。
 */
export async function POST(req: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ success: false, error: 'Unauthorized: 请先登录' }, { status: 401 });
    }
    const userId = session.user.id;
    const body = await req.json().catch(() => ({}));
    const { proposalId, action } = body || {};
    if (!proposalId || (action !== 'approve' && action !== 'reject')) {
      return NextResponse.json(
        { success: false, error: '参数缺失: proposalId 与 action(approve|reject)必填' },
        { status: 400 }
      );
    }

    const resolved = resolvePolicyProposal(userId, String(proposalId), action === 'approve');
    if (!resolved) {
      return NextResponse.json(
        { success: false, error: '提案不存在或已被裁决(仅 pending 可操作)' },
        { status: 404 }
      );
    }

    if (action === 'approve') {
      // 热更新通道:通知 in-flight 任务的 taskSandbox 活引用原地生效
      getGovernanceBus().emitPermissionResolved({
        userId,
        proposalId: resolved.id,
        approved: true,
        kind: resolved.kind,
        payload: { envVar: resolved.detail?.envVar, hosts: resolved.detail?.hosts },
      });
    } else {
      getGovernanceBus().emitPermissionResolved({
        userId,
        proposalId: resolved.id,
        approved: false,
        kind: resolved.kind,
      });
    }

    return NextResponse.json({
      success: true,
      proposal: resolved,
      config: getSandboxConfig(userId),
    });
  } catch (e: any) {
    return NextResponse.json({ success: false, error: e?.message || String(e) }, { status: 500 });
  }
}
