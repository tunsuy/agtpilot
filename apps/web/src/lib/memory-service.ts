import {
  getUserMemories,
  getUserData,
  saveUserData,
  saveUserMemory,
  getAuthorityEpoch,
  appendDeletionLedger,
  appendMemoryAudit,
  type DeletionLedgerEntry,
} from './user-store';
import { getGovernanceBus } from './governance-bus';

/**
 * 用户长期记忆统一服务 (User Memory Service) —— 双通道架构 + 持久状态治理
 *
 * 之前记忆体系有两套互不相通的实现:
 * - plugin-memory 全局单文件 .cache/long_term_memory.json(多用户部署时 A 用户的
 *   Agent 沉淀会被 B 用户召回,跨用户泄漏);
 * - user-store 按 userId 隔离,但只能手动增删,注入 system prompt 时全量无上限。
 *
 * 本模块把 Web 端记忆统一收敛到 user-store(按用户隔离)。记忆按【主体】分双通道
 * (对齐 "Memory in the Age of AI Agents" 综述的 Factual/Experiential 划分与
 * Hermes Agent 的 USER.md/MEMORY.md 物理分离):
 *
 * - subject=user(用户事实记忆,"我知道什么"):画像、偏好、约束 —— 从用户原话提炼;
 * - subject=agent(Agent 经验记忆,"我学会什么"):环境事实、工具用法教训、流程策略
 *   —— 从任务执行轨迹(工具调用/失败/熔断/效率统计)提炼,带来源任务引用,
 *   让 Agent 不再每个会话重踩同一个坑。
 *
 * 通用能力:
 * 1. TF-IDF 加权余弦召回(词袋向量,按用户语料算 IDF;可平滑替换为 embedding);
 * 2. 按任务相关性排序 + 体积上限的 prompt 注入(用户 rule 永远全量注入;
 *    Agent 经验独立分块注入);
 * 3. 用户级 memory_store/recall/list 工具(经 runTask 的 taskTools 同名覆盖
 *    plugin-memory 的全局版本,多用户互不可见);
 * 4. 命中反馈与衰减:recall/注入时累计 hitCount,长期零命中的自动记忆降权,
 *    前端标记「疑似过时」;
 * 5. 会话结束自动维护(Mem0 式 CRUD 决策环,双通道各自跑):对照现有记忆做
 *   ADD/UPDATE/DELETE 决策,代码侧校验执行。用户手动固化的执行红线(rule)
 *   受保护,自动流程不可改删。
 *
 * 持久状态治理(docs/design/persistent-state-governance.md,对齐综述
 * 《Always-On Agents》的六维状态元数据与回退弧):
 * 6. 六维治理元数据 GovernanceMeta:权威/范围/可变性/来源/可恢复性/可行动性,
 *    存量记忆读取时惰性回填(§6 迁移规则),写回时落盘;
 * 7. 回退弧:软删除(用户删 30 天、自动删 7 天内可恢复)+ 删除台账 + 传导
 *    (衍生记忆打 flag-review、被取代链一并软删)+ governance-bus 广播
 *    memory-revoked(in-flight 任务下一步注入治理提示)+ append-only 审计日志;
 * 8. 提炼防抹平(AOEP 教训):UPDATE 不再原地覆盖 —— 新版本独立成条,
 *    supersededBy/originMemoryIds 保留来源链(I4);自动提炼禁改 protected
 *    条目;不允许借 update 扩大 scope(I2)或把 fact 升级成 commitment;
 * 9. 权限纪元联动:绑定连接器的 commitment 记忆,其授权纪元落后于当前纪元时
 *    自动降级「待重新确认」,不再注入 prompt(I1)。
 */

export type MemoryCategory = 'preference' | 'project' | 'fact' | 'rule';
export type MemorySubject = 'user' | 'agent';

/** 记忆条目的授予权威来源 */
export type MemoryAuthority = 'user-manual' | 'user-confirmed' | 'agent-auto' | 'system';

/**
 * 六维治理元数据(综述的「每条持久状态六张身份证」):
 * 权威 / 范围 / 可变性 / 来源 / 可恢复性 / 可行动性。
 * 提炼与整合过程必须原样保留本结构 —— 治理不是阅读问题,
 * 字段没存,模型再强也读不出来(AOEP 的核心教训)。
 */
export interface GovernanceMeta {
  /** 权威:谁允许这条状态影响行动 */
  authority: {
    grantedBy: MemoryAuthority;
    /** 权限纪元:授予时的 epoch;对应连接器授权撤销后 epoch 递增,旧纪元的 commitment 待重新确认 */
    epoch: number;
    /** 受保护:自动流程不可改删(收敛原「手动 user-rule 红线」逻辑的唯一判断入口) */
    protected: boolean;
  };
  /** 范围:哪些上下文可以用它(缺省 = 该用户全域;I2:范围不能悄悄扩大) */
  scope: {
    /** 绑定的连接器 id(commitment 与该连接器的权限纪元联动) */
    connectorId?: string;
    /** 限定只对某任务生效 */
    missionId?: string;
    /** 限定只对某类工具生效(如 ['browser_']) */
    toolPrefixes?: string[];
    /** 时间边界 */
    expiresAt?: number;
  };
  /** 可变性:能否被修订、取代、衰减、锁定 */
  mutability: {
    policy: 'immutable' | 'user-only' | 'auto-decay' | 'mutable';
    /** 修订号:每次 UPDATE(取代)+1 */
    revision: number;
    /** 被哪条新记忆取代(旧版本退出注入,但保留可追溯) */
    supersededBy?: string;
  };
  /** 来源:从哪个源头、经哪些变换得来(I4:整合必须保留来源) */
  provenance: {
    originMissionId?: string;
    /** UPDATE/合并时的来源条目 id(取代链的上一环) */
    originMemoryIds?: string[];
    transforms: Array<'distill' | 'user-edit' | 'auto-crud'>;
  };
  /** 可恢复性:软删标记与台账指针(I3/I5) */
  recoverability: {
    deleted?: {
      at: number;
      by: 'user' | 'auto' | 'propagated';
      ledgerId: string;
      /** 超过该时刻物理清除(惰性 purge) */
      recoverableUntil: number;
    };
  };
  /** 可行动性:被动事实还是可执行承诺(commitment 注入时显式标注) */
  actionability: 'fact' | 'commitment';
  /** 待人工复核标记(传导产生:来源记忆被删除等) */
  reviewFlag?: { at: number; reason: string };
}

export interface UserMemory {
  id: string;
  title: string;
  content: string;
  category: MemoryCategory;
  confidence: number;
  updatedAt: number;
  /** manual = 用户在记忆库页面手动添加;auto = 会话结束自动提炼 */
  source?: 'manual' | 'auto';
  /** 记忆主体:user = 用户事实记忆(画像/偏好);agent = Agent 经验记忆(环境/工具/流程) */
  subject?: MemorySubject;
  /** 来源任务引用(自动提炼时记录,构成情景记忆的时间锚点) */
  missionId?: string;
  /** 被召回(工具检索或 prompt 注入)的累计次数 */
  hitCount?: number;
  /** 最近一次被召回的时间 */
  lastHitAt?: number;
  /** 六维治理元数据;存量数据缺失时读取层惰性回填(ensureGovernance) */
  governance?: GovernanceMeta;
}

/** 自动提炼的维护决策结果 */
export interface DistillOutcome {
  added: UserMemory[];
  updated: UserMemory[];
  deletedIds: string[];
}

