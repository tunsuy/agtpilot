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
  addRunnerUsage,
  buildPublishCommands,
  canTransitionRunnerTask,
  isTerminalRunnerState,
  isValidPairCodeFormat,
  normalizeNoAction,
  normalizeRunnerEvent,
  normalizeRunnerUsage,
  normalizeTaskPack,
  normalizeDeviceAction,
  type ApprovalRequest,
  type NoActionFinal,
  type PendingInterject,
  type RunnerApproval,
  type RunnerDeviceInfo,
  type RunnerDeviceAction,
  type RunnerDeviceMeta,
  type RunnerEvent,
  type RunnerPairCodeRecord,
  type RunnerTaskRecord,
  type RunnerTaskState,
} from '@agtpilot/protocol';
import { runnerDeletable, type RunnerTaskTombstone } from './runner-dispatch';

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
const taskTombstonesFile = (userId: string) => path.join(userDir(userId), 'task-tombstones.json');

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
 * 派发防重冲突(同一 issueUrl 的历史任务):
 * - no_action:agent 已带证据核实「无需改动」(上游已修复/无法复现/不属于本仓库)——
 *   重复派发大概率再烧一次执行窗口得到同样结论(生产背景:milvus #52049 同日 4 派);
 * - active:已有在途任务(queued→finishing 非终态)——重复派发会并行跑两份。
 * failed/done/cancelled/expired 不算冲突:失败重派、完成后再派都是合法人工动作。
 */
export interface DispatchConflict {
  kind: 'no_action' | 'active';
  taskId: string;
  state: RunnerTaskState;
  /** kind='no_action' 时的结论(原因 + 证据),路由侧透出给 UI 展示 */
  noAction?: NoActionFinal;
}

/** 纯查询:任务记录里找同 issueUrl 的派发冲突(no_action 优先于 active;无 → null) */
export function findDispatchConflict(tasks: RunnerTaskRecord[], issueUrl: string): DispatchConflict | null {
  if (!issueUrl) return null;
  const same = tasks.filter((t) => t.pack.issueUrl === issueUrl);
  const noAction = same.find((t) => t.state === 'no_action');
  if (noAction) {
    return { kind: 'no_action', taskId: noAction.taskId, state: noAction.state, ...(noAction.noAction ? { noAction: noAction.noAction } : {}) };
  }
  const active = same.find((t) => !isTerminalRunnerState(t.state));
  if (active) return { kind: 'active', taskId: active.taskId, state: active.state };
  return null;
}

/**
 * 入队(派发在 M2 接 UI;协议清洗失败 → null,拒绝入队)。
 * targetDeviceId(派发时指定设备,§4):必须是本用户未吊销的配对设备,
 * 否则 null 拒绝入队;缺省 = 不绑定,任意在线设备 FIFO 领取(存量语义)。
 * missionId(关联会话):设备任务 ↔ 驾驶舱会话互跳的关联键,形状不合法 → null。
 * force(派发防重旁路):同 issueUrl 已有 no_action 结论或在途任务时默认拒绝入队
 * (findDispatchConflict);UI 明示历史结论并经用户确认后带 force 重发。
 */
export function enqueueTask(
  userId: string,
  packInput: unknown,
  now: number = Date.now(),
  opts: { targetDeviceId?: string; missionId?: string; force?: boolean } = {}
): RunnerTaskRecord | null {
  const pack = normalizeTaskPack(packInput);
  if (!pack) return null;
  // 派发防重(权威闸,路由 409 预检之后仍兜底):no_action 结论/在途任务 → 拒绝,force 旁路
  if (opts.force !== true && findDispatchConflict(readTasks(userId), pack.issueUrl)) return null;
  let targetDeviceId: string | undefined;
  if (opts.targetDeviceId !== undefined) {
    if (!DEVICE_ID_RE.test(opts.targetDeviceId)) return null;
    const device = readDevices(userId).find((d) => d.deviceId === opts.targetDeviceId);
    if (!device || device.revoked) return null; // 目标设备不存在/已吊销:拒绝入队,不静默降级 FIFO
    targetDeviceId = opts.targetDeviceId;
  }
  // 关联会话(可选):形状校验(存在性由派发侧上下文保证;会话删除后跳转自然失效)
  let missionId: string | undefined;
  if (opts.missionId !== undefined) {
    if (typeof opts.missionId !== 'string' || opts.missionId.length > 128 || opts.missionId.length === 0) return null;
    missionId = opts.missionId;
  }
  if (readTasks(userId).some((t) => t.taskId === pack.taskId)) return null; // taskId 冲突(幂等)
  const record: RunnerTaskRecord = {
    taskId: pack.taskId,
    userId,
    ...(targetDeviceId ? { targetDeviceId } : {}),
    ...(missionId ? { missionId } : {}),
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

/** 懒过期清扫(无常驻定时器:读取路径顺带执行,cron-service 同款哲学) */function sweepExpired(tasks: RunnerTaskRecord[], now: number): boolean {
  let changed = false;
  for (const t of tasks) {
    if (!isTerminalRunnerState(t.state) && t.expiresAt <= now && canTransitionRunnerTask(t.state, 'expired')) {
      t.state = 'expired';
      t.updatedAt = now;
      // 过期也是"离开在飞状态":残留的终止请求/待送达插话一并清掉
      t.cancelRequested = undefined;
      t.pendingInterjects = undefined;
      changed = true;
    }
  }
  return changed;
}

/**
 * 用户终止任务(执行中止损;与审批拒绝同构的两阶段设计):
 * - queued(从未被领取):云端单方面直接落 cancelled,runner 永远领不到;
 * - dispatched/running(在飞):置 cancelRequested 标志、状态不动 ——
 *   getDeviceActions 据此下发 cancel 动作,runner 杀掉本地 claude 进程后
 *   上报 state cancelled 落终态(runner 未升级不识别时,任务至多跑到超时/过期,与现状同);
 * - awaiting_approval 不在此列:审批卡「拒绝」即其终止路径;终态一律拒绝。
 */
export function cancelRunnerTask(userId: string, taskId: string, now: number = Date.now()): { ok: boolean; error?: string; task?: RunnerTaskRecord } {
  const tasks = readTasks(userId);
  const task = tasks.find((t) => t.taskId === taskId);
  if (!task) return { ok: false, error: 'not_found' };
  if (task.state === 'queued') {
    task.state = 'cancelled';
    task.updatedAt = now;
    writeTasks(userId, tasks);
    return { ok: true, task };
  }
  if (task.state === 'dispatched' || task.state === 'running') {
    if (task.cancelRequested) return { ok: true, task }; // 幂等:已请求过
    task.cancelRequested = true;
    task.updatedAt = now;
    writeTasks(userId, tasks);
    return { ok: true, task };
  }
  return { ok: false, error: 'not_cancellable', task };
}

/** 墓碑只服务雷达黑名单(每轮截断 50 条),200 条封顶够多年派发量;超限丢最旧 */
const TOMBSTONES_CAP = 200;

function readTombstones(userId: string): RunnerTaskTombstone[] {
  const raw = readJson<RunnerTaskTombstone[]>(taskTombstonesFile(userId), []);
  return Array.isArray(raw) ? raw : [];
}

/** 删除任务的墓碑(server-render 合并进雷达派发历史:删列表 ≠ Issue 放出黑名单) */
export function getRunnerTaskTombstones(userId: string): RunnerTaskTombstone[] {
  return readTombstones(userId);
}

/**
 * 删除终态任务记录(设备页清理):完整记录与事件流从 tasks.json 移除;带
 * issueUrl 的落一条墓碑 —— 雷达去重黑名单不因删除失效(milvus #52049 修复
 * 合并后仍被周扫反复推荐的回归保护)。非终态(在途/待审批)一律拒绝:
 * 先终止(或审批卡拒绝)落终态再删。同一 Issue 只留最近一条墓碑,与
 * radarDispatchHistory「同 issueUrl 只留最近一次」口径一致。
 */
export function deleteRunnerTask(
  userId: string,
  taskId: string,
  now: number = Date.now()
): { ok: boolean; error?: string } {
  const tasks = readTasks(userId);
  const idx = tasks.findIndex((t) => t.taskId === taskId);
  if (idx < 0) return { ok: false, error: 'not_found' };
  const task = tasks[idx];
  if (!runnerDeletable(task)) return { ok: false, error: 'not_deletable' };
  tasks.splice(idx, 1);
  writeTasks(userId, tasks);
  const issueUrl = task.pack?.issueUrl;
  if (issueUrl) {
    const next = readTombstones(userId).filter((t) => t.issueUrl !== issueUrl);
    next.push({
      taskId,
      issueUrl,
      state: task.state,
      ...(task.noAction?.reason ? { noActionReason: task.noAction.reason } : {}),
      deletedAt: now,
    });
    writeJsonAtomic(
      taskTombstonesFile(userId),
      next.length > TOMBSTONES_CAP ? next.slice(next.length - TOMBSTONES_CAP) : next
    );
  }
  return { ok: true };
}

/** 单任务待送达插话上限(队列满 → 拒绝新插话;正常纠偏场景远够用,防误连发) */
const PENDING_INTERJECTS_CAP = 10;

/**
 * 用户中途插话(执行中纠偏;与 cancel 同构的两阶段设计):
 * dispatched/running 才受理 —— 写入 pendingInterjects 队列,状态不动;
 * getDeviceActions 据此派生 interject 动作(at-least-once 下行,runner 按
 * interjectId 去重),直到 runner 上报 interject_ack 按 id 清队。
 * 正文防线与协议清洗**同源**:构造下行动作形状过 normalizeDeviceAction,
 * 通过即 runner 侧必能受理(trim 后非空 ≤2000、拒控制字符);拒绝即拒收。
 */
export function interjectRunnerTask(
  userId: string,
  taskId: string,
  text: string,
  now: number = Date.now()
): { ok: boolean; error?: string; task?: RunnerTaskRecord } {
  const tasks = readTasks(userId);
  const task = tasks.find((t) => t.taskId === taskId);
  if (!task) return { ok: false, error: 'not_found' };
  if (task.state !== 'dispatched' && task.state !== 'running') {
    return { ok: false, error: 'not_interjectable', task };
  }
  const id = `intj_${now.toString(36)}_${crypto.randomBytes(4).toString('hex')}`;
  const probe = normalizeDeviceAction({
    taskId,
    kind: 'interject',
    repo: task.pack.repo,
    workBranch: task.pack.workBranch,
    interjectId: id,
    text,
  });
  if (!probe || probe.kind !== 'interject' || !probe.text) {
    return { ok: false, error: 'invalid_text', task };
  }
  const pending: PendingInterject[] = task.pendingInterjects ?? [];
  if (pending.length >= PENDING_INTERJECTS_CAP) return { ok: false, error: 'queue_full', task };
  pending.push({ id, text: probe.text, createdAt: now });
  task.pendingInterjects = pending;
  task.updatedAt = now;
  writeTasks(userId, tasks);
  return { ok: true, task };
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
 * - phase2_result 携带 prUrl → 回流任务记录;
 * - phase1_result/error 携带 usage → 清洗累加落 task.localUsage(本地消耗补账)。
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
      let to = event.payload?.state as RunnerTaskState | undefined;
      // no-action 升级(v1 线上兼容:runner 上报 failed + error 事件带 noAction 标记,
      // 标记在同批次先落 task.noAction)→ failed 升级为 no_action 例外终态入库。
      // running→no_action 在迁移表内;雷达去重与派发防重都以 no_action 记录为准。
      if (to === 'failed' && task.noAction && canTransitionRunnerTask(task.state, 'no_action')) to = 'no_action';
      if (!to || isTerminalRunnerState(task.state) || !canTransitionRunnerTask(task.state, to)) {
        result.rejected++;
        continue;
      }
      const from = task.state;
      task.state = to;
      task.updatedAt = now;
      // 终止请求只在在飞状态有意义:任务一旦离开 dispatched/running(被 runner 确认落
      // cancelled、跑到自然终态、或进审批卡),标志即清 —— 旧 runner 不识别 cancel 动作时
      // 任务会跑到自然终态,不清则 UI 永远显示「终止中…」,getDeviceActions 也不再派生
      if (task.cancelRequested && to !== 'dispatched' && to !== 'running') task.cancelRequested = undefined;
      // 同口径:离开在飞状态即无会话可注,待送达插话整队清空(ack 永不会再来,
      // 不清则 getDeviceActions 会永远重发、UI 永远显示「送达中…」)
      if (task.pendingInterjects?.length && to !== 'dispatched' && to !== 'running') task.pendingInterjects = undefined;
      result.stateChanges.push({ taskId: task.taskId, from, to });
    }

    if (event.type === 'phase2_result') {
      if (typeof event.payload?.prUrl === 'string') {
        task.prUrl = event.payload.prUrl.slice(0, 500);
        task.updatedAt = now;
      } else if (task.pack.prFollowUp && !task.prUrl) {
        // PR 跟进任务:发布命令 push-only,没有 gh pr create 输出可提取 PR 链接 ——
        // 跟进任务的 PR 就是任务包里的原 PR,回流兜底它(任务卡 PR 入口不缺席)
        task.prUrl = task.pack.prFollowUp.prUrl;
        task.updatedAt = now;
      }
    }
    if (event.type === 'error' && typeof event.payload?.message === 'string') {
      task.error = event.payload.message.slice(0, 2000);
      // 加固 ②:瞬时 API/网关失败 → runner 在 error 事件带 retryable:true,落任务记录;
      // UI 据此把 failed 标成「可重试」(重派仍人工,不自动 requeue)。仅认显式 true。
      if (event.payload?.retryable === true) task.retryable = true;
      // no-action 结论标记(例外终态):agent 核实无需改动且带证据 → 清洗落库;
      // 随后的 state failed 事件据此升级 no_action(证据缺失/畸形 → normalizeNoAction
      // 返回 null,任务保持普通 failed 语义,与旧 runner 行为一致)
      const noAction = normalizeNoAction(event.payload?.noAction);
      if (noAction) task.noAction = noAction;
      task.updatedAt = now;
    }
    if (event.type === 'interject_ack') {
      // 插话送达回执:按 interjectId 清出待送达队列(at-least-once 下行到此为止;
      // runner 侧另有去重集兜底重发窗口)。delivered=false(会话已收尾等)同样清 ——
      // 送达状态与原因已随事件入时间线,UI 据此显示「未送达」而非继续挂「送达中」
      const ackId = event.payload?.interjectId;
      const pending = task.pendingInterjects;
      if (typeof ackId === 'string' && pending?.length) {
        const rest = pending.filter((p) => p.id !== ackId);
        if (rest.length !== pending.length) {
          task.pendingInterjects = rest.length > 0 ? rest : undefined;
          task.updatedAt = now;
        }
      }
    }
    // 本地 CLI 用量补账(2026-10-20):phase1_result/error 事件带 payload.usage
    // (runner 报当轮汇总,含自动重试轮)→ 清洗后跨重派轮次累加落任务记录。
    // 幂等:上方 eventId 去重先行,重发批次不会重复计账。只展示不并入 mission 预算。
    if ((event.type === 'phase1_result' || event.type === 'error') && event.payload?.usage) {
      const u = normalizeRunnerUsage(event.payload.usage);
      if (u) {
        task.localUsage = addRunnerUsage(task.localUsage, u);
        task.updatedAt = now;
      }
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
  // PR 跟进任务(pack.prFollowUp):发布 = push-only(push 到已关联 PR 的分支即更新
  // PR;gh pr create 对已有 PR 必败),审批卡描述与命令预览同语义
  const followUpPrUrl = task.pack.prFollowUp?.prUrl;
  const preview = buildPublishCommands({
    workBranch: task.pack.workBranch,
    baseBranch,
    // 经 fork 派发:pr create 显式 --repo 钉住上游(否则 gh 按 fork 克隆的
    // origin 解析缺省 base 仓,PR 会落进 fork 自己而非上游)
    repo: task.pack.repo,
    prTitle: a.prTitle,
    prBody: a.prBody,
    forkHead: forkRepo?.split('/')[0],
    prExists: Boolean(followUpPrUrl),
  });
  return {
    id: a.approvalId,
    action: 'runner_publish',
    description: followUpPrUrl
      ? `发布本地贡献成果(PR 跟进):${task.pack.repo} · 推送 ${task.pack.workBranch} 更新既有 PR`
      : forkRepo
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
      // PR 跟进任务:审批卡展示原 PR 链接与 push-only 文案(命令集只固化 git push)
      ...(followUpPrUrl ? { followUpPrUrl } : {}),
      // 批准后必执行的两条(展示预览;批准时刻重新固化落盘,以落盘为准)
      commands: preview ?? undefined,
    },
    // 不设 taskId:runner 任务不是 Mission,避免 submitApproval 误定位 mission。
    // missionId 仅供 UI 作用域(审批卡归回来源会话展示),不参与裁决路由
    ...(task.missionId ? { missionId: task.missionId } : {}),
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
    // 经 fork 派发:PR head 固化为 `ghLogin:branch` 跨仓形式,且显式 --repo 钉住
    // 上游(base 仍是上游基线)——不带 --repo 时 gh 在 fork 克隆目录内按 origin
    // 解析缺省 base 仓,PR 会开进 fork 自己,到不了上游
    const forkRepo = taskForkRepo(userId, task);
    const commands = buildPublishCommands({
      workBranch: task.pack.workBranch,
      // 实探基线(runner 回流,如 master):固化命令执行的 gh pr create --base
      // 必须指向上游真实存在的分支 —— 派发缺省 'main' 在 milvus 类仓库开不出 PR
      baseBranch: taskBaseBranch(task),
      repo: task.pack.repo,
      prTitle: a.prTitle,
      prBody: a.prBody,
      issueUrl: task.pack.issueUrl,
      claimDraft: task.pack.claimDraft,
      includeClaim,
      forkHead: forkRepo?.split('/')[0],
      // PR 跟进任务:只固化 git push(push 到已关联 PR 的分支即更新 PR;
      // gh pr create 对已有 PR 必败,认领留言无意义 —— prExists 分支全部跳过)
      prExists: Boolean(task.pack.prFollowUp?.prUrl),
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
    // 用户终止任务(cancelRequested 标记派生;无审批单,approvalId 缺省):
    // 幂等下发直到 runner 上报 cancelled(recordRunnerEvents 收到终态时清标志)
    if (t.cancelRequested && (t.state === 'dispatched' || t.state === 'running')) {
      actions.push({ taskId: t.taskId, kind: 'cancel', repo: t.pack.repo, workBranch: t.pack.workBranch });
    }
    // 用户中途插话(pendingInterjects 队列派生):at-least-once 下行,持续重发
    // 直到 runner 上报 interject_ack 清队(runner 按 interjectId 去重,不会重复注入);
    // 老 runner 白名单不识别 interject → 忽略,任务至多跑完,插话自然过期(队列随终态清)
    if (t.pendingInterjects?.length && (t.state === 'dispatched' || t.state === 'running')) {
      for (const p of t.pendingInterjects) {
        actions.push({
          taskId: t.taskId,
          kind: 'interject',
          repo: t.pack.repo,
          workBranch: t.pack.workBranch,
          interjectId: p.id,
          text: p.text,
        });
      }
    }
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
