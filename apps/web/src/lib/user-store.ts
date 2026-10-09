import * as fs from 'fs';
import * as path from 'path';
import { encryptSecret, decryptSecret, isEncrypted } from './secret-box';
import { getGovernanceBus } from './governance-bus';

/**
 * 用户级别数据持久化隔离存储引擎 (User Scoped Data Store)
 * 每个用户独占自己的数据空间，包含：
 * - 连接器 API Key 与环境变量配置 (connectors) —— 落盘一律 AES-256-GCM 加密（secret-box）
 * - MCP OAuth 授权记录 (mcpAuth) —— token/客户端注册信息/PKCE verifier，整条加密
 * - 个人长效记忆与画像 (memories)
 * - 主动巡航定时任务 (cron jobs)
 * - 执行会话历史任务 (missions)
 */

export interface PushSubscriptionRecord {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  userAgent?: string;
  createdAt: number;
}

export interface UserScopedData {
  userId: string;
  connectors: Record<string, string>; // envVar -> value（密文 `enc:v1:...`，历史明文读取时自动迁移）
  activeModelId?: string;
  /** MCP OAuth 授权记录：connectorId -> 加密后的 JSON 串（tokens/clientInfo/codeVerifier） */
  mcpAuth?: Record<string, string>;
  memories: any[];
  cronJobs: any[];
  missions: any[];
  goals?: any[];
  pushSubscriptions?: PushSubscriptionRecord[];
  /** 删除台账（持久状态治理 I3：删除必须传导到所有衍生副本，台账是传导与追责的依据） */
  deletionLedger?: DeletionLedgerEntry[];
  /** 权限纪元：key(connectorId 或 envVar) -> 单调递增纪元。撤销凭证后 +1，旧纪元的授权/承诺失效 */
  authorityEpochs?: Record<string, number>;
  updatedAt: number;
}

/**
 * 删除台账条目（docs/design/persistent-state-governance.md §3.2）：
 * 每次(软)删除都留下「删了什么、谁删的、何时删、传导了哪些下游动作」,
 * 只增不改 —— AOEP「删除台账还在吗」考题的直接答案。
 */
export interface DeletionLedgerEntry {
  id: string;
  target: { kind: 'memory' | 'connector-auth' | 'rag-doc'; id: string; userId: string };
  requestedBy: 'user' | 'auto' | 'propagated';
  reason?: string;
  at: number;
  /** I3 传导:由本次删除派生的下游删除/失效/待审动作 */
  propagated: Array<{ kind: string; id: string; action: 'soft-delete' | 'invalidate' | 'flag-review' }>;
  status: 'done' | 'partial';
}

/** 记忆审计日志条目（只增不改，落盘为独立 jsonl,与用户数据文件分离） */
export interface MemoryAuditEntry {
  at: number;
  actor: 'user' | 'agent' | 'auto-distill' | 'system';
  op:
    | 'add'
    | 'update'
    | 'supersede'
    | 'soft-delete'
    | 'restore'
    | 'purge'
    | 'write-rejected'
    | 'authority-revoked';
  memoryId?: string;
  connectorId?: string;
  epoch?: number;
  detail?: string;
}

/** MCP OAuth 单连接器授权记录（明文形态，落盘前整体 JSON 加密） */
export interface McpAuthRecord {
  tokens?: any; // OAuthTokens（access/refresh/expires/issuer）
  clientInfo?: any; // DCR 动态注册获得的客户端信息
  codeVerifier?: string; // PKCE verifier（start → callback 之间短暂存在）
  updatedAt?: number;
}