// ---- 可调参数 ----
/** system prompt 注入的用户记忆条数上限 */
const PROMPT_MAX_ITEMS = 12;
/** system prompt 注入的用户记忆总字符预算 */
const PROMPT_MAX_CHARS = 3600;
/** 执行红线(rule)类记忆始终全量注入的条数上限 */
const PROMPT_MAX_RULES = 10;
/** system prompt 注入的 Agent 经验条数上限(独立分块、独立预算) */
const AGENT_PROMPT_MAX_ITEMS = 6;
/** system prompt 注入的 Agent 经验总字符预算 */
const AGENT_PROMPT_MAX_CHARS = 1600;
/** 单次会话结束自动提炼的操作条数上限(含 add/update/delete,每通道独立) */
const DISTILL_MAX_OPS = 5;
/** 提炼 prompt 中列出的现有记忆条数上限(优先最近更新的) */
const DISTILL_EXISTING_LIMIT = 50;
/** 单用户记忆总量上限(自动提炼在达到上限后停止新增,更新/删除仍可) */
const MEMORIES_MAX_TOTAL = 100;
/** 自动提炼喂给模型的对话摘录/轨迹摘录总字符上限 */
const DISTILL_TRANSCRIPT_LIMIT = 6000;
/** 「疑似过时」判定:自动沉淀 + 零命中 + 超过该天数 */
const STALE_AFTER_DAYS = 30;
/** 疑似过时记忆的排序惩罚系数 */
const STALE_SCORE_PENALTY = 0.3;
/** Agent 经验通道的轨迹信息量门槛:工具调用次数达到该值才提炼 */
const AGENT_DISTILL_MIN_TOOL_CALLS = 3;
/** 自动提炼开关:AGTPILOT_AUTO_MEMORY=0 关闭(两个通道一起关) */
export function isAutoMemoryEnabled(): boolean {
  return process.env.AGTPILOT_AUTO_MEMORY !== '0';
}

// ---- 治理参数 ----
/** 用户手动删除的软删保留期(可恢复窗口) */
const SOFT_DELETE_USER_RETENTION_MS = 30 * 24 * 3600 * 1000;
/** 自动流程删除的软删保留期 */
const SOFT_DELETE_AUTO_RETENTION_MS = 7 * 24 * 3600 * 1000;

// ---- 六维治理元数据:惰性回填 / 活跃过滤 / 软删与恢复 ----

/** 旧版保护判定(手动固化的 user 通道 rule 红线),仅用于 governance 缺失时回填 */
function legacyProtected(m: UserMemory): boolean {
  return m.source === 'manual' && m.category === 'rule' && (m.subject || 'user') === 'user';
}

/**
 * 惰性回填六维治理元数据(§6 迁移规则,纯函数不落盘):
 * - source=manual → grantedBy=user-manual;source=auto → agent-auto;
 * - protected 收敛原「手动 user-rule」判定;
 * - missionId → provenance.originMissionId;
 * - actionability 按 category 映射(rule → commitment,其余 → fact);
 * - epoch 回填 0(历史数据无法考证授权纪元,按最低信任处理 ——
 *   绑定连接器的 commitment 会因纪元落后被降级待确认,符合 I1 只收窄)。
 */
export function ensureGovernance(m: UserMemory): UserMemory {
  if (m.governance) return m;
  const manual = m.source !== 'auto';
  return {
    ...m,
    governance: {
      authority: {
        grantedBy: manual ? 'user-manual' : 'agent-auto',
        epoch: 0,
        protected: legacyProtected(m),
      },
      scope: { missionId: m.missionId },
      mutability: {
        policy: manual ? 'user-only' : 'auto-decay',
        revision: 0,
      },
      provenance: {
        originMissionId: m.missionId,
        transforms: [manual ? 'user-edit' : 'distill'],
      },
      recoverability: {},
      actionability: m.category === 'rule' ? 'commitment' : 'fact',
    },
  };
}

/** 受保护条目(自动流程不可改删):governance 存在时以其为准,否则走旧判定 */
export function isProtectedMemory(m: UserMemory): boolean {
  return m.governance ? m.governance.authority.protected : legacyProtected(m);
}

/**
 * 活跃判定(哪些记忆有资格进入召回/注入/提炼视野):
 * 软删的、被取代的、超过 scope 时间边界的、绑定连接器的 commitment
 * 且授权纪元已落后的(待重新确认)—— 全部排除(I1/I2)。
 */
export function isActiveMemory(
  m: UserMemory,
  opts: { now?: number; epochLookup?: (connectorId: string) => number } = {}
): boolean {
  const now = opts.now ?? Date.now();
  const g = m.governance;
  if (!g) return true; // 未回填的存量数据由调用方先 ensureGovernance
  if (g.recoverability.deleted) return false;
  if (g.mutability.supersededBy) return false;
  if (g.scope.expiresAt && now > g.scope.expiresAt) return false;
  if (
    g.actionability === 'commitment' &&
    g.scope.connectorId &&
    opts.epochLookup &&
    g.authority.epoch < opts.epochLookup(g.scope.connectorId)
  ) {
    return false; // 授权纪元落后 → 降级待重新确认
  }
  return true;
}

/**
 * 读取该用户全部记忆(治理视角):惰性回填 governance + 惰性物理清除
 * 超过保留期的软删条目(purge 留审计)。返回的是内存副本,
 * 需要活跃子集时再按 isActiveMemory 过滤。
 */
export function listGovernedMemories(userId: string): UserMemory[] {
  const raw = (getUserMemories(userId) as UserMemory[]) || [];
  const now = Date.now();
  let purged = 0;
  const governed = raw
    .map((m) => ensureGovernance(m))
    .filter((m) => {
      const deleted = m.governance?.recoverability.deleted;
      if (deleted && now > deleted.recoverableUntil) {
        purged++;
        return false;
      }
      return true;
    });
  if (purged > 0) {
    // 惰性 purge:保留期已过的软删条目物理移除(台账与审计仍保留完整链路)
    try {
      const data = getUserData(userId);
      const aliveIds = new Set(governed.map((m) => m.id));
      data.memories = (data.memories || []).filter((m: any) => aliveIds.has(m.id));
      saveUserData(data);
      appendMemoryAudit(userId, {
        at: now,
        actor: 'system',
        op: 'purge',
        detail: `物理清除 ${purged} 条超过软删保留期的记忆`,
      });
    } catch {
      // purge 失败不影响读取
    }
  }
  return governed;
}

/** 活跃记忆(召回/注入/提炼的统一入口):governed + 活跃过滤(含纪元联动) */
export function listActiveMemories(userId: string, now = Date.now()): UserMemory[] {
  const epochLookup = (connectorId: string) => getAuthorityEpoch(userId, connectorId);
  return listGovernedMemories(userId).filter((m) => isActiveMemory(m, { now, epochLookup }));
}

/** 软删保留期内的条目(前端「最近删除/可恢复」视图用) */
export function listSoftDeletedMemories(userId: string, now = Date.now()): UserMemory[] {
  return listGovernedMemories(userId).filter(
    (m) => m.governance?.recoverability.deleted && now <= m.governance.recoverability.deleted.recoverableUntil
  );
}

