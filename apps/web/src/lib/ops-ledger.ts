/**
 * 运营事件流水(append-only JSONL,运营视角数据源)。
 *
 * 为什么独立于 mission 存储:mission 有保留窗口(手动 50 条/每巡航任务
 * 20 条,saveUserMission 会把旧数据挤出窗口),直接扫 mission 文件做不了
 * 长期趋势;token 用量也只挂在 mission 对象上随窗口丢失。这里按事件
 * 逐条追加、永不删除 ——30 天 DAU/用量/失败趋势都有完整档案。
 *
 * 纪律(仿 runtime-log.ts):
 * - 落盘 <dataDir>/ops/events.jsonl(data 卷内,容器重建不丢);
 *   超过 10MB 滚动为 events.jsonl.1(仅保留一代,滚动即覆盖旧代);
 * - 串行追加(单链 promise),并发写不会交错出半行;
 * - 全程 best-effort:磁盘失败静默降级为丢弃,绝不影响业务主路径;
 * - 不记录任务标题/会话内容,只记结构与用量字段(运营后台是聚合视角,
 *   用户内容留在用户自己的 mission 存储里,不进运营流水)。
 */
import fs from 'node:fs';
import path from 'node:path';
import { getDataDir } from './user-store';

const OPS_DIRNAME = 'ops';
const LEDGER_FILENAME = 'events.jsonl';
const BACKFILL_MARKER = '.backfilled';
const ROTATE_BYTES = 10 * 1024 * 1024;

/**事件行(一行一个 JSON;at 为毫秒时间戳) */
export type OpsEvent =
  | { t: 'mission_started'; at: number; missionId: string; userId: string; source: OpsSource; workshopId?: string; cronJobId?: string }
  | { t: 'mission_finished'; at: number; missionId: string; userId: string; outcome: 'done' | 'failed' | 'aborted' | 'interrupted'; durationMs: number; stepCount: number }
  | { t: 'usage'; at: number; missionId: string; userId: string; promptTokens: number; completionTokens: number; sub?: boolean }
  | { t: 'user_login'; at: number; userId: string; name?: string; email?: string; provider?: string };

/** 任务来源(mission_started.source;运营视角的渠道分布口径) */
export type OpsSource = 'chat' | 'workshop' | 'cron' | 'channel' | 'background';

/** 从 runMission options 派生来源:显式 source > cronJobId > parentMissionId > workshopId > chat */
export function deriveOpsSource(options: { source?: string; cronJobId?: string; parentMissionId?: string; workshopId?: string }): OpsSource {
  if (options.source === 'channel') return 'channel';
  if (options.cronJobId) return 'cron';
  if (options.parentMissionId) return 'background';
  if (options.workshopId) return 'workshop';
  return 'chat';
}

let writeChain: Promise<void> = Promise.resolve();
let ledgerFilePath: string | null = null;
/** 路径缓存键:getDataDir 以 USER_DATA_DIR 为缓存键(测试切临时目录自动重算),这里同款语义 */
let ledgerDirKey: string | undefined;
/** 启动后已因落盘失败降级的标记:失败一次后不再反复尝试(避免错误日志风暴) */
let degradedToDropOnly = false;
/** 本进程已记过终态的 mission(done/abort/error 回声防双记,见 recordMissionFinished) */
const finishedInProcess = new Set<string>();

function resolveLedgerFilePath(): string | null {
  const key = process.env.USER_DATA_DIR;
  if (ledgerFilePath && ledgerDirKey === key) return ledgerFilePath;
  try {
    const dir = path.join(getDataDir(), OPS_DIRNAME);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    ledgerFilePath = path.join(dir, LEDGER_FILENAME);
    ledgerDirKey = key;
    return ledgerFilePath;
  } catch {
    return null;
  }
}

/** 测试专用:重置模块级状态(路径缓存/降级标记/终态去重 Set),并等待写链排空 */
export async function __resetOpsLedgerForTests(): Promise<void> {
  await writeChain;
  ledgerFilePath = null;
  ledgerDirKey = undefined;
  degradedToDropOnly = false;
  finishedInProcess.clear();
  writeChain = Promise.resolve();
}

/** 测试专用:等待已入队的全部写操作落盘。
 *  recordMissionFinished 的去重检查在链内、emit 在链执行时才追加新链节 ——
 *  单次 await 会漏掉链内新生的写,循环等待直到链稳定不再增长。 */
export async function __flushOpsWrites(): Promise<void> {
  let prev: Promise<void> | null = null;
  while (prev !== writeChain) {
    prev = writeChain;
    await prev;
  }
}