export function getDataDir(): string {
  // 1. 优先读取显式环境变量
  if (process.env.USER_DATA_DIR) {
    const custom = path.resolve(process.env.USER_DATA_DIR);
    if (!fs.existsSync(custom)) {
      try { fs.mkdirSync(custom, { recursive: true }); } catch {}
    }
    return custom;
  }

  // 2. 自动检测多个可能存在已有数据的候选路径（优先选已有 .json 数据的目录）
  const candidates = [
    '/app/.cache/user_data',
    '/app/apps/web/.cache/user_data',
    path.resolve(process.cwd(), '.cache', 'user_data'),
    path.resolve(process.cwd(), '..', '..', '.cache', 'user_data'),
  ];

  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) {
        const files = fs.readdirSync(c);
        if (files.some((f) => f.endsWith('.json'))) {
          return c;
        }
      }
    } catch {
      // ignore
    }
  }

  // 3. 若无已有 json，取已存在的目录
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }

  // 4. 回退
  const fallback = path.resolve(process.cwd(), '.cache', 'user_data');
  if (!fs.existsSync(fallback)) {
    try { fs.mkdirSync(fallback, { recursive: true }); } catch {}
  }
  return fallback;
}

function getUserFilePath(userId: string): string {
  const dataDir = getDataDir();
  // 对 userId 做安全文件名转义
  const safeFilename = userId.replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(dataDir, `${safeFilename}.json`);
}

export function getUserData(userId: string): UserScopedData {
  const filePath = getUserFilePath(userId);
  try {
    if (fs.existsSync(filePath)) {
      const raw = fs.readFileSync(filePath, 'utf-8');
      const data = JSON.parse(raw);
      if (!data.goals) data.goals = [];
      // 凭证解密 + 历史明文自动迁移加密（首次读取时用当前密钥补加密并回写）
      const plaintextFound = new Map<string, string>();
      if (data.connectors && typeof data.connectors === 'object') {
        for (const [k, v] of Object.entries<string>(data.connectors)) {
          if (typeof v !== 'string' || !v) continue;
          if (isEncrypted(v)) {
            data.connectors[k] = decryptSecret(v);
          } else {
            plaintextFound.set(k, v); // 内存里保持明文可直接用
          }
        }
      }
      if (plaintextFound.size > 0) {
        try {
          const toPersist = { ...data, connectors: { ...data.connectors }, updatedAt: Date.now() };
          for (const [k, plain] of plaintextFound) {
            toPersist.connectors[k] = encryptSecret(plain);
          }
          const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
          fs.writeFileSync(tmpPath, JSON.stringify(toPersist, null, 2), 'utf-8');
          fs.renameSync(tmpPath, filePath);
        } catch (e) {
          console.error(`Failed to migrate plaintext connectors for ${userId}:`, e);
        }
      }
      return data;
    }
  } catch (e) {
    console.error(`Failed to read user data for ${userId}:`, e);
  }

  // 默认空数据结构
  return {
    userId,
    connectors: {},
    activeModelId: 'deepseek',
    memories: [],
    cronJobs: [],
    missions: [],
    goals: [],
    updatedAt: Date.now(),
  };
}

export function saveUserData(data: UserScopedData) {
  const filePath = getUserFilePath(data.userId);
  try {
    data.updatedAt = Date.now();
    // 凭证落盘前统一加密（单一收口：所有写路径都经过这里；内存对象不受影响）
    const toWrite: UserScopedData = { ...data };
    if (toWrite.connectors) {
      const enc: Record<string, string> = {};
      for (const [k, v] of Object.entries(toWrite.connectors)) {
        enc[k] = typeof v === 'string' && v && !isEncrypted(v) ? encryptSecret(v) : v;
      }
      toWrite.connectors = enc;
    }
    // 原子写入：先写临时文件再 rename，避免写入中途崩溃/并发读导致 JSON 损坏
    const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(toWrite, null, 2), 'utf-8');
    fs.renameSync(tmpPath, filePath);
  } catch (e) {
    console.error(`Failed to save user data for ${data.userId}:`, e);
  }
}

// 辅助方法：连接器配置
export function getUserConnectors(userId: string) {
  const data = getUserData(userId);
  return {
    configs: data.connectors || {},
    activeModelId: data.activeModelId || 'deepseek',
  };
}

