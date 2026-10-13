/**
 * 工坊 skill 包注册表 · 统一出口
 *
 * 每个工坊 = src/workshops/<id>/ 自包含包(清单 skill.ts + 提示词 prompt.ts),
 * 本模块按序装配并提供 buildWorkshopRun(表单提交、实时预览、「一键重跑」共用)。
 * 新增工坊 = 新建一个包目录 + 在 WORKSHOP_SKILLS 加一行 + 配一个表单组件
 * (FORMS 映射在 WorkshopsView,Record<WorkshopId, Component> 保编译期穷尽)。
 */
import { WORKSHOP_SKILL as XHS } from './xhs/skill';
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
import { WORKSHOP_SKILL as OSS_RADAR } from './oss_radar/skill';
import type {
  WorkshopId,
  WorkshopDef,
  WorkshopSkill,
  WorkshopRun,
  WorkshopRunContext,
} from './types';

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

export type { WorkshopId, WorkshopDef, WorkshopSkill, WorkshopRun, WorkshopRunContext };
export {
  WORKSHOP_CATEGORIES,
  type WorkshopAccent,
  type WorkshopDep,
  type ArtifactSpec,
} from './types';
