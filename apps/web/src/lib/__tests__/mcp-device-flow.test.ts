import { describe, beforeAll, afterAll, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * 设备码授权通道（OAuth 2.0 Device Grant）单测。
 *
 * 背景:GitHub 远程 MCP 的授权服务器无 DCR(registration_endpoint 缺失,2026-10-14 实测),
 * SDK 自动注册+回跳流程走不通;设备码流程无回调、不要求 https 部署,
 * 换到的 gho_ token 实测可直连 api.githubcopilot.com/mcp/。
 *
 * 安全红线(本文件锁定):
 * - device_code / client_secret 只进服务端存储与出站请求体,绝不出现在返回值里;
 * - 前端可见的只有 user_code(本来就是给用户看的)与轮询状态;
 * - success 时 token 写入 tokenEnvVar 键(与粘贴凭证同链路加密存储),deviceFlow 中间态清除。
 *
 * 环境隔离:USER_DATA_DIR 指向一次性临时目录,必须在动态 import 被测模块之前设置。
 */
let us: typeof import('@/lib/user-store');
let mc: typeof import('@/lib/mcp-connectors');
let dfl: typeof import('@/lib/mcp-device-flow');

const UID = 'device-flow-user-a';
const ENV_ID = 'AGTPILOT_GITHUB_OAUTH_CLIENT_ID';
const ENV_SECRET = 'AGTPILOT_GITHUB_OAUTH_SECRET';

/** 可编程 mock fetch:按队列消费响应,并记录全部出站调用 */
let fetchCalls: Array<{ url: string; init: any }> = [];
let fetchQueue: Array<{ body?: any; reject?: boolean } | undefined> = [];
const mockFetch = (async (url: string, init?: any) => {
  fetchCalls.push({ url: String(url), init });
  const next = fetchQueue.shift();
  if (next?.reject) throw new Error('network down');
  return { ok: true, status: 200, json: async () => next?.body ?? {} };
}) as unknown as typeof fetch;

function resetMock() {
  fetchCalls = [];
  fetchQueue = [];
}

const githubDef = () => {
  const def = mc.MCP_CONNECTOR_DEFS.find((d) => d.id === 'github_mcp');
  if (!def) throw new Error('目录中缺少 github_mcp');
  return def;
};

beforeAll(async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agtpilot-device-flow-'));
  process.env.USER_DATA_DIR = tmpDir;
  process.env.AGTPILOT_SECRET_KEY = 'device-flow-test-key';
  us = await import('@/lib/user-store');
  mc = await import('@/lib/mcp-connectors');
  dfl = await import('@/lib/mcp-device-flow');
});

afterAll(() => {
  delete process.env[ENV_ID];
  delete process.env[ENV_SECRET];
});

describe('目录配置回归(github_mcp)', () => {
  it('保持 authType token + MCP_GITHUB_PAT 键(设备码 token 复用粘贴凭证消费链路)', () => {
    const def = githubDef();
    expect(def.authType).toBe('token');
    expect(def.tokenEnvVar).toBe('MCP_GITHUB_PAT');
  });

  it('deviceFlow 指向 GitHub 官方端点,secret 走 env 变量名而非明文', () => {
    const df = githubDef().deviceFlow!;
    expect(df.deviceUrl).toBe('https://github.com/login/device/code');
    expect(df.tokenUrl).toBe('https://github.com/login/oauth/access_token');
    expect(df.clientIdEnv).toBe(ENV_ID);
    expect(df.clientSecretEnv).toBe(ENV_SECRET);
    expect(df.verificationUri).toBe('https://github.com/login/device');
    // scope 默认对齐官方 github-mcp-server README 的 code+devinfo 组合
    expect(df.scope).toContain('repo');
    expect(df.scope).toContain('read:org');
    // GitHub 2026-08-14 起新建 App 默认短期 token(8h),offline_access 换 refresh token 供自动续期
    expect(df.scope).toContain('offline_access');
  });

  it('client_secret 不出现在目录任何字段(只允许 env 变量名)', () => {
    const raw = JSON.stringify(githubDef());
    expect(raw).not.toContain('client_secret');
  });
});

