import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { getDataDir } from './user-store';
import { safeName } from './user-store-v2';
import { encryptSecret, decryptSecret } from './secret-box';
import {
  PAIR_CODE_ALPHABET,
  PAIR_CODE_LENGTH,
  PAIR_CODE_TTL_MS,
  RUNNER_TASK_TTL_MS,
  RUNNER_PROTOCOL_VERSION,
  buildPublishCommands,
  canTransitionRunnerTask,
  isTerminalRunnerState,
  isValidPairCodeFormat,
  normalizeRunnerEvent,
  normalizeTaskPack,
  type ApprovalRequest,
  type RunnerApproval,
  type RunnerDeviceInfo,
  type RunnerDeviceAction,
  type RunnerDeviceMeta,
  type RunnerEvent,
  type RunnerPairCodeRecord,
  type RunnerTaskRecord,
  type RunnerTaskState,
} from '@agtpilot/protocol';

/**
 * 本地 Runner 桥接 · 云端侧服务(docs/design/local-runner-bridge.md)
 *
 * 形态仿 cron-service:纯函数式 lib,无常驻进程 —— 一切状态由
 * /api/runner/* 路由在被调用时同步读改写。持久化落
 * `<dataDir>/runner/`(独立于 user-store v2 域,心跳高频写不扰动 profile 域):
 *
 *   pair-codes.json           全局一次性配对码(短命,核销/过期即清)
 *   device-index.json         全局 deviceId → userId 索引(设备密钥认证寻址用)
 *   <safeUserId>/devices.json 设备注册表(deviceSecret 以 secret-box 密文存)
 *   <safeUserId>/tasks.json   任务队列(TaskPack + 状态机 + 事件)
 *
 * 安全边界(§4/§11):
 * - deviceSecret 256-bit 随机,只在配对应答里出现一次,云端只存密文;
 * - 比对走 timingSafeEqual;吊销 = 删密文 + 摘索引,轮询即刻 401;
 * - 配对码 5 分钟一次性核销,绑定创建它的 userId(防配对码钓鱼的影响面)。
 */

const ONLINE_WINDOW_MS = 60 * 1000; // 心跳 3-5s,60s 未见即视为离线
const LAST_SEEN_THROTTLE_MS = 30 * 1000; // lastSeenAt 落盘节流(轮询高频,不每次写盘)
const EVENTS_CAP = 200; // 每任务保留的最近事件数
const REDEEMED_CODE_KEEP_MS = 24 * 60 * 60 * 1000; // 已核销码保留一天(排障)后清

// ---------- 存储原语(原子写:tmp + rename) ----------

