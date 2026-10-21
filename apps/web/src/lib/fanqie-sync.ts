/**
 * 番茄全自动同步运行器(P2 · docs/design/novel-workshop.md · 服务端专属)
 *
 * 用户拍板(2026-10-16):本地建书 → 自动在番茄开新书;每章入库 → 自动写入
 * 番茄草稿箱;用户只在番茄点发布(发布按钮被引擎围栏代码级永久拦截,本模块
 * 无任何绕过路径)。AI 辅助声明由技能如实代勾(optional 步骤,页面没有就跳过)。
 *
 * 架构要点:
 * - **同步是服务端确定性流程,不经模型**:直接 buildScriptSkillTool().execute,
 *   完整复用引擎守卫管线(参数校验/每日限频/登录门/审计)——与 Agent 调用
 *   同源同池,服务端同步不旁路限频。
 * - **意图先落盘再入队**:book.json.fanqie 是唯一事实源(novel-store 的
 *   updateNovelFanqie 唯一写入口);内存队列只是执行器,进程重启后 sweeper
 *   按落盘意图恢复,不丢同步。
 * - **create 成功但未捕获书号 = 终态 failed,绝不自动重试**(番茄侧可能已建书,
 *   重试即重复建书)→ 引导人工核对后走 bindFanqieBook 手动绑定。
 * - **每用户单 Page 无锁** → 全局并发 1 的 FIFO + 软避让(活跃任务三态/
 *   活跃登录会话)→ 60s 重臂;残余竞态与 /api/browser/login 同姿态。
 * - kill switch:AGTPILOT_FANQIE_SYNC=0 → 只记意图不执行(恢复后 sweeper 排空)。
 *
 * **前提:self-hosted 长活容器**(与 detached mission / cron 调度器同一前提;
 * 不适用 serverless——响应后后台执行没有生命周期保障)。
 */
import {
  loadScriptSkills,
  buildScriptSkillTool,
  scriptSkillsDir,
  type ScriptSkillManifest,
  type ScriptSkillBrowserService,
} from '@agtpilot/plugin-skill';
import { webSkillStore, skillGateAllows } from './script-skills';
import { getFanqieManaged, listUserProfilesLight, getBrowserAudit } from './user-store';
import {
  getNovelBook,
  getChapterContent,
  getPrologueContent,
  listNovelBooks,
  updateNovelFanqie,
  saveFanqieDiagShot,
  type NovelBook,
  type NovelFanqieState,
} from './novel-store';
import { hasActiveLoginSession } from './browser-login';
import { getAgentBackend } from './agent-backend';

// ---- 常量与技能契约 ----

/** 番茄开书技能名(commit 6 部署 fanqie-create.skill.json;缺席时 create 项保持 pending 等待) */
export const CREATE_SKILL = 'fanqie_create_book';
/** 存草稿技能名(已上线的 fanqie-draft.skill.json) */
export const DRAFT_SKILL = 'fanqie_save_chapter_draft';
/** 开书技能 captureUrl 的输出名(captures[fanqieBookId] = 番茄书号) */
export const CAPTURE_KEY = 'fanqieBookId';

/** 章节自动重试上限(sweeper);超过转手动(卡片「重试」仍可显式触发) */
const MAX_CHAPTER_ATTEMPTS = 3;
/** 章节失败自动重试冷却 */
const RETRY_COOLDOWN_MS = 30 * 60_000;
/** 软避让重臂上限:超过后不再空转,交给 15min sweeper */
const MAX_REARMS = 30;

/** 引擎 execute 的会话参数:服务端同步没有 mission,审计里 missionId 恒记
 *  'fanqie-sync' —— 审计页可据此区分「Agent 受令调用」与「后台自动同步」 */
const SYNC_SESSION = { taskId: 'fanqie-sync', step: 0 };

const timing = {
  /** 软避让重臂间隔 */
  rearmMs: 60_000,
  /** sweeper 周期 */
  sweepMs: 15 * 60_000,
};

// ---- 内存队列(全局并发 1 的 FIFO;意图账本在 book.json,这里只是执行器) ----

interface SyncItem {
  userId: string;
  bookId: string;
  kind: 'create' | 'chapter';
  /** kind='chapter' 时的本地章号(0=序章,1 起为正文章节,与账本 key 同源) */
  chapterIndex?: number;
}