describe('deviceFlowAvailable(env 齐备才开通道)', () => {
  it('未配置 env → false(UI 隐藏按钮,PAT 通道不受影响)', () => {
    delete process.env[ENV_ID];
    delete process.env[ENV_SECRET];
    expect(mc.deviceFlowAvailable(githubDef())).toBe(false);
  });

  it('只配 client_id 缺 secret → false', () => {
    process.env[ENV_ID] = 'iv1.test-id';
    delete process.env[ENV_SECRET];
    expect(mc.deviceFlowAvailable(githubDef())).toBe(false);
    delete process.env[ENV_ID];
  });

  it('两个 env 齐备 → true', () => {
    process.env[ENV_ID] = 'iv1.test-id';
    process.env[ENV_SECRET] = 'test-secret';
    expect(mc.deviceFlowAvailable(githubDef())).toBe(true);
  });

  it('未配 deviceFlow 的连接器恒为 false', () => {
    const zhihu = mc.MCP_CONNECTOR_DEFS.find((d) => d.id === 'zhihu')!;
    expect(zhihu.deviceFlow).toBeUndefined();
    expect(mc.deviceFlowAvailable(zhihu)).toBe(false);
  });
});

describe('startDeviceFlow(申请设备码)', () => {
  it('成功:返回 user_code 展示信息,device_code 加密落盘且不在返回值里', async () => {
    process.env[ENV_ID] = 'iv1.test-id';
    process.env[ENV_SECRET] = 'test-secret';
    resetMock();
    fetchQueue.push({
      body: {
        device_code: 'SECRET-DEVICE-CODE',
        user_code: 'ABCD-1234',
        verification_uri: 'https://github.com/login/device',
        expires_in: 900,
        interval: 5,
      },
    });

    const r = await dfl.startDeviceFlow(UID, githubDef(), mockFetch);
    expect(r).toEqual({
      userCode: 'ABCD-1234',
      verificationUri: 'https://github.com/login/device',
      expiresIn: 900,
      interval: 5,
    });
    // 红线:device_code 绝不下发
    expect(JSON.stringify(r)).not.toContain('SECRET-DEVICE-CODE');

    // 出站请求:官方 device 端点 + form 体带 client_id/scope,不带 secret
    expect(fetchCalls[0].url).toBe('https://github.com/login/device/code');
    const bodyStr = String(fetchCalls[0].init.body);
    expect(bodyStr).toContain('client_id=iv1.test-id');
    expect(bodyStr).toContain('scope=');
    expect(bodyStr).not.toContain('test-secret');
    expect(fetchCalls[0].init.headers.Accept).toBe('application/json');

    // 中间态落盘(加密空间),含 device_code 供后续轮询
    const rec = us.getMcpAuth(UID, 'github_mcp');
    expect(rec?.deviceFlow?.deviceCode).toBe('SECRET-DEVICE-CODE');
    expect(rec?.deviceFlow?.interval).toBe(5);
    expect(rec!.deviceFlow!.expiresAt).toBeGreaterThan(Date.now());
  });

  it('env 未配置 → 抛出可操作的错误信息(点名两个变量)', async () => {
    delete process.env[ENV_ID];
    resetMock();
    await expect(dfl.startDeviceFlow(UID, githubDef(), mockFetch)).rejects.toThrow(ENV_ID);
    process.env[ENV_ID] = 'iv1.test-id';
  });

  it('端点返回 error → 抛错且不落盘中间态', async () => {
    resetMock();
    us.deleteMcpAuth(UID, 'github_mcp');
    fetchQueue.push({ body: { error: 'unauthorized_client', error_description: 'device flow not enabled' } });
    await expect(dfl.startDeviceFlow(UID, githubDef(), mockFetch)).rejects.toThrow('device flow not enabled');
    expect(us.getMcpAuth(UID, 'github_mcp')?.deviceFlow).toBeUndefined();
  });

  it('响应缺 verification_uri → 回退目录配置值', async () => {
    resetMock();
    fetchQueue.push({ body: { device_code: 'dc-1', user_code: 'WXYZ-9999', expires_in: 900, interval: 5 } });
    const r = await dfl.startDeviceFlow(UID, githubDef(), mockFetch);
    expect(r.verificationUri).toBe('https://github.com/login/device');
  });
});