function makeLedgerId(): string {
  return `led_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * 软删除 + 删除台账 + 传导(治理回退弧核心,§3.2):
 * 1. protected 条目仅用户本人可删,自动流程发起时拒绝并留审计(G4);
 * 2. 目标条目打软删标记(保留期内可 restore);
 * 3. 传导(I3):
 *    - 衍生记忆(provenance.originMemoryIds 含目标 id)→ 打 reviewFlag 待人工复核;
 *    - 被目标取代的历史版本(target.supersededBy 指向的旧条目)→ 一并软删;
 * 4. 台账登记全部传导动作;审计留痕;governance-bus 广播 memory-revoked
 *    (in-flight 任务下一步注入「该记忆已删除」治理提示)。
 */
export function softDeleteUserMemory(
  userId: string,
  memoryId: string,
  opts: { requestedBy: 'user' | 'auto' | 'propagated'; reason?: string; actor?: 'user' | 'agent' | 'auto-distill' | 'system' }
): { ok: boolean; rejected?: 'protected' | 'not-found'; ledgerId?: string; propagatedCount?: number } {
  const all = listGovernedMemories(userId);
  const target = all.find((m) => m.id === memoryId);
  if (!target || target.governance?.recoverability.deleted) {
    return { ok: false, rejected: 'not-found' };
  }
  if (isProtectedMemory(target) && opts.requestedBy !== 'user') {
    appendMemoryAudit(userId, {
      at: Date.now(),
      actor: opts.actor || 'auto-distill',
      op: 'write-rejected',
      memoryId,
      detail: `自动流程试图删除受保护条目 [${target.title}],已拦截`,
    });
    return { ok: false, rejected: 'protected' };
  }

  const now = Date.now();
  const ledgerId = makeLedgerId();
  const retention = opts.requestedBy === 'user' ? SOFT_DELETE_USER_RETENTION_MS : SOFT_DELETE_AUTO_RETENTION_MS;
  const propagated: DeletionLedgerEntry['propagated'] = [];

  const data = getUserData(userId);
  const memories = ((data.memories || []) as UserMemory[]).map((m) => ensureGovernance(m));
  const byId = new Map(memories.map((m) => [m.id, m]));

  // 待软删集合:目标 + 被其取代的历史版本链(向旧追溯)
  const toDelete = new Set<string>([memoryId]);
  let cursor = byId.get(memoryId);
  while (cursor?.governance?.provenance.originMemoryIds?.length) {
    const prevId = cursor.governance.provenance.originMemoryIds[0];
    const prev = byId.get(prevId);
    if (!prev || toDelete.has(prevId)) break;
    toDelete.add(prevId);
    cursor = prev;
  }

  for (const m of memories) {
    if (toDelete.has(m.id) && !m.governance!.recoverability.deleted) {
      m.governance!.recoverability.deleted = {
        at: now,
        by: m.id === memoryId ? opts.requestedBy : 'propagated',
        ledgerId,
        recoverableUntil: now + retention,
      };
      if (m.id !== memoryId) {
        propagated.push({ kind: 'memory', id: m.id, action: 'soft-delete' });
      }
    } else {
      // 衍生记忆:来源被删 → 打待复核标记(不自动删,I3 的保守传导)
      const origins = m.governance!.provenance.originMemoryIds || [];
      if (origins.includes(memoryId) && !m.governance!.reviewFlag) {
        m.governance!.reviewFlag = { at: now, reason: 'origin-deleted' };
        propagated.push({ kind: 'memory', id: m.id, action: 'flag-review' });
      }
    }
  }
  data.memories = memories;
  saveUserData(data);

  const ledgerEntry: DeletionLedgerEntry = {
    id: ledgerId,
    target: { kind: 'memory', id: memoryId, userId },
    requestedBy: opts.requestedBy,
    reason: opts.reason,
    at: now,
    propagated,
    status: 'done',
  };
  appendDeletionLedger(userId, ledgerEntry);
  appendMemoryAudit(userId, {
    at: now,
    actor: opts.actor || (opts.requestedBy === 'user' ? 'user' : 'auto-distill'),
    op: 'soft-delete',
    memoryId,
    detail: `by=${opts.requestedBy}${opts.reason ? ` reason=${opts.reason}` : ''} 传导 ${propagated.length} 项`,
  });

  getGovernanceBus().emitMemoryRevoked({
    userId,
    memoryId,
    title: target.title,
    requestedBy: opts.requestedBy,
    reason: opts.reason,
  });

  return { ok: true, ledgerId, propagatedCount: propagated.length };
}

/** 恢复软删条目(G5:保留期内可 restore;restore 本身也留审计) */
export function restoreUserMemory(
  userId: string,
  memoryId: string,
  actor: 'user' | 'system' = 'user'
): { ok: boolean; error?: 'not-found' | 'expired' } {
  // 刻意读原始存储而非 listGovernedMemories:后者会先触发惰性 purge,
  // 把刚过期的条目物理清掉,导致「已超保留期」退化成「不存在」——
  // 两种语义对用户不同(前者可解释为何不能恢复),必须区分
  const raw = ((getUserMemories(userId) as UserMemory[]) || []).map((m) => ensureGovernance(m));
  const target = raw.find((m) => m.id === memoryId);
  const deleted = target?.governance?.recoverability.deleted;
  if (!target || !deleted) return { ok: false, error: 'not-found' };
  if (Date.now() > deleted.recoverableUntil) return { ok: false, error: 'expired' };

  const data = getUserData(userId);
  data.memories = ((data.memories || []) as UserMemory[]).map((m) => {
    const g = ensureGovernance(m);
    if (g.id === memoryId) {
      delete g.governance!.recoverability.deleted;
      return g;
    }
    return m;
  });
  saveUserData(data);
  appendMemoryAudit(userId, {
    at: Date.now(),
    actor,
    op: 'restore',
    memoryId,
    detail: `从软删恢复(原删除台账 ${deleted.ledgerId})`,
  });
  return { ok: true };
}

/**
 * 用户手动新增/更新记忆的统一入口(API 路由用):
 * 手动条目 grantedBy=user-manual,rule 类自动 protected(I1:权威只收窄 ——
 * 手动更新不会降级既有保护位),全程审计留痕。
 */
export function upsertManualMemory(
  userId: string,
  payload: { id?: string; title: string; content: string; category?: MemoryCategory; subject?: MemorySubject; confidence?: number }
): UserMemory {
  const now = Date.now();
  const existing = payload.id
    ? ((getUserMemories(userId) as UserMemory[]) || []).find((m) => m.id === payload.id)
    : undefined;
  const category = payload.category || existing?.category || 'preference';
  const subject = payload.subject || existing?.subject || 'user';
  const base = existing ? ensureGovernance(existing) : undefined;
  const record: UserMemory = {
    id: existing?.id || payload.id || makeMemoryId(),
    title: payload.title.trim(),
    content: payload.content.trim(),
    category,
    confidence: payload.confidence ?? existing?.confidence ?? 1.0,
    updatedAt: now,
    source: 'manual',
    subject,
    missionId: existing?.missionId,
    hitCount: existing?.hitCount,
    lastHitAt: existing?.lastHitAt,
    governance: {
      authority: {
        grantedBy: 'user-manual',
        epoch: base?.governance?.authority.epoch ?? 0,
        protected: category === 'rule' && subject === 'user' ? true : (base?.governance?.authority.protected ?? false),
      },
      scope: { ...(base?.governance?.scope || {}), missionId: existing?.missionId },
      mutability: {
        policy: 'user-only',
        revision: (base?.governance?.mutability.revision ?? 0) + (existing ? 1 : 0),
        supersededBy: base?.governance?.mutability.supersededBy,
      },
      provenance: {
        originMissionId: base?.governance?.provenance.originMissionId ?? existing?.missionId,
        originMemoryIds: base?.governance?.provenance.originMemoryIds,
        transforms: [...(base?.governance?.provenance.transforms || []), 'user-edit'],
      },
      recoverability: {},
      actionability: category === 'rule' ? 'commitment' : (base?.governance?.actionability ?? 'fact'),
    },
  };
  saveUserMemory(userId, record);
  appendMemoryAudit(userId, {
    at: now,
    actor: 'user',
    op: existing ? 'update' : 'add',
    memoryId: record.id,
    detail: `[${record.category}] ${record.title}`,
  });
  return record;
}

// ---- 分词 ----

const LATIN_STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'for', 'in', 'on', 'with', 'is', 'are',
  'be', 'by', 'as', 'at', 'it', 'this', 'that', 'from', 'will', 'can', 'please',
  'help', 'me', 'my', 'you', 'your', 'i', 'we', 'do', 'does', 'how', 'what',
]);
const CJK_STOPCHARS = new Set('的了是我你他她它这那不也都和与或请吧呢啊呀'.split(''));

/** 分词:拉丁词(≥2字符,去停用词)+ CJK 二元组(bigram),供相关性打分 */
export function tokenize(text: string): string[] {
  const tokens: string[] = [];
  for (const w of text.toLowerCase().match(/[a-z0-9_][a-z0-9_-]{1,}/g) || []) {
    if (!LATIN_STOPWORDS.has(w)) tokens.push(w);
  }
  for (const seg of text.match(/[㐀-䶿一-鿿]+/g) || []) {
    if (seg.length === 1) {
      if (!CJK_STOPCHARS.has(seg)) tokens.push(seg);
    } else {
      for (let i = 0; i < seg.length - 1; i++) tokens.push(seg.slice(i, i + 2));
    }
  }
  return tokens;
}

/** 归一化标题/内容用于去重:小写 + 去空白标点 */
function normalizeForDedupe(s: string): string {
  return s.toLowerCase().replace(/[\s.,;:!?'""()\[\]{}~`@#$%^&*+=|\\/-]+/g, '');
}

