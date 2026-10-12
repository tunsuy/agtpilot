/**
 * TRS 技能卡(Skill Cards)—— 任务轨迹蒸馏出的结构化可复用技能
 *
 * 来源:TRS(Trajectory-distilled Reusable Skills)论文的技能卡机制。
 * 与 memory-service 的 Agent 经验通道(自由文本条目)互补:技能卡是
 * 【结构化五字段】卡片,专为"重复形态任务"(工坊类:小红书/知乎/公众号/
 * AI Builders 日报等)沉淀可直接照做的操作程序:
 *
 * - Trigger  适用场景:什么任务形态该用这张卡;
 * - Do       核心步骤:被验证有效的操作程序(命令式要点);
 * - Avoid    反模式:踩过的坑 → 正确做法(失败教训优先级最高);
 * - Check    必验约束:宣告完成前逐项核验的清单;
 * - Risk     边界:什么情况下卡片不适用/可能失效。
 *
 * 生命周期(全部旁路执行,失败静默,不影响任务交付):
 * 1. 蒸馏:任务结束(成功或失败——失败轨迹正是 Avoid/Check 的最好素材)且
 *    轨迹有信息量时,把执行轨迹喂给模型蒸馏至多 2 张卡,按 trigger 去重合并
 *    进用户空间的卡片库(user-store data.skillCards,零迁移透传);
 * 2. 检索注入:任务开始时按卡片 keywords/trigger 与任务目标做关键词匹配
 *    (CJK 子串 + 分词命中,复用 memory-service 的 tokenize),取 top-k 且
 *    总预算封顶,附「仅采用直接适用技能」门控指令注入 system prompt ——
 *    任务内前缀稳定(同 missingKeyNote 模式),不破 DeepSeek/OpenAI 自动前缀缓存;
 * 3. 命中反馈:被注入即累计 hitCount,超量淘汰时高频卡优先保留。
 *
 * 经济学(TRS 的核心论点):蒸馏与注入增加的是便宜的输入 tokens 与一次
 * 任务末的小调用,省下的是未来同类任务里昂贵的试错输出 tokens 与重复踩坑。
 *
 * 开关:AGTPILOT_SKILL_CARDS=0 整体关闭;受 AGTPILOT_AUTO_MEMORY=0 总闸约束
 * (自动记忆总开关关闭时蒸馏也不跑)。
 */
import { getUserData, saveUserData, appendMemoryAudit } from './user-store';
import { tokenize } from './memory-service';

export interface SkillCard {
  id: string;
  /** Trigger:何种任务形态适用本卡 */
  trigger: string;
  /** Do:被验证有效的核心操作步骤 */
  steps: string;
  /** Avoid:反模式(踩过的坑 → 正确做法) */
  avoid?: string;
  /** Check:完成前必验约束 */
  check?: string;
  /** Risk:边界条件与失败模式 */
  risk?: string;
  /** 检索关键词(与未来任务目标做匹配) */
  keywords: string[];
  createdAt: number;
  updatedAt: number;
  /** 蒸馏来源任务(情景锚点) */
  sourceMissionId?: string;
  /** 被注入命中的累计次数 */
  hitCount?: number;
  lastHitAt?: number;
}

/** 蒸馏产物候选卡(入库前的形状,id/时间戳由存储层补) */
export type SkillCardCandidate = Omit<SkillCard, 'id' | 'createdAt' | 'updatedAt' | 'hitCount' | 'lastHitAt'>;

export interface SkillDistillOutcome {
  added: SkillCard[];
  updated: SkillCard[];
}

// ---- 可调参数 ----
/** 单用户卡片库总量上限(超出按 hitCount/updatedAt 淘汰) */
export const SKILL_CARDS_MAX = 40;
/** 单次任务蒸馏至多产出的卡片数(宁缺毋滥) */
const SKILL_DISTILL_MAX_CARDS = 2;
/** 注入的卡片条数上限(top-k) */
const SKILL_INJECT_MAX_ITEMS = 3;
/** 注入的卡片总字符预算(封顶,不破前缀之外的成本) */
const SKILL_INJECT_MAX_CHARS = 1200;
/** 注入门槛分:低于该分视为"不直接适用",不注入(检索层的门控) */
const SKILL_MIN_MATCH_SCORE = 2;
/** 蒸馏信息量门槛:工具调用达到该数(或出现失败/熔断)才跑 */
const DISTILL_MIN_TOOL_CALLS = 3;
/** 蒸馏喂给模型的轨迹摘录总字符上限 */
const DISTILL_TRAJECTORY_LIMIT = 6000;
/** 五字段各自的长度上限(结构化字段不许无限膨胀) */
const FIELD_LIMITS = { trigger: 80, steps: 400, avoid: 200, check: 200, risk: 200 } as const;
/** 关键词个数与单个长度上限 */
const KEYWORDS_MAX = 20;
const KEYWORD_LEN_MAX = 24;