describe('pollDeviceFlow(轮询换 token)', () => {
  beforeAll(() => {
    process.env[ENV_ID] = 'iv1.test-id';
    process.env[ENV_SECRET] = 'test-secret';
  });

  async function startFresh(userCode = 'POLL-0001') {
    resetMock();
    fetchQueue.push({
      body: { device_code: 'DC-POLL', user_code: userCode, verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 5 },
    });
    await dfl.startDeviceFlow(UID, githubDef(), mockFetch);
    resetMock();
  }

  it('无进行中授权 → error(不打出站请求)', async () => {
    us.deleteMcpAuth(UID, 'github_mcp');
    resetMock();
    const r = await dfl.pollDeviceFlow(UID, githubDef(), mockFetch);
    expect(r.status).toBe('error');
    expect(fetchCalls).toHaveLength(0);
  });

  it('authorization_pending → pending,中间态保留', async () => {
    await startFresh();
    fetchQueue.push({ body: { error: 'authorization_pending', error_description: '...' } });
    const r = await dfl.pollDeviceFlow(UID, githubDef(), mockFetch);
    expect(r).toEqual({ status: 'pending', interval: 5 });
    expect(us.getMcpAuth(UID, 'github_mcp')?.deviceFlow?.deviceCode).toBe('DC-POLL');
  });

  it('slow_down → 采用响应 interval 并回写存储', async () => {
    await startFresh();
    fetchQueue.push({ body: { error: 'slow_down', interval: 10 } });
    const r = await dfl.pollDeviceFlow(UID, githubDef(), mockFetch);
    expect(r).toEqual({ status: 'slow_down', interval: 10 });
    expect(us.getMcpAuth(UID, 'github_mcp')?.deviceFlow?.interval).toBe(10);
  });

  it('slow_down 无 interval 字段 → 原间隔 +5(RFC 8628 §3.5)', async () => {
    await startFresh();
    fetchQueue.push({ body: { error: 'slow_down' } });
    const r = await dfl.pollDeviceFlow(UID, githubDef(), mockFetch);
    expect(r).toEqual({ status: 'slow_down', interval: 10 });
  });

  it('success → gho_ token 写入 MCP_GITHUB_PAT 键,中间态清除,返回掩码', async () => {
    await startFresh();
    fetchQueue.push({ body: { access_token: 'gho_AAAAAAAAAAAAAAAAAAAA9999', token_type: 'bearer', scope: 'repo,read:org' } });
    const r = await dfl.pollDeviceFlow(UID, githubDef(), mockFetch);
    expect(r.status).toBe('success');
    expect(r.keyMasked).toBe('****9999');
    // 红线:token 原文不出现在轮询返回值
    expect(JSON.stringify(r)).not.toContain('gho_AAAA');

    // token 走用户凭证加密存储(与粘贴凭证同链路),连接消费零改动
    const cred = us.getUserConnectors(UID).configs['MCP_GITHUB_PAT'];
    expect(cred).toBe('gho_AAAAAAAAAAAAAAAAAAAA9999');
    expect(us.getMcpAuth(UID, 'github_mcp')?.deviceFlow).toBeUndefined();
    // 长效 token(响应无 refresh_token)→ 不落续期状态
    expect(us.getMcpAuth(UID, 'github_mcp')?.tokenRefresh).toBeUndefined();

    // 出站:token 端点 + device_code grant + secret 只在服务端出站体里
    expect(fetchCalls[0].url).toBe('https://github.com/login/oauth/access_token');
    const bodyStr = String(fetchCalls[0].init.body);
    expect(bodyStr).toContain('grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code');
    expect(bodyStr).toContain('device_code=DC-POLL');
    expect(bodyStr).toContain('client_secret=test-secret');
  });

  it('expired_token → expired 且清中间态', async () => {
    await startFresh();
    fetchQueue.push({ body: { error: 'expired_token' } });
    const r = await dfl.pollDeviceFlow(UID, githubDef(), mockFetch);
    expect(r.status).toBe('expired');
    expect(us.getMcpAuth(UID, 'github_mcp')?.deviceFlow).toBeUndefined();
  });

  it('access_denied → denied 且清中间态', async () => {
    await startFresh();
    fetchQueue.push({ body: { error: 'access_denied', error_description: 'user rejected' } });
    const r = await dfl.pollDeviceFlow(UID, githubDef(), mockFetch);
    expect(r.status).toBe('denied');
    expect(us.getMcpAuth(UID, 'github_mcp')?.deviceFlow).toBeUndefined();
  });

  it('incorrect_client_credentials → error 且清中间态(配置类致命错误不空转)', async () => {
    await startFresh();
    fetchQueue.push({ body: { error: 'incorrect_client_credentials', error_description: 'bad secret' } });
    const r = await dfl.pollDeviceFlow(UID, githubDef(), mockFetch);
    expect(r.status).toBe('error');
    expect(r.error).toContain('bad secret');
    expect(us.getMcpAuth(UID, 'github_mcp')?.deviceFlow).toBeUndefined();
  });

  it('网络抖动 → 按 pending 继续轮询,中间态保留(过期时间兜底)', async () => {
    await startFresh();
    fetchQueue.push({ reject: true });
    const r = await dfl.pollDeviceFlow(UID, githubDef(), mockFetch);
    expect(r).toEqual({ status: 'pending', interval: 5 });
    expect(us.getMcpAuth(UID, 'github_mcp')?.deviceFlow?.deviceCode).toBe('DC-POLL');
  });

  it('本地判定设备码已过期 → expired 且不打任何出站请求', async () => {
    await startFresh();
    // 手动把 expiresAt 拨到过去
    const rec = us.getMcpAuth(UID, 'github_mcp')!;
    us.saveMcpAuth(UID, 'github_mcp', { ...rec, deviceFlow: { ...rec.deviceFlow!, expiresAt: Date.now() - 1000 } });
    resetMock();
    const r = await dfl.pollDeviceFlow(UID, githubDef(), mockFetch);
    expect(r.status).toBe('expired');
    expect(fetchCalls).toHaveLength(0);
    expect(us.getMcpAuth(UID, 'github_mcp')?.deviceFlow).toBeUndefined();
  });
});