function runnerRoot(): string {
  const dir = path.join(getDataDir(), 'runner');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function userDir(userId: string): string {
  const dir = path.join(runnerRoot(), safeName(userId));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8')) as T;
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(file: string, data: unknown) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
  fs.renameSync(tmp, file);
}

const pairCodesFile = () => path.join(runnerRoot(), 'pair-codes.json');
const deviceIndexFile = () => path.join(runnerRoot(), 'device-index.json');
const devicesFile = (userId: string) => path.join(userDir(userId), 'devices.json');
const tasksFile = (userId: string) => path.join(userDir(userId), 'tasks.json');

function readPairCodes(): RunnerPairCodeRecord[] {
  return readJson<RunnerPairCodeRecord[]>(pairCodesFile(), []);
}

function readDeviceIndex(): Record<string, string> {
  return readJson<Record<string, string>>(deviceIndexFile(), {});
}

function readDevices(userId: string): RunnerDeviceInfo[] {
  return readJson<RunnerDeviceInfo[]>(devicesFile(userId), []);
}

function writeDevices(userId: string, devices: RunnerDeviceInfo[]) {
  writeJsonAtomic(devicesFile(userId), devices);
}

function readTasks(userId: string): RunnerTaskRecord[] {
  return readJson<RunnerTaskRecord[]>(tasksFile(userId), []);
}

function writeTasks(userId: string, tasks: RunnerTaskRecord[]) {
  writeJsonAtomic(tasksFile(userId), tasks);
}

// ---------- 配对与设备管理(§4) ----------

export interface PairCodeResult {
  code: string;
  expiresAt: number;
}

/** 生成一次性配对码(绑定当前登录用户;5 分钟过期) */
export function createPairCode(userId: string, now: number = Date.now()): PairCodeResult {
  let code = '';
  for (let i = 0; i < PAIR_CODE_LENGTH; i++) {
    code += PAIR_CODE_ALPHABET[crypto.randomInt(PAIR_CODE_ALPHABET.length)];
  }
  const codes = readPairCodes().filter(
    (c) => c.expiresAt > now || (c.redeemedAt && now - c.redeemedAt < REDEEMED_CODE_KEEP_MS)
  );
  codes.push({ code, userId, createdAt: now, expiresAt: now + PAIR_CODE_TTL_MS });
  writeJsonAtomic(pairCodesFile(), codes);
  return { code, expiresAt: now + PAIR_CODE_TTL_MS };
}

export type RedeemOk = { ok: true; userId: string; deviceId: string; deviceSecret: string };
export type RedeemErr = { ok: false; error: 'invalid_code' | 'expired' | 'already_redeemed' | 'protocol_unsupported' };

/** 核销配对码 → 注册设备,deviceSecret 只在此应答里出现一次;clientIp 为云端记录的来源 IP(可缺省) */
export function redeemPairCode(
  rawCode: unknown,
  meta: RunnerDeviceMeta,
  now: number = Date.now(),
  clientIp?: string | null
): RedeemOk | RedeemErr {
  if (!isProtocolSupportedLocal(meta.protocolVersion)) return { ok: false, error: 'protocol_unsupported' };
  if (!isValidPairCodeFormat(rawCode)) return { ok: false, error: 'invalid_code' };
  const code = String(rawCode).trim().toUpperCase();

  const codes = readPairCodes();
  const rec = codes.find((c) => c.code === code);
  if (!rec) return { ok: false, error: 'invalid_code' };
  if (rec.redeemedAt) return { ok: false, error: 'already_redeemed' };
  if (rec.expiresAt <= now) return { ok: false, error: 'expired' };

  const deviceId = `dev_${crypto.randomBytes(8).toString('hex')}`;
  const deviceSecret = crypto.randomBytes(32).toString('base64url');

  rec.redeemedAt = now;
  rec.deviceId = deviceId;
  writeJsonAtomic(pairCodesFile(), codes);

  const devices = readDevices(rec.userId);
  devices.push({
    deviceId,
    userId: rec.userId,
    hostname: meta.hostname,
    platform: meta.platform,
    runnerVersion: meta.runnerVersion,
    protocolVersion: meta.protocolVersion,
    ...(meta.ghLogin !== undefined ? { ghLogin: meta.ghLogin } : {}),
    createdAt: now,
    lastSeenAt: now,
    ...(clientIp ? { lastSeenIp: clientIp } : {}),
    secretEnc: encryptSecret(deviceSecret),
  });
  writeDevices(rec.userId, devices);

  const index = readDeviceIndex();
  index[deviceId] = rec.userId;
  writeJsonAtomic(deviceIndexFile(), index);

  return { ok: true, userId: rec.userId, deviceId, deviceSecret };
}

function isProtocolSupportedLocal(v: number): boolean {
  // v1:严格同版本;协议字段只增不改,破坏性变更走大版本号(§9)
  return v === RUNNER_PROTOCOL_VERSION;
}

/**
 * 设备密钥认证:X-Runner-Id + Bearer deviceSecret → { userId, device }。
 * 任何失败(未知设备/已吊销/密钥不符)一律 null(路由侧统一 401)。
 * 成功时顺带节流落盘 lastSeenAt(心跳);clientIp 为云端观察到的来源 IP,
 * 随同一节流窗口落盘 lastSeenIp(展示用,非鉴权依据)。
 */
export function authenticateRunner(
  runnerId: string | null,
  bearer: string | null,
  now: number = Date.now(),
  clientIp?: string | null
): { userId: string; device: RunnerDeviceInfo } | null {
  if (!runnerId || !bearer) return null;
  const userId = readDeviceIndex()[runnerId];
  if (!userId) return null;

  const devices = readDevices(userId);
  const device = devices.find((d) => d.deviceId === runnerId);
  if (!device || device.revoked || !device.secretEnc) return null;

  const expected = decryptSecret(device.secretEnc);
  if (!expected) return null;
  const a = Buffer.from(expected, 'utf-8');
  const b = Buffer.from(bearer, 'utf-8');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  if (now - device.lastSeenAt >= LAST_SEEN_THROTTLE_MS) {
    device.lastSeenAt = now;
    if (clientIp) device.lastSeenIp = clientIp;
    writeDevices(userId, devices);
  }
  return { userId, device };
}

export interface RunnerDeviceView {
  deviceId: string;
  hostname: string;
  platform: string;
  runnerVersion: string;
  protocolVersion: number;
  /** gh 公开登录名:undefined = 未上报(旧版 runner),null = 已上报未登录 */
  ghLogin?: string | null;
  /** 最近来源 IP(云端记录;直连无反代时可能缺省) */
  lastSeenIp?: string;
  createdAt: number;
  lastSeenAt: number;
  online: boolean;
  revoked: boolean;
}

/** 设备列表(出口剥离 secretEnc,绝不回传密文;online 由 lastSeenAt 窗口推导) */
export function listDevices(userId: string, now: number = Date.now()): RunnerDeviceView[] {
  return readDevices(userId).map((d) => ({
    deviceId: d.deviceId,
    hostname: d.hostname,
    platform: d.platform,
    runnerVersion: d.runnerVersion,
    protocolVersion: d.protocolVersion,
    ...(d.ghLogin !== undefined ? { ghLogin: d.ghLogin } : {}),
    ...(d.lastSeenIp ? { lastSeenIp: d.lastSeenIp } : {}),
    createdAt: d.createdAt,
    lastSeenAt: d.lastSeenAt,
    online: !d.revoked && now - d.lastSeenAt < ONLINE_WINDOW_MS,
    revoked: Boolean(d.revoked),
  }));
}

/** 吊销设备:删密文 + 摘全局索引 → 该设备下次轮询即 401(runner 本地自毁凭据) */
export function revokeDevice(userId: string, deviceId: string): boolean {
  const devices = readDevices(userId);
  const device = devices.find((d) => d.deviceId === deviceId);
  if (!device || device.revoked) return false;
  device.revoked = true;
  device.secretEnc = '';
  writeDevices(userId, devices);

  const index = readDeviceIndex();
  if (index[deviceId] === userId) {
    delete index[deviceId];
    writeJsonAtomic(deviceIndexFile(), index);
  }
  return true;
}

/** 心跳上报元信息更新(runner 升级后版本变化;节流同 authenticateRunner) */
export function updateDeviceMeta(userId: string, deviceId: string, meta: RunnerDeviceMeta): boolean {
  const devices = readDevices(userId);
  const device = devices.find((d) => d.deviceId === deviceId);
  if (!device || device.revoked) return false;
  device.hostname = meta.hostname;
  device.platform = meta.platform;
  device.runnerVersion = meta.runnerVersion;
  device.protocolVersion = meta.protocolVersion;
  // ghLogin 未上报(undefined,旧版 runner)时不覆盖存量值;null = 明确未登录,要覆盖
  if (meta.ghLogin !== undefined) device.ghLogin = meta.ghLogin;
  writeDevices(userId, devices);
  return true;
}

// ---------- 任务队列与事件(§5) ----------

const DEVICE_ID_RE = /^dev_[0-9a-f]{16}$/;

/**
 * 入队(派发在 M2 接 UI;协议清洗失败 → null,拒绝入队)。
 * targetDeviceId(派发时指定设备,§4):必须是本用户未吊销的配对设备,
 * 否则 null 拒绝入队;缺省 = 不绑定,任意在线设备 FIFO 领取(存量语义)。
 */
export function enqueueTask(
  userId: string,
  packInput: unknown,
  now: number = Date.now(),
  opts: { targetDeviceId?: string } = {}
): RunnerTaskRecord | null {
  const pack = normalizeTaskPack(packInput);
  if (!pack) return null;
  let targetDeviceId: string | undefined;
  if (opts.targetDeviceId !== undefined) {
    if (!DEVICE_ID_RE.test(opts.targetDeviceId)) return null;
    const device = readDevices(userId).find((d) => d.deviceId === opts.targetDeviceId);
    if (!device || device.revoked) return null; // 目标设备不存在/已吊销:拒绝入队,不静默降级 FIFO
    targetDeviceId = opts.targetDeviceId;
  }
  if (readTasks(userId).some((t) => t.taskId === pack.taskId)) return null; // taskId 冲突(幂等)
  const record: RunnerTaskRecord = {
    taskId: pack.taskId,
    userId,
    ...(targetDeviceId ? { targetDeviceId } : {}),
    pack,
    state: 'queued',
    createdAt: now,
    updatedAt: now,
    expiresAt: now + RUNNER_TASK_TTL_MS,
    events: [],
  };
  const tasks = readTasks(userId);
  tasks.push(record);
  writeTasks(userId, tasks);
  return record;
}

/** 懒过期清扫(无常驻定时器:读取路径顺带执行,cron-service 同款哲学) */
function sweepExpired(tasks: RunnerTaskRecord[], now: number): boolean {
  let changed = false;
  for (const t of tasks) {
    if (!isTerminalRunnerState(t.state) && t.expiresAt <= now && canTransitionRunnerTask(t.state, 'expired')) {
      t.state = 'expired';
      t.updatedAt = now;
      changed = true;
    }
  }
  return changed;
}

/** runner 领取:FIFO 取最老的可领 queued 任务(无绑定 或 绑定到本设备)→ dispatched 并绑定设备 */
export function claimNextTask(userId: string, deviceId: string, now: number = Date.now()): RunnerTaskRecord | null {
  const tasks = readTasks(userId);
  const changed = sweepExpired(tasks, now);
  const next = tasks
    .filter((t) => t.state === 'queued' && (!t.targetDeviceId || t.targetDeviceId === deviceId))
    .sort((a, b) => a.createdAt - b.createdAt)[0];
  if (next) {
    next.state = 'dispatched';
    next.deviceId = deviceId;
    next.updatedAt = now;
    writeTasks(userId, tasks);
    return next;
  }
  if (changed) writeTasks(userId, tasks);
  return null;
}

/** 任务列表(懒过期清扫后返回;最近在前) */
export function getRunnerTasks(userId: string, now: number = Date.now()): RunnerTaskRecord[] {
  const tasks = readTasks(userId);
  if (sweepExpired(tasks, now)) writeTasks(userId, tasks);
  return [...tasks].sort((a, b) => b.createdAt - a.createdAt);
}

export function getRunnerTask(userId: string, taskId: string, now: number = Date.now()): RunnerTaskRecord | null {
  return getRunnerTasks(userId, now).find((t) => t.taskId === taskId) ?? null;
}

export interface RecordEventsResult {
  accepted: number;
  rejected: number;
  /** 本批次触发的状态跳变(路由侧据此联动 Mission/审批,M3 接线) */
  stateChanges: Array<{ taskId: string; from: RunnerTaskState; to: RunnerTaskState }>;
}

/**
 * 批量记录上行事件(§5.3):
 * - normalize 失败 / 任务不属于该用户 / 设备冒名(event.deviceId ≠ 认证设备)→ rejected;
 * - eventId 幂等去重(重发批次不重复计);
 * - type='state' 且迁移合法 → 推进任务状态机;非法迁移拒绝该条(不改状态);
 * - phase2_result 携带 prUrl → 回流任务记录。
 */
export function recordRunnerEvents(
  userId: string,
  deviceId: string,
  eventsInput: unknown[],
  now: number = Date.now()
): RecordEventsResult {
  const result: RecordEventsResult = { accepted: 0, rejected: 0, stateChanges: [] };
  if (!Array.isArray(eventsInput) || eventsInput.length === 0) return result;

  const tasks = readTasks(userId);
  let dirty = false;

  for (const raw of eventsInput.slice(0, 100)) {
    const event = normalizeRunnerEvent(raw, { now });
    if (!event || event.deviceId !== deviceId) {
      result.rejected++;
      continue;
    }
    const task = tasks.find((t) => t.taskId === event.taskId);
    if (!task) {
      result.rejected++;
      continue;
    }
    const events = task.events ?? [];
    if (events.some((e) => e.eventId === event.eventId)) {
      result.accepted++; // 幂等重发:计已收,不重复入列
      continue;
    }

    if (event.type === 'state') {
      const to = event.payload?.state as RunnerTaskState | undefined;
      if (!to || isTerminalRunnerState(task.state) || !canTransitionRunnerTask(task.state, to)) {
        result.rejected++;
        continue;
      }
      const from = task.state;
      task.state = to;
      task.updatedAt = now;
      result.stateChanges.push({ taskId: task.taskId, from, to });
    }

    if (event.type === 'phase2_result' && typeof event.payload?.prUrl === 'string') {
      task.prUrl = event.payload.prUrl.slice(0, 500);
      task.updatedAt = now;
    }
    if (event.type === 'error' && typeof event.payload?.message === 'string') {
      task.error = event.payload.message.slice(0, 2000);
      // 加固 ②:瞬时 API/网关失败 → runner 在 error 事件带 retryable:true,落任务记录;
      // UI 据此把 failed 标成「可重试」(重派仍人工,不自动 requeue)。仅认显式 true。
      if (event.payload?.retryable === true) task.retryable = true;
      task.updatedAt = now;
    }

    events.push(event);
    if (events.length > EVENTS_CAP) events.splice(0, events.length - EVENTS_CAP);
    task.events = events;
    dirty = true;
    result.accepted++;
  }

  if (dirty || sweepExpired(tasks, now)) writeTasks(userId, tasks);
  return result;
}

// ---------- Phase 2 审批门(§6.2,M3) ----------
//
// 审批单随任务记录持久化(tasks.json):agent-backend 的卡片列表是内存态,
// 服务重启后由 listPendingRunnerApprovalRequests 重新灌入(/api/agent/state 拉取时),
// 审批的**持久真相**永远在这里。固化命令集在批准时刻构建(buildPublishCommands),
// 批准后不可变 —— 审批批的就是 runner 执行的(§6.2 防漂移围栏)。

function newApprovalId(now: number): string {
  return `rappr_${now.toString(36)}_${crypto.randomBytes(4).toString('hex')}`;
}

/** 最近一条 phase1_result 载荷(PR 终稿/diffstat/测试尾部快照来源) */
function latestPhase1Payload(task: RunnerTaskRecord): Record<string, unknown> | null {
  const events = task.events ?? [];
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].type === 'phase1_result') return events[i].payload ?? null;
  }
  return null;
}

