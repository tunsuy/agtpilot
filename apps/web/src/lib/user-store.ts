import * as fs from 'fs';
import * as path from 'path';
import { encryptSecret, decryptSecret, isEncrypted } from './secret-box';
import { getGovernanceBus } from './governance-bus';
import { isCronMission } from './mission-wire';
import type { ScenarioProfile } from './scenario-profile';
import { isPrivateOrReservedIp, DEFAULT_CREDENTIAL_BINDINGS } from '@agtpilot/core';
import {
  isV2Enabled,
  safeName,
  userDirV2,
  readUserDataV2,
  writeUserDataV2,
  migrateLegacyUser,
  auditFilePathV2,
  listUserIdsV2,
  carryBaseline,
  attachFreshBaseline,
  readProfileV2,
  readArrayDomainV2,
} from './user-store-v2';

/**
 * 用户级别数据持久化隔离存储引擎 (User Scoped Data Store)
 * 每个用户独占自己的数据空间，包含：
 * - 连接器 API Key 与环境变量配置 (connectors) —— 落盘一律 AES-256-GCM 加密（secret-box）
 * - MCP OAuth 授权记录 (mcpAuth) —— token/客户端注册信息/PKCE verifier，整条加密
 * - 个人长效记忆与画像 (memories)
 * - 主动巡航定时任务 (cron jobs)
 * - 执行会话历史任务 (missions)
 *
 * 存储布局 v2(docs/design/context-store-filesystem-paradigm.md P1):
 * 默认落「用户上下文目录」<dataDir>/v2/<userId>/(profile.json + 域文件 +
 * missions/ 每任务一文件 + audit/ 追加日志),按域脏检查只重写有变化的域;
 * 旧单文件首次访问懒迁移(原文件改名 .bak 归档可回滚)。
 * AGTPILOT_CONTEXT_STORE_V2=0 整体回退旧单文件路径。布局细节见 user-store-v2.ts。
 */

export interface PushSubscriptionRecord {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  userAgent?: string;
  createdAt: number;
}

/**
 * 工坊模型设置(每用户 × 每工坊一份,工坊卡片上持久生效):
 * 思考深度是首个成员。任务级优先级 = 工坊设置 > 连接器全局 > env > 分支缺省
 * —— 重产出轻推理的工坊(小说日更等)可单独压档,不用动全局;巡航触发时同样现读生效。
 */
export interface WorkshopModelSetting {
  /** 思考深度;未存 = 跟随连接器全局;none = 显式关闭(推理型模型的省 token 档) */
  reasoningEffort?: 'low' | 'medium' | 'high' | 'none';
  updatedAt: number;
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
  /** 沙箱控制配置(docs/design/sandbox-control-hardening.md §5):暴露白名单/凭据绑定/围栏模式 */
  sandbox?: SandboxConfigRecord;
  /** 权限提案(deny-log → proposal → 人工审核 → 热更新;只增 + 状态迁移) */
  policyProposals?: PolicyProposalRecord[];
  /** 工坊场景档案(scenarioKey -> 档案;旧文件未知字段透传,零迁移) */
  scenarioProfiles?: Record<string, ScenarioProfile>;
  /** 工坊模型设置(workshopId -> 设置;思考深度任务级档,旧文件未知字段透传,零迁移) */
  workshopModelSettings?: Record<string, WorkshopModelSetting>;
  /** 小红书托管模式开关与登录状态(scenario-loop P2;opt-in 默认关闭,零迁移) */
  xhsManaged?: XhsManagedRecord;
  /** 知乎托管模式开关与登录状态(与 xhsManaged 同构;opt-in 默认关闭,零迁移) */
  zhihuManaged?: ZhihuManagedRecord;
  /** 番茄作者后台托管模式开关与登录状态(与 xhsManaged 同构;opt-in 默认关闭,零迁移) */
  fanqieManaged?: FanqieManagedRecord;
  /** 写操作审计(浏览器存草稿/公众号官方 API 投草稿等;上限 200 条滚动,最近在前) */
  browserAudit?: BrowserAuditEntry[];
  /** TRS 技能卡(skill-cards.ts):任务轨迹蒸馏的五字段结构化经验;旧文件未知字段透传,零迁移 */
  skillCards?: any[];
  updatedAt: number;
}

/**
 * 小红书托管模式记录(scenario-loop P2 模块 2):
 * - enabled:显式 opt-in(默认关),开启前强制阅读风险明示(riskAckAt);
 * - lastLoginAt:网页版扫码登录成功时间(登录态存浏览器 profile,此处只记时间供过期提醒);
 * - dailyLimit 缺省 3(可用 AGTPILOT_XHS_DRAFT_DAILY_LIMIT 调整)。
 */
export interface XhsManagedRecord {
  enabled: boolean;
  enabledAt?: number;
  riskAckAt?: number;
  lastLoginAt?: number;
}

/**
 * 知乎托管模式记录(与小红书同构):opt-in + 风险已读 + 扫码登录时间。
 * 每日存草稿上限缺省 3(可用 AGTPILOT_ZHIHU_DRAFT_DAILY_LIMIT 调整)。
 */
export type ZhihuManagedRecord = XhsManagedRecord;

/**
 * 番茄作者后台托管模式记录(与小红书同构):opt-in + 风险已读 + 扫码登录时间。
 * 每日存章节草稿上限缺省 3(可用 AGTPILOT_FANQIE_DRAFT_DAILY_LIMIT 调整)。
 */
export type FanqieManagedRecord = XhsManagedRecord;

/** 浏览器写操作审计条目:谁在何时用哪个工具对哪个页面做了什么、结果如何(成败都落) */
export interface BrowserAuditEntry {
  at: number;
  tool: string;
  action: string;
  title?: string;
  imageCount?: number;
  result: 'success' | 'failure';
  error?: string;
  missionId?: string;
}

/**
 * 沙箱控制用户级配置(docs/design/sandbox-control-hardening.md §5):
 * - exposeAllowlist: 允许进子进程环境的 session.env 键(用户显式 opt-in,默认空 = 零暴露);
 * - credentialBindings: 自定义凭据-端点绑定(与 core DEFAULT_CREDENTIAL_BINDINGS 合并后下发);
 * - fence: 内核围栏模式(off / best_effort / hard_requirement,需宿主机 bwrap)。
 */
