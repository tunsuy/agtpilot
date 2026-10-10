/**
 * 场景档案(docs/design/workshop-scenario-loop.md §2)
 *
 * 工坊从「匿名单次工具」升级为「认识用户的运营伙伴」的核心实体:每用户 × 每场景一份,
 * 存 user-store(per-user JSON),经 /api/scenario-profiles 读写。
 * P0 只覆盖小红书('xhs')且无 insights 写入口;normalize 在 API 入口做契约收口。
 */

export interface ScenarioProfile {
  /** 场景键,与 WorkshopDef.profileSlot 对应('xhs' | 'invest' | ...) */
  scenarioKey: string;
  /** 认知(insights)写回时递增;P0 恒为 1 */
  version: number;
  positioning: { niche: string; audience: string; differentiation?: string };
  persona: { toneSamples: string[]; taboos: string[] };
  cadence: { postsPerWeek?: number; mix?: Array<{ kind: string; weight: number }> };
  /** 已验证认知(P1 复盘写回,须经人工确认;P0 只读展示) */
  insights: Array<{ claim: string; evidence?: string; at: number }>;
  createdAt: number;
  updatedAt: number;
}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/** 字符串按行拆分数组(语气样例:「写两句你最自然的口吻」) */
const toLines = (v: unknown): string[] => {
  if (typeof v === 'string') {
    return v
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
  }
  if (Array.isArray(v)) {
    return v.map((s) => str(s)).filter(Boolean);
  }
  return [];
};

/** 禁忌字符串按逗号/分号/顿号拆分 */
const toTaboos = (v: unknown): string[] => {
  if (typeof v === 'string') {
    return v
      .split(/[，,;；、\n]/)
      .map((s) => s.trim())
      .filter(Boolean);
  }
  if (Array.isArray(v)) {
    return v.map((s) => str(s)).filter(Boolean);
  }
  return [];
};

/**
 * API 入参净化:unknown → 合法档案。
 * 必填(赛道 niche + 目标人群 audience)缺失 → null(调用方 400)。
 */
export function normalizeScenarioProfile(scenarioKey: string, input: unknown): ScenarioProfile | null {
  if (!scenarioKey || typeof input !== 'object' || input === null) return null;
  const raw = input as Record<string, unknown>;

  const niche = str(raw.niche ?? (raw.positioning as Record<string, unknown> | undefined)?.niche);
  const audience = str(raw.audience ?? (raw.positioning as Record<string, unknown> | undefined)?.audience);
  if (!niche || !audience) return null;

  const positioningRaw = (raw.positioning && typeof raw.positioning === 'object' ? raw.positioning : {}) as Record<string, unknown>;
  const personaRaw = (raw.persona && typeof raw.persona === 'object' ? raw.persona : {}) as Record<string, unknown>;
  const cadenceRaw = (raw.cadence && typeof raw.cadence === 'object' ? raw.cadence : {}) as Record<string, unknown>;

  const differentiation = str(positioningRaw.differentiation) || str(raw.differentiation) || undefined;
  const postsPerWeekRaw = Number(cadenceRaw.postsPerWeek ?? raw.postsPerWeek);
  const postsPerWeek =
    Number.isFinite(postsPerWeekRaw) && postsPerWeekRaw >= 1 && postsPerWeekRaw <= 30
      ? Math.round(postsPerWeekRaw)
      : undefined;

  const insights = Array.isArray(raw.insights)
    ? raw.insights
        .filter((i): i is Record<string, unknown> => typeof i === 'object' && i !== null)
        .map((i) => ({
          claim: str(i.claim),
          evidence: str(i.evidence) || undefined,
          at: typeof i.at === 'number' && Number.isFinite(i.at) ? i.at : Date.now(),
        }))
        .filter((i) => i.claim)
    : [];

  const now = Date.now();
  return {
    scenarioKey,
    version: typeof raw.version === 'number' && raw.version >= 1 ? raw.version : 1,
    positioning: { niche, audience, ...(differentiation ? { differentiation } : {}) },
    persona: { toneSamples: toLines(personaRaw.toneSamples ?? raw.toneSamples), taboos: toTaboos(personaRaw.taboos ?? raw.taboos) },
    cadence: { ...(postsPerWeek ? { postsPerWeek } : {}) },
    insights,
    createdAt: typeof raw.createdAt === 'number' && Number.isFinite(raw.createdAt) ? raw.createdAt : now,
    updatedAt: now,
  };
}

/**
 * 档案 → Prompt 拼接段(工坊构建器注入,插在主题段之前)。
 * 无定位且无人设(档案实质为空)→ null,不注入——与无档案时的 prompt 逐字节一致。
 */
export function buildProfileSection(profile: ScenarioProfile): string | null {
  const { positioning, persona, cadence, insights } = profile;
  const lines: string[] = [];

  if (positioning.niche) lines.push(`- 赛道:${positioning.niche}`);
  if (positioning.audience) lines.push(`- 目标人群:${positioning.audience}`);
  if (positioning.differentiation) lines.push(`- 差异点:${positioning.differentiation}`);
  if (persona.toneSamples.length > 0) {
    lines.push('- 语气样例(请模仿这个口吻,不要逐句复用):');
    persona.toneSamples.forEach((s) => lines.push(`  「${s}」`));
  }
  if (persona.taboos.length > 0) {
    lines.push(`- 禁忌(绝对不允许出现):${persona.taboos.join(';')}`);
  }
  if (cadence.postsPerWeek) {
    lines.push(`- 发布节奏:每周约 ${cadence.postsPerWeek} 篇`);
  }
  if (insights.length > 0) {
    lines.push('- 已验证认知(选题与创作优先遵循):');
    insights.forEach((i) => lines.push(`  - ${i.claim}`));
  }

  // 定位与语气都没有实质内容 → 档案形同虚设,不注入
  const hasPositioning = Boolean(positioning.niche || positioning.audience || positioning.differentiation);
  const hasPersona = persona.toneSamples.length > 0 || persona.taboos.length > 0;
  if (!hasPositioning && !hasPersona) return null;

  return `【账号档案】以下是我的长期账号设定,优先级高于单次的风格选择,所有产出必须与之一致:
${lines.join('\n')}`;
}
