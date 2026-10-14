import { getMcpAuth, saveMcpAuth, saveUserConnector, getUserConnectors } from './user-store';
import { MCP_CONNECTOR_DEFS, type McpConnectorDef } from './mcp-connectors';

/**
 * MCP 连接器「设备码授权」通道（OAuth 2.0 Device Grant, RFC 8628）
 *
 * 为什么存在：GitHub 远程 MCP 的授权服务器（github.com/login/oauth）**不支持
 * 动态客户端注册**（registration_endpoint 缺失，2026-10-14 实测 404），authType:'oauth'
 * 那套 SDK 自动注册+浏览器回跳流程走不通；且回跳授权要求 https 回调地址，
 * http/内网部署直接被挡。设备码流程无回调、不挑部署形态，是 gh CLI 同款做法：
 * 用户在 github.com/login/device 输一次 user_code，后端轮询 token 端点换 gho_ token。
 *
 * 安全边界：
 * - client_secret / device_code 只存在于服务端（env + 加密的 McpAuthRecord），绝不下发前端；
 * - 前端只见 user_code（本来就给用户看的）与轮询状态；
 * - 换到的 token 写入 tokenEnvVar 键（与粘贴凭证同一加密存储与消费链路），
 *   断开连接走既有 disconnect（清 tokenEnvVar + deleteMcpAuth）。
 */

export interface DeviceStartResult {
  /** 给用户展示的一次性码（如 ABCD-1234） */
  userCode: string;
  /** 用户输码页（如 https://github.com/login/device） */
  verificationUri: string;
  /** 设备码有效期（秒，GitHub 默认 900） */
  expiresIn: number;
  /** 建议轮询间隔（秒） */
  interval: number;
}

export type DevicePollStatus =
  | 'pending' // 用户还没在页面上确认
  | 'slow_down' // 轮询太快，按返回的 interval 放慢
  | 'success' // 拿到 token，已写入用户凭证
  | 'expired' // 设备码过期，需重新发起
  | 'denied' // 用户在页面上拒绝
  | 'error'; // 其它错误（配置/网络/协议）

export interface DevicePollResult {
  status: DevicePollStatus;
  /** 最新轮询间隔（秒）；slow_down 时前端据此调整 */
  interval?: number;
  error?: string;
  /** success 时的凭证掩码（****后四位），供 UI 展示 */
  keyMasked?: string;
}

type FetchLike = (url: string, init?: any) => Promise<{ ok: boolean; status: number; json: () => Promise<any> }>;

const REQUEST_TIMEOUT_MS = 10_000;

function readEnv(def: McpConnectorDef): { clientId: string; clientSecret: string; scope: string } {
  const df = def.deviceFlow;
  if (!df || !def.tokenEnvVar) throw new Error(`连接器 ${def.id} 未配置设备码授权通道`);
  const clientId = (process.env[df.clientIdEnv] || '').trim();
  const clientSecret = (process.env[df.clientSecretEnv] || '').trim();
  if (!clientId || !clientSecret) {
    throw new Error(
      `设备码授权未配置：请在部署环境设置 ${df.clientIdEnv} 与 ${df.clientSecretEnv}（GitHub OAuth App 注册后获得，需勾选 Enable Device Flow）`
    );
  }
  const scope = (df.scopeEnv && (process.env[df.scopeEnv] || '').trim()) || df.scope || '';
  return { clientId, clientSecret, scope };
}

async function postForm(url: string, params: Record<string, string>, fetchImpl: FetchLike): Promise<any> {
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json', // GitHub token 端点默认回 form-encoded，显式要 JSON
    },
    body: new URLSearchParams(params).toString(),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  // GitHub 对 pending/slow_down 等也可能回非 2xx + JSON error 体，统一按 JSON 解析
  const body = await res.json().catch(() => null);
  if (!body) throw new Error(`设备码端点返回非 JSON（HTTP ${res.status}）`);
  return body;
}