const queue: SyncItem[] = [];
let draining = false;
let rearmTimer: ReturnType<typeof setTimeout> | null = null;
let rearmCount = 0;
let sweepTimer: ReturnType<typeof setInterval> | null = null;

function log(...args: unknown[]) {
  console.log('[fanqie-sync]', ...args);
}

function syncKillSwitchOn(): boolean {
  return process.env.AGTPILOT_FANQIE_SYNC === '0';
}

/** 托管门:enabled + 风险确认(与引擎 gate 同一判据,入队前廉价同步检查) */
function fanqieGateOpen(userId: string): boolean {
  const rec = getFanqieManaged(userId);
  return Boolean(rec?.enabled && rec.riskAckAt);
}

function sameItem(a: SyncItem, b: SyncItem): boolean {
  return (
    a.userId === b.userId &&
    a.bookId === b.bookId &&
    a.kind === b.kind &&
    (a.chapterIndex || 0) === (b.chapterIndex || 0)
  );
}

function enqueueItem(item: SyncItem): boolean {
  if (queue.some((q) => sameItem(q, item))) return false;
  queue.push(item);
  return true;
}

// ---- 对外入口(API 路由 / 卡片 / sweeper 调用) ----

/**
 * 建书入库钩子:记「番茄开书」意图(pending 落盘)并入队。
 * 幂等守卫:已有书号 / 已在 pending|creating / 终态 failed(只认显式重试)→ 不重复排。
 * 返回是否记录/确认了意图(kill switch 开启时仍落意图,只是不执行)。
 */
export function maybeEnqueueFanqieBookCreate(userId: string, bookId: string): boolean {
  const book = getNovelBook(userId, bookId);
  if (!book) return false;
  const f = book.fanqie || {};
  if (f.syncEnabled === false) return false;
  if (!fanqieGateOpen(userId)) return false;
  if (f.fanqieBookId) return false; // 映射已建立
  if (f.createStatus === 'failed') return false; // 终态:只认 retryFanqieSync 显式重试
  if (f.createStatus !== 'pending' && f.createStatus !== 'creating') {
    updateNovelFanqie(userId, bookId, { createStatus: 'pending' });
  }
  const added = enqueueItem({ userId, bookId, kind: 'create' });
  if (added) scheduleDrain();
  return true;
}

/**
 * 章节入库钩子(手动 append 与日更 cron 两条路都经 API action=append 走这里):
 * 记「该章存草稿」意图并排队。已 synced/pending 不重复排;failed 交给 sweeper
 * 冷却重试或显式 retry。
 */
export function maybeEnqueueFanqieChapter(userId: string, bookId: string, chapterIndex: number): boolean {
  const book = getNovelBook(userId, bookId);
  if (!book) return false;
  const f = book.fanqie || {};
  if (f.syncEnabled === false) return false;
  if (!fanqieGateOpen(userId)) return false;
  const idx = Math.floor(Number(chapterIndex));
  // idx 0 = 序章(独立槽位,progress 不含它):仅当序章已落库才放行
  if (idx === 0 && !book.prologue) return false;
  if (!Number.isInteger(idx) || idx < 0 || idx > book.progress.chapterCount) return false;
  const rec = f.chapters?.[String(idx)];
  if (rec?.status === 'synced') return false;
  if (rec?.status === 'failed') return false; // 冷却重试是 sweeper 的事,钩子不捞
  if (rec?.status !== 'pending') {
    updateNovelFanqie(userId, bookId, { chapters: { [String(idx)]: { status: 'pending' } } });
  }
  const added = enqueueItem({ userId, bookId, kind: 'chapter', chapterIndex: idx });
  if (added) scheduleDrain();
  return true;
}