function makeMemoryId(): string {
  return `mem_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
}

/** 疑似过时:自动沉淀 + 从未被召回 + 存在超过 STALE_AFTER_DAYS 天 */
export function isStaleMemory(m: UserMemory, now = Date.now()): boolean {
  return (
    m.source === 'auto' &&
    !(m.hitCount || 0) &&
    now - (m.updatedAt || 0) > STALE_AFTER_DAYS * 24 * 3600 * 1000
  );
}

// ---- TF-IDF 加权余弦相关性 ----

/**
 * 计算一批记忆与查询的 TF-IDF 加权余弦相似度(标题词权重 ×2)。
 * 相比简单命中计数:在全部记忆里都出现的泛化词(如"偏好/项目")IDF 低自动降权,
 * 独特词(如"pnpm/阿里云")主导排序 —— 换说法的召回质量显著更好。
 * 返回 id → score(0~1)。
 */
function computeRelevance(query: string, memories: UserMemory[]): Map<string, number> {
  const scores = new Map<string, number>();
  const queryTokens = tokenize(query);
  if (queryTokens.length === 0 || memories.length === 0) return scores;

  // 每条记忆的词频(标题 ×2),顺带统计文档频率 df
  const tfMaps = memories.map((m) => {
    const counts = new Map<string, number>();
    for (const t of tokenize(m.title)) counts.set(t, (counts.get(t) || 0) + 2);
    for (const t of tokenize(m.content)) counts.set(t, (counts.get(t) || 0) + 1);
    return counts;
  });
  const df = new Map<string, number>();
  for (const tf of tfMaps) {
    for (const t of tf.keys()) df.set(t, (df.get(t) || 0) + 1);
  }
  const N = memories.length;
  const idf = (t: string) => Math.log(1 + N / (1 + (df.get(t) || 0)));

  // 查询向量(tf-idf)
  const qCounts = new Map<string, number>();
  for (const t of queryTokens) qCounts.set(t, (qCounts.get(t) || 0) + 1);
  let qNorm = 0;
  for (const [t, tf] of qCounts) {
    const w = (1 + Math.log(tf)) * idf(t);
    qNorm += w * w;
  }

  memories.forEach((m, i) => {
    const tf = tfMaps[i];
    let dot = 0;
    let mNorm = 0;
    for (const [t, tfreq] of tf) {
      const w = (1 + Math.log(tfreq)) * idf(t);
      mNorm += w * w;
      const qw = qCounts.get(t);
      if (qw) {
        const qwm = (1 + Math.log(qw)) * idf(t);
        dot += w * qwm;
      }
    }
    if (mNorm > 0 && qNorm > 0) {
      let score = dot / Math.sqrt(mNorm * qNorm);
      // 疑似过时的自动记忆降权(用户长期没用上,大概率不再成立)
      if (isStaleMemory(m)) score *= STALE_SCORE_PENALTY;
      scores.set(m.id, score);
    }
  });
  return scores;
}

/**
 * 关键词召回:TF-IDF 余弦排序,子串包含兜底加成(标题/内容直接包含查询串)。
 * subject 可选限定记忆主体(user/agent)。
 */
export function recallUserMemories(
  userId: string,
  query: string,
  category?: MemoryCategory,
  subject?: MemorySubject
): UserMemory[] {
  const q = query.toLowerCase().trim();
  if (!q) return [];
  // 治理过滤:软删/被取代/过期/纪元降级的记忆不进召回(I1/I2/I3)
  const all = listActiveMemories(userId).filter(
    (m) => (!category || m.category === category) && (!subject || (m.subject || 'user') === subject)
  );
  if (all.length === 0) return [];

  const scores = computeRelevance(q, all);
  const substringBonus = 0.5; // 子串命中在余弦之上叠加确定性加成
  return all
    .map((m) => {
      const hay = `${m.title} ${m.content}`.toLowerCase();
      const substringHit = hay.includes(q) || q.includes(m.title.toLowerCase());
      const stalePenalty = isStaleMemory(m) ? STALE_SCORE_PENALTY : 1;
      const score = (scores.get(m.id) || 0) * stalePenalty + (substringHit ? substringBonus : 0);
      return { m, score };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || b.m.updatedAt - a.m.updatedAt)
    .map((s) => s.m);
}

// ---- 命中反馈 ----

/** 记录一批记忆被召回(累计 hitCount / lastHitAt),单次合并写盘 */
export function noteMemoryHits(userId: string, ids: string[]): void {
  if (ids.length === 0) return;
  try {
    const data = getUserData(userId);
    const idSet = new Set(ids);
    let touched = false;
    data.memories = (data.memories || []).map((m: any) => {
      if (idSet.has(m.id)) {
        touched = true;
        return { ...m, hitCount: (m.hitCount || 0) + 1, lastHitAt: Date.now() };
      }
      return m;
    });
    if (touched) saveUserData(data);
  } catch {
    // 命中统计失败不影响主流程
  }
}

// ---- prompt 注入 ----

/**
 * 构建 system prompt 记忆注入块(双通道分块):
 * - 用户事实记忆:rule(执行红线)始终全量注入,其余按与任务目标的 TF-IDF 相关性
 *   排序,超过条数/字符预算截断;
 * - Agent 经验记忆:独立分块【Agent 执行经验与教训】,按相关性独立预算注入;
 * - 无记忆时返回空串(不占 prompt)。
 * 副作用:被注入的记忆视为一次命中,累计 hitCount(每次任务一次写盘)。
 */
export function buildMemoryPromptBlock(userId: string, goal: string): string {
  // 治理过滤:软删/被取代/过期/授权纪元降级的记忆一律不注入(I1/I2/I3)
  const all = listActiveMemories(userId)
    .slice()
    .sort((a, b) => b.updatedAt - a.updatedAt);
  if (all.length === 0) return '';

  // ---- 通道一:用户事实记忆(subject=user,缺省归此) ----
  const userMems = all.filter((m) => (m.subject || 'user') === 'user');
  const agentMems = all.filter((m) => m.subject === 'agent');

  const userScores = computeRelevance(goal, userMems);
  const rules = userMems.filter((m) => m.category === 'rule').slice(0, PROMPT_MAX_RULES);
  const ruleIds = new Set(rules.map((m) => m.id));
  const userOthers = userMems
    .filter((m) => !ruleIds.has(m.id))
    .sort((a, b) => (userScores.get(b.id) || 0) - (userScores.get(a.id) || 0) || b.updatedAt - a.updatedAt);

  const selectedUser: UserMemory[] = [...rules];
  let usedChars = rules.reduce((acc, m) => acc + m.title.length + m.content.length, 0);
  for (const m of userOthers) {
    if (selectedUser.length >= PROMPT_MAX_ITEMS) break;
    const cost = m.title.length + m.content.length;
    if (usedChars + cost > PROMPT_MAX_CHARS) continue;
    selectedUser.push(m);
    usedChars += cost;
  }

  // ---- 通道二:Agent 经验记忆(subject=agent,独立分块独立预算) ----
  const agentScores = computeRelevance(goal, agentMems);
  const selectedAgent: UserMemory[] = [];
  let agentChars = 0;
  for (const m of agentMems.sort(
    (a, b) => (agentScores.get(b.id) || 0) - (agentScores.get(a.id) || 0) || b.updatedAt - a.updatedAt
  )) {
    if (selectedAgent.length >= AGENT_PROMPT_MAX_ITEMS) break;
    const cost = m.title.length + m.content.length;
    if (agentChars + cost > AGENT_PROMPT_MAX_CHARS) continue;
    selectedAgent.push(m);
    agentChars += cost;
  }

  if (selectedUser.length === 0 && selectedAgent.length === 0) return '';

  // 注入 = 一次命中(供衰减统计;失败静默)
  noteMemoryHits(userId, [...selectedUser, ...selectedAgent].map((m) => m.id));

  const sections: string[] = [];
  if (selectedUser.length > 0) {
    const omittedUser = userMems.length - selectedUser.length;
    sections.push(
      [
        '【当前用户的专属个性画像与长期记忆】:',
        ...selectedUser.map(formatMemoryLine),
        omittedUser > 0 ? `(另有 ${omittedUser} 条低相关记忆未注入,可用 memory_recall 按需检索)` : '',
      ]
        .filter(Boolean)
        .join('\n')
    );
  }
  if (selectedAgent.length > 0) {
    const omittedAgent = agentMems.length - selectedAgent.length;
    sections.push(
      [
        '【Agent 执行经验与教训(过往任务轨迹沉淀的环境/工具/流程经验,请主动规避已知坑、复用有效路径)】:',
        ...selectedAgent.map(formatMemoryLine),
        omittedAgent > 0 ? `(另有 ${omittedAgent} 条低相关经验未注入,可用 memory_recall 检索)` : '',
      ]
        .filter(Boolean)
        .join('\n')
    );
  }
  sections.push('请严格遵守上述用户的个性偏好与安全规则,并善用 Agent 已沉淀的执行经验进行思考与输出。');
  return sections.join('\n\n');
}

/**
 * 注入行格式化:commitment(可执行承诺)显式标注 —— 被动事实与待执行承诺
 * 分开呈现(六维之一 actionability),避免模型把承诺当背景知识读过就算。
 */
function formatMemoryLine(m: UserMemory): string {
  const tag = m.governance?.actionability === 'commitment' ? '[承诺·须持续遵守/执行]' : '';
  return `- [${m.category.toUpperCase()}]${tag} ${m.title}: ${m.content}`;
}

// ---- 用户级记忆工具(taskTools 同名覆盖 plugin-memory 全局版) ----

/**
 * 构建绑定到指定用户的 memory_store/recall/list 工具。
 * 经 runTask 的 taskTools 注入(核心层同名任务级工具优先于全局注册),
 * 读写全部落在 user-store 的该用户空间 —— 多用户部署时互不可见。
 */
export function buildUserMemoryTools(userId: string): any[] {
  const store = (
    title: string,
    content: string,
    category: MemoryCategory,
    subject: MemorySubject = 'user'
  ): { record: UserMemory; isUpdate: boolean } => {
    const normTitle = normalizeForDedupe(title);
    // 同名去重只看活跃记忆:软删/被取代条目的标题可复用,不会「复活」旧 id
    const existing = listActiveMemories(userId).find(
      (m) => normalizeForDedupe(m.title) === normTitle && (m.subject || 'user') === subject
    );
    const now = Date.now();
    const protectedFlag = category === 'rule' && subject === 'user';
    const record: UserMemory = {
      id: existing?.id || makeMemoryId(),
      title: title.trim(),
      content: content.trim(),
      category,
      confidence: 1.0,
      updatedAt: now,
      source: existing?.source || 'manual',
      subject,
      governance: {
        // 任务中经用户指示保存 → user-confirmed(权威低于记忆库页手动固化的 user-manual,
        // 但高于会话末自动提炼的 agent-auto)
        authority: {
          grantedBy: existing?.governance?.authority.grantedBy === 'user-manual' ? 'user-manual' : 'user-confirmed',
          epoch: existing?.governance?.authority.epoch ?? 0,
          protected: existing?.governance?.authority.protected || protectedFlag,
        },
        scope: { ...(existing?.governance?.scope || {}) },
        mutability: {
          policy: existing?.governance?.mutability.policy ?? 'user-only',
          revision: (existing?.governance?.mutability.revision ?? 0) + (existing ? 1 : 0),
        },
        provenance: {
          originMissionId: existing?.governance?.provenance.originMissionId,
          originMemoryIds: existing?.governance?.provenance.originMemoryIds,
          transforms: [...(existing?.governance?.provenance.transforms || []), 'user-edit'],
        },
        recoverability: {},
        actionability: protectedFlag || category === 'rule' ? 'commitment' : (existing?.governance?.actionability ?? 'fact'),
      },
    };
    saveUserMemory(userId, record);
    appendMemoryAudit(userId, {
      at: now,
      actor: 'agent',
      op: existing ? 'update' : 'add',
      memoryId: record.id,
      detail: `memory_store 工具 [${record.category}] ${record.title}`,
    });
    return { record, isUpdate: Boolean(existing) };
  };

  return [
    {
      name: 'memory_store',
      description:
        '长期记住用户的习惯偏好、技术栈规范、专属业务知识,或本次任务中发现的环境事实/工具用法教训。存储后的记忆会持久化到当前用户的记忆库并在未来的跨会话任务中永久生效。',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: '记忆简短标题 (例如: "代码风格偏好", "沙箱环境事实", "XX站点抓取技巧")' },
          content: { type: 'string', description: '要牢记的核心知识点或偏好细节' },
          category: {
            type: 'string',
            enum: ['preference', 'project', 'fact', 'rule'],
            description: '记忆类型：preference (偏好/流程策略), project (项目背景), fact (关键事实/环境事实), rule (执行红线与规则)',
          },
          subject: {
            type: 'string',
            enum: ['user', 'agent'],
            description: '记忆主体：user = 关于用户本人的偏好与背景(默认)；agent = Agent 自己执行任务时学到环境/工具/流程经验(踩坑教训、有效路径)',
          },
        },
        required: ['title', 'content'],
      },
      execute: async ({ title, content, category, subject }: any) => {
        const subj: MemorySubject = subject === 'agent' ? 'agent' : 'user';
        const { record, isUpdate } = store(
          String(title),
          String(content),
          (category as MemoryCategory) || 'fact',
          subj
        );
        return {
          success: true,
          memoryId: record.id,
          title: record.title,
          category: record.category,
          subject: record.subject,
          updated: isUpdate,
          message: isUpdate
            ? `已有同名记忆 [${record.title}]，已更新其内容。`
            : `已成功将${subj === 'agent' ? ' Agent 执行经验' : '记忆'} [${record.title}] 固化到当前用户的长期记忆库中。`,
        };
      },
    },
    {
      name: 'memory_recall',
      description: '在执行任务前检索当前用户的长期记忆库,主动获取过去沉淀的用户偏好、项目知识与 Agent 执行经验。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '检索关键词 (如: "部署习惯", "前端规范", "沙箱环境")' },
          category: {
            type: 'string',
            enum: ['preference', 'project', 'fact', 'rule'],
            description: '可选,限定检索的记忆类型',
          },
          subject: {
            type: 'string',
            enum: ['user', 'agent'],
            description: '可选,限定记忆主体：user = 用户偏好与背景；agent = Agent 执行经验',
          },
        },
        required: ['query'],
      },
      execute: async ({ query, category, subject }: any) => {
        const results = recallUserMemories(
          userId,
          String(query || ''),
          category as MemoryCategory | undefined,
          subject === 'agent' || subject === 'user' ? (subject as MemorySubject) : undefined
        );
        // 被召回 = 一次命中(供衰减统计)
        noteMemoryHits(userId, results.map((r) => r.id));
        return {
          success: true,
          query,
          count: results.length,
          memories: results.map((r) => ({
            title: r.title,
            content: r.content,
            category: r.category,
            subject: r.subject || 'user',
          })),
        };
      },
    },
    {
      name: 'memory_list',
      description: '列出当前用户长期记忆库中所有已记录的用户偏好与 Agent 执行经验清单(不含已删除/已取代条目)。',
      parameters: { type: 'object', properties: {} },
      execute: async () => {
        const list = listActiveMemories(userId).sort((a, b) => b.updatedAt - a.updatedAt);
        return {
          success: true,
          total: list.length,
          memories: list.map((m) => ({
            id: m.id,
            title: m.title,
            category: m.category,
            subject: m.subject || 'user',
            actionability: m.governance?.actionability || 'fact',
            needsReview: Boolean(m.governance?.reviewFlag),
            updatedAt: new Date(m.updatedAt).toISOString(),
          })),
        };
      },
    },
  ];
}

// ---- 会话结束自动维护(Mem0 式 CRUD 决策环,双通道共用执行内核) ----

/** 从文本中提取第一个 JSON 数组(容忍 ```json 围栏与前后说明文字) */
function parseJsonArray(text: string): any[] | null {
  const stripped = text.replace(/```(?:json)?/g, '').trim();
  const start = stripped.indexOf('[');
  const end = stripped.lastIndexOf(']');
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(stripped.slice(start, end + 1));
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** 取消息的可读文本(string 直返;分片/对象取 JSON;空安全) */
function messageText(content: any): string {
  if (typeof content === 'string') return content;
  if (content == null) return '';
  try {
    return JSON.stringify(content);
  } catch {
    return '';
  }
}

/** 列出某通道的现有记忆(带 id 与保护标记),供决策 prompt 引用 */
function formatExistingBrief(memories: UserMemory[]): string {
  if (memories.length === 0) return '(该通道记忆为空)';
  return memories
    .map(
      (m) =>
        `- id=${m.id} [${m.category}]${isProtectedMemory(m) ? '🔒' : ''} ${m.title}: ${m.content.slice(0, 80)}`
    )
    .join('\n');
}

/**
 * CRUD 决策执行内核(双通道共用):
 * 调模型拿操作数组 → 逐条校验(id 真实存在 / 手动 user-rule 受保护 / add 去重)→ 执行。
 * 通道差异(system 提示词、现有记忆清单、对话/轨迹摘录)由调用方组装。
 */
async function runMemoryDecision(
  ctx: any,
  input: {
    userId: string;
    subject: MemorySubject;
    system: string;
    userMessage: string;
    missionId?: string;
    configOverride?: any;
  }
): Promise<DistillOutcome> {
  const empty: DistillOutcome = { added: [], updated: [], deletedIds: [] };
  const model = ctx?.model;
  if (!model?.invokeStep) return empty;

  let text = '';
  try {
    const result = await model.invokeStep({
      system: input.system,
      messages: [{ role: 'user', content: input.userMessage }],
      disableTools: true,
      configOverride: input.configOverride,
    });
    text = result?.text || '';
  } catch {
    return empty;
  }
  if (!text) return empty;

  const raw = parseJsonArray(text);
  if (!raw) return empty;

  // prompt 只列最近 50 条;计数/去重仍用全量活跃记忆(软删/被取代的不算),
  // 避免超出展示窗口的旧记忆被重复新增
  const allExisting = listActiveMemories(input.userId)
    .slice()
    .sort((a, b) => b.updatedAt - a.updatedAt);
  const subjectExisting = allExisting.filter((m) => (m.subject || 'user') === input.subject).slice(0, DISTILL_EXISTING_LIMIT);

  const validCategories: MemoryCategory[] = ['preference', 'project', 'fact', 'rule'];
  const existingById = new Map(subjectExisting.map((m) => [m.id, m]));
  const existingNorms = allExisting.map((m) => ({
    title: normalizeForDedupe(m.title),
    content: normalizeForDedupe(m.content),
  }));
  const batchNorms: Array<{ title: string; content: string }> = [];
  const outcome: DistillOutcome = { added: [], updated: [], deletedIds: [] };
  const remainingIds = new Set(existingById.keys()); // 前序 op 已删除/更新的 id 防重复操作

  for (const item of raw.slice(0, DISTILL_MAX_OPS)) {
    if (!item || typeof item !== 'object') continue;
    const op = String(item.op || '');

    if (op === 'add') {
      if (allExisting.length + outcome.added.length >= MEMORIES_MAX_TOTAL) continue;
      const title = String(item.title || '').trim().slice(0, 40);
      const content = String(item.content || '').trim().slice(0, 300);
      const category = validCategories.includes(item.category) ? item.category : 'fact';
      if (!title || !content) continue;
      // 可行动性由模型判定、代码侧校验(§3.5:提炼时结构化字段不许丢):
      // 缺省按保守值 fact 处理 —— 只有用户明确委托的持续义务才是 commitment
      const actionability: 'fact' | 'commitment' =
        item.actionability === 'commitment' || category === 'rule' ? 'commitment' : 'fact';

      const normTitle = normalizeForDedupe(title);
      const normContent = normalizeForDedupe(content);
      const duplicate = [...existingNorms, ...batchNorms].some(
        (n) =>
          n.title === normTitle ||
          n.content === normContent ||
          (normTitle.length >= 8 && (n.title.includes(normTitle) || normTitle.includes(n.title)))
      );
      if (duplicate) continue;

      const now = Date.now();
      const record: UserMemory = {
        id: makeMemoryId(),
        title,
        content,
        category,
        confidence: 0.8, // 自动提炼置信度低于手动固化(权威分层)
        updatedAt: now,
        source: 'auto',
        subject: input.subject,
        missionId: input.missionId,
        governance: {
          authority: { grantedBy: 'agent-auto', epoch: 0, protected: false },
          scope: { missionId: undefined },
          mutability: { policy: 'auto-decay', revision: 0 },
          provenance: {
            originMissionId: input.missionId,
            transforms: ['distill'],
          },
          recoverability: {},
          actionability,
        },
      };
      saveUserMemory(input.userId, record);
      appendMemoryAudit(input.userId, {
        at: now,
        actor: 'auto-distill',
        op: 'add',
        memoryId: record.id,
        detail: `[${record.category}/${actionability}] ${record.title}(来源任务 ${input.missionId || '未知'})`,
      });
      batchNorms.push({ title: normTitle, content: normContent });
      outcome.added.push(record);
    } else if (op === 'update') {
      const target = existingById.get(String(item.id || ''));
      if (!target || !remainingIds.has(target.id)) continue;
      if (isProtectedMemory(target)) {
        appendMemoryAudit(input.userId, {
          at: Date.now(),
          actor: 'auto-distill',
          op: 'write-rejected',
          memoryId: target.id,
          detail: `自动流程试图修改受保护条目 [${target.title}],已拦截`,
        });
        continue; // 受保护条目自动流程不可改(I1)
      }
      const content = String(item.content || '').trim().slice(0, 300);
      if (!content) continue;
      const title = String(item.title || target.title).trim().slice(0, 40) || target.title;
      const category = validCategories.includes(item.category) ? item.category : target.category;
      const tg = ensureGovernance(target).governance!;

      // 权威/范围/可行动性只收窄不放宽(I1/I2):update 不许把 fact 升级成
      // commitment、不许改 protected、不许扩 scope —— 需要时走用户手动确认新建
      const wantsCommitment = item.actionability === 'commitment' || category === 'rule';
      const escalationBlocked =
        (wantsCommitment && tg.actionability !== 'commitment') ||
        (category === 'rule' && target.category !== 'rule');
      if (escalationBlocked) {
        appendMemoryAudit(input.userId, {
          at: Date.now(),
          actor: 'auto-distill',
          op: 'write-rejected',
          memoryId: target.id,
          detail: `自动流程试图把事实记忆升级为承诺/红线 [${target.title}],已拦截(需用户手动确认)`,
        });
        continue;
      }

      // UPDATE 不原地覆盖(§3.5 防抹平 + I4 整合保来源):新版本独立成条,
      // 旧条目标记 supersededBy 退出注入但保留可追溯
      const now = Date.now();
      const newId = makeMemoryId();
      const record: UserMemory = {
        id: newId,
        title,
        content,
        category,
        confidence: Math.min(target.confidence ?? 0.8, 0.8), // 自动修订不提升权威
        updatedAt: now,
        source: target.source,
        subject: target.subject,
        missionId: target.missionId,
        hitCount: 0, // 新条目重新接受命中检验(旧条目的 hitCount 不转移)
        governance: {
          authority: { ...tg.authority }, // 权威原样继承(只能收窄,继承即不放宽)
          scope: { ...tg.scope }, // 范围原样继承,禁止借 update 扩大
          mutability: { policy: tg.mutability.policy, revision: tg.mutability.revision + 1 },
          provenance: {
            originMissionId: tg.provenance.originMissionId ?? target.missionId,
            originMemoryIds: [target.id, ...(tg.provenance.originMemoryIds || [])].slice(0, 5),
            transforms: [...tg.provenance.transforms, 'auto-crud'],
          },
          recoverability: {},
          actionability: tg.actionability,
        },
      };
      const superseded: UserMemory = {
        ...target,
        governance: { ...tg, mutability: { ...tg.mutability, supersededBy: newId } },
      };
      saveUserMemory(input.userId, superseded);
      saveUserMemory(input.userId, record);
      appendMemoryAudit(input.userId, {
        at: now,
        actor: 'auto-distill',
        op: 'supersede',
        memoryId: newId,
        detail: `取代 ${target.id}(revision ${tg.mutability.revision} → ${record.governance!.mutability.revision})`,
      });
      remainingIds.delete(target.id); // 旧 id 不再可操作
      outcome.updated.push(record);
    } else if (op === 'delete') {
      const target = existingById.get(String(item.id || ''));
      if (!target || !remainingIds.has(target.id)) continue;
      // 软删除(带台账/传导/审计;protected 拦截在 softDeleteUserMemory 内统一执行)
      const res = softDeleteUserMemory(input.userId, target.id, {
        requestedBy: 'auto',
        reason: '会话末自动维护判定已被推翻',
        actor: 'auto-distill',
      });
      if (!res.ok) continue;
      remainingIds.delete(target.id);
      outcome.deletedIds.push(target.id);
    }
  }
  return outcome;
}

const CRUD_OP_SPEC =
  '输出严格的 JSON 操作数组(最多 5 条,无需任何变更就输出 []),每条:\n' +
  '{"op":"add","title":"简短标题(20字内)","content":"具体内容(150字内)","category":"preference|project|fact|rule","actionability":"fact|commitment"} —— 新的持久事实。\n' +
  '  actionability 判定:只是背景信息/偏好 → "fact";用户明确委托 Agent 持续执行的义务(如「以后每周五自动汇总周报」)→ "commitment"。拿不准就填 "fact"。\n' +
  '{"op":"update","id":"现有记忆id","content":"修正后的完整内容"} —— 新信息与现有记忆矛盾或演进,更新过时表述(系统会以新版本取代旧版本并保留来源链;不允许借 update 把事实升级为承诺/红线或扩大适用范围)\n' +
  '{"op":"delete","id":"现有记忆id"} —— 现有记忆被明确推翻,不再成立(系统执行软删除,保留期内可恢复,并自动处理衍生记忆)\n' +
  '判定原则:\n' +
  '- update/delete 必须有明确依据,不确定时宁可不操作 —— 错误删除比漏记更糟;\n' +
  '- 不要提炼一次性任务细节、临时性内容;\n' +
  '只输出 JSON,不要任何其他文字。';

/**
 * 通道一 —— 用户事实记忆提炼(从用户原话):
 * 蒸馏本轮对话中值得跨会话记住的用户偏好/项目背景/关键事实,并对照现有记忆做维护决策。
 */
export async function distillMissionMemories(
  ctx: any,
  opts: {
    userId: string;
    goal: string;
    messages: Array<{ role: string; content: any }>;
    missionId?: string;
    configOverride?: any;
  }
): Promise<DistillOutcome> {
  // 组装对话摘录:用户原话优先(偏好都在原话里),Agent 最终回复辅助;
  // 历史压缩纪要跳过(是蒸馏产物,重复提炼无信息量)
  const userTexts: string[] = [];
  const assistantTexts: string[] = [];
  for (const m of opts.messages) {
    const text = messageText(m.content).trim();
    if (!text) continue;
    if (m.role === 'user' && !text.startsWith('【历史会话纪要】')) {
      userTexts.push(text.slice(0, 500));
    } else if (m.role === 'assistant' && typeof m.content === 'string') {
      assistantTexts.push(text.slice(0, 800));
    }
  }
  const userChars = userTexts.reduce((acc, t) => acc + t.length, 0);
  if (userChars < 12) return { added: [], updated: [], deletedIds: [] }; // 太短(寒暄),无偏好可提炼

  const transcriptParts = [
    `【任务目标】${opts.goal.slice(0, 200)}`,
    '【用户原话】',
    ...userTexts.map((t) => `- ${t}`),
  ];
  if (assistantTexts.length > 0) {
    transcriptParts.push('【Agent 最终回复(节选)】', ...assistantTexts.slice(-2).map((t) => `- ${t}`));
  }
  let transcript = transcriptParts.join('\n');
  if (transcript.length > DISTILL_TRANSCRIPT_LIMIT) {
    transcript = transcript.slice(0, DISTILL_TRANSCRIPT_LIMIT);
  }

  const subjectExisting = listActiveMemories(opts.userId)
    .filter((m) => (m.subject || 'user') === 'user')
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, DISTILL_EXISTING_LIMIT);
  const protectedNote = subjectExisting.some(isProtectedMemory)
    ? '\n(标注 🔒 的记忆是用户手动固化的执行红线,不可修改或删除)'
    : '';

  return runMemoryDecision(ctx, {
    userId: opts.userId,
    subject: 'user',
    missionId: opts.missionId,
    system:
      '你是用户记忆管理器。对照【现有记忆】与【最新对话】,对用户的长期画像记忆(偏好/背景/约束)执行维护决策。\n' +
      '只维护"关于用户本人"的持久信息:语言/格式偏好、工具与流程习惯、技术栈选型、业务约束、用户纠正过的错误做法。\n' +
      '不要把"Agent 自己学到的环境/工具经验"写进本通道(那属于 Agent 经验通道)。\n' +
      CRUD_OP_SPEC,
    userMessage: `【现有记忆】\n${formatExistingBrief(subjectExisting)}${protectedNote}\n\n【对话记录】\n${transcript}`,
    configOverride: opts.configOverride,
  });
}

/**
 * 通道二 —— Agent 经验记忆提炼(从任务执行轨迹):
 * 把工具调用/结果/失败/熔断/效率统计喂给模型,蒸馏"环境事实、工具用法教训、
 * 有效流程策略",同样走 CRUD 决策维护 agent 通道的现有经验。
 * 触发门槛:轨迹有信息量(工具调用 ≥ AGENT_DISTILL_MIN_TOOL_CALLS,或出现失败/
 * 熔断)—— 纯闲聊任务不跑,省一次模型调用。
 */
export async function distillAgentExperience(
  ctx: any,
  opts: {
    userId: string;
    goal: string;
    mission: {
      id?: string;
      steps?: Array<{ tool?: string; args?: any; output?: any; status?: string; duration?: string; role?: string; answer?: string; title?: string }>;
    };
    efficiency?: { stepsCount?: number; toolCalls?: number; failedCalls?: number; skippedCalls?: number; effectiveRate?: number };
    missionId?: string;
    configOverride?: any;
  }
): Promise<DistillOutcome> {
  const empty: DistillOutcome = { added: [], updated: [], deletedIds: [] };
  const steps = opts.mission?.steps || [];
  const toolSteps = steps.filter((s) => s.tool && s.role !== 'user');
  const failed = (opts.efficiency?.failedCalls || 0) + (opts.efficiency?.skippedCalls || 0);
  // 信息量门槛:足够多的工具调用,或出现过失败/熔断
  if (toolSteps.length < AGENT_DISTILL_MIN_TOOL_CALLS && failed === 0) return empty;

  // 组装轨迹摘录:工具调用与结果(失败优先截断保留),最后附执行统计与最终交付
  const entries: string[] = [];
  for (const s of toolSteps.slice(0, 40)) {
    const argsBrief = (() => {
      try {
        const str = typeof s.args === 'string' ? s.args : JSON.stringify(s.args);
        return str ? ` ${str.slice(0, 150)}` : '';
      } catch {
        return '';
      }
    })();
    const outputBrief = (() => {
      const str = typeof s.output === 'string' ? s.output : messageText(s.output);
      const brief = str ? str.slice(0, 200) : '';
      return s.status === 'FAILED' || /error|失败|异常/i.test(brief) ? ` → 异常: ${brief}` : '';
    })();
    entries.push(`- ${s.tool}${argsBrief} [${s.status || 'DONE'}${s.duration ? ` ${s.duration}` : ''}]${outputBrief}`);
  }
  const eff = opts.efficiency;
  const finalAnswer = [...steps].reverse().find((s) => s.role === 'assistant' && s.answer)?.answer || '';
  const trajectoryParts = [
    `【任务目标】${opts.goal.slice(0, 200)}`,
    '【执行轨迹(工具调用与结果)】',
    ...entries,
    eff
      ? `【执行统计】步数 ${eff.stepsCount ?? '?'} · 工具调用 ${eff.toolCalls ?? toolSteps.length} · 失败 ${eff.failedCalls ?? 0} · 熔断跳过 ${eff.skippedCalls ?? 0} · 有效率 ${Math.round((eff.effectiveRate ?? 1) * 100)}%`
      : `【执行统计】工具调用 ${toolSteps.length} 次`,
  ];
  if (finalAnswer) {
    trajectoryParts.push(`【最终交付(节选)】${finalAnswer.slice(0, 400)}`);
  }
  let transcript = trajectoryParts.join('\n');
  if (transcript.length > DISTILL_TRANSCRIPT_LIMIT) {
    transcript = transcript.slice(0, DISTILL_TRANSCRIPT_LIMIT);
  }

  const subjectExisting = listActiveMemories(opts.userId)
    .filter((m) => m.subject === 'agent')
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, DISTILL_EXISTING_LIMIT);

  return runMemoryDecision(ctx, {
    userId: opts.userId,
    subject: 'agent',
    missionId: opts.missionId || opts.mission?.id,
    system:
      '你是 Agent 经验管理器。对照【现有经验】与【本次任务执行轨迹】,对 Agent 自己的执行经验库执行维护决策。\n' +
      '只维护"关于执行环境与方法"的持久经验,分三类:\n' +
      '- 环境事实(fact):沙箱/系统里装了什么、缺什么,路径与账号约定;\n' +
      '- 工具教训(rule/preference):某工具在某场景的坑与正确用法(如某站点 browser 超时应先 search、某接口要先校验 token);\n' +
      '- 流程策略(project/preference):被验证有效的任务路径(如发布走草稿箱最稳)。\n' +
      '不要把"用户本人的偏好与背景"写进本通道(那属于用户画像通道)。\n' +
      '从失败与绕路中提炼教训优先级最高;成功路径仅在可复用且非显而易见时记录。\n' +
      CRUD_OP_SPEC,
    userMessage: `【现有经验】\n${formatExistingBrief(subjectExisting)}\n\n【本次任务执行轨迹】\n${transcript}`,
    configOverride: opts.configOverride,
  });
}