/** 发起设备码授权：申请 device_code/user_code，中间态加密落盘，返回展示信息 */
export async function startDeviceFlow(
  userId: string,
  def: McpConnectorDef,
  fetchImpl: FetchLike = fetch
): Promise<DeviceStartResult> {
  const { clientId, scope } = readEnv(def);
  const df = def.deviceFlow!;
  const body = await postForm(df.deviceUrl, { client_id: clientId, ...(scope ? { scope } : {}) }, fetchImpl);
  if (body.error || !body.device_code || !body.user_code) {
    throw new Error(`申请设备码失败：${body.error_description || body.error || '端点未返回 device_code'}`);
  }
  const expiresIn = Number(body.expires_in) > 0 ? Number(body.expires_in) : 900;
  const interval = Number(body.interval) > 0 ? Number(body.interval) : 5;
  const verificationUri = String(body.verification_uri || df.verificationUri || '');
  if (!verificationUri) throw new Error('申请设备码失败：端点未返回 verification_uri 且目录未配置');

  const record = getMcpAuth(userId, def.id) || {};
  saveMcpAuth(userId, def.id, {
    ...record,
    deviceFlow: {
      deviceCode: String(body.device_code),
      userCode: String(body.user_code),
      verificationUri,
      expiresAt: Date.now() + expiresIn * 1000,
      interval,
    },
    updatedAt: Date.now(),
  });
  return { userCode: String(body.user_code), verificationUri, expiresIn, interval };
}

/** 轮询一次授权结果；success 时 token 已写入用户凭证（tokenEnvVar 键） */
export async function pollDeviceFlow(
  userId: string,
  def: McpConnectorDef,
  fetchImpl: FetchLike = fetch
): Promise<DevicePollResult> {
  const { clientId, clientSecret } = readEnv(def);
  const df = def.deviceFlow!;
  const record = getMcpAuth(userId, def.id);
  const flow = record?.deviceFlow;
  if (!flow?.deviceCode) {
    return { status: 'error', error: '没有进行中的设备码授权，请先重新发起' };
  }
  if (Date.now() > flow.expiresAt) {
    clearDeviceFlow(userId, def.id);
    return { status: 'expired' };
  }

  let body: any;
  try {
    body = await postForm(
      df.tokenUrl,
      {
        client_id: clientId,
        client_secret: clientSecret,
        device_code: flow.deviceCode,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      },
      fetchImpl
    );
  } catch {
    // 网络抖动按 pending 处理，前端继续轮询；设备码过期时间是天然兜底,不会无限空转
    return { status: 'pending', interval: flow.interval };
  }

  if (typeof body.access_token === 'string' && body.access_token) {
    saveUserConnector(userId, def.tokenEnvVar!, body.access_token);
    clearDeviceFlow(userId, def.id);
    // 新建 OAuth App 默认短期 token(2026-08-14 起 access 8h):响应带 refresh_token 时
    // 落续期状态,ensureDeviceTokenFresh 负责临期静默换新;长效 token 无此字段,自动 no-op
    saveRefreshState(userId, def.id, body);
    const t: string = body.access_token;
    return { status: 'success', keyMasked: t.length > 8 ? `****${t.slice(-4)}` : '****' };
  }

  const err = String(body.error || '');
  if (err === 'authorization_pending') {
    return { status: 'pending', interval: flow.interval };
  }
  if (err === 'slow_down') {
    // GitHub 语义：interval 字段给了就用，否则原间隔 +5（RFC 8628 §3.5）
    const next = Number(body.interval) > 0 ? Number(body.interval) : flow.interval + 5;
    const rec = getMcpAuth(userId, def.id) || {};
    if (rec.deviceFlow) saveMcpAuth(userId, def.id, { ...rec, deviceFlow: { ...rec.deviceFlow, interval: next }, updatedAt: Date.now() });
    return { status: 'slow_down', interval: next };
  }
  if (err === 'expired_token') {
    clearDeviceFlow(userId, def.id);
    return { status: 'expired' };
  }
  if (err === 'access_denied') {
    clearDeviceFlow(userId, def.id);
    return { status: 'denied' };
  }
  if (err === 'incorrect_device_code' || err === 'incorrect_client_credentials' || err === 'unauthorized_client') {
    // 致命配置类错误：清状态，避免前端拿着死码空转
    clearDeviceFlow(userId, def.id);
    return { status: 'error', error: `${err}${body.error_description ? `：${body.error_description}` : ''}` };
  }
  return { status: 'error', error: body.error_description || err || '未知错误', interval: flow.interval };
}