export function saveUserConnector(userId: string, envVar: string, value: string, extra?: { activeModelId?: string }) {
  const data = getUserData(userId);
  data.connectors = data.connectors || {};
  if (value) {
    data.connectors[envVar] = value;
  } else {
    delete data.connectors[envVar];
  }
  if (extra?.activeModelId) {
    data.activeModelId = extra.activeModelId;
  }
  saveUserData(data);
  // 权限纪元（治理 I1：权威只能收窄,且收窄即时生效）：清空凭证 = 撤销授权,
  // 纪元 +1 并广播 —— in-flight 任务的 session.env 同步移除该 Key
  if (!value) {
    bumpAuthorityEpoch(userId, envVar, { envVars: [envVar] });
  }
  return data;
}

export function setUserActiveModel(userId: string, modelId: string) {
  const data = getUserData(userId);
  data.activeModelId = modelId;
  saveUserData(data);
  return data;
}

// 辅助方法：记忆库
export function getUserMemories(userId: string): any[] {
  const data = getUserData(userId);
  return data.memories || [];
}

export function saveUserMemory(userId: string, memory: any) {
  const data = getUserData(userId);
  data.memories = data.memories || [];
  const existingIdx = data.memories.findIndex((m: any) => m.id === memory.id);
  if (existingIdx >= 0) {
    data.memories[existingIdx] = { ...data.memories[existingIdx], ...memory, updatedAt: Date.now() };
  } else {
    data.memories.push(memory);
  }
  saveUserData(data);
  return data.memories;
}

export function deleteUserMemory(userId: string, memoryId: string) {
  const data = getUserData(userId);
  data.memories = (data.memories || []).filter((m: any) => m.id !== memoryId);
  saveUserData(data);
  return data.memories;
}

// 辅助方法：巡航任务
export function getUserCronJobs(userId: string): any[] {
  const data = getUserData(userId);
  return data.cronJobs || [];
}

export function saveUserCronJob(userId: string, job: any) {
  const data = getUserData(userId);
  data.cronJobs = data.cronJobs || [];
  const existingIdx = data.cronJobs.findIndex((j: any) => j.id === job.id);
  if (existingIdx >= 0) {
    data.cronJobs[existingIdx] = { ...data.cronJobs[existingIdx], ...job };
  } else {
    data.cronJobs.push(job);
  }
  saveUserData(data);
  return data.cronJobs;
}

export function deleteUserCronJob(userId: string, jobId: string) {
  const data = getUserData(userId);
  data.cronJobs = (data.cronJobs || []).filter((j: any) => j.id !== jobId);
  saveUserData(data);
  return data.cronJobs;
}

// 辅助方法：任务流记录 (Missions)
export function getUserMissions(userId: string): any[] {
  const data = getUserData(userId);
  return data.missions || [];
}

export function saveUserMission(userId: string, mission: any) {
  const data = getUserData(userId);
  data.missions = data.missions || [];
  const existingIdx = data.missions.findIndex((m: any) => m.id === mission.id);
  if (existingIdx >= 0) {
    data.missions[existingIdx] = { ...data.missions[existingIdx], ...mission };
  } else {
    data.missions.unshift(mission);
    // 仅保留最近 50 条任务记录，避免单文件无限膨胀
    if (data.missions.length > 50) {
      data.missions = data.missions.slice(0, 50);
    }
  }
  saveUserData(data);
  return data.missions;
}

export function deleteUserMission(userId: string, missionId: string) {
  const data = getUserData(userId);
  data.missions = (data.missions || []).filter((m: any) => m.id !== missionId);
  saveUserData(data);
  return data.missions;
}

// 辅助方法：长期目标 (Long-term Goals & Milestones)
export function getUserGoals(userId: string): any[] {
  const data = getUserData(userId);
  return data.goals || [];
}