function snapshotStr(p1: Record<string, unknown> | null, key: string, max: number): string | undefined {
  const v = p1?.[key];
  return typeof v === 'string' && v ? v.slice(0, max) : undefined;
}

const REPO_FULL_RE = /^[\w.-]{1,100}\/[\w.-]{1,100}$/;
/** 分支名形状(实探回流防注入:git/gh 命令以数组传参,此处形状校验只做防御性过滤) */
const BRANCH_NAME_RE = /^[\w./-]{1,150}$/;

/**
 * 任务生效的基线分支:首选 runner 在 phase1_result 里回流的实探值 ——
 * 派发包缺省 'main',但不少仓库默认分支是 master(milvus 等),runner
 * 在仓库准备阶段已回落到真实默认分支;PR --base 与审批展示都以它为准。
 * 回流缺失/畸形 → 退 pack.baseBranch(再缺省 'main',与 runner 同口径)。
 */
function taskBaseBranch(task: RunnerTaskRecord): string | undefined {
  const fromEvent = snapshotStr(latestPhase1Payload(task), 'baseBranch', 150);
  if (fromEvent && BRANCH_NAME_RE.test(fromEvent) && !fromEvent.split('/').some((s) => s === '.' || s === '..')) {
    return fromEvent;
  }
  return task.pack.baseBranch;
}

