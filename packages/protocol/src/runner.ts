/**
 * 本地 Runner 桥接协议(docs/design/local-runner-bridge.md §5)
 *
 * web(云端调度)与 apps/runner(本地薄桥)共同依赖的单一事实源:
 * 纯类型 + 纯清洗函数(normalize*,不抛错、脏输入降级为 null),
 * 无任何 IO / 框架依赖,vitest 直测。
 *
 * 版本兼容治理(§9,已拍板发 npm 后成为硬约束):
 * - 协议字段只增不改,破坏性变更走大版本号(RUNNER_PROTOCOL_VERSION);
 * - runner 在配对与每次心跳上报自身版本与协议版本,云端对不兼容版本拒绝派发。
 */

import type { RunnerApproval } from './runner-publish';

/** 协议版本(v1:字段只增不改) */
export const RUNNER_PROTOCOL_VERSION = 1;

/** 任务 TTL:排队/在途任务默认 7 天过期(§5.2 状态机 expired) */
export const RUNNER_TASK_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** 一次性配对码:长度 / 有效期 / 字符集(去 0O1IL 等易混字符,§4) */
export const PAIR_CODE_LENGTH = 8;
export const PAIR_CODE_TTL_MS = 5 * 60 * 1000;
export const PAIR_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

/** 单条事件 payload 上行上限(数据最小化 §5.3;超限整体降级为截断标记) */
export const EVENT_PAYLOAD_MAX_BYTES = 64 * 1024;

/** 任务状态机(§5.2) */
export type RunnerTaskState =
  | 'queued'
  | 'dispatched'
  | 'running'
  | 'awaiting_approval'
  | 'finishing'
  | 'done'
  | 'failed'
  | 'cancelled'
  | 'expired';

const TASK_TRANSITIONS: Record<RunnerTaskState, RunnerTaskState[]> = {
  queued: ['dispatched', 'cancelled', 'expired'],
  dispatched: ['running', 'failed', 'cancelled', 'expired'],
  running: ['awaiting_approval', 'failed', 'cancelled', 'expired'],
  // 审批拒绝 → cancelled(本地分支保留,§6.2)
  awaiting_approval: ['finishing', 'cancelled', 'expired'],
  finishing: ['done', 'failed', 'cancelled'],
  done: [],
  failed: [],
  cancelled: [],
  expired: [],
};

export function isTerminalRunnerState(state: RunnerTaskState): boolean {
  return TASK_TRANSITIONS[state]?.length === 0;
}

export function canTransitionRunnerTask(from: RunnerTaskState, to: RunnerTaskState): boolean {
  return Boolean(TASK_TRANSITIONS[from]?.includes(to));
}

/** 任务包(§5.1;T0 离线交接包同格式超集) */
export interface RunnerTaskPack {
  taskId: string;
  /** v1 唯一类型,协议留扩展 */
  kind: 'oss_contribution';
  /** owner/repo */
  repo: string;
  /** Issue 直达链接(雷达产出) */
  issueUrl: string;
  /** 缺省 main */
  baseBranch?: string;
  /** 工作分支,如 contrib/oss-radar-<issueNo> */
  workBranch: string;
  /** 约束(只修这个 Issue/不动无关文件/遵循 CONTRIBUTING) */
  constraints: string[];
  /** 验收:哪些测试要绿 */
  acceptance: { testCommand?: string; note?: string };
  /**
   * Issue 上下文(标题+正文摘要,云端派发时装入;协议只增不改的增补字段)。
   * Phase 1 禁网(WebFetch/WebSearch 在 disallowedTools),本地 agent 看不到
   * Issue 页面 —— 干活依据必须随包携带。
   */
  issueContext?: string;
  /** 认领留言草稿(是否发送由 Phase 2 审批决定,决策项 6 已拍板并入) */
  claimDraft?: string;
  /** PR 草稿(终稿由本地 agent 按实际改动补全) */
  prDraft: { title: string; bodyTemplate: string };
  executor: { name: 'claude-code'; maxTurns: number; timeoutMinutes: number };
  /** 用户在派发弹窗里的补充说明(自由文本,进 prompt) */
  dispatchNote?: string;
  /**
   * 经 fork 派发(派发弹窗显式勾选):runner 领取后先 `gh repo fork`(幂等)
   * 确保 gh 账号名下存在上游 fork,克隆**fork 副本**干活;Phase 2 固化命令的
   * push 目标是 fork(origin),PR 以 `owner:branch` head 指向上游。
   * 解决第三方开源仓无推送权限时 push 必败的问题(§6.2)。
   */
  viaFork?: boolean;
}

