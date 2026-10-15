import * as os from 'os';
import * as fs from 'fs';
import {
  RUNNER_PROTOCOL_VERSION,
  normalizeRunnerEvent,
  type RunnerDeviceMeta,
  type RunnerEvent,
} from '@agtpilot/protocol';
import { redactEvent } from './redaction';
import { getCachedGhLogin } from './gh';

/**
 * runner 自身版本(心跳/配对上报,云端做版本治理 §9)。
 * 从包根 package.json 运行时读取 —— src 经 tsx 直跑与 dist/bin.mjs 发布形态
 * 的相对位置一致(均为「包根/package.json」),不再手工同步版本号
 * (曾硬编码 '0.0.3' 落后 package.json 三个小版本,心跳版本治理失真)。
 */
function readSelfVersion(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf-8'));
    return typeof pkg?.version === 'string' ? pkg.version : 'unknown';
  } catch {
    return 'unknown';
  }
}
export const RUNNER_VERSION = readSelfVersion();

/** 401(密钥不符/已吊销)→ 调用方应自毁本地凭据并提示重新配对 */
export class RunnerAuthError extends Error {}
/** 426(协议版本不兼容)→ 调用方应提示升级命令 */
export class RunnerUpgradeError extends Error {}

export function deviceMeta(): RunnerDeviceMeta {
  // ghLogin:bin 启动时 ensureGhLogin() 探测一次后缓存(公开用户名,非凭据);
  // 未探测过(旧调用路径)则省略字段,云端回退存量值
  const ghLogin = getCachedGhLogin();
  return {
    hostname: os.hostname().slice(0, 100),
    platform: process.platform,
    runnerVersion: RUNNER_VERSION,
    protocolVersion: RUNNER_PROTOCOL_VERSION,
    ...(ghLogin !== undefined ? { ghLogin } : {}),
  };
}

export interface RunnerClientCreds {
  deviceId: string;
  deviceSecret: string;
}

export interface PollResult {
  serverTime: number;
  claimed: { taskId: string; pack: unknown } | null;
  /** 队列概览;targetDeviceId = 派发时指定的目标设备(缺省 = 任意设备可领),旧版云端不带 */
  queue: Array<{ taskId: string; state: string; targetDeviceId?: string }>;
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
   *  心跳顺带上报元信息(runner 升级后版本自新)。ghLogin:null 以空串编码
   *  (query 参数天然是字符串;云端 '' → 明确未登录,缺省参数 → 沿用存量值)。 */
  async poll(opts: { claim?: boolean; meta?: RunnerDeviceMeta } = {}): Promise<PollResult> {
    const meta = opts.meta ?? deviceMeta();
    return this.request<PollResult>(
      this.url('/api/runner/tasks', {
        ...(opts.claim ? { claim: '1' } : {}),
        hostname: meta.hostname,
        platform: meta.platform,
        runnerVersion: meta.runnerVersion,
        protocolVersion: String(meta.protocolVersion),
        ...(meta.ghLogin !== undefined ? { ghLogin: meta.ghLogin ?? '' } : {}),
      })
    , { headers: this.headers() });
  }

  /** 批量上行事件(断网重发安全:云端按 eventId 幂等去重);
   *  M4:上行前过 redaction(已知密钥形态 + 本机 deviceSecret 值黑名单,§5.3),
   *  畸形项本地先行过滤。这里是全部事件出本机的唯一出口(集中闸)。 */
  async postEvents(events: unknown[]): Promise<{ accepted: number; rejected: number }> {
    const blacklist = this.creds?.deviceSecret ? [this.creds.deviceSecret] : [];
    const clean = events
      .map((e) => redactEvent(e, blacklist))
      .map((e) => normalizeRunnerEvent(e))
      .filter((e): e is RunnerEvent => e !== null);
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