export interface SandboxConfigRecord {
  exposeAllowlist?: string[];
  credentialBindings?: Record<string, string[]>;
  fence?: 'off' | 'best_effort' | 'hard_requirement';
}

/**
 * 权限提案记录:sandbox_deny 拒绝日志自动/手动生成,人工审核后生效。
 * approve credential-binding → hosts 合并进 sandbox.credentialBindings;
 * approve expose-env → envVar 并入 exposeAllowlist。热更新经 governance-bus
 * PermissionResolvedEvent 传导到 in-flight 任务的 taskSandbox 活引用。
 */
export interface PolicyProposalRecord {
  id: string;
  at: number;
  kind: 'credential-binding' | 'expose-env';
  status: 'pending' | 'approved' | 'rejected';
  detail: {
    envVar?: string;
    hosts?: string[];
    reason?: string;
  };
  source?: {
    taskId?: string;
    tool?: string;
    url?: string;
  };
  resolvedAt?: number;
}

/** 沙箱拒绝审计条目(只增不改,落盘为独立 jsonl,镜像 memory audit 模式) */
export interface SandboxAuditEntry {
  at?: number;
  userId: string;
  tool: string;
  /** 拒绝原因码: private_host_blocked / credential_endpoint_mismatch / credential_not_found / scheme_not_allowed / dns_failed 等 */
  reason: string;
  url?: string;
  credentialRef?: string;
  taskId?: string;
  detail?: string;
}

/**
 * 删除台账条目（docs/design/persistent-state-governance.md §3.2）：
 * 每次(软)删除都留下「删了什么、谁删的、何时删、传导了哪些下游动作」,
 * 只增不改 —— AOEP「删除台账还在吗」考题的直接答案。
 */
export interface DeletionLedgerEntry {
  id: string;
  target: { kind: 'memory' | 'connector-auth' | 'rag-doc' | 'skill-card' | 'skill-pack'; id: string; userId: string };
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
    | 'dedup-blocked'
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
  /**
   * 设备码授权（OAuth 2.0 Device Grant, RFC 8628）进行中状态（start → poll 之间短暂存在）。
   * device_code 是服务端机密,绝不下发前端;前端只见 user_code(展示)与轮询状态。
   * 换到 token 后整体清除,token 走 connectors 配置通道（与粘贴凭证同链路加密存储）。
   */
  deviceFlow?: {
    deviceCode: string;
    userCode: string;
    verificationUri: string;
    /** 设备码过期时间戳(ms);过期后 poll 直接返回 expired */
    expiresAt: number;
    /** 轮询间隔(s);GitHub slow_down 时 +5 并回写 */
    interval: number;
  };
  /**
   * 设备码/OAuth token 的续期状态。GitHub 自 2026-08-14 起对**新建** OAuth App 默认签发
   * 短期 token(access 8h + refresh 6 个月单次轮换,需 scope 带 offline_access);
   * 老 App/关闭 expiring tokens 的 App 仍发长效 token(响应无 refresh_token,此字段为空)。
   * ensureDeviceTokenFresh 在 access 临期时用 refresh_token 静默换新并轮换存储。
   */
  tokenRefresh?: {
    /** 当前 access token 原文(加密记录内);用于检测凭证是否已被用户手动替换(如改贴 PAT) */
    accessToken: string;
    /** 单次轮换的 refresh token(ghr_);用过即废,新值随响应回写 */
    refreshToken: string;
    /** 当前 access token 过期时间戳(ms) */
    expiresAt: number;
  };
  updatedAt?: number;
}

function computeDataDir(): string {
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

let dataDirCache: { key: string | undefined; dir: string } | null = null;
/**
 * 数据目录（进程内缓存）。运行期 env/目录不变，但该函数在热路径（每次
 * getUserData / readProfileLight / 各域读写）都会被调用，原实现每次要做
 * 多次 existsSync + readdirSync 探测 —— 缓存后热路径只剩一次字符串返回。
 * 以 USER_DATA_DIR 为缓存键：测试用例切换临时目录时会自动重算。
 */
export function getDataDir(): string {
  const key = process.env.USER_DATA_DIR;
  if (dataDirCache && dataDirCache.key === key) return dataDirCache.dir;
  const dir = computeDataDir();
  dataDirCache = { key, dir };
  return dir;
}

function getUserFilePath(userId: string): string {
  const dataDir = getDataDir();
  // 对 userId 做安全文件名转义
  const safeFilename = userId.replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(dataDir, `${safeFilename}.json`);
}

/** 旧单文件读取(不存在/损坏返回 null;v2 关闭时的主路径、开启时的迁移源) */
function readLegacyUserFile(dataDir: string, userId: string): UserScopedData | null {
  const filePath = getUserFilePath(userId);
  try {
    if (fs.existsSync(filePath)) {
      const raw = fs.readFileSync(filePath, 'utf-8');
      const data = JSON.parse(raw);
      if (data && typeof data === 'object') return data as UserScopedData;
    }
  } catch (e) {
    console.error(`Failed to read user data for ${userId}:`, e);
  }
  return null;
}

export function getUserData(userId: string): UserScopedData {
  const dataDir = getDataDir();
  let data: UserScopedData | null = null;

  if (isV2Enabled()) {
    data = readUserDataV2(dataDir, userId);
    if (!data) {
      // 懒迁移:首次访问把旧单文件转成 v2 目录;旧文件改名 .bak 只读归档(可回滚)
      const legacy = readLegacyUserFile(dataDir, userId);
      if (legacy) {
        migrateLegacyUser(dataDir, userId, legacy);
        data = readUserDataV2(dataDir, userId);
      }
    }
  } else {
    data = readLegacyUserFile(dataDir, userId);
  }

  if (data) {
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
        // 经 saveUserData 单一收口回写(自动补加密,并按开关路由 v2/旧路径)
        saveUserData(data);
      } catch (e) {
        console.error(`Failed to migrate plaintext connectors for ${userId}:`, e);
      }
    }
    return data;
  }

  // 默认空数据结构(v2 下挂空盘基线:多个默认空对象并发保存时互不全量覆盖)
  const empty: UserScopedData = {
    userId,
    connectors: {},
    activeModelId: 'deepseek',
    memories: [],
    cronJobs: [],
    missions: [],
    goals: [],
    updatedAt: Date.now(),
  };
  if (isV2Enabled()) attachFreshBaseline(empty);
  return empty;
}