/** 书级同步开关(卡片 FanqieSyncRow);重新打开时把落盘意图翻回队列 */
export function setFanqieSyncEnabled(userId: string, bookId: string, enabled: boolean): NovelFanqieState | null {
  const book = getNovelBook(userId, bookId);
  if (!book) return null;
  const updated = updateNovelFanqie(userId, bookId, { syncEnabled: enabled });
  if (enabled) {
    // 有映射:补全账本(关开关期间入库的章没有意图记录,重开即整体翻入);
    // 无映射:先补建书意图 —— 同步功能上线前入库的旧书没有 fanqie 记录,
    // 打开开关即是「开始为这本书建番茄书」(maybeEnqueue 自带幂等/failed 终态守卫),
    // 再捞已落盘意图;缺记录的章等建书成功后统一翻入
    if (updated.fanqie?.fanqieBookId) {
      enqueuePendingChapters(userId, updated);
    } else {
      maybeEnqueueFanqieBookCreate(userId, bookId);
      enqueuePendingWork(userId, bookId);
    }
    scheduleDrain();
  }
  return updated.fanqie || {};
}

/**
 * 显式重试(卡片「重试」按钮):
 * - 带 chapterIndex:该章 failed/pending → 重新排队(立即可试,不等 sweeper 冷却);
 * - 不带:create 终态 failed → 翻回 pending 重排(人工确认番茄侧没建出重复书后点),
 *   并把全部 failed 章节翻回 pending 重排。
 */
export function retryFanqieSync(userId: string, bookId: string, chapterIndex?: number): boolean {
  const book = getNovelBook(userId, bookId);
  if (!book) return false;
  if (book.fanqie?.syncEnabled === false) return false;
  if (!fanqieGateOpen(userId)) return false;

  if (chapterIndex !== undefined) {
    const idx = Math.floor(Number(chapterIndex));
    const rec = book.fanqie?.chapters?.[String(idx)];
    if (!rec || rec.status === 'synced') return false;
    updateNovelFanqie(userId, bookId, { chapters: { [String(idx)]: { ...rec, status: 'pending' } } });
    const added = enqueueItem({ userId, bookId, kind: 'chapter', chapterIndex: idx });
    if (added) scheduleDrain();
    return true;
  }

  let touched = false;
  if (book.fanqie?.createStatus === 'failed' && !book.fanqie?.fanqieBookId) {
    updateNovelFanqie(userId, bookId, (cur) => ({
      createStatus: 'pending',
      createError: undefined,
      createAttempts: (cur.createAttempts || 0),
    }));
    touched = true;
  }
  // 序章账本 key "0"(progress 不含它):显式重试绕过冷却上限,单独翻回 pending
  if (book.prologue && book.fanqie?.chapters?.['0']?.status === 'failed') {
    const rec0 = book.fanqie.chapters['0'];
    updateNovelFanqie(userId, bookId, { chapters: { ['0']: { ...rec0, status: 'pending' } } });
    touched = true;
  }
  for (let i = 1; i <= book.progress.chapterCount; i++) {
    const rec = book.fanqie?.chapters?.[String(i)];
    if (rec?.status === 'failed') {
      updateNovelFanqie(userId, bookId, { chapters: { [String(i)]: { ...rec, status: 'pending' } } });
      touched = true;
    }
  }
  if (touched) {
    enqueuePendingWork(userId, bookId);
    scheduleDrain();
  }
  return touched;
}

/**
 * 手动绑定番茄书号(自动建书失败的逃生门 / 既有番茄书的接入口)。
 * 绑定即视为建书完成:写映射 + created,并把所有未同步章节翻入队列。
 * 书号格式宽松校验(真实格式以 commit 6 侦察为准;拒绝空白与奇怪字符)。
 */
export function bindFanqieBook(userId: string, bookId: string, fanqieBookId: string): { ok: boolean; error?: string } {
  const book = getNovelBook(userId, bookId);
  if (!book) return { ok: false, error: '书不存在' };
  const fid = String(fanqieBookId || '').trim();
  if (!/^[A-Za-z0-9_-]{4,40}$/.test(fid)) {
    return { ok: false, error: '番茄书号格式不符(作品管理页 URL 里 chapter-manage/ 后那一段)' };
  }
  updateNovelFanqie(userId, bookId, {
    fanqieBookId: fid,
    createStatus: 'created',
    createAt: Date.now(),
    createError: undefined,
  });
  enqueuePendingChapters(userId, getNovelBook(userId, bookId) || book);
  scheduleDrain();
  return { ok: true };
}

/** 把一本书所有「未同步」章节(无记录或 pending)落意图并排队(create 成功/绑定后调用)。
 *  序章占账本 key "0"(独立槽位,progress 不含它),排在正文章节之前。 */
