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

/**
 * 服务端权威渲染的工坊任务载荷:/api/agent/run 收到 {workshop: {id, params}} 后
 * 用注册表 + user-store 当前档案重渲染 prompt(并应用覆盖目录热修),忽略客户端拼好的 prompt;
 * 普通手输 prompt 不带此载荷,不受影响。
 */
export interface WorkshopRunPayload {
  id: string;
  params: Record<string, unknown>;
}

/** 运行上下文:场景档案等表单之外的状态,表单与「一键重跑」共用 */
export interface WorkshopRunContext {
  scenarioProfile?: ScenarioProfile;
}

/** 一个工坊 skill 包的完整装配:元数据 + 参数分发(+ 可选 cron 订阅场景声明) */
export interface WorkshopSkill {
  meta: WorkshopDef;
  run: (params: Record<string, unknown>, ctx?: WorkshopRunContext) => WorkshopRun;
  /**
   * cron 订阅场景声明(仅订阅型工坊如 xhs/oss_radar 填):cron-scenario.ts 按 key
   * 从注册表汇总的 CRON_SCENARIOS 找到这里,触发时用当前档案重建 prompt。
   * 声明即生效:白名单、count 钳制区间、缺省值、档案槽位全部以这里为单一事实源。
   */
  cron?: CronScenarioSpec;
}

/** cron 订阅场景声明(cron 任务存场景标记而非写死的 prompt,触发时现读档案重建) */
export interface CronScenarioSpec {
  /** 场景标记(cron 任务上存的 key;全局唯一,注册表按它分发) */
  key: string;
  /** 档案槽位:触发时 getProfile(profileSlot) 取当前档案 */
  profileSlot: string;
  /** 产出条数钳制区间(区间外的 count 丢弃,走 defaultCount) */
  countMin: number;
  countMax: number;
  /** count 缺省值 */
  defaultCount: number;
  /** (count, profile) => prompt;档案读取由调用方注入,保持纯可测 */
  build: (count: number, profile: ScenarioProfile | undefined) => string;
}
