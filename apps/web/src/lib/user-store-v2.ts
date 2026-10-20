/**
 * user-store v2 —— 用户上下文目录存储引擎
 * (docs/design/context-store-filesystem-paradigm.md P1)
 *
 * 范式:每用户单 JSON blob → `<dataDir>/v2/<safeUserId>/` 目录,按写入频率与
 * 并发面分域:
 *
 *   profile.json           低频配置域(connectors 密文/mcpAuth/sandbox/纪元/托管开关/
 *                          pushSubscriptions/policyProposals/scenarioProfiles + 未知字段透传)
 *   memories.jsonl         一行一条(治理字段全透传)
 *   skill-cards.jsonl      TRS 技能卡
 *   goals.jsonl            长期目标
 *   cron-jobs.json         巡航任务(低频,整文件)
 *   missions/index.json    任务顺序(有序 key 列表)
 *   missions/<key>.json    每任务一文件 —— 按任务寻址,写不碰他人
 *   deletion-ledger.jsonl  删除台账(治理 I3)
 *   audit/browser.jsonl    浏览器写操作审计(≤200 条滚动)
 *   audit/memory.jsonl     记忆审计(原 <user>.audit.jsonl,懒迁移)
 *   audit/sandbox.jsonl    沙箱审计(原 <user>.sandbox-audit.jsonl,懒迁移)
 *   audit/retrieval.jsonl  检索轨迹(P2:注入/召回的得分明细与入选/落选原因;
 *                          P3 起 Agent 笔记区操作也经此通道审计 kind='agent-note')
 *   agent-notes/           Agent 自管笔记文件区(P3:context_file 工具外部化中间产物,
 *                          总预算/单文件上限/路径锁死由 user-store 笔记 API 强制)
 *
 * 并发保护 = 每对象「读取基线」脏检查:readUserDataV2 把各域序列化快照以不可枚举
 * 属性挂在返回对象上,写路径只重写「相对该对象自己读取时刻有变化」的域 ——
 * user-store 的辅助函数都是同步读改写(天然原子),跨 await 的陈旧对象因此只会
 * 覆盖调用方自己改过的域,不再整 blob last-writer-wins(治理不变量 I5)。
 *
 * 加密收口不变:connectors 逐值 `enc:v1:` 由 user-store.saveUserData 在调用
 * 本模块前完成;本模块只负责布局、脏检查与原子写(tmp + rename)。
 * 开关:AGTPILOT_CONTEXT_STORE_V2=0 整体回退旧单文件路径(v2 目录保留不动)。
 */
import * as fs from 'fs';
import * as path from 'path';
import type { UserScopedData } from './user-store';

// ---- 开关与路径 ----

export function isV2Enabled(): boolean {
  return process.env.AGTPILOT_CONTEXT_STORE_V2 !== '0';
}

/** userId → 安全文件/目录名(与旧单文件同一套转义,保证迁移前后目录对应) */
export function safeName(userId: string): string {
  return userId.replace(/[^a-zA-Z0-9_-]/g, '_');
}

export function userDirV2(dataDir: string, userId: string): string {
  return path.join(dataDir, 'v2', safeName(userId));
}

/** JSONL 数组域 → 相对文件路径(一行一条;整域重写受脏检查约束) */
const JSONL_DOMAINS: Array<{ field: string; file: string }> = [
  { field: 'memories', file: 'memories.jsonl' },
  { field: 'skillCards', file: 'skill-cards.jsonl' },
  { field: 'goals', file: 'goals.jsonl' },
  { field: 'deletionLedger', file: 'deletion-ledger.jsonl' },
  { field: 'browserAudit', file: 'audit/browser.jsonl' },
];

/** 从 blob 剥离的域字段(其余字段全部进 profile.json,含未知字段透传) */
const SPLIT_FIELDS = new Set([...JSONL_DOMAINS.map((d) => d.field), 'missions', 'cronJobs']);

// ---- 读时基线(脏检查基准) ----