function enqueuePendingChapters(userId: string, book: NovelBook): void {
  const patch: NovelFanqieState['chapters'] = {};
  if (book.prologue) {
    const rec0 = book.fanqie?.chapters?.['0'];
    if (rec0?.status !== 'synced' && rec0?.status !== 'failed') {
      if (!rec0) patch['0'] = { status: 'pending' };
      enqueueItem({ userId, bookId: book.bookId, kind: 'chapter', chapterIndex: 0 });
    }
  }
  for (let i = 1; i <= book.progress.chapterCount; i++) {
    const rec = book.fanqie?.chapters?.[String(i)];
    if (rec?.status === 'synced' || rec?.status === 'failed') continue;
    if (!rec) patch[String(i)] = { status: 'pending' };
    enqueueItem({ userId, bookId: book.bookId, kind: 'chapter', chapterIndex: i });
  }
  if (Object.keys(patch).length > 0) updateNovelFanqie(userId, book.bookId, { chapters: patch });
}

/** 重排一本书的全部落盘意图(开关重开 / 显式重试后用;creating 视同 pending——冻账捞回) */
function enqueuePendingWork(userId: string, bookId: string): void {
  const book = getNovelBook(userId, bookId);
  if (!book) return;
  if (
    (book.fanqie?.createStatus === 'pending' || book.fanqie?.createStatus === 'creating') &&
    !book.fanqie?.fanqieBookId
  ) {
    enqueueItem({ userId, bookId, kind: 'create' });
  }
  if (book.prologue && book.fanqie?.chapters?.['0']?.status === 'pending') {
    enqueueItem({ userId, bookId, kind: 'chapter', chapterIndex: 0 });
  }
  for (let i = 1; i <= book.progress.chapterCount; i++) {
    if (book.fanqie?.chapters?.[String(i)]?.status === 'pending') {
      enqueueItem({ userId, bookId, kind: 'chapter', chapterIndex: i });
    }
  }
}

// ---- 软避让(共享每用户单 Page) ----

function isUserBusy(userId: string): boolean {
  if (hasActiveLoginSession(userId)) return true;
  try {
    const backend = getAgentBackend();
    const missions: any[] = (backend?.state as any)?.missions || [];
    return missions.some(
      (m) => m.userId === userId && ['ACTIVE', 'WAITING_APPROVAL', 'QUEUED'].includes(m.status)
    );
  } catch {
    return false; // backend 未初始化(测试/边缘态):不视为忙
  }
}

// ---- 执行 ----

async function acquireBrowser(): Promise<ScriptSkillBrowserService | null> {
  try {
    const backend = getAgentBackend();
    await backend.whenReady();
    return (backend.ctx?.browser as ScriptSkillBrowserService | undefined) || null;
  } catch (err: any) {
    log('浏览器服务未就绪:', err?.message || err);
    return null;
  }
}

function findSkill(name: string): ScriptSkillManifest | null {
  const { skills } = loadScriptSkills(scriptSkillsDir());
  return skills.find((s) => s.name === name) || null;
}

/**
 * not_logged_in 判定:引擎对该情形返回 {success:false, error:<login.hint>}(无结构化码),
 * 但审计落 error='not_logged_in'。全局串行保证了「execute 前后读审计最近条」没有竞态。
 */
function wasNotLoggedIn(userId: string, tool: string, since: number): boolean {
  try {
    return getBrowserAudit(userId, 10).some(
      (e: any) => e.tool === tool && e.error === 'not_logged_in' && Number(e.at) >= since
    );
  } catch {
    return false;
  }
}

const FEMALE_GENRE = /女频|言情|古言|现言|宫斗|宅斗|甜宠|婚恋|大女主/;
/** genre → 番茄频道(enum 闭集,与 fanqie-create 技能 parameters.channel.enum 同源) */
function mapChannel(genre: string): '男频' | '女频' {
  return FEMALE_GENRE.test(String(genre || '')) ? '女频' : '男频';
}

