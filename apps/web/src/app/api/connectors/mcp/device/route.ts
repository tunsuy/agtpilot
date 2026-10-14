import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import { getMcpConnectorDef, deviceFlowAvailable, buildUserMcpServers } from '@/lib/mcp-connectors';
import { startDeviceFlow, pollDeviceFlow, cancelDeviceFlow } from '@/lib/mcp-device-flow';
import { getAgentBackend } from '@/lib/agent-backend';
import { resolveConnectorAuth } from '@/lib/connector-bridge';

/**
 * POST /api/connectors/mcp/device —— 设备码授权通道（OAuth 2.0 Device Grant）
 * body: { action: 'start' | 'poll' | 'cancel', connectorId }
 *
 * - start：向服务方申请设备码，中间态（device_code 等）加密落盘，返回 user_code 展示信息；
 * - poll：轮询一次授权结果；success 时 token 已写入用户凭证并预热连接（立即挂工具）；
 * - cancel：用户关闭弹窗，清掉进行中的中间态。
 *
 * 安全：device_code / client_secret 只存在服务端；本路由返回体只含 user_code、
 * 轮询状态与凭证掩码。所有 action 都要求已登录，记录按 (userId, connectorId) 隔离。
 */
export async function POST(req: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ success: false, error: 'Unauthorized: 请先登录后再授权' }, { status: 401 });
    }
    const userId = session.user.id;
    const body = await req.json();
    const { action, connectorId } = body;

    const def = typeof connectorId === 'string' ? getMcpConnectorDef(connectorId) : undefined;
    if (!def || !def.deviceFlow || !def.tokenEnvVar) {
      return NextResponse.json({ success: false, error: `连接器 ${connectorId || '(空)'} 不支持设备码授权` }, { status: 400 });
    }
    if (!deviceFlowAvailable(def)) {
      return NextResponse.json(
        {
          success: false,
          error: `设备码授权未配置：部署环境需设置 ${def.deviceFlow.clientIdEnv} 与 ${def.deviceFlow.clientSecretEnv}（可先用粘贴凭证方式）`,
        },
        { status: 400 }
      );
    }

    if (action === 'start') {
      const device = await startDeviceFlow(userId, def);
      return NextResponse.json({ success: true, device });
    }

    if (action === 'poll') {
      const result = await pollDeviceFlow(userId, def);
      if (result.status === 'success') {
        // 预热连接：立即连上并挂载工具（失败不阻断，任务执行时会重试）——与粘贴凭证 saveToken 同款
        try {
          const backend = getAgentBackend();
          await backend.whenReady();
          await backend.mcp?.syncUserServers?.(userId, buildUserMcpServers(userId));
        } catch (e: any) {
          console.error(`[mcp-device] warm connect failed for ${def.id}:`, e?.message);
        }
        // 若有任务正在中途等待该连接器授权，解冻它
        resolveConnectorAuth(userId, def.id, 'authorized');
      }
      return NextResponse.json({ success: true, ...result });
    }

    if (action === 'cancel') {
      cancelDeviceFlow(userId, def.id);
      return NextResponse.json({ success: true });
    }

    return NextResponse.json({ success: false, error: `未知 action: ${action}` }, { status: 400 });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err?.message || '设备码授权失败' }, { status: 500 });
  }
}