export function saveUserGoal(userId: string, goal: any) {
  const data = getUserData(userId);
  data.goals = data.goals || [];
  const existingIdx = data.goals.findIndex((g: any) => g.id === goal.id);
  if (existingIdx >= 0) {
    data.goals[existingIdx] = { ...data.goals[existingIdx], ...goal, updatedAt: Date.now() };
  } else {
    data.goals.unshift({ ...goal, createdAt: goal.createdAt || Date.now(), updatedAt: Date.now() });
  }
  saveUserData(data);
  return data.goals;
}

export function deleteUserGoal(userId: string, goalId: string) {
  const data = getUserData(userId);
  data.goals = (data.goals || []).filter((g: any) => g.id !== goalId);
  saveUserData(data);
  return data.goals;
}

// 辅助方法：Web Push 订阅 (PWA 推送通知)
export function getUserPushSubscriptions(userId: string): PushSubscriptionRecord[] {
  return getUserData(userId).pushSubscriptions || [];
}

export function addUserPushSubscription(userId: string, sub: PushSubscriptionRecord) {
  const data = getUserData(userId);
  data.pushSubscriptions = data.pushSubscriptions || [];
  // 同一 endpoint 去重（浏览器重新订阅时 endpoint 可能变化，旧的自然过期清理）
  data.pushSubscriptions = data.pushSubscriptions.filter((s) => s.endpoint !== sub.endpoint);
  data.pushSubscriptions.push(sub);
  // 单用户最多保留 10 个订阅端点，防止僵尸订阅堆积
  if (data.pushSubscriptions.length > 10) {
    data.pushSubscriptions = data.pushSubscriptions.slice(-10);
  }
  saveUserData(data);
  return data.pushSubscriptions;
}

export function removeUserPushSubscription(userId: string, endpoint: string) {
  const data = getUserData(userId);
  data.pushSubscriptions = (data.pushSubscriptions || []).filter((s) => s.endpoint !== endpoint);
  saveUserData(data);
  return data.pushSubscriptions;
}

// 辅助方法：MCP OAuth 授权记录（tokens / clientInfo / PKCE verifier，整条加密落盘）
export function getMcpAuth(userId: string, connectorId: string): McpAuthRecord | undefined {
  const data = getUserData(userId);
  const raw = data.mcpAuth?.[connectorId];
  if (!raw) return undefined;
  try {
    const json = decryptSecret(raw);
    if (!json) return undefined; // 解密失败（密钥变更）视为未授权
    return JSON.parse(json);
  } catch {
    return undefined;
  }
}

export function saveMcpAuth(userId: string, connectorId: string, record: McpAuthRecord) {
  const data = getUserData(userId);
  data.mcpAuth = data.mcpAuth || {};
  data.mcpAuth[connectorId] = encryptSecret(JSON.stringify({ ...record, updatedAt: Date.now() }));
  saveUserData(data);
  return record;
}

export function deleteMcpAuth(userId: string, connectorId: string) {
  const data = getUserData(userId);
  if (data.mcpAuth) {
    delete data.mcpAuth[connectorId];
    saveUserData(data);
  }
  // 权限纪元:OAuth 授权撤销同样 +1 并广播(订阅方断开 MCP 连接、清理 in-flight 凭证)
  bumpAuthorityEpoch(userId, connectorId, { connectorId });
}

// ---- 持久状态治理:权限纪元 / 删除台账 / 审计日志 ----
// 设计依据 docs/design/persistent-state-governance.md §3.2 / §3.3

/** 读取某授权键(connectorId 或 envVar)的当前权限纪元;从未撤销过 = 0 */
export function getAuthorityEpoch(userId: string, key: string): number {
  return getUserData(userId).authorityEpochs?.[key] || 0;
}

/**
 * 权限纪元 +1(单调递增,永不回退 —— 治理不变量 I1)。
 * 落盘后经 governance-bus 广播 authority-revoked,agent-backend 据此:
 * 1) 从 in-flight 任务的 session.env 移除对应 Key;
 * 2) 断开该用户对应 MCP 连接;
 * 3) 下一步 prepareStep 前注入治理提示,让模型显式感知「授权已撤销」。
 */