/**
 * 开书参数(技能契约:title/intro/channel;commit 6 侦察 2026-10-16 定稿)。
 * 阅读/内容标签、主角名、封面在建书页均**选填**(标签是服务端 ID 下拉,自动化
 * 脆且无必需价值)→ 不代填,作者可在书信息页自补。书名平台上限 15 字预截断;
 * 简介优先取开书时交付的作品简介(读者向文案,质量优于大纲拼凑),缺省回落
 * premise → 总纲 → 粗纲;平台要求 50-500 字且选填 → 不足 50 字传空串留空,绝不凑字。
 */
function buildCreateArgs(book: NovelBook): Record<string, string> {
  const introSource =
    String(book.synopsis || '').trim() ||
    String(book.premise || '').trim() ||
    String(book.volumeSummary || '').trim() ||
    String(book.outline || '').trim();
  return {
    title: String(book.title || '').slice(0, 15),
    intro: introSource.length >= 50 ? introSource.slice(0, 500) : '',
    channel: mapChannel(book.genre),
  };
}

async function runCreate(item: SyncItem, book: NovelBook): Promise<void> {
  const { userId, bookId } = item;
  if (book.fanqie?.fanqieBookId) return; // 已绑定(可能被手动 bind 抢先)
  if (book.fanqie?.createStatus === 'failed') return; // 终态,只认显式重试
  const skill = findSkill(CREATE_SKILL);
  const browser = skill ? await acquireBrowser() : null;
  if (!skill || !browser || !skillGateAllows(skill, userId)) {
    // 技能未部署 / 浏览器未就绪 / 托管被关:意图保持 pending,sweeper 后续再试(不算失败)
    log(`开书暂缓(${!skill ? '技能未部署' : !browser ? '浏览器未就绪' : '托管门关闭'}): ${book.title}`);
    updateNovelFanqie(userId, bookId, { createStatus: 'pending' });
    return;
  }

  updateNovelFanqie(userId, bookId, { createStatus: 'creating' });
  const tool = buildScriptSkillTool(skill, userId, browser, webSkillStore());
  const t0 = Date.now();
  let result: any;
  try {
    result = await tool.execute(buildCreateArgs(book), SYNC_SESSION);
  } catch (err: any) {
    result = { success: false, error: String(err?.message || err) };
  }

  if (result?.success) {
    const captured = String(result.captures?.[CAPTURE_KEY] || '').trim();
    if (captured) {
      updateNovelFanqie(userId, bookId, {
        fanqieBookId: captured,
        createStatus: 'created',
        createAt: Date.now(),
        createError: undefined,
      });
      log(`番茄开书成功:《${book.title}》→ 书号 ${captured}`);
      // 建书即把已有章节(含开书时带的第1章)翻入草稿队列
      const fresh = getNovelBook(userId, bookId);
      if (fresh) enqueuePendingChapters(userId, fresh);
      scheduleDrain();
    } else {
      // 流程走完但没抓到书号:番茄侧可能已建书 —— 终态 failed,绝不自动重试
      updateNovelFanqie(userId, bookId, (cur) => ({
        createStatus: 'failed',
        createAttempts: (cur.createAttempts || 0) + 1,
        createError: '建书流程已完成但未捕获到番茄书号。为防止重复建书不会自动重试:请到番茄「作品管理」核对是否已建出本书,再用卡片「绑定书号」补映射。',
      }));
      log(`开书未捕获书号(终态,禁自动重试):《${book.title}》`);
    }
    return;
  }

  if (result?.rejected) {
    // 每日限频:保持 pending,次日 sweeper 续传(建书限频与存草稿分池计数)
    updateNovelFanqie(userId, bookId, { createStatus: 'pending' });
    log(`开书限频延后:《${book.title}》`);
    return;
  }

  if (wasNotLoggedIn(userId, CREATE_SKILL, t0)) {
    updateNovelFanqie(userId, bookId, {
      createStatus: 'failed',
      createError: '番茄登录态失效:请到「连接器 → 番茄作者后台」重新扫码登录后,在卡片点「重试同步」。',
    });
    failUserQueue(userId, '番茄登录态失效,同步已暂停;请重新扫码登录后点「重试同步」。');
    return;
  }

  // 其余失败(页面改版/超时等):create 一律终态 failed —— 无法区分「提交前失败」与
  // 「已提交但流程断」,自动重试有重复建书风险;显式重试是用户的判断。
  // 失败现场照(executor 抛错前补拍)落盘书目录,createError 带上路径便于排障。
  const shot = saveFanqieDiagShot(userId, bookId, 'create', result?.screenshotBase64);
  updateNovelFanqie(userId, bookId, (cur) => ({
    createStatus: 'failed',
    createAttempts: (cur.createAttempts || 0) + 1,
    createError: String(result?.error || '未知错误').slice(0, 300) + (shot ? `(现场照:${shot})` : ''),
  }));
  log(`开书失败(终态,需显式重试):《${book.title}》 ${result?.error || ''}${shot ? ` [${shot}]` : ''}`);
}