/**
 * 经 fork 派发(viaFork)任务的实际 fork 全名(ghLogin/repo):
 * 首选 runner 在 phase1_result 里回流的 forkRepo(runner 实探的 gh 账号是唯一
 * 事实源);缺省回退「绑定设备的 ghLogin + 上游仓库名」推算。直连派发 / 无法
 * 确定 → undefined(固化命令的 PR head 退回裸分支名,gh 在 fork 克隆内也能
 * 从 origin 推断 head 仓库,只是不如显式 owner:branch 确定)。
 */
function taskForkRepo(userId: string, task: RunnerTaskRecord): string | undefined {
  if (!task.pack.viaFork) return undefined;
  const fromEvent = snapshotStr(latestPhase1Payload(task), 'forkRepo', 201);
  if (fromEvent && REPO_FULL_RE.test(fromEvent) && !fromEvent.split('/').some((s) => s === '.' || s === '..')) {
    return fromEvent;
  }
  const device = task.deviceId ? readDevices(userId).find((d) => d.deviceId === task.deviceId) : undefined;
  const name = task.pack.repo.split('/')[1];
  return device?.ghLogin && name ? `${device.ghLogin}/${name}` : undefined;
}

/**
 * 任务进入 awaiting_approval 时创建审批单(幂等:已有 pending 单直接复用)。
 * 非 awaiting_approval / 任务不存在 → null。
 */