/**
 * 每个域在「读取时刻」的序列化快照。readUserDataV2 把它以不可枚举属性
 * __v2Baseline 挂在返回对象上;writeUserDataV2 只重写「相对该对象自己的
 * 读取基线有变化」的域 —— 跨 await 的陈旧对象因此不会回滚并发写入者在
 * 其他域(乃至同域其他任务文件)的变更。无基线(迁移/手工构造)= 全量写。
 */
interface DomainBaseline {
  /** 域文件 → 序列化快照(profile / 各 jsonl / cron-jobs / missions-index) */
  domains: Record<string, string>;
  /** mission key → 序列化快照 */
  missions: Record<string, string>;
}

const BASELINE = '__v2Baseline';

/** 把读取基线从源对象带到副本(saveUserData 的 {...data} 浅拷贝会丢不可枚举属性) */
export function carryBaseline(from: any, to: any): void {
  const b = from?.[BASELINE];
  if (b) Object.defineProperty(to, BASELINE, { value: b, enumerable: false, writable: true, configurable: true });
}

/**
 * 给「盘上尚无任何状态」的默认空对象挂上空盘基线:后续 save 相对它做脏检查,
 * 防止多个持有默认空对象的调用方互相全量覆盖(首个写入者的域被陈旧空值回滚)。
 * profile.json 不进基线 —— 首次保存必然落 profile。
 */
export function attachFreshBaseline(data: any): void {
  const base: DomainBaseline = { domains: {}, missions: {} };
  for (const { field, file } of JSONL_DOMAINS) {
    base.domains[file] = jsonlOf(Array.isArray(data?.[field]) ? data[field] : []);
  }
  base.domains['cron-jobs.json'] = JSON.stringify(data?.cronJobs || []);
  base.domains['missions/index.json'] = JSON.stringify([]);
  Object.defineProperty(data, BASELINE, { value: base, enumerable: false, writable: true, configurable: true });
}


// ---- 原子写与容错读 ----

function writeAtomic(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, content, 'utf-8');
  fs.renameSync(tmp, file);
}

function readJsonSafe(file: string): any {
  try {
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    return null;
  }
}

function readJsonlSafe(file: string): any[] {
  try {
    if (!fs.existsSync(file)) return [];
    return fs
      .readFileSync(file, 'utf-8')
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter((x) => x !== null && typeof x === 'object');
  } catch {
    return [];
  }
}

function jsonlOf(arr: any[]): string {
  return arr.length ? `${arr.map((x) => JSON.stringify(x)).join('\n')}\n` : '';
}

/** mission 存储 key:优先 id;无 id 用序号兜底(与旧数组位置对应) */
function missionKey(m: any, idx: number): string {
  const id = m && typeof m === 'object' && m.id ? String(m.id) : `anon_${idx}`;
  return safeName(id);
}

// ---- 读:目录 → UserScopedData ----

/**
 * profile.json 轻读(只读热路径专用):页面加载/切页签/周期扫描/推送查询
 * 往往只要 profile 里的一个小域(connectors/托管开关/订阅等),不该拖着
 * missions 全量读(每 mission 一文件 + 读基线双重序列化)。
 * 返回 null = v2 目录不存在(调用方回退 getUserData 全量读,顺带触发懒迁移)。
 * 纪律:返回值是无基线、未解密的只读投影,不得交给 saveUserData
 * (缺域对象过脏检查会把没带的域当成「已删空」误删文件)。
 */
export function readProfileV2(dataDir: string, userId: string): any | null {
  const dir = userDirV2(dataDir, userId);
  if (!fs.existsSync(dir)) return null;
  return readJsonSafe(path.join(dir, 'profile.json')) || {};
}

/**
 * 数组域轻读(JSONL 域 + cronJobs;只读热路径专用,约束同 readProfileV2)。
 * 返回 null = v2 目录不存在或字段不支持轻读(missions 走全量路径);
 * 域文件不存在 = 空数组(与全量读语义一致)。
 */