/** 用户取消/关闭弹窗：清掉进行中的设备码中间态 */
export function cancelDeviceFlow(userId: string, connectorId: string): void {
  clearDeviceFlow(userId, connectorId);
}

function clearDeviceFlow(userId: string, connectorId: string): void {
  const record = getMcpAuth(userId, connectorId);
  if (!record?.deviceFlow) return;
  const { deviceFlow: _drop, ...rest } = record;
  saveMcpAuth(userId, connectorId, { ...rest, updatedAt: Date.now() });
}

// ---- 短期 token 自动续期（GitHub 新建 OAuth App 默认 access 8h + refresh 6 个月单次轮换）----

/** access token 剩余有效期低于该值时,在任务派发等热路径上提前静默换新 */
const REFRESH_MARGIN_MS = 30 * 60 * 1000;
/** 响应缺 expires_in 时的保守回退(GitHub 短期 token 固定 8h) */
const DEFAULT_EXPIRES_IN_S = 8 * 3600;
/** 同一用户+连接器的在途刷新;refresh token 单次轮换,并发双刷会让第二个必失败 */
const refreshLocks = new Map<string, Promise<RefreshResult>>();

export interface RefreshResult {
  /** 本次调用是否真的换发了新 access token(写入 configs,fingerprint 变化触发重连) */
  refreshed: boolean;
  error?: string;
}

/** token 响应带 refresh_token/expires_in → 落续期状态;长效 token(无字段)则清掉旧状态 */
function saveRefreshState(userId: string, connectorId: string, body: any): void {
  const record = getMcpAuth(userId, connectorId) || {};
  if (typeof body.refresh_token === 'string' && body.refresh_token) {
    const expiresIn = Number(body.expires_in) > 0 ? Number(body.expires_in) : DEFAULT_EXPIRES_IN_S;
    saveMcpAuth(userId, connectorId, {
      ...record,
      tokenRefresh: {
        accessToken: String(body.access_token),
        refreshToken: body.refresh_token,
        expiresAt: Date.now() + expiresIn * 1000,
      },
      updatedAt: Date.now(),
    });
    return;
  }
  if (record.tokenRefresh) {
    const { tokenRefresh: _drop, ...rest } = record;
    saveMcpAuth(userId, connectorId, { ...rest, updatedAt: Date.now() });
  }
}

/**
 * 临期则静默续期设备码换来的 token。设计要点:
 * - 无 tokenRefresh(长效 token / 粘贴的 PAT)→ 零出站请求直接返回;
 * - 凭证漂移检测:configs 里的值已不是本记录签发的 access token(用户改贴了 PAT /
 *   重新走过授权)→ 清掉续期状态,绝不覆盖用户手动配置的凭证;
 * - 刷新成功:新 access token 写入 tokenEnvVar 键(消费链路零改动),新 refresh token
 *   轮换落盘;MCP 连接 fingerprint 含 header 哈希,下次 syncUserServers 自动重建连接;
 * - refresh token 已死(单次轮换被用掉/6 个月未用过期):清续期状态,保留现有 access
 *   token 到自然过期,连接报错浮出 lastError,用户重新设备码授权即可;
 * - 网络抖动:保留状态下次再试(临期窗口 30min,任务派发频次内有多次机会)。
 */
