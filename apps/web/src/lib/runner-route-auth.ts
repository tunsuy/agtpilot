import { NextRequest, NextResponse } from 'next/server';
import { authenticateRunner, updateDeviceMeta } from './runner-bridge';
import { extractClientIp } from './client-ip';
import {
  RUNNER_PROTOCOL_VERSION,
  isProtocolSupported,
  normalizeDeviceMeta,
  type RunnerDeviceInfo,
} from '@agtpilot/protocol';

/**
 * /api/runner/* 设备侧路由的统一认证入口(§4):
 * `X-Runner-Id` + `Authorization: Bearer <deviceSecret>` → 归属用户与设备。
 *
 * 顺带三件事:
 * - 心跳元信息:query 携带 hostname/platform/runnerVersion/protocolVersion/ghLogin
 *   时清洗后更新设备记录(runner 升级后版本自新;ghLogin = gh 公开登录名);
 * - 来源 IP:云端从请求头观察(x-forwarded-for/x-real-ip),随 lastSeenAt 节流落盘
 *   lastSeenIp —— 设备页展示用,runner 零改动,不作鉴权依据;
 * - 版本兼容治理(§9):存量设备协议版本不再受支持 → 426 + 升级提示,拒绝派发。
 */
export type RunnerAuthResult =
  | { ok: true; userId: string; device: RunnerDeviceInfo }
  | { ok: false; response: NextResponse };

export function authenticateRunnerRequest(req: NextRequest): RunnerAuthResult {
  const runnerId = req.headers.get('x-runner-id');
  const authHeader = req.headers.get('authorization');
  const bearer = authHeader?.startsWith('Bearer ') ? authHeader.slice(7).trim() : null;

  const authed = authenticateRunner(runnerId, bearer, Date.now(), extractClientIp(req.headers));
  if (!authed) {
    return {
      ok: false,
      response: NextResponse.json(
        { success: false, error: 'Unauthorized: 设备未配对、密钥不符或已被吊销,请重新执行 agtpilot-runner pair' },
        { status: 401 }
      ),
    };
  }

  // 心跳携带的元信息更新(可选)。ghLogin 参数:缺省 = 沿用存量值;
  // 空串 = runner 明确上报「gh 未登录」(normalizeDeviceMeta 归一为 null)
  const url = new URL(req.url);
  const ghLoginParam = url.searchParams.get('ghLogin');
  const metaInput = {
    hostname: url.searchParams.get('hostname') ?? authed.device.hostname,
    platform: url.searchParams.get('platform') ?? authed.device.platform,
    runnerVersion: url.searchParams.get('runnerVersion') ?? authed.device.runnerVersion,
    protocolVersion: Number(url.searchParams.get('protocolVersion') ?? authed.device.protocolVersion),
    ghLogin: ghLoginParam !== null ? ghLoginParam : authed.device.ghLogin,
  };
  const meta = normalizeDeviceMeta(metaInput);
  if (
    meta &&
    (meta.runnerVersion !== authed.device.runnerVersion ||
      meta.protocolVersion !== authed.device.protocolVersion ||
      meta.ghLogin !== authed.device.ghLogin)
  ) {
    updateDeviceMeta(authed.userId, authed.device.deviceId, meta);
    authed.device = { ...authed.device, ...meta };
  }

  if (!isProtocolSupported(authed.device.protocolVersion)) {
    return {
      ok: false,
      response: NextResponse.json(
        {
          success: false,
          error: `协议版本不兼容(设备 ${authed.device.protocolVersion} / 云端 ${RUNNER_PROTOCOL_VERSION}),请升级:npm i -g @agtpilot/runner@latest`,
          supportedProtocol: RUNNER_PROTOCOL_VERSION,
        },
        { status: 426 }
      ),
    };
  }

  return { ok: true, userId: authed.userId, device: authed.device };
}