/** 技能卡开关:AGTPILOT_SKILL_CARDS=0 关闭 */
export function isSkillCardsEnabled(): boolean {
  return process.env.AGTPILOT_SKILL_CARDS !== '0';
}

// ---- 解析与归一化(纯函数,便于契约测试) ----

/** 从模型输出提取第一个 JSON 数组(容忍 ```json 围栏与前后说明文字) */
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

function capField(v: unknown, max: number): string {
  return String(v ?? '').trim().slice(0, max);
}

/** trigger 归一化(去重键):小写 + 去空白 */
function normalizeTriggerKey(s: string): string {
  return s.toLowerCase().replace(/\s+/g, '');
}

/**
 * 归一化单张候选卡:trigger/steps 必填,其余可选;字段截断到上限;
 * keywords 缺失时从 trigger 分词兜底派生。不合格返回 null。
 */
export function normalizeSkillCard(raw: any): SkillCardCandidate | null {
  if (!raw || typeof raw !== 'object') return null;
  const trigger = capField(raw.trigger, FIELD_LIMITS.trigger);
  const steps = capField(raw.steps ?? raw.do, FIELD_LIMITS.steps);
  if (!trigger || !steps) return null;
  const avoid = capField(raw.avoid, FIELD_LIMITS.avoid) || undefined;
  const check = capField(raw.check, FIELD_LIMITS.check) || undefined;
  const risk = capField(raw.risk, FIELD_LIMITS.risk) || undefined;
  let keywords = Array.isArray(raw.keywords)
    ? raw.keywords
        .map((k: any) => String(k ?? '').trim().slice(0, KEYWORD_LEN_MAX))
        .filter(Boolean)
        .slice(0, KEYWORDS_MAX)
    : [];
  if (keywords.length === 0) {
    // 兜底:从 trigger 派生检索词(CJK bigram + 拉丁词),保证卡片可被召回
    keywords = Array.from(new Set(tokenize(trigger))).slice(0, 10);
  }
  return { trigger, steps, avoid, check, risk, keywords };
}

/** 解析模型蒸馏输出:JSON 数组 → 合格候选卡(至多 SKILL_DISTILL_MAX_CARDS 张) */
export function parseSkillCards(text: string): SkillCardCandidate[] {
  const raw = parseJsonArray(text || '');
  if (!raw) return [];
  const cards: SkillCardCandidate[] = [];
  for (const item of raw) {
    if (cards.length >= SKILL_DISTILL_MAX_CARDS) break;
    const c = normalizeSkillCard(item);
    if (c) cards.push(c);
  }
  return cards;
}

// ---- 存储(user-store data.skillCards,零迁移透传) ----

function isStoredCard(x: any): x is SkillCard {
  return (
    x && typeof x === 'object' &&
    typeof x.id === 'string' &&
    typeof x.trigger === 'string' && x.trigger.length > 0 &&
    typeof x.steps === 'string' && x.steps.length > 0 &&
    Array.isArray(x.keywords)
  );
}

/** 读取用户卡片库(过滤损坏条目;不落盘) */
export function listSkillCards(userId: string): SkillCard[] {
  try {
    const data = getUserData(userId);
    const raw = Array.isArray((data as any).skillCards) ? (data as any).skillCards : [];
    return raw.filter(isStoredCard);
  } catch {
    return [];
  }
}

/**
 * 候选卡入库(按 trigger 归一化去重):
 * - 同 trigger 已存在 → 原位更新(steps 以新为准,可选字段新值覆盖旧值,
 *   keywords 并集截断),保留 id/createdAt/hitCount;
 * - 新 trigger → 追加;
 * - 超过 SKILL_CARDS_MAX → 淘汰(hitCount 低且 updatedAt 旧的先走)。
 * 每次落库写记忆审计(op=add/update,detail 注明技能卡)。
 */