export function createPublishApproval(
  userId: string,
  taskId: string,
  now: number = Date.now()
): { task: RunnerTaskRecord; approval: RunnerApproval } | null {
  const tasks = readTasks(userId);
  const task = tasks.find((t) => t.taskId === taskId);
  if (!task || task.state !== 'awaiting_approval') return null;
  if (task.approval?.status === 'pending') return { task, approval: task.approval };

  const p1 = latestPhase1Payload(task);
  const prFinal = (p1?.prFinal && typeof p1.prFinal === 'object' ? p1.prFinal : null) as
    | { title?: unknown; body?: unknown }
    | null;
  const approval: RunnerApproval = {
    approvalId: newApprovalId(now),
    status: 'pending',
    createdAt: now,
    // PR 终稿(agent 起草)优先,缺省回落派发时的草稿
    prTitle: String(
      (typeof prFinal?.title === 'string' && prFinal.title.trim()) || task.pack.prDraft.title
    ).slice(0, 300),
    prBody: String(
      (typeof prFinal?.body === 'string' && prFinal.body.trim()) || task.pack.prDraft.bodyTemplate || ''
    ).slice(0, 20000),
    commitHash: snapshotStr(p1, 'commitHash', 64),
    diffstat: snapshotStr(p1, 'diffstat', 4000),
    testTail: snapshotStr(p1, 'testTail', 2048),
  };
  task.approval = approval;
  task.approvalId = approval.approvalId;
  task.updatedAt = now;
  writeTasks(userId, tasks);
  return { task, approval };
}