async function runChapter(item: SyncItem, book: NovelBook): Promise<void> {
  const { userId, bookId } = item;
  const idx = item.chapterIndex!;
  const key = String(idx);
  const f = book.fanqie || {};
  if (f.chapters?.[key]?.status === 'synced') return; // 幂等
  const label = idx === 0 ? '序章' : `第${idx}章`; // idx 0 = 序章(账本 key "0",独立槽位)

  const fid = f.fanqieBookId;
  if (!fid) {
    // 映射未建立:create 在排队/进行中 → 保持 pending(create 成功会重排);
    // create 终态 failed / 从未排 → 同样保持 pending 等绑定(sweeper 会周期重排)
    log(`${label}暂缓(番茄书号未建立):《${book.title}》`);
    return;
  }

  const skill = findSkill(DRAFT_SKILL);
  const browser = skill ? await acquireBrowser() : null;
  if (!skill || !browser || !skillGateAllows(skill, userId)) {
    log(`${label}暂缓(${!skill ? '技能未部署' : !browser ? '浏览器未就绪' : '托管门关闭'}):《${book.title}》`);
    return; // 保持 pending
  }

  // 序章正文走 prologue.md,标题取序章元数据(原样,不拼「第N章」);不落 chapters 索引
  const content = idx === 0 ? getPrologueContent(userId, bookId) : getChapterContent(userId, bookId, idx);
  let title: string;
  if (idx === 0) {
    title = String(book.prologue?.title || '').trim() || '序章';
  } else {
    // 番茄草稿标题只传章名本体(生产实测 2026-10-21:编辑器标题行前面的「第N章」
    // 是平台按目录位置自动编的固定序号,删不掉;标题里再带序号会显示成
    // 「第2章 第1章 章名」双编号)。章名可能自带「第N章」前缀(模型章头余文/
    // 正文首行原样入库)且自称序号可能与书库漂移 —— 一律剥掉只留本体;
    // 无章名回落「未命名」(技能要求标题非空)。
    const rawTitle = String(book.chapters[idx - 1]?.title || '').trim();
    title = rawTitle.replace(/^第\s*[0-9]+\s*章\s*/, '').trim() || '未命名';
  }
  if (!content || !content.trim()) {
    updateNovelFanqie(userId, bookId, {
      chapters: { [key]: { status: 'failed', error: '本地章节正文缺失,无法同步', at: Date.now() } },
    });
    return;
  }

  const tool = buildScriptSkillTool(skill, userId, browser, webSkillStore());
  const t0 = Date.now();
  let result: any;
  try {
    result = await tool.execute({ bookId: fid, title, body: content }, SYNC_SESSION);
  } catch (err: any) {
    result = { success: false, error: String(err?.message || err) };
  }

  if (result?.success) {
    updateNovelFanqie(userId, bookId, {
      chapters: { [key]: { status: 'synced', at: Date.now() } },
    });
    log(`${label}已存番茄草稿:《${book.title}》`);
    return;
  }
  if (result?.rejected) {
    log(`${label}限频延后(今日额度已尽,明日自动续传):《${book.title}》`);
    return; // 保持 pending
  }
  if (wasNotLoggedIn(userId, DRAFT_SKILL, t0)) {
    updateNovelFanqie(userId, bookId, {
      chapters: { [key]: { status: 'failed', error: '番茄登录态失效,请重新扫码登录后重试', at: Date.now() } },
    });
    failUserQueue(userId, '番茄登录态失效,同步已暂停;请重新扫码登录后点「重试同步」。');
    return;
  }
  const prev = f.chapters?.[key];
  const chShot = saveFanqieDiagShot(userId, bookId, `chapter-${idx}`, result?.screenshotBase64);
  updateNovelFanqie(userId, bookId, {
    chapters: {
      [key]: {
        status: 'failed',
        attempts: (prev?.attempts || 0) + 1,
        error: String(result?.error || '未知错误').slice(0, 300) + (chShot ? `(现场照:${chShot})` : ''),
        at: Date.now(),
      },
    },
  });
  log(`${label}同步失败:《${book.title}》 ${result?.error || ''}${chShot ? ` [${chShot}]` : ''}`);
}

