/**
 * 工坊 skill 包注册表 · 统一出口
 *
 * 每个工坊 = src/workshops/<id>/ 自包含包(清单 skill.ts + 提示词 prompt.ts),
 * 本模块按序装配并提供 buildWorkshopRun(表单提交、实时预览、「一键重跑」共用)。
 * 新增工坊 = 新建一个包目录 + 在 WORKSHOP_SKILLS 加一行 + 配一个表单组件
 * (FORMS 映射在 WorkshopsView,Record<WorkshopId, Component> 保编译期穷尽)。
 */
import { WORKSHOP_SKILL as XHS, CRON as XHS_CRON, CRON_KEY as XHS_CRON_KEY } from './xhs/skill';
import { WORKSHOP_SKILL as WECHAT_MP } from './wechat_mp/skill';
import { WORKSHOP_SKILL as ZHIHU } from './zhihu/skill';
import { WORKSHOP_SKILL as WEIBO } from './weibo/skill';
import { WORKSHOP_SKILL_DOUYIN, WORKSHOP_SKILL_BILIBILI } from './video/skill';
import { WORKSHOP_SKILL as EMAIL_TRIAGE } from './email_triage/skill';
import { WORKSHOP_SKILL as WEEKLY } from './weekly/skill';
import { WORKSHOP_SKILL as PPT } from './ppt/skill';
import { WORKSHOP_SKILL as FOLLOW_BUILDERS } from './follow_builders/skill';
import { WORKSHOP_SKILL as INVEST } from './invest/skill';
import { WORKSHOP_SKILL as EDU } from './edu/skill';
import { WORKSHOP_SKILL as OSS_RADAR, CRON as OSS_CRON, CRON_KEY as OSS_CRON_KEY } from './oss_radar/skill';
import type {
  WorkshopId,
  WorkshopDef,
  WorkshopSkill,
  WorkshopRun,
  WorkshopRunContext,
  WorkshopRunPayload,
  CronScenarioSpec,
  ArtifactDraftSpec,
} from './types';
import type { ArticlePackage } from './shared/article-package';
import type { NotePackage } from './xhs/note-package';

/** id → skill 包(类型键全覆盖,新增工坊漏配会在编译期报错) */
const WORKSHOP_SKILLS: Record<WorkshopId, WorkshopSkill> = {
  xhs: XHS,
  wechat_mp: WECHAT_MP,
  zhihu: ZHIHU,
  weibo: WEIBO,
  video_douyin: WORKSHOP_SKILL_DOUYIN,
  video_bilibili: WORKSHOP_SKILL_BILIBILI,
  email_triage: EMAIL_TRIAGE,
  weekly: WEEKLY,
  ppt: PPT,
  follow_builders: FOLLOW_BUILDERS,
  invest: INVEST,
  edu: EDU,
  oss_radar: OSS_RADAR,
};

/** 卡片网格顺序(与旧 components/workshops/registry.ts 的 WORKSHOPS 一致) */
export const WORKSHOPS: WorkshopDef[] = [
  WORKSHOP_SKILLS.xhs.meta,
  WORKSHOP_SKILLS.wechat_mp.meta,
  WORKSHOP_SKILLS.zhihu.meta,
  WORKSHOP_SKILLS.weibo.meta,
  WORKSHOP_SKILLS.video_douyin.meta,
  WORKSHOP_SKILLS.video_bilibili.meta,
  WORKSHOP_SKILLS.email_triage.meta,
  WORKSHOP_SKILLS.weekly.meta,
  WORKSHOP_SKILLS.ppt.meta,
  WORKSHOP_SKILLS.follow_builders.meta,
  WORKSHOP_SKILLS.oss_radar.meta,
  WORKSHOP_SKILLS.invest.meta,
  WORKSHOP_SKILLS.edu.meta,
];

export function getWorkshop(id: string): WorkshopDef | undefined {
  return WORKSHOPS.find((w) => w.id === id);
}

export function getWorkshopSkill(id: WorkshopId): WorkshopSkill {
  return WORKSHOP_SKILLS[id];
}

/** 工坊 → Agent 任务的统一出口(表单提交与「一键重跑」共用,保证两处生成的任务完全一致) */
export function buildWorkshopRun(
  id: WorkshopId,
  params: Record<string, unknown>,
  ctx?: WorkshopRunContext
): WorkshopRun {
  return WORKSHOP_SKILLS[id].run(params, ctx);
}

/** 交付物 kind → 其包格式对应的结构类型(解析结果的 pkg) */
type ArtifactPkg<K extends 'article-package' | 'note-package'> =
  K extends 'article-package' ? ArticlePackage : NotePackage;

/**
 * 按任务来源工坊 + 交付物 kind 解析存草稿投递声明(工域知识路由的统一出口)。
 *
 * 工坊已为该交付物声明 draft → 用它自己的投递指令(知乎文章包走知乎托管存草稿,
 * 公众号走草稿箱直连)。任务无 workshopId 或来源工坊不产出该格式(手输任务/历史任务)
 * 时按格式缺省路由:文章包 → 公众号(格式为两工坊共享,公众号是缺省投递目标),
 * 笔记包 → 小红书(格式仅 xhs 工坊产出)。不靠任务标题嗅探,投递目标永远出自声明。
 */
export function resolveArtifactDraft<K extends 'article-package' | 'note-package'>(
  workshopId: string | undefined,
  kind: K
): ArtifactDraftSpec<ArtifactPkg<K>> | undefined {
  const fromWorkshop =
    workshopId && (workshopId as WorkshopId) in WORKSHOP_SKILLS
      ? (WORKSHOP_SKILLS[workshopId as WorkshopId].meta.artifacts || []).find((a) => a.kind === kind)?.draft
      : undefined;
  if (fromWorkshop) return fromWorkshop as ArtifactDraftSpec<ArtifactPkg<K>>;
  const fallbackId: WorkshopId = kind === 'note-package' ? 'xhs' : 'wechat_mp';
  return (WORKSHOP_SKILLS[fallbackId].meta.artifacts || []).find((a) => a.kind === kind)?.draft as
    | ArtifactDraftSpec<ArtifactPkg<K>>
    | undefined;
}

/**
 * cron 订阅场景声明(从各包清单汇总;cron-scenario.ts 按此分发,不再硬编码场景)。
 * 新增订阅场景 = 在包的 skill.ts 里声明 cron + 在这里加一行;CronScenarioKey union 由此派生。
 */
export const CRON_SCENARIOS = {
  [XHS_CRON_KEY]: XHS_CRON,
  [OSS_CRON_KEY]: OSS_CRON,
} satisfies Readonly<Record<string, CronScenarioSpec>>;

/** cron 场景 key 白名单(编译期 union 与运行时 CRON_SCENARIOS 同源) */
export type CronScenarioKey = keyof typeof CRON_SCENARIOS;

export type {
  WorkshopId,
  WorkshopDef,
  WorkshopSkill,
  WorkshopRun,
  WorkshopRunContext,
  WorkshopRunPayload,
  CronScenarioSpec,
};
export {
  WORKSHOP_CATEGORIES,
  type WorkshopAccent,
  type WorkshopDep,
  type ArtifactSpec,
  type ArtifactDraftSpec,
} from './types';