export function readArrayDomainV2(dataDir: string, userId: string, field: string): any[] | null {
  if (field === 'missions') return null;
  const dir = userDirV2(dataDir, userId);
  if (!fs.existsSync(dir)) return null;
  const jsonl = JSONL_DOMAINS.find((d) => d.field === field);
  if (jsonl) return readJsonlSafe(path.join(dir, jsonl.file));
  if (field === 'cronJobs') return readJsonSafe(path.join(dir, 'cron-jobs.json')) || [];
  return null;
}

/**
 * 从 v2 目录组装用户数据;目录不存在返回 null(调用方据此触发懒迁移)。
 * connectors 保持密文原样返回 —— 解密与明文补加密迁移仍由 getUserData 统一收口。
 * 读取同时以不可枚举属性挂上「读取基线」(各域序列化快照),供写路径脏检查:
 * 只重写调用方相对自己读取时刻真正改过的域。
 */
export function readUserDataV2(dataDir: string, userId: string): UserScopedData | null {
  const dir = userDirV2(dataDir, userId);
  if (!fs.existsSync(dir)) return null;
  const base: DomainBaseline = { domains: {}, missions: {} };

  const profile = readJsonSafe(path.join(dir, 'profile.json')) || {};
  base.domains['profile.json'] = JSON.stringify(profile);

  const data: any = { ...profile };
  for (const { field, file } of JSONL_DOMAINS) {
    const arr = readJsonlSafe(path.join(dir, file));
    data[field] = arr;
    base.domains[file] = jsonlOf(arr);
  }
  data.cronJobs = readJsonSafe(path.join(dir, 'cron-jobs.json')) || [];
  base.domains['cron-jobs.json'] = JSON.stringify(data.cronJobs);

  // missions:index.json 定序;索引外孤儿文件(崩溃残留)按更新时间附在尾部
  const missionsDir = path.join(dir, 'missions');
  const missions: any[] = [];
  const seen = new Set<string>();
  const indexRaw = readJsonSafe(path.join(missionsDir, 'index.json'));
  const order: string[] = Array.isArray(indexRaw) ? indexRaw.filter((k) => typeof k === 'string') : [];
  for (const key of order) {
    const m = readJsonSafe(path.join(missionsDir, `${key}.json`));
    if (m && typeof m === 'object') {
      missions.push(m);
      seen.add(key);
      base.missions[key] = JSON.stringify(m);
    }
  }
  if (fs.existsSync(missionsDir)) {
    const orphanKeys = fs
      .readdirSync(missionsDir)
      .filter((f) => f.endsWith('.json') && f !== 'index.json')
      .map((f) => f.replace(/\.json$/, ''))
      .filter((key) => !seen.has(key));
    const orphans: any[] = [];
    for (const key of orphanKeys) {
      const m = readJsonSafe(path.join(missionsDir, `${key}.json`));
      if (m && typeof m === 'object') {
        orphans.push(m);
        base.missions[key] = JSON.stringify(m);
      }
    }
    // 索引序优先;孤儿(崩溃残留)按更新时间排后附尾,不打乱既有顺序
    orphans.sort((a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0));
    missions.push(...orphans);
  }
  data.missions = missions;
  base.domains['missions/index.json'] = JSON.stringify(
    missions.map((m, i) => missionKey(m, i))
  );

  data.userId = typeof profile.userId === 'string' && profile.userId ? profile.userId : userId;
  if (!data.goals) data.goals = [];
  if (!data.memories) data.memories = [];
  data.updatedAt = typeof profile.updatedAt === 'number' ? profile.updatedAt : Date.now();

  Object.defineProperty(data, BASELINE, { value: base, enumerable: false, writable: true, configurable: true });
  return data as UserScopedData;
}

// ---- 写:UserScopedData → 目录(域级脏检查,只重写有变化的域) ----

