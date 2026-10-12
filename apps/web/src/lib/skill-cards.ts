/**
 * TRS 技能卡 —— web 侧薄壳(引擎已迁至 @agtpilot/plugin-skill)
 *
 * 卡片引擎(五字段解析归一化 / trigger 去重合并 / 关键词检索注入 / 命中反馈 /
 * 任务末蒸馏)现在住在统一技能插件 packages/plugin-skill(ctx.skills 服务面);
 * 本文件只保留两件 web 独有的事:
 *
 * 1. webCardStore():把本仓 user-store(data.skillCards 卡片库 + 记忆审计)
 *    适配成插件的 SkillCardStore 注入 —— 存储不下沉,插件不依赖 web;
 *    分词器沿用 memory-service 的 tokenize(与记忆通道同一实现,避免漂移);
 * 2. 原 API 的兼容转发(buildSkillCardsBlock / distillSkillCards / 纯函数与
 *    类型再导出),既有调用方与测试不用改导入路径。
 *
 * agent-backend 优先走 ctx.skills.buildCardsBlock / distillCards(装配时已
 * 注入同一个 webCardStore);插件加载失败时回落这里的本地构建,行为一致。
 *
 * 机制说明(TRS 五字段、生命周期、经济学)见 packages/plugin-skill/src/cards.ts
 * 头注。开关:AGTPILOT_SKILL_CARDS=0 整体关闭。
 */
import {
  createSkillCardsEngine,
  type SkillCard,
  type SkillCardAuditEntry,
  type SkillCardStore,
  type SkillDistillOutcome,
} from '@agtpilot/plugin-skill';
import { getUserData, saveUserData, appendMemoryAudit, appendRetrievalTrace, type MemoryAuditEntry } from './user-store';
import { tokenize } from './memory-service';

// ---- 引擎再导出(既有导入路径不变) ----
export {
  SKILL_CARDS_MAX,
  isSkillCardsEnabled,
  renderSkillCard,
  buildTrajectoryDigest,
  type SkillCard,
  type SkillCardCandidate,
  type SkillDistillOutcome,
} from '@agtpilot/plugin-skill';

/** web 卡片存储适配器:卡片库 = user-store data.skillCards(零迁移透传),审计走记忆审计通道 */
export function webCardStore(): SkillCardStore {
  return {
    listCards(userId: string): unknown[] {
      try {
        const data = getUserData(userId);
        return Array.isArray((data as any).skillCards) ? (data as any).skillCards : [];
      } catch {
        return [];
      }
    },
    saveCards(userId: string, cards: SkillCard[]) {
      const data = getUserData(userId);
      (data as any).skillCards = cards;
      saveUserData(data);
    },
    appendCardAudit(userId: string, entry: SkillCardAuditEntry) {
      appendMemoryAudit(userId, entry as MemoryAuditEntry);
    },
    // 检索轨迹:卡片注入的得分明细/落选原因 → user-store audit/retrieval.jsonl(P2)
    appendRetrievalTrace(userId: string, entry: Record<string, unknown>) {
      appendRetrievalTrace(userId, entry as any);
    },
  };
}

/** 绑定 web 存储与分词器的卡片引擎(模块级单例;存储调用是惰性的,随取随新) */
const engine = createSkillCardsEngine({ store: webCardStore(), tokenize });

// ---- 原 API 兼容转发(签名与迁移前一致) ----

/** 归一化单张候选卡(不合格返回 null) */
export const normalizeSkillCard = (raw: any) => engine.normalizeCard(raw);

/** 解析模型蒸馏输出:JSON 数组 → 合格候选卡(至多 2 张) */
export const parseSkillCards = (text: string) => engine.parseCards(text);

/** 读取用户卡片库(过滤损坏条目) */
export const listSkillCards = (userId: string): SkillCard[] => engine.listCards(userId);

/** 候选卡入库(trigger 去重合并、总量淘汰、审计) */
export const upsertSkillCards = (
  userId: string,
  candidates: Array<import('@agtpilot/plugin-skill').SkillCardCandidate & { sourceMissionId?: string }>
): SkillDistillOutcome => engine.upsertCards(userId, candidates);

/** 卡片与任务目标的匹配分 */
export const scoreSkillCard = (card: SkillCard, goal: string): number => engine.scoreCard(card, goal);

/** 按任务目标选卡(门槛分 → 排序 → top-k + 预算封顶) */
export const selectSkillCards = (
  cards: SkillCard[],
  goal: string,
  opts: { maxItems?: number; maxChars?: number; minScore?: number } = {}
): SkillCard[] => engine.selectCards(cards, goal, opts);

/** 记录一批卡片被注入命中(hitCount/lastHitAt;失败静默) */
export const noteSkillCardHits = (userId: string, ids: string[]): void => engine.noteCardHits(userId, ids);

/**
 * 构建 system prompt 技能卡注入块(任务开始时调用一次,任务内前缀稳定):
 * 检索 top-k 直接适用卡 + 「仅采用直接适用技能」门控指令;无达标卡返回空串。
 */
export const buildSkillCardsBlock = (userId: string, goal: string): string =>
  engine.buildCardsBlock(userId, goal);

/** 任务末技能卡蒸馏(旁路执行,失败静默;model 取传入 ctx 的 model 服务) */
export const distillSkillCards = (
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
): Promise<SkillDistillOutcome> => engine.distillCards(ctx?.model, opts);