export function upsertSkillCards(
  userId: string,
  candidates: Array<SkillCardCandidate & { sourceMissionId?: string }>
): SkillDistillOutcome {
  const outcome: SkillDistillOutcome = { added: [], updated: [] };
  if (candidates.length === 0) return outcome;
  const data = getUserData(userId);
  let cards: SkillCard[] = (Array.isArray((data as any).skillCards) ? (data as any).skillCards : []).filter(isStoredCard);
  const now = Date.now();

  for (const cand of candidates) {
    const key = normalizeTriggerKey(cand.trigger);
    const idx = cards.findIndex((c) => normalizeTriggerKey(c.trigger) === key);
    if (idx >= 0) {
      const prev = cards[idx];
      const merged: SkillCard = {
        ...prev,
        steps: cand.steps,
        avoid: cand.avoid ?? prev.avoid,
        check: cand.check ?? prev.check,
        risk: cand.risk ?? prev.risk,
        keywords: Array.from(new Set([...(prev.keywords || []), ...cand.keywords])).slice(0, KEYWORDS_MAX),
        updatedAt: now,
        sourceMissionId: cand.sourceMissionId ?? prev.sourceMissionId,
      };
      cards[idx] = merged;
      outcome.updated.push(merged);
    } else {
      const card: SkillCard = {
        id: `skill_${now}_${Math.random().toString(36).slice(2, 6)}`,
        ...cand,
        createdAt: now,
        updatedAt: now,
      };
      cards.push(card);
      outcome.added.push(card);
    }
  }

  if (cards.length > SKILL_CARDS_MAX) {
    // 淘汰策略:高频命中优先保留,其次最近更新;排序后截断
    cards = cards
      .slice()
      .sort(
        (a, b) =>
          (b.hitCount || 0) - (a.hitCount || 0) ||
          b.updatedAt - a.updatedAt
      )
      .slice(0, SKILL_CARDS_MAX);
  }

  (data as any).skillCards = cards;
  saveUserData(data);

  for (const c of outcome.added) {
    appendMemoryAudit(userId, {
      at: now,
      actor: 'auto-distill',
      op: 'add',
      memoryId: c.id,
      detail: `技能卡 [${c.trigger}]${c.sourceMissionId ? `(来源任务 ${c.sourceMissionId})` : ''}`,
    });
  }
  for (const c of outcome.updated) {
    appendMemoryAudit(userId, {
      at: now,
      actor: 'auto-distill',
      op: 'update',
      memoryId: c.id,
      detail: `技能卡按 trigger 合并更新 [${c.trigger}]`,
    });
  }
  return outcome;
}

// ---- 检索与注入(纯函数 + 命中反馈) ----

/**
 * 卡片与任务目标的匹配分:
 * - keyword 作为子串直接命中目标文本 → +2(确定性信号);
 * - keyword 分词后全部 token 命中目标分词(CJK bigram 覆盖换说法)→ +1;
 * - trigger 分词与目标分词每重叠一个 → +0.5(弱信号,兜底)。
 */
export function scoreSkillCard(card: SkillCard, goal: string): number {
  const gl = goal.toLowerCase();
  const goalTokens = new Set(tokenize(goal));
  if (goalTokens.size === 0) return 0;
  let score = 0;
  for (const kw of card.keywords || []) {
    const k = String(kw).trim().toLowerCase();
    if (!k) continue;
    if (gl.includes(k)) {
      score += 2;
      continue;
    }
    const kTokens = tokenize(k);
    if (kTokens.length > 0 && kTokens.every((t) => goalTokens.has(t))) score += 1;
  }
  for (const t of new Set(tokenize(card.trigger))) {
    if (goalTokens.has(t)) score += 0.5;
  }
  return score;
}

/** 渲染单卡为注入文本(五字段竖排,可选字段缺失不占行) */
export function renderSkillCard(c: SkillCard): string {
  const lines = [`◆ Trigger(适用): ${c.trigger}`, `  Do(步骤): ${c.steps}`];
  if (c.avoid) lines.push(`  Avoid(反模式): ${c.avoid}`);
  if (c.check) lines.push(`  Check(必验): ${c.check}`);
  if (c.risk) lines.push(`  Risk(边界): ${c.risk}`);
  return lines.join('\n');
}

/**
 * 按任务目标选卡:达标分过滤(不直接适用的不注入)→ 分数排序 →
 * top-k + 总字符预算封顶。
 */
export function selectSkillCards(
  cards: SkillCard[],
  goal: string,
  opts: { maxItems?: number; maxChars?: number; minScore?: number } = {}
): SkillCard[] {
  const maxItems = opts.maxItems ?? SKILL_INJECT_MAX_ITEMS;
  const maxChars = opts.maxChars ?? SKILL_INJECT_MAX_CHARS;
  const minScore = opts.minScore ?? SKILL_MIN_MATCH_SCORE;
  const scored = cards
    .map((c) => ({ c, s: scoreSkillCard(c, goal) }))
    .filter((x) => x.s >= minScore)
    .sort((a, b) => b.s - a.s || b.c.updatedAt - a.c.updatedAt);
  const out: SkillCard[] = [];
  let used = 0;
  for (const { c } of scored) {
    if (out.length >= maxItems) break;
    const cost = renderSkillCard(c).length;
    if (used + cost > maxChars) continue;
    out.push(c);
    used += cost;
  }
  return out;
}