/**
 * 把用户数据写入 v2 目录。与「该对象自己的读取基线」一致的域跳过重写 ——
 * 陈旧对象不会回滚并发写入者在其他域(乃至其他任务文件)的变更;
 * missions 逐任务比对,只写变化的任务文件。无基线(迁移/手工构造)= 全量写。
 * 写完后把新基线挂回传入对象(重复 save 幂等)。
 */
export function writeUserDataV2(dataDir: string, data: UserScopedData): void {
  const userId = data.userId;
  const dir = userDirV2(dataDir, userId);
  const prev: DomainBaseline | undefined = (data as any)[BASELINE];
  const next: DomainBaseline = { domains: {}, missions: {} };

  // 分域:剥离 JSONL/missions/cronJobs,其余(含未知字段)进 profile
  const profile: any = {};
  for (const [k, v] of Object.entries(data)) {
    if (!SPLIT_FIELDS.has(k)) profile[k] = v;
  }

  /**
   * 域写入:compareSer 用于脏检查(读/写两侧都是「解析后对象的紧凑序列化」,
   * 与盘上是否 pretty 无关);fileSer 是落盘文本(pretty,便于运维查看)。
   * 与基线一致 → 完全不碰盘(陈旧对象不回滚并发写入者的其他域变更)。
   */
  const writeIfChanged = (rel: string, compareSer: string, fileSer: string, emptyMeansDelete: boolean) => {
    next.domains[rel] = compareSer;
    if (prev && prev.domains[rel] === compareSer) return; // 未变 → 不碰盘
    const file = path.join(dir, rel);
    if (emptyMeansDelete && (compareSer === '' || compareSer === '[]')) {
      try {
        if (fs.existsSync(file)) fs.unlinkSync(file);
      } catch {}
      return;
    }
    writeAtomic(file, fileSer);
  };

  const profileSer = JSON.stringify(profile);
  writeIfChanged('profile.json', profileSer, JSON.stringify(profile, null, 2), false);
  for (const { field, file } of JSONL_DOMAINS) {
    const arr = Array.isArray((data as any)[field]) ? (data as any)[field] : [];
    const ser = jsonlOf(arr);
    writeIfChanged(file, ser, ser, true); // JSONL 本体即逐行紧凑序列化
  }
  const cronSer = JSON.stringify(data.cronJobs || []);
  writeIfChanged('cron-jobs.json', cronSer, JSON.stringify(data.cronJobs || [], null, 2), true);

  // missions:逐任务脏检查 + index 定序;被移除的任务文件删除
  const missionsDir = path.join(dir, 'missions');
  const missions = Array.isArray(data.missions) ? data.missions : [];
  const order: string[] = [];
  const usedKeys = new Set<string>();
  missions.forEach((m: any, i: number) => {
    let k = missionKey(m, i);
    while (usedKeys.has(k)) k = `${k}_${i}`; // 同 id 重复条目防文件互覆
    usedKeys.add(k);
    order.push(k);
    const ser = JSON.stringify(m);
    next.missions[k] = ser;
    if (prev && prev.missions[k] === ser) return; // 该任务未变 → 不碰盘
    writeAtomic(path.join(missionsDir, `${k}.json`), JSON.stringify(m, null, 2));
  });
  if (prev) {
    for (const oldKey of Object.keys(prev.missions)) {
      if (!usedKeys.has(oldKey)) {
        try {
          const f = path.join(missionsDir, `${oldKey}.json`);
          if (fs.existsSync(f)) fs.unlinkSync(f);
        } catch {}
      }
    }
  }
  const indexSer = JSON.stringify(order);
  writeIfChanged('missions/index.json', indexSer, JSON.stringify(order, null, 2), true);

  Object.defineProperty(data, BASELINE, { value: next, enumerable: false, writable: true, configurable: true });
}

// ---- 懒迁移:旧单文件/审计 → v2 目录 ----

/**
 * 迁移一个用户到 v2:写目录 → 挪审计文件 → 旧 blob 改名 .bak 归档(可回滚)。
 * legacyData 应为盘上原样(connectors 密文),不要先解密。
 */