/** 追加一行(串行链;滚动检查同步做在链内,保持与 runtime-log 同款的简单性) */
function appendLine(line: string): void {
  writeChain = writeChain
    .then(() => {
      if (degradedToDropOnly) return;
      const file = resolveLedgerFilePath();
      if (!file) return;
      try {
        // 滚动:超限保留一代(与 runtime.log 同款语义,运营聚合窗口30 天,
        // 一代 10MB 足够;真被写满说明用量远超预期,丢最旧一天可接受)
        try {
          if (fs.existsSync(file) && fs.statSync(file).size > ROTATE_BYTES) {
            fs.renameSync(file, `${file}.1`);
          }
        } catch {
          // 滚动失败继续写原文件(宁可超限不丢当日事件)
        }
        fs.appendFileSync(file, line + '\n', 'utf-8');
      } catch (e) {
        degradedToDropOnly = true;
        console.error('[ops-ledger] 落盘失败,本进程内运营事件降级为丢弃:', e);
      }
    })
    .catch(() => {});
}

function emit(event: OpsEvent): void {
  try {
    appendLine(JSON.stringify(event));
  } catch {
    // JSON.stringify 失败(理论上不可达)同样静默
  }
}

export function recordMissionStarted(params: {
  missionId: string;
  userId?: string;
  source: OpsSource;
  workshopId?: string;
  cronJobId?: string;
  at?: number;
}): void {
  if (!params.userId || !params.missionId) return;
  emit({
    t: 'mission_started',
    at: params.at ?? Date.now(),
    missionId: params.missionId,
    userId: params.userId,
    source: params.source,
    ...(params.workshopId ? { workshopId: params.workshopId } : {}),
    ...(params.cronJobId ? { cronJobId: params.cronJobId } : {}),
  });
}

/**
 * 终态入账。同进程内每 mission 只记一次:done/error/abort 多路可能对同一
 * 任务重复到达(如 stop 后 orchestrator 回抛 Cancelled 回声),进程级
 * Set 去重 ——事件在串行链上落盘,去重检查也同步做在链内保时序一致。
 */
export function recordMissionFinished(params: {
  missionId: string;
  userId?: string;
  outcome: 'done' | 'failed' | 'aborted' | 'interrupted';
  durationMs: number;
  stepCount: number;
  at?: number;
}): void {
  if (!params.userId || !params.missionId) return;
  const key = params.missionId;
  writeChain = writeChain
    .then(() => {
      if (finishedInProcess.has(key)) return false;
      finishedInProcess.add(key);
      return true;
    })
    .then((shouldWrite) => {
      if (!shouldWrite) return;
      emit({
        t: 'mission_finished',
        at: params.at ?? Date.now(),
        missionId: params.missionId,
        userId: params.userId!,
        outcome: params.outcome,
        durationMs: Math.max(0, Math.round(params.durationMs)),
        stepCount: Math.max(0, Math.round(params.stepCount)),
      });
    })
    .catch(() => {});
 // 常驻任务会持续累积 Set 条目:巡航/后台任务量大时按10k 上限裁最旧
  if (finishedInProcess.size > 10000) {
    const it = finishedInProcess.values().next();
    if (!it.done) finishedInProcess.delete(it.value);
  }
}

export function recordUsage(params: {
  missionId: string;
  userId?: string;
  promptTokens: number;
  completionTokens: number;
  sub?: boolean;
  at?: number;
}): void {
  if (!params.userId || !params.missionId) return;
  const p = Number.isFinite(params.promptTokens) ? params.promptTokens : 0;
  const c = Number.isFinite(params.completionTokens) ? params.completionTokens : 0;
  if (p + c <= 0) return;
  emit({
    t: 'usage',
    at: params.at ?? Date.now(),
    missionId: params.missionId,
    userId: params.userId,
    promptTokens: p,
    completionTokens: c,
    ...(params.sub ? { sub: true } : {}),
  });
}

export function recordUserLogin(params: { userId: string; name?: string | null; email?: string | null; provider?: string }): void {
  if (!params.userId) return;
  emit({
    t: 'user_login',
    at: Date.now(),
    userId: params.userId,
    ...(params.name ? { name: String(params.name).slice(0, 64) } : {}),
    ...(params.email ? { email: String(params.email).toLowerCase().slice(0, 128) } : {}),
    ...(params.provider ? { provider: String(params.provider).slice(0, 32) } : {}),
  });
}

/** 全量读取(滚动代 + 当前文件;损坏行跳过;返回按时间升序) */
export function readOpsEvents(): OpsEvent[] {
  const events: OpsEvent[] = [];
  try {
    const file = resolveLedgerFilePath();
    if (!file) return events;
    for (const f of [`${file}.1`, file]) {
      if (!fs.existsSync(f)) continue;
      const raw = fs.readFileSync(f, 'utf-8');
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        try {
          const obj = JSON.parse(line);
          if (obj && typeof obj === 'object' && typeof obj.t === 'string') events.push(obj as OpsEvent);
        } catch {
          // 损坏行跳过(半行写入/手工编辑残留)
        }
      }
    }
  } catch {
    // 读失败返回已收集部分(运营看板尽力而为)
  }
  events.sort((a, b) => a.at - b.at);
  return events;
}