describe('cancelDeviceFlow(用户关弹窗)', () => {
  it('清掉进行中的中间态,不影响已有 OAuth/PKCE 字段', async () => {
    us.saveMcpAuth(UID, 'github_mcp', {
      codeVerifier: 'keep-me',
      deviceFlow: { deviceCode: 'dc', userCode: 'uc', verificationUri: 'https://x', expiresAt: Date.now() + 60000, interval: 5 },
    });
    dfl.cancelDeviceFlow(UID, 'github_mcp');
    const rec = us.getMcpAuth(UID, 'github_mcp');
    expect(rec?.deviceFlow).toBeUndefined();
    expect(rec?.codeVerifier).toBe('keep-me');
  });

  it('无中间态时调用为无害 no-op', () => {
    us.deleteMcpAuth(UID, 'github_mcp');
    expect(() => dfl.cancelDeviceFlow(UID, 'github_mcp')).not.toThrow();
  });
});

/**
 * 短期 token 自动续期。GitHub 2026-08-14 起对新建 OAuth App 默认签发
 * access 8h + refresh 6 个月单次轮换(需 offline_access);长效 token 无 refresh_token,
 * 续期逻辑必须自动 no-op(零出站请求)。
 */
describe('短期 token 自动续期(ensureDeviceTokenFresh)', () => {
  beforeAll(() => {
    process.env[ENV_ID] = 'iv1.test-id';
    process.env[ENV_SECRET] = 'test-secret';
  });

  /** 布置「设备码已换到 token」的落盘态:configs 存 access,记录存续期状态 */
  function seed(opts?: { accessToken?: string; refreshToken?: string; expiresAt?: number }) {
    const accessToken = opts?.accessToken ?? 'gho_CUR1CUR1CUR1CUR10001';
    us.saveUserConnector(UID, 'MCP_GITHUB_PAT', accessToken);
    us.saveMcpAuth(UID, 'github_mcp', {
      tokenRefresh: {
        accessToken,
        refreshToken: opts?.refreshToken ?? 'ghr_ROTATE1',
        expiresAt: opts?.expiresAt ?? Date.now() + 60_000, // 临期(<30min 阈值)
      },
    });
  }

  it('poll success 响应带 refresh_token/expires_in → 落续期状态', async () => {
    us.saveMcpAuth(UID, 'github_mcp', {
      deviceFlow: { deviceCode: 'DC-R', userCode: 'R-1', verificationUri: 'https://github.com/login/device', expiresAt: Date.now() + 600_000, interval: 5 },
    });
    resetMock();
    fetchQueue.push({ body: { access_token: 'gho_SHORT1111', refresh_token: 'ghr_R1', expires_in: 28800, token_type: 'bearer' } });
    const r = await dfl.pollDeviceFlow(UID, githubDef(), mockFetch);
    expect(r.status).toBe('success');
    const tr = us.getMcpAuth(UID, 'github_mcp')?.tokenRefresh;
    expect(tr?.refreshToken).toBe('ghr_R1');
    expect(tr?.accessToken).toBe('gho_SHORT1111');
    expect(tr!.expiresAt).toBeGreaterThan(Date.now() + 28_000 * 1000);
    expect(us.getMcpAuth(UID, 'github_mcp')?.deviceFlow).toBeUndefined();
  });

  it('重新授权拿到长效 token(无 refresh_token)→ 旧续期状态被清掉', async () => {
    seed();
    us.saveMcpAuth(UID, 'github_mcp', {
      tokenRefresh: us.getMcpAuth(UID, 'github_mcp')!.tokenRefresh,
      deviceFlow: { deviceCode: 'DC-L', userCode: 'L-1', verificationUri: 'https://github.com/login/device', expiresAt: Date.now() + 600_000, interval: 5 },
    });
    resetMock();
    fetchQueue.push({ body: { access_token: 'gho_LONGLIVED0001', token_type: 'bearer' } });
    const r = await dfl.pollDeviceFlow(UID, githubDef(), mockFetch);
    expect(r.status).toBe('success');
    expect(us.getMcpAuth(UID, 'github_mcp')?.tokenRefresh).toBeUndefined();
  });

  it('无续期状态(长效 token / 粘贴 PAT)→ no-op 且零出站请求', async () => {
    us.deleteMcpAuth(UID, 'github_mcp');
    us.saveUserConnector(UID, 'MCP_GITHUB_PAT', 'github_pat_11ABCD');
    resetMock();
    const r = await dfl.ensureDeviceTokenFresh(UID, githubDef(), mockFetch);
    expect(r).toEqual({ refreshed: false });
    expect(fetchCalls).toHaveLength(0);
  });

  it('未临期(剩余 > 30min)→ no-op 且零出站请求', async () => {
    seed({ expiresAt: Date.now() + 4 * 3600 * 1000 });
    resetMock();
    const r = await dfl.ensureDeviceTokenFresh(UID, githubDef(), mockFetch);
    expect(r).toEqual({ refreshed: false });
    expect(fetchCalls).toHaveLength(0);
  });

  it('临期 → refresh grant 换新:新 access 写入 MCP_GITHUB_PAT,refresh token 轮换落盘', async () => {
    seed();
    resetMock();
    fetchQueue.push({ body: { access_token: 'gho_NEW2NEW2NEW20002', refresh_token: 'ghr_ROTATE2', expires_in: 28800, token_type: 'bearer' } });
    const r = await dfl.ensureDeviceTokenFresh(UID, githubDef(), mockFetch);
    expect(r).toEqual({ refreshed: true });

    // 消费链路零改动:新 token 就在粘贴凭证同一个键里(fingerprint 变化 → sync 自动重连)
    expect(us.getUserConnectors(UID).configs['MCP_GITHUB_PAT']).toBe('gho_NEW2NEW2NEW20002');
    const tr = us.getMcpAuth(UID, 'github_mcp')?.tokenRefresh;
    expect(tr?.refreshToken).toBe('ghr_ROTATE2');
    expect(tr?.accessToken).toBe('gho_NEW2NEW2NEW20002');

    // 出站:refresh grant + client_secret 只在服务端出站体;返回值不含任何 token 原文
    expect(fetchCalls[0].url).toBe('https://github.com/login/oauth/access_token');
    const bodyStr = String(fetchCalls[0].init.body);
    expect(bodyStr).toContain('grant_type=refresh_token');
    expect(bodyStr).toContain('refresh_token=ghr_ROTATE1');
    expect(bodyStr).toContain('client_secret=test-secret');
    expect(JSON.stringify(r)).not.toContain('gho_');
    expect(JSON.stringify(r)).not.toContain('ghr_');
  });

  it('刷新响应未带新 refresh_token → 防御性沿用旧值(GitHub 轮换制下理论不发生)', async () => {
    seed();
    resetMock();
    fetchQueue.push({ body: { access_token: 'gho_NEW3NEW3NEW30003', expires_in: 28800 } });
    const r = await dfl.ensureDeviceTokenFresh(UID, githubDef(), mockFetch);
    expect(r.refreshed).toBe(true);
    expect(us.getMcpAuth(UID, 'github_mcp')?.tokenRefresh?.refreshToken).toBe('ghr_ROTATE1');
  });

  it('凭证漂移(用户改贴 PAT)→ 清续期状态、零出站、绝不覆盖用户凭证', async () => {
    seed(); // 记录里 accessToken 是 gho_CUR1...
    us.saveUserConnector(UID, 'MCP_GITHUB_PAT', 'github_pat_USER_OWNS'); // 用户手动换贴 PAT
    resetMock();
    const r = await dfl.ensureDeviceTokenFresh(UID, githubDef(), mockFetch);
    expect(r).toEqual({ refreshed: false });
    expect(fetchCalls).toHaveLength(0);
    expect(us.getMcpAuth(UID, 'github_mcp')?.tokenRefresh).toBeUndefined();
    expect(us.getUserConnectors(UID).configs['MCP_GITHUB_PAT']).toBe('github_pat_USER_OWNS');
  });

  it('refresh 链已死(bad_refresh_token)→ 清续期状态,现有 access token 保留到自然过期', async () => {
    seed();
    resetMock();
    fetchQueue.push({ body: { error: 'bad_refresh_token', error_description: 'refresh token expired' } });
    const r = await dfl.ensureDeviceTokenFresh(UID, githubDef(), mockFetch);
    expect(r.refreshed).toBe(false);
    expect(r.error).toContain('bad_refresh_token');
    expect(us.getMcpAuth(UID, 'github_mcp')?.tokenRefresh).toBeUndefined();
    expect(us.getUserConnectors(UID).configs['MCP_GITHUB_PAT']).toBe('gho_CUR1CUR1CUR1CUR10001');
  });

  it('网络抖动 → 保留状态待下次重试(临期窗口内任务派发有多次机会)', async () => {
    seed();
    resetMock();
    fetchQueue.push({ reject: true });
    const r = await dfl.ensureDeviceTokenFresh(UID, githubDef(), mockFetch);
    expect(r.refreshed).toBe(false);
    expect(r.error).toContain('网络异常');
    expect(us.getMcpAuth(UID, 'github_mcp')?.tokenRefresh?.refreshToken).toBe('ghr_ROTATE1');
  });

  it('并发调用去重:refresh token 单次轮换,双刷会让第二个必失败 → 只出站一次', async () => {
    seed();
    let release!: () => void;
    const gate = new Promise<void>((res) => { release = res; });
    const calls: string[] = [];
    const gatedFetch = (async (url: string) => {
      calls.push(String(url));
      await gate;
      return { ok: true, status: 200, json: async () => ({ access_token: 'gho_LOCK1', refresh_token: 'ghr_LOCK2', expires_in: 28800 }) };
    }) as any;
    const p1 = dfl.ensureDeviceTokenFresh(UID, githubDef(), gatedFetch);
    const p2 = dfl.ensureDeviceTokenFresh(UID, githubDef(), gatedFetch);
    release();
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(calls).toHaveLength(1);
    expect(r1.refreshed).toBe(true);
    expect(r2.refreshed).toBe(true); // 共享同一在途结果
  });

  it('ensureDeviceTokensFresh(任务派发/预热统一入口)→ 遍历目录完成续期,永不 throw', async () => {
    seed();
    resetMock();
    fetchQueue.push({ body: { access_token: 'gho_WRAP1WRAP10004', refresh_token: 'ghr_WRAP2', expires_in: 28800 } });
    await dfl.ensureDeviceTokensFresh(UID, mockFetch);
    expect(us.getUserConnectors(UID).configs['MCP_GITHUB_PAT']).toBe('gho_WRAP1WRAP10004');
    // 无续期状态的用户调用为无害 no-op
    us.deleteMcpAuth(UID, 'github_mcp');
    resetMock();
    await expect(dfl.ensureDeviceTokensFresh(UID, mockFetch)).resolves.toBeUndefined();
    expect(fetchCalls).toHaveLength(0);
  });
});