export function migrateLegacyUser(dataDir: string, userId: string, legacyData: UserScopedData): void {
  writeUserDataV2(dataDir, legacyData); // legacyData 无基线 → 全量写

  const auditDir = path.join(userDirV2(dataDir, userId), 'audit');
  const relocations: Array<[string, string]> = [
    [`${safeName(userId)}.audit.jsonl`, 'memory.jsonl'],
    [`${safeName(userId)}.sandbox-audit.jsonl`, 'sandbox.jsonl'],
  ];
  for (const [oldName, newName] of relocations) {
    const oldP = path.join(dataDir, oldName);
    const newP = path.join(auditDir, newName);
    try {
      if (fs.existsSync(oldP) && !fs.existsSync(newP)) {
        fs.mkdirSync(auditDir, { recursive: true });
        fs.renameSync(oldP, newP);
      }
    } catch {}
  }

  const legacyPath = path.join(dataDir, `${safeName(userId)}.json`);
  try {
    if (fs.existsSync(legacyPath)) fs.renameSync(legacyPath, `${legacyPath}.bak`);
  } catch {}
}

/**
 * 审计文件路径(v2):懒迁移 —— 新路径不存在且旧路径存在时先挪再用。
 * kind: memory(原 <user>.audit.jsonl)/ sandbox(原 <user>.sandbox-audit.jsonl)/
 * retrieval(检索轨迹,P2 新增,无旧平铺对应,只负责建目录)。
 */
export function auditFilePathV2(dataDir: string, userId: string, kind: 'memory' | 'sandbox' | 'retrieval'): string {
  const p = path.join(userDirV2(dataDir, userId), 'audit', `${kind}.jsonl`);
  const legacyName =
    kind === 'memory'
      ? `${safeName(userId)}.audit.jsonl`
      : kind === 'sandbox'
        ? `${safeName(userId)}.sandbox-audit.jsonl`
        : null;
  try {
    const legacy = legacyName ? path.join(dataDir, legacyName) : null;
    if (legacy && !fs.existsSync(p) && fs.existsSync(legacy)) {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.renameSync(legacy, p);
    } else {
      // appendFileSync 不会建父目录:用户目录可能尚未落过盘(纯审计首写)
      fs.mkdirSync(path.dirname(p), { recursive: true });
    }
  } catch {}
  return p;
}

/**
 * 枚举全部用户 id(v2 目录 + 尚未迁移的旧单文件)。
 * 旧文件用户就地触发懒迁移 —— 启动路径(getAllUsersData 加载 cron)不漏人。
 */
export function listUserIdsV2(dataDir: string): string[] {
  const ids: string[] = [];
  const seenDirs = new Set<string>();
  const v2root = path.join(dataDir, 'v2');
  try {
    if (fs.existsSync(v2root)) {
      for (const entry of fs.readdirSync(v2root)) {
        const dir = path.join(v2root, entry);
        try {
          if (!fs.statSync(dir).isDirectory()) continue;
        } catch {
          continue;
        }
        seenDirs.add(entry);
        const profile = readJsonSafe(path.join(dir, 'profile.json'));
        ids.push(typeof profile?.userId === 'string' && profile.userId ? profile.userId : entry);
      }
    }
  } catch {}
  try {
    if (fs.existsSync(dataDir)) {
      for (const f of fs.readdirSync(dataDir)) {
        if (!f.endsWith('.json')) continue;
        // 非用户文件不参与迁移:根目录还有 _vapid.json(推送密钥)、.开头隐藏文件等
        if (f.startsWith('.') || f.startsWith('_')) continue;
        const safe = f.replace(/\.json$/, '');
        if (seenDirs.has(safe)) continue;
        const raw = readJsonSafe(path.join(dataDir, f));
        if (!raw || typeof raw !== 'object') continue;
        const userId = typeof raw.userId === 'string' && raw.userId ? raw.userId : safe;
        migrateLegacyUser(dataDir, userId, raw as UserScopedData);
        ids.push(userId);
      }
    }
  } catch {}
  return ids;
}