/**
 * 历史回灌:把存量 mission(保留窗口内的)按 startedAt 补写流水,看板
 * 上线首日即有趋势。标记文件防重入,标记先行写(哪怕回灌中途崩溃,
 * 最多缺部分历史,不会二次回灌造成双计)。live usage 是增量事件、回灌
 * 是 startedAt 时刻的总量一笔,同 mission 不混用(回灌的 mission 全部
 * 是历史终态,live 只发生在回灌之后的新任务上)。
 */
export function backfillOpsFromMissions(params?: {
  getAllUsersData: () => Array<{ userId: string; missions?: any[] }>;
  nowMs?: number;
}): number {
  const now = params?.nowMs ?? Date.now();
  const dataDir = (() => {
    try {
      return getDataDir();
    } catch {
      return null;
    }
  })();
  if (!dataDir) return 0;
  let marker: string;
  let eventsFile: string;
  try {
    const dir = path.join(dataDir, OPS_DIRNAME);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    marker = path.join(dir, BACKFILL_MARKER);
    eventsFile = path.join(dir, LEDGER_FILENAME);
  } catch {
    return 0;
  }
  if (fs.existsSync(marker)) return 0;
  try {
    fs.writeFileSync(marker, String(now), 'utf-8');
  } catch {
    return 0; // 标记都写不进去,说明磁盘不可用,回灌无意义
  }

  const getAll = params?.getAllUsersData;
  let users: Array<{ userId: string; missions?: any[] }> = [];
  try {
    if (getAll) {
      users = getAll();
    } else {
      // 动态 require 避免测试/边缘环境下的循环加载问题(user-store 是
      // 热路径基础模块,ledger 是它的低频旁路消费者)
      const { getAllUsersData } = require('./user-store');
      users = getAllUsersData();
    }
  } catch (e) {
    console.error('[ops-ledger] 回灌读取用户数据失败:', e);
    return 0;
  }

  let written = 0;
  for (const user of users) {
    if (!user?.userId || !Array.isArray(user.missions)) continue;
    for (const m of user.missions) {
      if (!m || typeof m !== 'object' || !m.id) continue;
      const startedAt = Number.isFinite(m.startedAt) ? m.startedAt : now;
      const source = deriveOpsSource({
        cronJobId: m.cronJobId,
        parentMissionId: m.parentMissionId,
        workshopId: m.workshopId,
      });
      emit({
        t: 'mission_started',
        at: startedAt,
        missionId: String(m.id),
        userId: user.userId,
        source,
        ...(m.workshopId ? { workshopId: String(m.workshopId) } : {}),
        ...(m.cronJobId ? { cronJobId: String(m.cronJobId) } : {}),
      });
      written++;
      const usage = m.usage;
      if (usage && (usage.promptTokens > 0 || usage.completionTokens > 0)) {
        emit({
          t: 'usage',
          at: startedAt,
          missionId: String(m.id),
          userId: user.userId,
          promptTokens: Math.max(0, Math.round(usage.promptTokens || 0)),
          completionTokens: Math.max(0, Math.round(usage.completionTokens || 0)),
        });
        written++;
      }
      // 终态补一条 finished(历史 mission 的 stepCount 用实际长度,
      // stripped 摘要携带 stepCount 字段时优先)。走 recordMissionFinished
      // 而非裸 emit:首次启动时 sweepInterruptedMissions 可能刚把在飞任务
      // 标成 INTERRUPTED 并入过账,进程级去重保证同一任务只记一条终态。
      if (m.status && m.status !== 'ACTIVE' && m.status !== 'QUEUED' && m.status !== 'WAITING_APPROVAL') {
        const outcome: 'done' | 'failed' | 'aborted' | 'interrupted' =
          m.status === 'INTERRUPTED' ? 'interrupted' : m.status === 'DONE' ? 'done' : 'failed';
        const stepCount = Number.isFinite(m.stepCount) ? m.stepCount : Array.isArray(m.steps) ? m.steps.length : 0;
        recordMissionFinished({
          missionId: String(m.id),
          userId: user.userId,
          outcome,
          durationMs: 0, // 历史 mission 没有可靠的结束时刻,时长留0(趋势用天粒度,不影响)
          stepCount: Math.max(0, Math.round(stepCount)),
          at: startedAt,
        });
        written++;
      }
    }
  }
  void eventsFile; // 路径仅用于上面 marker 同目录推导,显式引用避免 lint 报未用
  return written;
}