/** 记录一批卡片被注入命中(hitCount/lastHitAt,单次合并写盘;失败静默) */
export function noteSkillCardHits(userId: string, ids: string[]): void {
  if (ids.length === 0) return;
  try {
    const data = getUserData(userId);
    const idSet = new Set(ids);
    let touched = false;
    (data as any).skillCards = ((data as any).skillCards || []).map((c: any) => {
      if (idSet.has(c?.id)) {
        touched = true;
        return { ...c, hitCount: (c.hitCount || 0) + 1, lastHitAt: Date.now() };
      }
      return c;
    });
    if (touched) saveUserData(data);
  } catch {
    // 命中统计失败不影响主流程
  }
}

/**
 * 构建 system prompt 技能卡注入块(任务开始时调用一次,任务内前缀稳定):
 * 检索 top-k 直接适用卡 + 「仅采用直接适用技能」门控指令;无达标卡返回空串。
 * 副作用:被注入的卡片累计一次命中。
 */
export function buildSkillCardsBlock(userId: string, goal: string): string {
  if (!isSkillCardsEnabled()) return '';
  const cards = listSkillCards(userId);
  if (cards.length === 0) return '';
  const selected = selectSkillCards(cards, goal);
  if (selected.length === 0) return '';
  noteSkillCardHits(userId, selected.map((c) => c.id));
  return [
    '【技能卡(过往任务轨迹蒸馏的可复用程序与教训,五字段 Trigger/Do/Avoid/Check/Risk)】:',
    '使用规则:仅采用与当前任务直接适用的技能卡 —— 执行时遵循 Do、主动绕开 Avoid、宣告完成前逐项核对 Check;卡片与当前任务无关、或与用户本次指示冲突时,一律忽略卡片,以用户指示为准。',
    ...selected.map(renderSkillCard),
  ].join('\n');
}

// ---- 任务末蒸馏 ----

/** 取消息的可读文本(与 memory-service 同型;string 直返,其余 JSON 化) */
function messageText(content: any): string {
  if (typeof content === 'string') return content;
  if (content == null) return '';
  try {
    return JSON.stringify(content);
  } catch {
    return '';
  }
}

/**
 * 组装轨迹摘录(与 distillAgentExperience 同型裁剪):工具调用与结果
 * (失败优先保留异常摘要)+ 执行统计 + 任务结果 + 最终交付节选,总量封顶。
 */
export function buildTrajectoryDigest(opts: {
  goal: string;
  taskSucceeded: boolean;
  mission: { steps?: Array<{ tool?: string; args?: any; output?: any; status?: string; duration?: string; role?: string; answer?: string }> };
  efficiency?: { stepsCount?: number; toolCalls?: number; failedCalls?: number; skippedCalls?: number; effectiveRate?: number };
}): string {
  const steps = opts.mission?.steps || [];
  const toolSteps = steps.filter((s) => s.tool && s.role !== 'user');
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
  const finalAnswer = [...steps].reverse().find((s) => s.role === 'assistant' && (s as any).answer)?.answer || '';
  const parts = [
    `【任务目标】${opts.goal.slice(0, 200)}`,
    `【任务结果】${opts.taskSucceeded ? '成功交付' : '失败(失败轨迹中的坑正是 Avoid/Check 字段的最好素材,请重点提炼)'}`,
    '【执行轨迹(工具调用与结果)】',
    ...entries,
    eff
      ? `【执行统计】步数 ${eff.stepsCount ?? '?'} · 工具调用 ${eff.toolCalls ?? toolSteps.length} · 失败 ${eff.failedCalls ?? 0} · 熔断跳过 ${eff.skippedCalls ?? 0} · 有效率 ${Math.round((eff.effectiveRate ?? 1) * 100)}%`
      : `【执行统计】工具调用 ${toolSteps.length} 次`,
  ];
  if (finalAnswer) {
    parts.push(`【最终交付(节选)】${String(finalAnswer).slice(0, 400)}`);
  }
  let digest = parts.join('\n');
  if (digest.length > DISTILL_TRAJECTORY_LIMIT) {
    digest = digest.slice(0, DISTILL_TRAJECTORY_LIMIT);
  }
  return digest;
}