/** 审批单 → 既有 ApprovalRequest(驾驶舱审批卡 + Web Push 复用,§8 审批门行) */
export function runnerApprovalToRequest(task: RunnerTaskRecord, userId: string): ApprovalRequest | null {
  const a = task.approval;
  if (!a || a.status !== 'pending') return null;
  const forkRepo = taskForkRepo(userId, task);
  const baseBranch = taskBaseBranch(task);
  const preview = buildPublishCommands({
    workBranch: task.pack.workBranch,
    baseBranch,
    prTitle: a.prTitle,
    prBody: a.prBody,
    forkHead: forkRepo?.split('/')[0],
  });
  return {
    id: a.approvalId,
    action: 'runner_publish',
    description: forkRepo
      ? `发布本地贡献成果:${task.pack.repo}(经 fork ${forkRepo})· 推送 ${task.pack.workBranch} 并向上游创建 PR`
      : `发布本地贡献成果:${task.pack.repo} · 推送 ${task.pack.workBranch} 并创建 PR`,
    dangerLevel: 'high',
    params: {
      taskId: task.taskId,
      repo: task.pack.repo,
      workBranch: task.pack.workBranch,
      baseBranch: baseBranch ?? 'main',
      issueUrl: task.pack.issueUrl,
      // 经 fork 派发:审批卡展示 fork 全名(PR 将从它指向上游)
      forkRepo,
      prTitle: a.prTitle,
      prBody: a.prBody,
      commitHash: a.commitHash,
      diffstat: a.diffstat,
      testTail: a.testTail,
      // 决策项 6:认领留言由审批卡勾选,勾选后 gh issue comment 进固化命令集
      claimDraft: task.pack.claimDraft,
      claimCommand: task.pack.claimDraft
        ? { cmd: 'gh', args: ['issue', 'comment', task.pack.issueUrl, '--body', task.pack.claimDraft] }
        : undefined,
      // 批准后必执行的两条(展示预览;批准时刻重新固化落盘,以落盘为准)
      commands: preview ?? undefined,
    },
    // 不设 taskId:runner 任务不是 Mission,避免 submitApproval 误定位 mission
    userId,
  };
}

export type ResolveApprovalResult =
  | { ok: true; task: RunnerTaskRecord }
  | { ok: false; error: 'not_found' | 'not_pending' | 'invalid_commands' };