export function bumpAuthorityEpoch(
  userId: string,
  key: string,
  meta?: { connectorId?: string; envVars?: string[] }
): number {
  const data = getUserData(userId);
  data.authorityEpochs = data.authorityEpochs || {};
  const epoch = (data.authorityEpochs[key] || 0) + 1;
  data.authorityEpochs[key] = epoch;
  saveUserData(data);
  appendMemoryAudit(userId, {
    at: Date.now(),
    actor: 'user',
    op: 'authority-revoked',
    connectorId: meta?.connectorId || key,
    epoch,
    detail: meta?.envVars ? `envVars: ${meta.envVars.join(',')}` : undefined,
  });
  getGovernanceBus().emitAuthorityRevoked({
    userId,
    connectorId: meta?.connectorId,
    envVars: meta?.envVars,
    epoch,
  });
  return epoch;
}

/** 读取删除台账(最近在前) */
export function getDeletionLedger(userId: string): DeletionLedgerEntry[] {
  return getUserData(userId).deletionLedger || [];
}

/** 追加删除台账条目(只增不改;单用户最多保留 200 条,防单文件膨胀) */
export function appendDeletionLedger(userId: string, entry: DeletionLedgerEntry) {
  const data = getUserData(userId);
  data.deletionLedger = [entry, ...(data.deletionLedger || [])].slice(0, 200);
  saveUserData(data);
}

function getAuditFilePath(userId: string): string {
  const safeFilename = userId.replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(getDataDir(), `${safeFilename}.audit.jsonl`);
}

/**
 * 追加记忆审计日志(append-only jsonl,与用户数据文件分离):
 * 所有 add/update/supersede/soft-delete/restore/purge/write-rejected/
 * authority-revoked 操作都留痕 —— 回答「谁在何时对哪条状态做了什么」。
 */
export function appendMemoryAudit(userId: string, entry: MemoryAuditEntry) {
  try {
    fs.appendFileSync(getAuditFilePath(userId), `${JSON.stringify(entry)}\n`, 'utf-8');
  } catch (e) {
    console.error(`Failed to append audit log for ${userId}:`, e);
  }
}

/** 读取审计日志(尾部 limit 条,最近在前);文件缺失返回空 */
export function readMemoryAudit(userId: string, limit = 100): MemoryAuditEntry[] {
  try {
    const file = getAuditFilePath(userId);
    if (!fs.existsSync(file)) return [];
    const lines = fs.readFileSync(file, 'utf-8').split('\n').filter(Boolean);
    return lines
      .slice(-limit)
      .reverse()
      .map((l) => {
        try {
          return JSON.parse(l) as MemoryAuditEntry;
        } catch {
          return null;
        }
      })
      .filter((e): e is MemoryAuditEntry => e !== null);
  } catch {
    return [];
  }
}

// 辅助方法：读取所有用户数据（用于服务端启动时加载所有后台定时任务等）
export function getAllUsersData(): UserScopedData[] {
  const dataDir = getDataDir();
  try {
    if (!fs.existsSync(dataDir)) return [];
    const files = fs.readdirSync(dataDir);
    const result: UserScopedData[] = [];
    for (const f of files) {
      if (f.endsWith('.json')) {
        try {
          const raw = fs.readFileSync(path.join(dataDir, f), 'utf-8');
          const data = JSON.parse(raw);
          if (data) {
            if (!data.userId) {
              data.userId = f.replace(/\.json$/, '');
            }
            // 凭证解密（只读路径，不触发迁移写盘）
            if (data.connectors && typeof data.connectors === 'object') {
              for (const [k, v] of Object.entries<string>(data.connectors)) {
                if (typeof v === 'string' && isEncrypted(v)) {
                  data.connectors[k] = decryptSecret(v);
                }
              }
            }
            result.push(data);
          }
        } catch {
          // ignore corrupted user files
        }
      }
    }
    return result;
  } catch {
    return [];
  }
}

