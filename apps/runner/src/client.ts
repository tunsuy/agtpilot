import * as os from 'os';
import {
  RUNNER_PROTOCOL_VERSION,
  normalizeRunnerEvent,
  type RunnerDeviceMeta,
  type RunnerEvent,
} from '@agtpilot/protocol';

/** runner 自身版本(与 package.json 同步维护;心跳/配对上报,云端做版本治理 §9) */
export const RUNNER_VERSION = '0.0.1';

/** 401(密钥不符/已吊销)→ 调用方应自毁本地凭据并提示重新配对 */
export class RunnerAuthError extends Error {}
/** 426(协议版本不兼容)→ 调用方应提示升级命令 */
export class RunnerUpgradeError extends Error {}

export function deviceMeta(): RunnerDeviceMeta {
  return {
    hostname: os.hostname().slice(0, 100),
    platform: process.platform,
    runnerVersion: RUNNER_VERSION,
    protocolVersion: RUNNER_PROTOCOL_VERSION,
  };
}

export interface RunnerClientCreds {
  deviceId: string;
  deviceSecret: string;
}

export interface PollResult {
  serverTime: number;
  claimed: { taskId: string; pack: unknown } | null;
  queue: Array<{ taskId: string; state: string }>;
  /** M3:审批结果动作下行(publish 固化命令集 / cancel 拒绝确认;旧版云端可能缺省) */
  actions?: unknown[];
}

/**
 * 云端 /api/runner/* 的薄客户端(出站-only fetch,无 WebSocket)。
 * fetchImpl 可注入(测试用假 fetch)。
 */
export class RunnerClient {
  constructor(
    private serverUrl: string,
    private creds: RunnerClientCreds | null,
    private fetchImpl: typeof fetch = fetch
  ) {
    // 固定 server URL 时剥尾部斜杠,防拼接出 //api
    this.serverUrl = serverUrl.replace(/\/+$/, '');
  }

  private url(p: string, query?: Record<string, string>): string {
    const qs = query ? `?${new URLSearchParams(query).toString()}` : '';
    return `${this.serverUrl}${p}${qs}`;
  }

  private headers(json = false): Record<string, string> {
    const h: Record<string, string> = {};
    if (json) h['Content-Type'] = 'application/json';
    if (this.creds) {
      h['X-Runner-Id'] = this.creds.deviceId;
      h['Authorization'] = `Bearer ${this.creds.deviceSecret}`;
    }
    return h;
  }

  private async request<T>(url: string, init?: RequestInit): Promise<T> {
    const res = await this.fetchImpl(url, init);
    if (res.status === 401) throw new RunnerAuthError('401:设备密钥无效或已被吊销');
    if (res.status === 426) {
      const body = await res.json().catch(() => ({}));
      throw new RunnerUpgradeError(String((body as any)?.error || '426:协议版本不兼容,请升级 runner'));
    }
    const body = (await res.json().catch(() => ({}))) as any;
    if (!res.ok || body?.success === false) {
      throw new Error(String(body?.error || `HTTP ${res.status}`));
    }
    return body as T;
  }

  /** 配对核销:一次性配对码 + 设备元信息 → deviceId/deviceSecret */
  async pair(code: string, meta: RunnerDeviceMeta = deviceMeta()): Promise<{ deviceId: string; deviceSecret: string }> {
    return this.request<{ deviceId: string; deviceSecret: string }>(this.url('/api/runner/pair'), {
      method: 'POST',
      headers: this.headers(true),
      body: JSON.stringify({ code, ...meta }),
    });
  }

  /** 轮询(≈5s 一次):缺省纯心跳;claim=true 时 FIFO 领取任务(M2 起启用)。
   *  心跳顺带上报元信息(runner 升级后版本自新)。 */
  async poll(opts: { claim?: boolean; meta?: RunnerDeviceMeta } = {}): Promise<PollResult> {
    const meta = opts.meta ?? deviceMeta();
    return this.request<PollResult>(
      this.url('/api/runner/tasks', {
        ...(opts.claim ? { claim: '1' } : {}),
        hostname: meta.hostname,
        platform: meta.platform,
        runnerVersion: meta.runnerVersion,
        protocolVersion: String(meta.protocolVersion),
      })
    , { headers: this.headers() });
  }

  /** 批量上行事件(断网重发安全:云端按 eventId 幂等去重);畸形项本地先行过滤 */
  async postEvents(events: unknown[]): Promise<{ accepted: number; rejected: number }> {
    const clean = events.map((e) => normalizeRunnerEvent(e)).filter((e): e is RunnerEvent => e !== null);
    if (clean.length === 0) return { accepted: 0, rejected: 0 };
    const body = await this.request<{ accepted?: number; rejected?: number }>(this.url('/api/runner/events'), {
      method: 'POST',
      headers: this.headers(true),
      body: JSON.stringify({ events: clean }),
    });
    // 只取协议字段,不透传云端应答的其余键(success/stateChanges 属路由侧内部信息)
    return { accepted: Number(body?.accepted) || 0, rejected: Number(body?.rejected) || 0 };
  }
}
