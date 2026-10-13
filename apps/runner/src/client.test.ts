import { describe, it, expect } from 'vitest';
import { RunnerClient, RunnerAuthError, RunnerUpgradeError, RUNNER_VERSION } from './client';
import { RUNNER_PROTOCOL_VERSION } from '@agtpilot/protocol';

/** 假 fetch:按序返回预置应答,记录调用(URL/方法/头/体) */
function fakeFetch(responses: Array<{ status: number; body: unknown }>) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  let i = 0;
  const impl = (async (url: any, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const r = responses[Math.min(i, responses.length - 1)];
    i++;
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      json: async () => r.body,
    } as unknown as Response;
  }) as typeof fetch;
  return { impl, calls };
}

const creds = { deviceId: 'dev_abc', deviceSecret: 'sec'.repeat(10) };

describe('RunnerClient.pair', () => {
  it('POST /api/runner/pair,body 带配对码与设备元信息', async () => {
    const { impl, calls } = fakeFetch([
      { status: 200, body: { success: true, deviceId: 'dev_1', deviceSecret: 'x'.repeat(43) } },
    ]);
    const client = new RunnerClient('https://app.example.com/', null, impl);
    const r = await client.pair('ABCD2345', {
      hostname: 'h',
      platform: 'linux',
      runnerVersion: RUNNER_VERSION,
      protocolVersion: RUNNER_PROTOCOL_VERSION,
    });
    expect(r.deviceId).toBe('dev_1');
    expect(calls[0].url).toBe('https://app.example.com/api/runner/pair'); // 尾斜杠剥除
    const body = JSON.parse(String(calls[0].init?.body));
    expect(body.code).toBe('ABCD2345');
    expect(body.protocolVersion).toBe(RUNNER_PROTOCOL_VERSION);
  });

  it('业务失败(success:false)→ 抛云端 error 文案', async () => {
    const { impl } = fakeFetch([{ status: 410, body: { success: false, error: '配对码已过期' } }]);
    const client = new RunnerClient('https://app.example.com', null, impl);
    await expect(client.pair('ABCD2345')).rejects.toThrow('配对码已过期');
  });
});

describe('RunnerClient.poll', () => {
  it('设备认证头 + 心跳元信息 query;claim=1 显式传参', async () => {
    const { impl, calls } = fakeFetch([{ status: 200, body: { success: true, serverTime: 1, claimed: null, queue: [] } }]);
    const client = new RunnerClient('https://app.example.com', creds, impl);
    await client.poll({ claim: true });
    const url = new URL(calls[0].url);
    expect(url.pathname).toBe('/api/runner/tasks');
    expect(url.searchParams.get('claim')).toBe('1');
    expect(url.searchParams.get('runnerVersion')).toBe(RUNNER_VERSION);
    expect(url.searchParams.get('protocolVersion')).toBe(String(RUNNER_PROTOCOL_VERSION));
    const headers = calls[0].init?.headers as Record<string, string>;
    expect(headers['X-Runner-Id']).toBe('dev_abc');
    expect(headers['Authorization']).toBe(`Bearer ${creds.deviceSecret}`);
  });

  it('401 → RunnerAuthError;426 → RunnerUpgradeError(带升级文案)', async () => {
    const a = fakeFetch([{ status: 401, body: { success: false, error: 'Unauthorized' } }]);
    await expect(new RunnerClient('https://s', creds, a.impl).poll()).rejects.toBeInstanceOf(RunnerAuthError);

    const b = fakeFetch([{ status: 426, body: { success: false, error: '协议版本不兼容,请升级:npm i -g @agtpilot/runner@latest' } }]);
    await expect(new RunnerClient('https://s', creds, b.impl).poll()).rejects.toBeInstanceOf(RunnerUpgradeError);
  });
});

describe('RunnerClient.postEvents', () => {
  const validEvent = {
    eventId: 'ev_1',
    taskId: 'rtask_1',
    deviceId: 'dev_abc',
    at: 1760000000000,
    type: 'progress',
    payload: { tool: 'Bash', summary: 'ok' },
  };

  it('畸形项本地先过滤,只上行合法事件', async () => {
    const { impl, calls } = fakeFetch([{ status: 200, body: { success: true, accepted: 1, rejected: 0 } }]);
    const client = new RunnerClient('https://s', creds, impl);
    const r = await client.postEvents([validEvent, { garbage: true }, null]);
    expect(r).toEqual({ accepted: 1, rejected: 0 });
    const body = JSON.parse(String(calls[0].init?.body));
    expect(body.events).toHaveLength(1);
    expect(body.events[0].eventId).toBe('ev_1');
  });

  it('全部畸形 → 不发请求,零计数', async () => {
    const { impl, calls } = fakeFetch([{ status: 200, body: {} }]);
    const client = new RunnerClient('https://s', creds, impl);
    expect(await client.postEvents([{ garbage: true }])).toEqual({ accepted: 0, rejected: 0 });
    expect(calls).toHaveLength(0);
  });

  it('M4 redaction 集中闸:密钥形态与本机 deviceSecret 值在出网前被替换', async () => {
    const { impl, calls } = fakeFetch([{ status: 200, body: { success: true, accepted: 1, rejected: 0 } }]);
    const client = new RunnerClient('https://s', creds, impl);
    await client.postEvents([
      {
        ...validEvent,
        payload: {
          summary: 'auth ghp_aBcD1234567890aBcD1234567890aBcD1234 失败',
          nested: { stderr: `Bearer ${creds.deviceSecret} 被记录` },
        },
      },
    ]);
    const raw = String(calls[0].init?.body);
    expect(raw).toContain('[REDACTED]');
    expect(raw).not.toContain('ghp_aBcD1234567890aBcD1234567890aBcD1234');
    expect(raw).not.toContain(creds.deviceSecret);
    // 结构化字段不动
    const body = JSON.parse(raw);
    expect(body.events[0].eventId).toBe('ev_1');
    expect(body.events[0].payload.summary).toContain('auth');
  });
});
