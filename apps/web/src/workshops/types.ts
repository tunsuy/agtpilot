/**
 * 工坊 skill 包 · 公共类型(从 components/workshops/registry.ts 平移)
 *
 * 工坊包结构(src/workshops/<id>/):
 * - skill.ts   清单:meta(卡片元数据)+ run(参数→{prompt,title},表单提交与重跑共用)
 * - prompt.ts  提示词构建器(Phase 3 迁 prompt.md 模板 + context.ts)
 * - shared/    跨包共享片段(检索梯度、参数规整)
 * components/workshops/registry.ts 与 run.ts 只做派生 re-export,不再持有定义。
 */
import type { LucideIcon } from 'lucide-react';
import type { ScenarioProfile } from '@/lib/scenario-profile';

export type WorkshopId =
  | 'xhs'
  | 'wechat_mp'
  | 'zhihu'
  | 'weibo'
  | 'video_douyin'
  | 'video_bilibili'
  | 'email_triage'
  | 'weekly'
  | 'ppt'
  | 'follow_builders'
  | 'invest'
  | 'edu'
  | 'oss_radar';

export type WorkshopAccent = 'violet' | 'sky' | 'emerald' | 'indigo';

export interface WorkshopDep {
  /** 连接器 / MCP 连接器 id(用于查询连接状态) */
  id: string;
  name: string;
  /** 必需依赖:未连接时卡片给出去配置入口;默认为可选增强 */
  required?: boolean;
}

/** 工坊交付物声明(P0 仅声明性;渲染按输出解析驱动,此处为 P1 交付库注册预留) */
export interface ArtifactSpec {
  kind: 'note-package' | 'article-package';
  label: string;
}

export interface WorkshopDef {
  id: WorkshopId;
  name: string;
  category: string;
  /** 一句话价值主张(卡片副标题) */
  desc: string;
  icon: LucideIcon;
  accent: WorkshopAccent;
  deps: WorkshopDep[];
  /** 安全与流程说明(表单底部展示,来自各工坊的红线约定) */
  note: string;
  /** 场景档案槽位(scenario-loop §2):声明后首次使用触发档案引导,Prompt 自动注入档案 */
  profileSlot?: string;
  /** 结构化交付物声明 */
  artifacts?: ArtifactSpec[];
}

export const WORKSHOP_CATEGORIES: Array<{ key: string; label: string; accent: WorkshopAccent }> = [
  { key: 'content', label: '内容运营', accent: 'violet' },
  { key: 'office', label: '办公提效', accent: 'sky' },
  { key: 'dev', label: '开发协作', accent: 'sky' },
  { key: 'invest', label: '投研辅助', accent: 'emerald' },
  { key: 'edu', label: '教研学习', accent: 'indigo' },
];

/** 工坊运行结果:作为新任务提交给 Agent */
export interface WorkshopRun {
  prompt: string;
  title: string;
}

/** 运行上下文:场景档案等表单之外的状态,表单与「一键重跑」共用 */
export interface WorkshopRunContext {
  scenarioProfile?: ScenarioProfile;
}

/** 一个工坊 skill 包的完整装配:元数据 + 参数分发 */
export interface WorkshopSkill {
  meta: WorkshopDef;
  run: (params: Record<string, unknown>, ctx?: WorkshopRunContext) => WorkshopRun;
}