/** 登录失效连坐:该用户剩余队列项全部落 failed 账本并出队(本轮不再碰该用户) */
function failUserQueue(userId: string, error: string): void {
  for (let i = queue.length - 1; i >= 0; i--) {
    const it = queue[i];
    if (it.userId !== userId) continue;
    queue.splice(i, 1);
    try {
      if (it.kind === 'create') {
        updateNovelFanqie(userId, it.bookId, { createStatus: 'failed', createError: error });
      } else {
        updateNovelFanqie(userId, it.bookId, {
          chapters: { [String(it.chapterIndex)]: { status: 'failed', error, at: Date.now() } },
        });
      }
    } catch {}
  }
}

async function runItem(item: SyncItem): Promise<void> {
  const book = getNovelBook(item.userId, item.bookId);
  if (!book) return; // 书已删除:意图随之消失
  if (book.fanqie?.syncEnabled === false) return; // 出队瞬间用户关了开关
  if (item.kind === 'create') await runCreate(item, book);
  else await runChapter(item, book);
}

// ---- drain(全局并发 1) ----

function scheduleDrain(): void {
  ensureFanqieSyncSweeper(); // 懒启动 sweeper(正常由 instrumentation 启动,双保险)
  if (draining) return;
  draining = true;
  void (async () => {
    try {
      await drainLoop();
    } catch (err: any) {
      log('drain 异常:', err?.message || err);
    } finally {
      draining = false;
      // 收尾竞态兜底:drain 空转返回的微任务还没落地时,新入队(如显式重试)的
      // scheduleDrain 会被上面 draining 门挡掉——这里补排,不靠 sweeper 周期兜底。
      // rearmTimer 在飞时不抢(定时器会自己续排);kill switch 开着不热转(恢复后 sweeper 排空)。
      if (!syncKillSwitchOn() && queue.length > 0 && !rearmTimer) scheduleDrain();
    }
  })();
}

async function drainLoop(): Promise<void> {
  for (;;) {
    if (syncKillSwitchOn()) return; // kill switch:队列与账本原样保留,恢复后 sweeper 排空
    if (queue.length === 0) return;
    const item = queue[0];
    if (isUserBusy(item.userId)) {
      rearm();
      return;
    }
    queue.shift();
    rearmCount = 0;
    try {
      await runItem(item);
    } catch (err: any) {
      log(`执行异常(${item.kind} ${item.bookId}#${item.chapterIndex || ''}):`, err?.message || err);
    }
  }
}

function rearm(): void {
  if (rearmTimer) return;
  if (rearmCount >= MAX_REARMS) {
    log('软避让重臂达上限,交给 sweeper 周期续传');
    return;
  }
  rearmCount++;
  rearmTimer = setTimeout(() => {
    rearmTimer = null;
    scheduleDrain();
  }, timing.rearmMs);
  rearmTimer.unref?.();
}

// ---- sweeper(15min:重启恢复 / 限频跨天续传 / 失败冷却重试) ----

let sweepStarted = false;

/** 启动周期 sweeper(instrumentation.ts register() 调用;重复调用无副作用) */
export function ensureFanqieSyncSweeper(): void {
  if (sweepStarted) return;
  sweepStarted = true;
  sweepTimer = setInterval(() => {
    try {
      runFanqieSyncSweep();
    } catch (err: any) {
      log('sweep 异常:', err?.message || err);
    }
  }, timing.sweepMs);
  sweepTimer.unref?.();
  log(`sweeper 已启动(${Math.round(timing.sweepMs / 60000)}min 周期)`);
}

/**
 * 扫描全部开启番茄托管的用户,把 book.json 里的落盘意图翻回队列:
 * - createStatus pending → 重排 create(failed 是终态,绝不自动重排);
 * - 章节 pending → 重排;章节 failed(attempts<3 且距上次 >30min)→ 冷却重试。
 * userIds 参数仅测试注入;缺省走 listUserProfilesLight() 全员档案轻扫描 ——
 * fanqieManaged 开关在 profile.json 里,不该为它把所有用户的 mission 全量读一遍。
 */