const SKILL_DISTILL_SYSTEM =
  '你是技能卡蒸馏器。从刚结束任务的执行轨迹中,蒸馏出可复用的技能卡,供未来同类任务直接照做。\n' +
  '每张卡五个字段:\n' +
  '- trigger: 何种任务适用本卡(一句话,具体到任务形态,如"向知乎发布文章草稿")\n' +
  '- steps: 被验证有效的核心操作步骤(Do;命令式要点,200字内)\n' +
  '- avoid: 反模式(Avoid;从本次失败/重试/绕路提炼:错误做法 → 正确做法)\n' +
  '- check: 宣告完成前必须逐项核验的约束(Check)\n' +
  '- risk: 边界条件与失败模式(Risk;什么情况下本卡不适用或可能失效)\n' +
  '- keywords: 10~20 个检索关键词(中英文混合,覆盖该类任务未来的常见说法)\n' +
  '输出严格 JSON 数组(至多 2 张;没有值得沉淀的就输出 []),每项形如:\n' +
  '{"trigger":"…","steps":"…","avoid":"…","check":"…","risk":"…","keywords":["…"]}\n' +
  '判定原则:\n' +
  '- 失败、重试、绕路的教训优先级最高(写进 avoid/check);成功路径仅在可复用且非显而易见时记录;\n' +
  '- 不记录一次性任务细节(具体文章内容、当日专名);卡片必须对"下一次同类任务"仍然成立;\n' +
  '- 已有卡片的 trigger 不要重复输出;要修正某张已有卡时,输出同一 trigger(系统自动合并);\n' +
  '只输出 JSON,不要任何其他文字。';

/**
 * 任务末技能卡蒸馏(旁路执行,任何失败静默返回空结果):
 * - 开关/信息量门槛:AGTPILOT_SKILL_CARDS 未关、ctx.model 可用、
 *   工具调用 ≥ DISTILL_MIN_TOOL_CALLS 或出现过失败/熔断(纯闲聊不跑);
 * - 成败都蒸(失败轨迹重点提炼 Avoid/Check);
 * - 模型输出经 parseSkillCards 校验归一化后按 trigger 去重合并入库。
 */
export async function distillSkillCards(
  ctx: any,
  opts: {
    userId: string;
    goal: string;
    taskSucceeded: boolean;
    mission: {
      id?: string;
      steps?: Array<{ tool?: string; args?: any; output?: any; status?: string; duration?: string; role?: string; answer?: string }>;
    };
    efficiency?: { stepsCount?: number; toolCalls?: number; failedCalls?: number; skippedCalls?: number; effectiveRate?: number };
    missionId?: string;
    configOverride?: any;
  }
): Promise<SkillDistillOutcome> {
  const empty: SkillDistillOutcome = { added: [], updated: [] };
  if (!isSkillCardsEnabled()) return empty;
  const model = ctx?.model;
  if (!model?.invokeStep) return empty;

  const steps = opts.mission?.steps || [];
  const toolSteps = steps.filter((s) => s.tool && s.role !== 'user');
  const failed = (opts.efficiency?.failedCalls || 0) + (opts.efficiency?.skippedCalls || 0);
  // 信息量门槛:足够多的工具调用,或出现过失败/熔断(与 Agent 经验通道同型)
  if (toolSteps.length < DISTILL_MIN_TOOL_CALLS && failed === 0) return empty;

  const digest = buildTrajectoryDigest({
    goal: opts.goal,
    taskSucceeded: opts.taskSucceeded,
    mission: opts.mission,
    efficiency: opts.efficiency,
  });
  const existing = listSkillCards(opts.userId);
  const existingBrief =
    existing.length > 0 ? existing.map((c) => `- ${c.trigger}`).join('\n') : '(暂无卡片)';

  let text = '';
  try {
    const result = await model.invokeStep({
      system: SKILL_DISTILL_SYSTEM,
      messages: [
        {
          role: 'user',
          content: `【已有技能卡(trigger 清单,勿重复;修正则输出同一 trigger)】\n${existingBrief}\n\n【本次任务轨迹】\n${digest}`,
        },
      ],
      disableTools: true,
      configOverride: opts.configOverride,
    });
    text = result?.text || '';
  } catch {
    return empty;
  }
  if (!text) return empty;

  const candidates = parseSkillCards(text);
  if (candidates.length === 0) return empty;
  return upsertSkillCards(
    opts.userId,
    candidates.map((c) => ({ ...c, sourceMissionId: opts.missionId || opts.mission?.id }))
  );
}
