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
  canTransitionRunnerTask,
  isTerminalRunnerState,
  isValidPairCodeFormat,
  normalizeRunnerEvent,
  normalizeTaskPack,
  type RunnerDeviceInfo,
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

/** 核销配对码 → 注册设备,deviceSecret 只在此应答里出现一次 */
export function redeemPairCode(
  rawCode: unknown,
  meta: RunnerDeviceMeta,
  now: number = Date.now()
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
    createdAt: now,
    lastSeenAt: now,
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
 * 成功时顺带节流落盘 lastSeenAt(心跳)。
 */
export function authenticateRunner(
  runnerId: string | null,
  bearer: string | null,
  now: number = Date.now()
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
  writeDevices(userId, devices);
  return true;
}

// ---------- 任务队列与事件(§5) ----------

/** 入队(派发在 M2 接 UI;协议清洗失败 → null,拒绝入队) */
export function enqueueTask(userId: string, packInput: unknown, now: number = Date.now()): RunnerTaskRecord | null {
  const pack = normalizeTaskPack(packInput);
  if (!pack) return null;
  if (readTasks(userId).some((t) => t.taskId === pack.taskId)) return null; // taskId 冲突(幂等)
  const record: RunnerTaskRecord = {
    taskId: pack.taskId,
    userId,
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

/** runner 领取:FIFO 取最老 queued → dispatched 并绑定设备 */
export function claimNextTask(userId: string, deviceId: string, now: number = Date.now()): RunnerTaskRecord | null {
  const tasks = readTasks(userId);
  const changed = sweepExpired(tasks, now);
  const next = tasks
    .filter((t) => t.state === 'queued')
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