/**
 * profile 域轻读(只读热路径):v2 布局下 profile.json 是个小文件,
 * 页面加载/切页签/周期扫描只要其中一两个字段时不该拖着 missions 全量读。
 * 返回 null = 轻读不可用(v2 关闭或目录不存在待懒迁移),调用方回退 getUserData。
 * 纪律:轻读结果是无基线、connectors 未解密的只读投影,不得交给 saveUserData。
 *
 * TTL 缓存:首屏聚合接口 / MCP 状态列表会对同一 profile.json 连续读十几次
 * (每个连接器一次 getMcpAuth),同步读盘+解密叠加起来很可观。1.5s TTL +
 * 写路径主动失效(getUserData 的写路径最终都过 saveUserData),让同一请求内
 * 只有首次真正碰盘。只服务只读投影,返回对象不得被调用方就地修改。
 */
const profileReadCache = new Map<string, { at: number; profile: any }>();
const PROFILE_READ_CACHE_TTL_MS = 1500;

function invalidateProfileCache(userId: string) {
  profileReadCache.delete(userId);
}

function readProfileLight(userId: string): any | null {
  if (!isV2Enabled()) return null;
  const hit = profileReadCache.get(userId);
  if (hit && Date.now() - hit.at < PROFILE_READ_CACHE_TTL_MS) return hit.profile;
  const profile = readProfileV2(getDataDir(), userId);
  if (profile) profileReadCache.set(userId, { at: Date.now(), profile });
  return profile;
}

/** 数组域轻读(JSONL 域 + cronJobs);约束同 readProfileLight */
function readArrayDomainLight(userId: string, field: string): any[] | null {
  if (!isV2Enabled()) return null;
  return readArrayDomainV2(getDataDir(), userId, field);
}