/** 云端任务记录(TaskPack + 状态机字段;user-store 侧持久化) */
export interface RunnerTaskRecord {
  taskId: string;
  userId: string;
  /** 领取后绑定设备 */
  deviceId?: string;
  /** 派发时指定的目标设备(§4「派发时选设备」):只有该设备可领取;缺省 = 任意在线设备 FIFO */
  targetDeviceId?: string;
  pack: RunnerTaskPack;
  state: RunnerTaskState;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
  /** Phase 2 成功后回流的 PR 链接 */
  prUrl?: string;
  /** awaiting_approval 对应的云端审批单 id(= approval.approvalId,冗余便于检索) */
  approvalId?: string;
  /** Phase 2 审批单(M3,§6.2):展示快照 + 批准时刻固化的命令集 */
  approval?: RunnerApproval;
  error?: string;
  /**
   * 失败是否为**瞬时 API/网关错误**(加固 ②,§6.1):runner 的 error 事件带
   * retryable 标志,recordRunnerEvents 落到这里。true = 重新派发大概率恢复,
   * UI 把这类 failed 标成「可重试」而非干巴巴的终态(重派仍人工,不自动 requeue)。
   * 协议字段只增不改(v1 兼容):旧 runner 不上报 → 缺省 undefined,UI 回退普通「失败」。
   */
  retryable?: boolean;
  /** 上行事件(幂等去重后保留最近 N 条,cap 由 runner-bridge 控制) */
  events?: RunnerEvent[];
}

export type RunnerEventType = 'state' | 'progress' | 'phase1_result' | 'phase2_result' | 'error';

/** 上行事件(§5.3;数据最小化分级 minimal/standard/verbose 由 payload 内容体现) */
export interface RunnerEvent {
  /** 幂等去重键 */
  eventId: string;
  taskId: string;
  deviceId: string;
  at: number;
  type: RunnerEventType;
  payload?: Record<string, unknown>;
}

/** 设备元信息(配对/心跳上报) */
export interface RunnerDeviceMeta {
  hostname: string;
  platform: string;
  runnerVersion: string;
  protocolVersion: number;
  /**
   * 本机 gh CLI 登录账号名(公开用户名,非凭据;runner 用 `gh api user` 查询)。
   * undefined = 未上报(旧版 runner),null = 已上报但未登录 gh。
   * 云端用途:派发弹窗比对「仓库属主 vs 设备 gh 账号」提示推送权限;经 fork 派发时
   * 计算 fork 全名。凭据零上行红线不变:只报用户名,token 永不出本机。
   */
  ghLogin?: string | null;
}

/** 云端设备注册表条目(secretEnc 为 secret-box 密文,listDevices 出口剥离) */
export interface RunnerDeviceInfo extends RunnerDeviceMeta {
  deviceId: string;
  userId: string;
  createdAt: number;
  lastSeenAt: number;
  /**
   * 最近一次配对/心跳的请求来源 IP(云端侧记录,非 runner 上报;展示排障用)。
   * 取自 x-forwarded-for / x-real-ip 头,无反代直连时可能缺省;
   * 直连场景头可被伪造 —— 仅展示,不作任何安全决策依据。
   */
  lastSeenIp?: string;
  revoked?: boolean;
  secretEnc?: string;
}