export function runFanqieSyncSweep(userIds?: string[]): { enqueued: number } {
  if (syncKillSwitchOn()) return { enqueued: 0 };
  const users =
    userIds ||
    listUserProfilesLight()
      .filter((u) => u.profile.fanqieManaged?.enabled && u.profile.fanqieManaged?.riskAckAt)
      .map((u) => u.userId);
  let enqueued = 0;
  for (const userId of users) {
    if (!fanqieGateOpen(userId)) continue;
    for (const sum of listNovelBooks(userId)) {
      const book = getNovelBook(userId, sum.bookId);
      if (!book) continue;
      const f = book.fanqie;
      if (!f || f.syncEnabled === false) continue;
      // pending 重排;creating 也重排 —— 进程在执行中途死掉会把 creating 冻在账本里,
      // 只有 sweep 能捞回来。与在飞执行撞车是安全的:runCreate 对「已有书号/已终态」
      // 有幂等早退,重复项只多读一次 book.json。
      if ((f.createStatus === 'pending' || f.createStatus === 'creating') && !f.fanqieBookId) {
        if (enqueueItem({ userId, bookId: book.bookId, kind: 'create' })) enqueued++;
      }
      // 序章账本 key "0"(progress 不含它):pending / 冷却到点的 failed 都要捞,
      // 排在正文章节之前保证平台目录顺序
      if (book.prologue) {
        const rec0 = f.chapters?.['0'];
        if (rec0) {
          const retryDue0 =
            rec0.status === 'failed' &&
            (rec0.attempts || 0) < MAX_CHAPTER_ATTEMPTS &&
            Date.now() - (rec0.at || 0) > RETRY_COOLDOWN_MS;
          if (rec0.status === 'pending' || retryDue0) {
            if (enqueueItem({ userId, bookId: book.bookId, kind: 'chapter', chapterIndex: 0 })) enqueued++;
          }
        }
      }
      for (let i = 1; i <= book.progress.chapterCount; i++) {
        const rec = f.chapters?.[String(i)];
        if (!rec) continue; // 无意图记录的章不自动补(建书成功/绑定时会整体翻入)
        const retryDue =
          rec.status === 'failed' &&
          (rec.attempts || 0) < MAX_CHAPTER_ATTEMPTS &&
          Date.now() - (rec.at || 0) > RETRY_COOLDOWN_MS;
        if (rec.status === 'pending' || retryDue) {
          if (enqueueItem({ userId, bookId: book.bookId, kind: 'chapter', chapterIndex: i })) enqueued++;
        }
      }
    }
  }
  if (enqueued > 0) log(`sweep 重排 ${enqueued} 项`);
  // 恒触发 drain:kill switch 恢复后,开关期间滞留的旧队列项全靠这里重启
  // (dedup 会让 enqueued=0,但队列非空);队列空时 drainLoop 立即返回,无成本
  scheduleDrain();
  return { enqueued };
}

// ---- 测试钩子(生产代码不得调用) ----

export const __fanqieSyncTest = {
  setTiming(t: { rearmMs?: number; sweepMs?: number }) {
    if (t.rearmMs !== undefined) timing.rearmMs = t.rearmMs;
    if (t.sweepMs !== undefined) timing.sweepMs = t.sweepMs;
  },
  snapshot(): { queue: SyncItem[]; draining: boolean } {
    return { queue: [...queue], draining };
  },
  reset() {
    queue.length = 0;
    draining = false;
    rearmCount = 0;
    if (rearmTimer) clearTimeout(rearmTimer);
    rearmTimer = null;
    if (sweepTimer) clearInterval(sweepTimer);
    sweepTimer = null;
    sweepStarted = false;
  },
  /** 自旋等 drain 排空(队列空且不在执行中;rearm 等待中视为未排空) */
  async waitIdle(timeoutMs = 3000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!draining && queue.length === 0 && !rearmTimer) return;
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error(`fanqie-sync 未排空: queue=${JSON.stringify(queue)} draining=${draining}`);
  },
};