export async function ensureDeviceTokenFresh(
  userId: string,
  def: McpConnectorDef,
  fetchImpl: FetchLike = fetch
): Promise<RefreshResult> {
  if (!def.deviceFlow || !def.tokenEnvVar) return { refreshed: false };
  const record = getMcpAuth(userId, def.id);
  const tr = record?.tokenRefresh;
  if (!tr?.refreshToken) return { refreshed: false };

  // 凭证漂移:configs 当前值不是本记录签发的 token → 用户已换凭证,放弃续期权
  const current = (getUserConnectors(userId).configs[def.tokenEnvVar] || '').trim();
  if (current !== tr.accessToken) {
    const { tokenRefresh: _drop, ...rest } = record!;
    saveMcpAuth(userId, def.id, { ...rest, updatedAt: Date.now() });
    return { refreshed: false };
  }

  if (tr.expiresAt - Date.now() > REFRESH_MARGIN_MS) return { refreshed: false };

  const lockKey = `${userId}::${def.id}`;
  const inflight = refreshLocks.get(lockKey);
  if (inflight) return inflight;
  const run = doRefresh(userId, def, tr, fetchImpl).finally(() => {
    if (refreshLocks.get(lockKey) === run) refreshLocks.delete(lockKey);
  });
  refreshLocks.set(lockKey, run);
  return run;
}

async function doRefresh(
  userId: string,
  def: McpConnectorDef,
  tr: NonNullable<import('./user-store').McpAuthRecord['tokenRefresh']>,
  fetchImpl: FetchLike
): Promise<RefreshResult> {
  const df = def.deviceFlow!;
  let clientId: string;
  let clientSecret: string;
  try {
    ({ clientId, clientSecret } = readEnv(def));
  } catch (e: any) {
    // env 被摘掉:保留状态(可能只是暂时缺失),报错给日志
    return { refreshed: false, error: e?.message || String(e) };
  }
  let body: any;
  try {
    body = await postForm(
      df.tokenUrl,
      {
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: 'refresh_token',
        refresh_token: tr.refreshToken,
      },
      fetchImpl
    );
  } catch (e: any) {
    return { refreshed: false, error: `网络异常,保留状态待下次重试: ${e?.message || e}` };
  }

  if (typeof body.access_token === 'string' && body.access_token) {
    saveUserConnector(userId, def.tokenEnvVar!, body.access_token);
    const expiresIn = Number(body.expires_in) > 0 ? Number(body.expires_in) : DEFAULT_EXPIRES_IN_S;
    const rec = getMcpAuth(userId, def.id) || {};
    saveMcpAuth(userId, def.id, {
      ...rec,
      tokenRefresh: {
        accessToken: body.access_token,
        // GitHub 轮换制:响应必带新 refresh_token;防御性回退旧值
        refreshToken: String(body.refresh_token || tr.refreshToken),
        expiresAt: Date.now() + expiresIn * 1000,
      },
      updatedAt: Date.now(),
    });
    return { refreshed: true };
  }

  const err = String(body.error || '');
  if (err) {
    // bad_refresh_token / unauthorized_client 等:续期链已死,清状态防止每次任务空转;
    // 现有 access token 保留(可能还没过期),真过期后连接错误自然浮出,引导重新授权
    const rec = getMcpAuth(userId, def.id);
    if (rec?.tokenRefresh) {
      const { tokenRefresh: _drop, ...rest } = rec;
      saveMcpAuth(userId, def.id, { ...rest, updatedAt: Date.now() });
    }
    return { refreshed: false, error: `refresh 失败(${err}),已清续期状态,需重新设备码授权` };
  }
  return { refreshed: false, error: 'refresh 响应异常(无 access_token 且无 error)' };
}

/**
 * 任务派发/重启预热/手动重连前的统一入口:遍历该用户所有设备码连接器临期续期。
 * 永不 throw(热路径上续期失败不阻断任务,连接错误走既有 lastError 通道浮出)。
 */
export async function ensureDeviceTokensFresh(userId: string, fetchImpl: FetchLike = fetch): Promise<void> {
  for (const def of MCP_CONNECTOR_DEFS) {
    if (!def.deviceFlow || !def.tokenEnvVar) continue;
    try {
      const r = await ensureDeviceTokenFresh(userId, def, fetchImpl);
      if (r.refreshed) {
        console.info(`[mcp-device-flow] ${def.id} access token 已自动续期(用户 ${userId})`);
      } else if (r.error) {
        console.warn(`[mcp-device-flow] ${def.id} 续期未完成: ${r.error}`);
      }
    } catch (e: any) {
      console.warn(`[mcp-device-flow] ${def.id} 续期异常: ${e?.message || e}`);
    }
  }
}