/** 一次性配对码记录(云端侧,短命一次核销) */
export interface RunnerPairCodeRecord {
  code: string;
  userId: string;
  createdAt: number;
  expiresAt: number;
  /** 核销时间与核销产出的设备(一次性) */
  redeemedAt?: number;
  deviceId?: string;
}

// ---------- 清洗函数(纯函数,脏输入 → null,不抛错) ----------

const EVENT_TYPES: RunnerEventType[] = ['state', 'progress', 'phase1_result', 'phase2_result', 'error'];

function str(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  if (!t || t.length > max) return null;
  return t;
}

function optStr(v: unknown, max: number): string | undefined {
  return str(v, max) ?? undefined;
}

function intOr(v: unknown, min: number, max: number, fallback: number): number {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.round(n);
  return Math.min(max, Math.max(min, i));
}

export function isProtocolSupported(protocolVersion: unknown): boolean {
  return protocolVersion === RUNNER_PROTOCOL_VERSION;
}

const REPO_RE = /^[\w.-]{1,100}\/[\w.-]{1,100}$/;
const BRANCH_RE = /^[\w./-]{1,200}$/;
const ID_RE = /^[\w-]{1,128}$/;

/** 任务包清洗:核心字段缺失/畸形 → null(拒绝派发);可选字段降级缺省 */
export function normalizeTaskPack(input: unknown): RunnerTaskPack | null {
  if (!input || typeof input !== 'object') return null;
  const o = input as Record<string, unknown>;

  const taskId = str(o.taskId, 128);
  if (!taskId || !ID_RE.test(taskId)) return null;
  if (o.kind !== 'oss_contribution') return null;

  const repo = str(o.repo, 201);
  if (!repo || !REPO_RE.test(repo)) return null;
  // 路径穿越防线:owner/repo 任一段为 '.'/'..' 即拒(workspaceRoot 围栏的第一道闸)
  if (repo.split('/').some((seg) => seg === '.' || seg === '..')) return null;

  const issueUrl = str(o.issueUrl, 500);
  if (!issueUrl || !issueUrl.startsWith('https://')) return null;

  const workBranch = str(o.workBranch, 200);
  if (!workBranch || !BRANCH_RE.test(workBranch) || workBranch.startsWith('-') || workBranch.includes('..')) {
    return null;
  }
  const baseBranch = optStr(o.baseBranch, 200);
  if (baseBranch !== undefined && (!BRANCH_RE.test(baseBranch) || baseBranch.startsWith('-') || baseBranch.includes('..'))) {
    return null;
  }

  const constraints = Array.isArray(o.constraints)
    ? o.constraints
        .slice(0, 20)
        .map((c) => str(c, 500))
        .filter((c): c is string => c !== null)
    : [];

  const acc = (o.acceptance && typeof o.acceptance === 'object' ? o.acceptance : {}) as Record<string, unknown>;
  const acceptance = {
    testCommand: optStr(acc.testCommand, 500),
    note: optStr(acc.note, 2000),
  };

  const pr = (o.prDraft && typeof o.prDraft === 'object' ? o.prDraft : null) as Record<string, unknown> | null;
  const prTitle = pr ? str(pr.title, 300) : null;
  if (!pr || !prTitle) return null;

  const ex = (o.executor && typeof o.executor === 'object' ? o.executor : null) as Record<string, unknown> | null;
  if (!ex || ex.name !== 'claude-code') return null;

  return {
    taskId,
    kind: 'oss_contribution',
    repo,
    issueUrl,
    baseBranch,
    workBranch,
    constraints,
    acceptance,
    issueContext: optStr(o.issueContext, 8000),
    claimDraft: optStr(o.claimDraft, 5000),
    prDraft: { title: prTitle, bodyTemplate: str(pr.bodyTemplate, 20000) ?? '' },
    executor: {
      name: 'claude-code',
      maxTurns: intOr(ex.maxTurns, 1, 200, 60),
      timeoutMinutes: intOr(ex.timeoutMinutes, 1, 240, 30),
    },
    dispatchNote: optStr(o.dispatchNote, 5000),
    // 只认真正的 true(缺省/false/脏值一律视为未经 fork,派发保持直连语义)
    viaFork: o.viaFork === true ? true : undefined,
  };
}