/**
 * 审批裁决(agent-backend.submitApproval 的 runner_publish 分支调用):
 * - 批准:构建固化命令集(含勾选的认领留言)落盘,任务 → finishing,等 runner 轮询领取;
 * - 拒绝:审批单记 rejected,任务**留在 awaiting_approval** —— cancel 指令下行,
 *   由 runner 上报 state cancelled 落终态(§6.2 步骤 5:本地分支保留,runner 上报确认)。
 */
export function resolvePublishApproval(
  userId: string,
  approvalId: string,
  approved: boolean,
  opts?: { includeClaim?: boolean },
  now: number = Date.now()
): ResolveApprovalResult {
  const tasks = readTasks(userId);
  const task = tasks.find((t) => t.approval?.approvalId === approvalId);
  if (!task || !task.approval) return { ok: false, error: 'not_found' };
  const a = task.approval;
  if (a.status !== 'pending' || task.state !== 'awaiting_approval') return { ok: false, error: 'not_pending' };

  if (approved) {
    const includeClaim = Boolean(opts?.includeClaim && task.pack.claimDraft);
    // 经 fork 派发:PR head 固化为 `ghLogin:branch` 跨仓形式(base 仍是上游基线)
    const forkRepo = taskForkRepo(userId, task);
    const commands = buildPublishCommands({
      workBranch: task.pack.workBranch,
      // 实探基线(runner 回流,如 master):固化命令执行的 gh pr create --base
      // 必须指向上游真实存在的分支 —— 派发缺省 'main' 在 milvus 类仓库开不出 PR
      baseBranch: taskBaseBranch(task),
      prTitle: a.prTitle,
      prBody: a.prBody,
      issueUrl: task.pack.issueUrl,
      claimDraft: task.pack.claimDraft,
      includeClaim,
      forkHead: forkRepo?.split('/')[0],
    });
    if (!commands) return { ok: false, error: 'invalid_commands' };
    a.status = 'approved';
    a.decidedAt = now;
    a.includeClaim = includeClaim;
    a.commands = commands; // 固化:此后不再随任何输入变化
    task.state = 'finishing';
  } else {
    a.status = 'rejected';
    a.decidedAt = now;
  }
  task.updatedAt = now;
  writeTasks(userId, tasks);
  return { ok: true, task };
}

/**
 * 设备轮询下行的审批结果动作:
 * - finishing + approved → publish(携带固化命令集;runner 逐条白名单复核后执行);
 * - awaiting_approval + rejected → cancel(runner 上报 cancelled 确认,本地分支保留)。
 * 由任务状态推导,天然幂等:runner 事件到达前每次轮询都会重复下发同一动作。
 */
export function getDeviceActions(userId: string, deviceId: string): RunnerDeviceAction[] {
  const actions: RunnerDeviceAction[] = [];
  for (const t of readTasks(userId)) {
    if (t.deviceId !== deviceId) continue;
    const a = t.approval;
    if (!a) continue;
    if (t.state === 'finishing' && a.status === 'approved' && a.commands && a.commands.length > 0) {
      const forkRepo = taskForkRepo(userId, t);
      actions.push({
        taskId: t.taskId,
        approvalId: a.approvalId,
        kind: 'publish',
        repo: t.pack.repo,
        workBranch: t.pack.workBranch,
        // 经 fork 派发:runner 须在 fork 克隆目录执行发布命令(origin 指向 fork)
        ...(forkRepo ? { forkRepo } : {}),
        commands: a.commands,
      });
    } else if (t.state === 'awaiting_approval' && a.status === 'rejected') {
      actions.push({ taskId: t.taskId, approvalId: a.approvalId, kind: 'cancel', repo: t.pack.repo, workBranch: t.pack.workBranch });
    }
  }
  return actions;
}

/** 挂起中的 runner 审批卡(服务重启后 /api/agent/state 拉取时重灌 agent-backend,幂等) */
export function listPendingRunnerApprovalRequests(userId: string): ApprovalRequest[] {
  return readTasks(userId)
    .filter((t) => t.state === 'awaiting_approval' && t.approval?.status === 'pending')
    .map((t) => runnerApprovalToRequest(t, userId))
    .filter((r): r is ApprovalRequest => r !== null);
}