export function saveUserData(data: UserScopedData) {
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
  invalidateProfileCache(data.userId);
  try {
    if (isV2Enabled()) {
      // v2:写用户上下文目录(相对读取基线的域级脏检查,只重写有变化的域)
      carryBaseline(data, toWrite); // {...data} 浅拷贝丢不可枚举基线,显式带过去
      writeUserDataV2(getDataDir(), toWrite);
      carryBaseline(toWrite, data); // 写后的新基线带回原对象,重复 save 幂等
      return;
    }
    const filePath = getUserFilePath(data.userId);
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
  // 轻读路径:connectors/activeModelId 都在 profile.json,解密在读取侧补齐
  // (与 getUserData 同语义)。发现历史明文未迁移加密时回退全量路径 ——
  // 那条路会顺带补加密回写,轻读路径不承担写盘职责。
  const profile = readProfileLight(userId);
  if (profile) {
    const raw = (profile.connectors || {}) as Record<string, string>;
    const configs: Record<string, string> = {};
    let plaintextFound = false;
    for (const [k, v] of Object.entries(raw)) {
      if (typeof v === 'string' && v && isEncrypted(v)) {
        configs[k] = decryptSecret(v);
      } else {
        configs[k] = v;
        if (typeof v === 'string' && v) plaintextFound = true;
      }
    }
    if (!plaintextFound) {
      return { configs, activeModelId: profile.activeModelId || 'deepseek' };
    }
  }
  const data = getUserData(userId);
  return {
    configs: data.connectors || {},
    activeModelId: data.activeModelId || 'deepseek',
  };
}

export function saveUserConnector(userId: string, envVar: string, value: string, extra?: { activeModelId?: string }) {
  const data = getUserData(userId);
  data.connectors = data.connectors || {};
  // 策略 lint(非阻断):保存前给出私网 host/通配符/端点不匹配警告,由调用方展示
  const warnings = value ? lintConnectorValue(envVar, value) : [];
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
  return { data, warnings };
}

export function setUserActiveModel(userId: string, modelId: string) {
  const data = getUserData(userId);
  data.activeModelId = modelId;
  saveUserData(data);
  return data;
}

// 辅助方法：记忆库
export function getUserMemories(userId: string): any[] {
  return readArrayDomainLight(userId, 'memories') ?? getUserData(userId).memories ?? [];
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
  return readArrayDomainLight(userId, 'cronJobs') ?? getUserData(userId).cronJobs ?? [];
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

/**
 * getUserMissions 短 TTL 读缓存(工作台首屏性能):
 * /api/agent/state、SSE init、mission/[id] 懒回水在首屏/重连时连环命中,
 * 每次命中都是一遍「全部 mission 文件同步读 + 解析 + 基线双重序列化」;
 * 2s TTL + 本进程写路径主动失效,让只读热路径不再反复碰盘。
 * 只服务只读消费方(路由层 filter/concat/序列化,不改动返回对象);
 * 写路径(saveUserMission/deleteUserMission)一律走 getUserData 全量读,
 * 落盘后同步失效缓存,同进程读写不见陈旧数据。
 */
const missionsReadCache = new Map<string, { at: number; missions: any[] }>();
const MISSIONS_READ_CACHE_TTL_MS = 2000;

export function getUserMissions(userId: string): any[] {
  const hit = missionsReadCache.get(userId);
  if (hit && Date.now() - hit.at < MISSIONS_READ_CACHE_TTL_MS) return hit.missions;
  const data = getUserData(userId);
  const missions = data.missions || [];
  missionsReadCache.set(userId, { at: Date.now(), missions });
  return missions;
}

/** 保留窗口(docs/design/cruise-session-split.md):手动会话最近 50 条 */
export const MISSIONS_MANUAL_CAP = 50;
/** 保留窗口:巡航会话每任务最近 20 次(旧数据无 cronJobId,按标题分组) */
export const MISSIONS_PER_CRON_JOB_CAP = 20;

export function saveUserMission(userId: string, mission: any) {
  const data = getUserData(userId);
  data.missions = data.missions || [];
  const existingIdx = data.missions.findIndex((m: any) => m.id === mission.id);
  if (existingIdx >= 0) {
    data.missions[existingIdx] = { ...data.missions[existingIdx], ...mission };
  } else {
    data.missions.unshift(mission);
    // 保留窗口按来源分账:手动会话与巡航会话各算各的,互不挤占 ——
    // 此前混算 50 条,一个日更巡航任务 50 天就把手动会话全部顶出窗口。
    // data.missions 新前旧后(unshift 序),顺序遍历即"留最近 N 条"。
    const manual: any[] = [];
    const cronByJob = new Map<string, any[]>();
    for (const m of data.missions) {
      if (!isCronMission(m)) {
        if (manual.length < MISSIONS_MANUAL_CAP) manual.push(m);
        continue;
      }
      const key = String(m.cronJobId || m.title);
      const list = cronByJob.get(key) || [];
      if (list.length < MISSIONS_PER_CRON_JOB_CAP) {
        list.push(m);
        cronByJob.set(key, list);
      }
    }
    data.missions = [...manual, ...[...cronByJob.values()].flat()].sort(
      (a: any, b: any) => (b.startedAt || 0) - (a.startedAt || 0)
    );
  }
  saveUserData(data);
  missionsReadCache.delete(userId);
  return data.missions;
}

export function deleteUserMission(userId: string, missionId: string) {
  const data = getUserData(userId);
  data.missions = (data.missions || []).filter((m: any) => m.id !== missionId);
  saveUserData(data);
  missionsReadCache.delete(userId);
  // 级联清理该任务的超长工具输出落盘目录(docs/design/tool-output-spill.md §4.5)。
  // 动态 import 避免与 tool-output-store(其静态依赖本模块的 getDataDir)成环;
  // 尽力而为不阻塞删除 —— 清理失败还有预算 LRU 与 TTL 兜底
  import('./tool-output-store')
    .then((m) => m.cleanupTaskToolOutputs(userId, missionId))
    .catch(() => {});
  return data.missions;
}

// 辅助方法：长期目标 (Long-term Goals & Milestones)
export function getUserGoals(userId: string): any[] {
  return readArrayDomainLight(userId, 'goals') ?? getUserData(userId).goals ?? [];
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

// 辅助方法：工坊场景档案 (Scenario Profiles —— docs/design/workshop-scenario-loop.md §2)
// 每用户 × 每场景一份，按 scenarioKey 唯一；upsert 语义同 goals。
export function getUserScenarioProfiles(userId: string): Record<string, ScenarioProfile> {
  const profile = readProfileLight(userId);
  if (profile) return profile.scenarioProfiles || {};
  return getUserData(userId).scenarioProfiles || {};
}

export function saveUserScenarioProfile(userId: string, profile: ScenarioProfile): Record<string, ScenarioProfile> {
  const data = getUserData(userId);
  data.scenarioProfiles = data.scenarioProfiles || {};
  const existing = data.scenarioProfiles[profile.scenarioKey];
  // version 不回退：写回是 P1 复盘的职责，P0 编辑保持既有版本号
  data.scenarioProfiles[profile.scenarioKey] = {
    ...profile,
    version: Math.max(profile.version, existing?.version ?? 0),
    createdAt: existing?.createdAt ?? profile.createdAt,
    updatedAt: Date.now(),
  };
  saveUserData(data);
  return data.scenarioProfiles;
}

export function deleteUserScenarioProfile(userId: string, scenarioKey: string): Record<string, ScenarioProfile> {
  const data = getUserData(userId);
  if (data.scenarioProfiles) {
    delete data.scenarioProfiles[scenarioKey];
  }
  saveUserData(data);
  return data.scenarioProfiles || {};
}

// 辅助方法：工坊模型设置 (每用户 × 每工坊一份;思考深度任务级档)
// 语义与场景档案同款:readProfileLight 轻读,upsert/删除走全量 getUserData。
export function getWorkshopModelSettings(userId: string): Record<string, WorkshopModelSetting> {
  const profile = readProfileLight(userId);
  if (profile) return profile.workshopModelSettings || {};
  return getUserData(userId).workshopModelSettings || {};
}

export function saveWorkshopModelSetting(
  userId: string,
  workshopId: string,
  setting: WorkshopModelSetting
): Record<string, WorkshopModelSetting> {
  const data = getUserData(userId);
  data.workshopModelSettings = data.workshopModelSettings || {};
  data.workshopModelSettings[workshopId] = { ...setting, updatedAt: Date.now() };
  saveUserData(data);
  return data.workshopModelSettings;
}

export function deleteWorkshopModelSetting(userId: string, workshopId: string): Record<string, WorkshopModelSetting> {
  const data = getUserData(userId);
  if (data.workshopModelSettings) {
    delete data.workshopModelSettings[workshopId];
  }
  saveUserData(data);
  return data.workshopModelSettings || {};
}

// 辅助方法：小红书托管模式与浏览器审计 (scenario-loop P2 —— docs/design/workshop-scenario-loop.md §5)
export function getXhsManaged(userId: string): XhsManagedRecord | undefined {
  const profile = readProfileLight(userId);
  if (profile) return profile.xhsManaged;
  return getUserData(userId).xhsManaged;
}

export function saveXhsManaged(userId: string, record: XhsManagedRecord): XhsManagedRecord {
  const data = getUserData(userId);
  data.xhsManaged = { ...data.xhsManaged, ...record, updatedAt: undefined } as XhsManagedRecord;
  delete (data.xhsManaged as any).updatedAt;
  saveUserData(data);
  return data.xhsManaged;
}

/** 记录网页版登录成功时间(登录态本体在浏览器 profile 目录,这里只记时间) */
export function markXhsLoginAt(userId: string) {
  const data = getUserData(userId);
  data.xhsManaged = { enabled: false, ...(data.xhsManaged || {}), lastLoginAt: Date.now() };
  saveUserData(data);
  return data.xhsManaged;
}

// 知乎托管模式:与小红书三件套同构(开关/风险已读/登录时间)
export function getZhihuManaged(userId: string): ZhihuManagedRecord | undefined {
  const profile = readProfileLight(userId);
  if (profile) return profile.zhihuManaged;
  return getUserData(userId).zhihuManaged;
}

export function saveZhihuManaged(userId: string, record: ZhihuManagedRecord): ZhihuManagedRecord {
  const data = getUserData(userId);
  data.zhihuManaged = { ...data.zhihuManaged, ...record };
  saveUserData(data);
  return data.zhihuManaged;
}

/** 记录知乎网页版登录成功时间(登录态本体在浏览器 profile 目录,这里只记时间) */
export function markZhihuLoginAt(userId: string) {
  const data = getUserData(userId);
  data.zhihuManaged = { enabled: false, ...(data.zhihuManaged || {}), lastLoginAt: Date.now() };
  saveUserData(data);
  return data.zhihuManaged;
}

// 番茄作者后台托管模式:与小红书/知乎三件套同构(开关/风险已读/登录时间)
export function getFanqieManaged(userId: string): FanqieManagedRecord | undefined {
  const profile = readProfileLight(userId);
  if (profile) return profile.fanqieManaged;
  return getUserData(userId).fanqieManaged;
}

export function saveFanqieManaged(userId: string, record: FanqieManagedRecord): FanqieManagedRecord {
  const data = getUserData(userId);
  data.fanqieManaged = { ...(data.fanqieManaged || {}), ...record };
  saveUserData(data);
  return data.fanqieManaged;
}

/** 记录番茄网页版登录成功时间(登录态本体在浏览器 profile 目录,这里只记时间) */
export function markFanqieLoginAt(userId: string) {
  const data = getUserData(userId);
  data.fanqieManaged = { enabled: false, ...(data.fanqieManaged || {}), lastLoginAt: Date.now() };
  saveUserData(data);
  return data.fanqieManaged;
}

/** 浏览器写操作审计:只增不改,最近在前,上限 200 条滚动 */
export function appendBrowserAudit(userId: string, entry: BrowserAuditEntry): BrowserAuditEntry[] {
  const data = getUserData(userId);
  data.browserAudit = [entry, ...(data.browserAudit || [])].slice(0, 200);
  saveUserData(data);
  return data.browserAudit;
}

/** 读取审计(最近 limit 条);不传 limit = 全量(≤200) */
export function getBrowserAudit(userId: string, limit?: number): BrowserAuditEntry[] {
  const all = readArrayDomainLight(userId, 'browserAudit') ?? getUserData(userId).browserAudit ?? [];
  return limit ? all.slice(0, limit) : all;
}

// 辅助方法：Web Push 订阅 (PWA 推送通知)
export function getUserPushSubscriptions(userId: string): PushSubscriptionRecord[] {
  const profile = readProfileLight(userId);
  if (profile) return profile.pushSubscriptions || [];
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
  // mcpAuth 落盘即密文,轻读 profile 后按条解密与全量路径同语义
  const profile = readProfileLight(userId);
  const raw = profile ? profile.mcpAuth?.[connectorId] : getUserData(userId).mcpAuth?.[connectorId];
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
  const profile = readProfileLight(userId);
  if (profile) return profile.authorityEpochs?.[key] || 0;
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
  return readArrayDomainLight(userId, 'deletionLedger') ?? getUserData(userId).deletionLedger ?? [];
}

/** 追加删除台账条目(只增不改;单用户最多保留 200 条,防单文件膨胀) */
export function appendDeletionLedger(userId: string, entry: DeletionLedgerEntry) {
  const data = getUserData(userId);
  data.deletionLedger = [entry, ...(data.deletionLedger || [])].slice(0, 200);
  saveUserData(data);
}

function getAuditFilePath(userId: string): string {
  const dataDir = getDataDir();
  // v2:audit 挪进用户目录(旧文件懒迁移);关闭开关回退旧平铺路径
  if (isV2Enabled()) return auditFilePathV2(dataDir, userId, 'memory');
  return path.join(dataDir, `${safeName(userId)}.audit.jsonl`);
}

/**
 * 追加记忆审计日志(append-only jsonl,与用户数据文件分离):
 * 所有 add/update/supersede/soft-delete/restore/purge/write-rejected/
 * dedup-blocked/authority-revoked 操作都留痕 —— 回答「谁在何时对哪条状态做了什么」。
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

// ---- 沙箱控制(docs/design/sandbox-control-hardening.md §4.4)----

/** 读取用户沙箱配置(缺省 = 零暴露/零自定义绑定/fence 未设) */
export function getSandboxConfig(userId: string): SandboxConfigRecord {
  const profile = readProfileLight(userId);
  if (profile) return profile.sandbox || {};
  return getUserData(userId).sandbox || {};
}

/** 保存用户沙箱配置(整体覆盖三个字段;调用方负责合并语义) */
export function saveSandboxConfig(userId: string, cfg: SandboxConfigRecord) {
  const data = getUserData(userId);
  data.sandbox = {
    exposeAllowlist: cfg.exposeAllowlist || [],
    credentialBindings: cfg.credentialBindings || {},
    fence: cfg.fence,
  };
  saveUserData(data);
  return data.sandbox;
}

/** 新增权限提案(pending);返回带生成 id 的完整记录 */
export function addPolicyProposal(
  userId: string,
  proposal: { kind: PolicyProposalRecord['kind']; detail: PolicyProposalRecord['detail']; source?: PolicyProposalRecord['source'] },
): PolicyProposalRecord {
  const data = getUserData(userId);
  const record: PolicyProposalRecord = {
    id: `prop_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    at: Date.now(),
    kind: proposal.kind,
    status: 'pending',
    detail: proposal.detail,
    source: proposal.source,
  };
  // 单用户最多保留 200 条,防单文件膨胀(同删除台账策略)
  data.policyProposals = [record, ...(data.policyProposals || [])].slice(0, 200);
  saveUserData(data);
  return record;
}

/** 列出提案(status 缺省 = 全部,最近在前) */
export function getPolicyProposals(userId: string, status?: PolicyProposalRecord['status']): PolicyProposalRecord[] {
  const profile = readProfileLight(userId);
  const all = (profile ? profile.policyProposals : getUserData(userId).policyProposals) || [];
  return status ? all.filter((p: PolicyProposalRecord) => p.status === status) : all;
}

/**
 * 裁决提案:approve 时把配置合并进 sandbox 记录(热更新数据源);
 * reject 只改状态。非 pending / 不存在 → null(幂等)。
 */
export function resolvePolicyProposal(
  userId: string,
  proposalId: string,
  approved: boolean,
): PolicyProposalRecord | null {
  const data = getUserData(userId);
  const proposal = (data.policyProposals || []).find((p) => p.id === proposalId);
  if (!proposal || proposal.status !== 'pending') return null;
  proposal.status = approved ? 'approved' : 'rejected';
  proposal.resolvedAt = Date.now();
  if (approved) {
    data.sandbox = data.sandbox || {};
    if (proposal.kind === 'credential-binding' && proposal.detail.envVar) {
      const envVar = proposal.detail.envVar;
      const hosts = proposal.detail.hosts || [];
      data.sandbox.credentialBindings = {
        ...(data.sandbox.credentialBindings || {}),
        [envVar]: Array.from(new Set([...((data.sandbox.credentialBindings || {})[envVar] || []), ...hosts])),
      };
    } else if (proposal.kind === 'expose-env' && proposal.detail.envVar) {
      const allow = data.sandbox.exposeAllowlist || [];
      if (!allow.includes(proposal.detail.envVar)) {
        data.sandbox.exposeAllowlist = [...allow, proposal.detail.envVar];
      }
    }
  }
  saveUserData(data);
  return proposal;
}

function getSandboxAuditFilePath(userId: string): string {
  const dataDir = getDataDir();
  if (isV2Enabled()) return auditFilePathV2(dataDir, userId, 'sandbox');
  return path.join(dataDir, `${safeName(userId)}.sandbox-audit.jsonl`);
}

/** 追加沙箱拒绝审计(append-only jsonl,与用户数据/记忆审计文件分离) */
export function appendSandboxAudit(userId: string, entry: SandboxAuditEntry) {
  try {
    const full = { at: Date.now(), ...entry };
    fs.appendFileSync(getSandboxAuditFilePath(userId), `${JSON.stringify(full)}\n`, 'utf-8');
  } catch (e) {
    console.error(`Failed to append sandbox audit for ${userId}:`, e);
  }
}

/** 读取沙箱审计(尾部 limit 条,最近在前);文件缺失返回空 */
export function readSandboxAudit(userId: string, limit = 100): SandboxAuditEntry[] {
  try {
    const file = getSandboxAuditFilePath(userId);
    if (!fs.existsSync(file)) return [];
    const lines = fs.readFileSync(file, 'utf-8').split('\n').filter(Boolean);
    return lines
      .slice(-limit)
      .reverse()
      .map((l) => {
        try {
          return JSON.parse(l) as SandboxAuditEntry;
        } catch {
          return null;
        }
      })
      .filter((e): e is SandboxAuditEntry => e !== null);
  } catch {
    return [];
  }
}

// ---- 检索轨迹(P2,docs/design/context-store-filesystem-paradigm.md §5)----

/**
 * 检索轨迹条目:一次注入/召回的「候选 id + 得分明细 + 入选/落选原因」。
 * kind: memory-inject(prompt 注入)/ memory-recall(工具检索)/ memory-read /
 * mission-read / skill-card(技能卡注入,经 webCardStore 适配写入)。
 * 回答「为什么注入了这条 / 漏了那条」—— 蒸馏与检索质量的观测面(P-e)。
 */
export interface RetrievalTraceEntry {
  at: number;
  kind: string;
  /** 任务目标或检索词(截断) */
  goal?: string;
  query?: string;
  /** 入选候选(带得分/命中明细) */
  selected?: unknown[];
  /** 落选候选(带得分与原因) */
  omitted?: unknown[];
  [key: string]: unknown;
}

function getRetrievalTracePath(userId: string): string {
  const dataDir = getDataDir();
  if (isV2Enabled()) return auditFilePathV2(dataDir, userId, 'retrieval');
  // 开关回退:旧平铺形态(检索轨迹是 v2 引入的观测面,回退期保持同名平铺文件)
  try {
    fs.mkdirSync(dataDir, { recursive: true });
  } catch {}
  return path.join(dataDir, `${safeName(userId)}.retrieval.jsonl`);
}

/** 追加检索轨迹(append-only jsonl;观测用途,失败静默绝不影响主流程) */
export function appendRetrievalTrace(
  userId: string,
  entry: { kind: string; goal?: string; query?: string; selected?: unknown[]; omitted?: unknown[]; [key: string]: unknown }
) {
  try {
    const full = { at: Date.now(), ...entry } as RetrievalTraceEntry;
    fs.appendFileSync(getRetrievalTracePath(userId), `${JSON.stringify(full)}\n`, 'utf-8');
  } catch {
    // 轨迹丢失不阻断任务
  }
}

/** 读取检索轨迹(尾部 limit 条,最近在前);文件缺失返回空 */
export function readRetrievalTrace(userId: string, limit = 100): RetrievalTraceEntry[] {
  try {
    const file = getRetrievalTracePath(userId);
    if (!fs.existsSync(file)) return [];
    const lines = fs.readFileSync(file, 'utf-8').split('\n').filter(Boolean);
    return lines
      .slice(-limit)
      .reverse()
      .map((l) => {
        try {
          return JSON.parse(l) as RetrievalTraceEntry;
        } catch {
          return null;
        }
      })
      .filter((e): e is RetrievalTraceEntry => e !== null);
  } catch {
    return [];
  }
}

// ---- Agent 笔记区(P3,docs/design/context-store-filesystem-paradigm.md §5 P3)----

/**
 * Agent 自管上下文文件(对标 Claude memory tool / Manus 文件系统范式):
 * 长任务把中间产物外部化到 `<用户目录>/agent-notes/`,会话上下文只留路径引用。
 *
 * 治理约束(I2 范围不扩大 + 预算封顶):
 * - 根目录锁死在该用户的笔记子树,路径规范化后二次校验不越界;
 * - 总预算 64KB / 单文件 16KB / 深度 ≤2 / 文件名白名单字符;
 * - 预算满不自动淘汰(避免误删他步还要用的产物)→ 拒绝写入并回显当前占用,
 *   由 Agent 自己 delete 腾挪;
 * - 全部操作(view/create/update/delete 与每次拒绝)进 audit/retrieval.jsonl
 *   (kind='agent-note'),失败静默不阻断主流程。
 *
 * 开关:AGTPILOT_AGENT_NOTES=0 → 工具不暴露、注入清单不显示(存储函数保留)。
 */
export const AGENT_NOTES_TOTAL_BYTES = 64 * 1024;
export const AGENT_NOTES_FILE_BYTES = 16 * 1024;
const AGENT_NOTES_MAX_DEPTH = 2;
/** 文件名段白名单:字母/数字/下划线/连字符/中文,内部允许点(扩展名);禁隐藏文件 */
const AGENT_NOTES_SEGMENT_RE = /^[A-Za-z0-9_\-一-鿿][A-Za-z0-9_\-一-鿿.]*$/;

export interface AgentNoteInfo {
  /** 笔记区内相对路径(posix 分隔) */
  path: string;
  size: number;
  updatedAt: number;
}

export type AgentNoteWriteResult =
  | { ok: true; path: string; size: number; total: number }
  | {
      ok: false;
      reason: 'invalid-path' | 'file-too-large' | 'total-budget' | 'io-error';
      message: string;
      total?: number;
      limit?: number;
    };

export function isAgentNotesEnabled(): boolean {
  return process.env.AGTPILOT_AGENT_NOTES !== '0';
}

/** 笔记区根目录:v2 → <userDir>/agent-notes/;存储开关回退 → 旧平铺 <safe>.notes/ */
export function agentNotesDir(userId: string): string {
  const dataDir = getDataDir();
  if (isV2Enabled()) return path.join(userDirV2(dataDir, userId), 'agent-notes');
  return path.join(dataDir, `${safeName(userId)}.notes`);
}

/** 相对路径规范化(白名单段 + 深度限制);非法返回 null */
function normalizeNoteRel(relPath: string): string[] | null {
  const raw = String(relPath || '').trim().replace(/\\/g, '/');
  if (!raw || raw.startsWith('/')) return null;
  const segs = raw.split('/').filter(Boolean);
  if (segs.length === 0 || segs.length > AGENT_NOTES_MAX_DEPTH) return null;
  for (const s of segs) {
    if (s.startsWith('.') || s.length > 64 || !AGENT_NOTES_SEGMENT_RE.test(s)) return null;
  }
  return segs;
}

/**
 * 相对路径 → { 绝对路径, 规范化相对路径 }。
 * 双保险:白名单段校验 + resolve 后必须仍在笔记区根目录内(防穿越)。
 */
export function resolveAgentNotePath(userId: string, relPath: string): { abs: string; rel: string } | null {
  const segs = normalizeNoteRel(relPath);
  if (!segs) return null;
  const root = path.resolve(agentNotesDir(userId));
  const abs = path.resolve(root, ...segs);
  if (!abs.startsWith(root + path.sep)) return null;
  return { abs, rel: segs.join('/') };
}

/** 笔记操作全量进审计(复用检索轨迹通道;失败静默) */
function traceNoteOp(userId: string, entry: Record<string, unknown>): void {
  appendRetrievalTrace(userId, { kind: 'agent-note', ...entry });
}

const clip = (v: unknown, n = 120) => String(v ?? '').slice(0, n);

/** 枚举笔记(相对路径 + 大小 + 修改时间,最近在前;目录缺失/失败返回空) */
export function listAgentNotes(userId: string): AgentNoteInfo[] {
  const out: AgentNoteInfo[] = [];
  const walk = (dir: string, prefix: string, depth: number) => {
    if (depth > AGENT_NOTES_MAX_DEPTH) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('.') || e.name.endsWith('.tmp')) continue;
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(abs, rel, depth + 1);
        continue;
      }
      if (!e.isFile()) continue;
      try {
        const st = fs.statSync(abs);
        out.push({ path: rel, size: st.size, updatedAt: st.mtimeMs });
      } catch {
        // 单文件 stat 失败跳过
      }
    }
  };
  walk(agentNotesDir(userId), '', 1);
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
}

/** 读笔记全文;路径非法/不存在/IO 失败返回 null(均留审计) */
export function readAgentNote(userId: string, relPath: string): string | null {
  const target = resolveAgentNotePath(userId, relPath);
  if (!target) {
    traceNoteOp(userId, { op: 'view', path: clip(relPath), reason: 'invalid-path' });
    return null;
  }
  try {
    if (!fs.existsSync(target.abs)) {
      traceNoteOp(userId, { op: 'view', path: target.rel, reason: 'not-found' });
      return null;
    }
    const content = fs.readFileSync(target.abs, 'utf-8');
    traceNoteOp(userId, { op: 'view', path: target.rel, size: Buffer.byteLength(content, 'utf-8') });
    return content;
  } catch {
    traceNoteOp(userId, { op: 'view', path: target.rel, reason: 'io-error' });
    return null;
  }
}

/**
 * 写笔记(create/overwrite,原子 tmp+rename)。
 * 硬约束:单文件 ≤16KB;总预算 ≤64KB(覆盖时扣除旧版本占用)。
 * 超限一律拒绝并回显占用,不做自动淘汰。
 */
export function writeAgentNote(userId: string, relPath: string, content: string): AgentNoteWriteResult {
  const target = resolveAgentNotePath(userId, relPath);
  if (!target) {
    const message = `路径非法:${clip(relPath, 60)}(仅允许相对路径、${AGENT_NOTES_MAX_DEPTH} 层内、字母/数字/中文/._- 命名,禁隐藏文件)`;
    traceNoteOp(userId, { op: 'create', path: clip(relPath), reason: 'invalid-path' });
    return { ok: false, reason: 'invalid-path', message };
  }
  const buf = Buffer.from(String(content ?? ''), 'utf-8');
  if (buf.byteLength > AGENT_NOTES_FILE_BYTES) {
    const message = `单文件超限:${buf.byteLength}B > ${AGENT_NOTES_FILE_BYTES}B,请拆分或精简后再写。`;
    traceNoteOp(userId, { op: 'create', path: target.rel, reason: 'file-too-large', size: buf.byteLength });
    return { ok: false, reason: 'file-too-large', message, limit: AGENT_NOTES_FILE_BYTES };
  }
  const others = listAgentNotes(userId)
    .filter((n) => n.path !== target.rel)
    .reduce((s, n) => s + n.size, 0);
  if (others + buf.byteLength > AGENT_NOTES_TOTAL_BYTES) {
    const message = `笔记区总预算超限:现有 ${others}B + 本次 ${buf.byteLength}B > ${AGENT_NOTES_TOTAL_BYTES}B。请先 delete 不再需要的笔记,或精简内容。`;
    traceNoteOp(userId, { op: 'create', path: target.rel, reason: 'total-budget', size: buf.byteLength, total: others });
    return { ok: false, reason: 'total-budget', message, total: others, limit: AGENT_NOTES_TOTAL_BYTES };
  }
  try {
    const existed = fs.existsSync(target.abs);
    fs.mkdirSync(path.dirname(target.abs), { recursive: true });
    const tmp = `${target.abs}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, buf);
    fs.renameSync(tmp, target.abs);
    traceNoteOp(userId, {
      op: existed ? 'update' : 'create',
      path: target.rel,
      size: buf.byteLength,
      total: others + buf.byteLength,
    });
    return { ok: true, path: target.rel, size: buf.byteLength, total: others + buf.byteLength };
  } catch {
    traceNoteOp(userId, { op: 'create', path: target.rel, reason: 'io-error' });
    return { ok: false, reason: 'io-error', message: '写入失败(磁盘 IO 异常)。' };
  }
}

/** 删笔记;成功 true,路径非法/不存在 false(均留审计) */
export function deleteAgentNote(userId: string, relPath: string): boolean {
  const target = resolveAgentNotePath(userId, relPath);
  if (!target) {
    traceNoteOp(userId, { op: 'delete', path: clip(relPath), reason: 'invalid-path' });
    return false;
  }
  try {
    if (!fs.existsSync(target.abs)) {
      traceNoteOp(userId, { op: 'delete', path: target.rel, reason: 'not-found' });
      return false;
    }
    const size = fs.statSync(target.abs).size;
    fs.unlinkSync(target.abs);
    traceNoteOp(userId, { op: 'delete', path: target.rel, size });
    return true;
  } catch {
    traceNoteOp(userId, { op: 'delete', path: target.rel, reason: 'io-error' });
    return false;
  }
}

/**
 * 连接器值策略 lint(非阻断警告,借鉴 OpenShell 策略风险预检的简化版):
 * - URL 形态值指向 localhost/字面量私网地址 → 警告;
 * - 值含通配符 '*' → 警告(高危主机匹配);
 * - envVar 有默认凭据绑定且 URL host 不在绑定内 → 端点不匹配警告。
 * 域名解析到私网的情况不在 lint 覆盖内(运行时 guardUrlHost 兜底)。
 */
export function lintConnectorValue(envVar: string, value: string): string[] {
  const warnings: string[] = [];
  const v = (value || '').trim();
  if (!v) return warnings;
  if (v.includes('*')) {
    warnings.push('值包含通配符「*」：可能匹配到意外的高危主机，请确认是否必要。');
  }
  // URL 形态才做 host 检查(纯 API Key 不触发)
  if (/^https?:\/\//i.test(v)) {
    let host = '';
    try {
      host = new URL(v).hostname.toLowerCase().replace(/^\[|\]$/g, '');
    } catch {
      warnings.push('URL 形态无法解析，请检查格式。');
      return warnings;
    }
    // 仅对字面量 IP 判私网(isPrivateOrReservedIp 对非 IP 输入 fail closed,域名会误报);
    // 域名解析到私网的情况由运行时 guardUrlHost 兜底
    const isLiteralIp = host.includes(':') || /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
    if (host === 'localhost' || host.endsWith('.localhost') || (isLiteralIp && isPrivateOrReservedIp(host))) {
      warnings.push(`URL 指向本机/私有网络地址(${host})：出站围栏会拒绝此类请求，且存在内网暴露风险。`);
    }
    const bound = DEFAULT_CREDENTIAL_BINDINGS[envVar];
    if (bound && host && !bound.some((h) => h.toLowerCase() === host)) {
      warnings.push(`端点不匹配：${envVar} 的默认凭据绑定为 [${bound.join(', ')}]，当前值指向 ${host}，凭据将拒绝发往该端点(credential_endpoint_mismatch)。`);
    }
  }
  return warnings;
}

/**
 * 全员 profile 轻扫描(周期 sweeper / 启动预热用):只读每个用户的
 * profile.json,不碰 missions/JSONL 域。15min 周期的番茄 sweeper 与启动
 * 预热曾走 getAllUsersData —— 为拿 userId 和一个小开关把【所有用户的
 * 全部 mission 文件】读一遍,是事件循环的周期性无谓重锤。
 * 返回的 profile 是只读投影(未解密),纪律同 readProfileLight;
 * v2 关闭时回退 getAllUsersData(旧单文件布局没有更轻的读法)。
 * 注意:v2 下不做旧文件懒迁移(listUserIdsV2 已含迁移语义)。
 */
export function listUserProfilesLight(): Array<{ userId: string; profile: any }> {
  const dataDir = getDataDir();
  if (isV2Enabled()) {
    const out: Array<{ userId: string; profile: any }> = [];
    for (const userId of listUserIdsV2(dataDir)) {
      const profile = readProfileV2(dataDir, userId);
      if (!profile) continue;
      out.push({
        userId: typeof profile.userId === 'string' && profile.userId ? profile.userId : userId,
        profile,
      });
    }
    return out;
  }
  return getAllUsersData().map((d) => ({ userId: d.userId, profile: d }));
}

// 辅助方法：读取所有用户数据（用于服务端启动时加载所有后台定时任务等）
export function getAllUsersData(): UserScopedData[] {
  const dataDir = getDataDir();
  try {
    if (isV2Enabled()) {
      // v2:枚举用户目录 + 就地懒迁移未迁移的旧单文件(启动路径不漏人)
      const result: UserScopedData[] = [];
      const seen = new Set<string>();
      for (const userId of listUserIdsV2(dataDir)) {
        if (seen.has(userId)) continue;
        seen.add(userId);
        const data = readUserDataV2(dataDir, userId);
        if (!data) continue;
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
      return result;
    }
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