/** 上行事件清洗:身份/类型字段畸形 → null;payload 超限 → 截断标记(不静默丢弃事件本体) */
export function normalizeRunnerEvent(
  input: unknown,
  opts?: { now?: number; maxPayloadBytes?: number }
): RunnerEvent | null {
  if (!input || typeof input !== 'object') return null;
  const o = input as Record<string, unknown>;

  const eventId = str(o.eventId, 128);
  const taskId = str(o.taskId, 128);
  const deviceId = str(o.deviceId, 128);
  if (!eventId || !taskId || !deviceId) return null;
  if (!ID_RE.test(taskId) || !ID_RE.test(deviceId)) return null;

  const type = EVENT_TYPES.includes(o.type as RunnerEventType) ? (o.type as RunnerEventType) : null;
  if (!type) return null;

  const maxBytes = opts?.maxPayloadBytes ?? EVENT_PAYLOAD_MAX_BYTES;
  let payload: Record<string, unknown> | undefined;
  if (o.payload && typeof o.payload === 'object' && !Array.isArray(o.payload)) {
    payload = o.payload as Record<string, unknown>;
    try {
      if (Buffer.byteLength(JSON.stringify(payload), 'utf-8') > maxBytes) {
        payload = { __truncated: true, reason: 'payload_exceeds_limit' };
      }
    } catch {
      payload = { __truncated: true, reason: 'payload_unserializable' };
    }
  }

  const at = typeof o.at === 'number' && Number.isFinite(o.at) && o.at > 0 ? o.at : (opts?.now ?? Date.now());

  return { eventId, taskId, deviceId, at, type, payload };
}

/** GitHub 登录名形状(1-39 位字母数字与连字符,不以连字符开头/结尾) */
const GH_LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;

/** 设备元信息清洗(配对与心跳共用)。ghLogin:null/'' = 明确未登录;
 *  合法字符串 = 登录名;缺省或畸形 = undefined(未知,路由侧回退存量值) */
export function normalizeDeviceMeta(input: unknown): RunnerDeviceMeta | null {
  if (!input || typeof input !== 'object') return null;
  const o = input as Record<string, unknown>;
  const hostname = str(o.hostname, 100);
  const runnerVersion = str(o.runnerVersion, 40);
  if (!hostname || !runnerVersion) return null;
  if (!/^[\w.+\-]{1,40}$/.test(runnerVersion)) return null;
  const protocolVersion = typeof o.protocolVersion === 'number' ? Math.trunc(o.protocolVersion) : NaN;
  if (!Number.isFinite(protocolVersion)) return null;
  let ghLogin: string | null | undefined;
  if (o.ghLogin === null || o.ghLogin === '') ghLogin = null;
  else if (typeof o.ghLogin === 'string' && GH_LOGIN_RE.test(o.ghLogin)) ghLogin = o.ghLogin;
  return {
    hostname: hostname.replace(/[\u0000-\u001f\u007f]/g, ''),
    platform: optStr(o.platform, 30) ?? 'unknown',
    runnerVersion,
    protocolVersion,
    ...(ghLogin !== undefined ? { ghLogin } : {}),
  };
}

/** 配对码格式校验(核销前粗筛;真核销在云端记录里一次性比对) */
export function isValidPairCodeFormat(code: unknown): boolean {
  if (typeof code !== 'string') return false;
  const c = code.trim().toUpperCase();
  return c.length === PAIR_CODE_LENGTH && [...c].every((ch) => PAIR_CODE_ALPHABET.includes(ch));
}
