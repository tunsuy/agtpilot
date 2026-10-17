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
import { WORKSHOP_SKILL as NOVEL, CRON as NOVEL_CRON, CRON_KEY as NOVEL_CRON_KEY } from './novel/skill';
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
  ArtifactSpec,
} from './types';
import type { ArticlePackage } from './shared/article-package';
import type { NotePackage } from './xhs/note-package';

/** id → skill 包(类型键全覆盖,新增工坊漏配会在编译期报错) */
const WORKSHOP_SKILLS: Record<WorkshopId, WorkshopSkill> = {
  xhs: XHS,
  wechat_mp: WECHAT_MP,
  zhihu: ZHIHU,
  weibo: WEIBO,
  novel: NOVEL,
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
  WORKSHOP_SKILLS.novel.meta,
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

/**
 * 工坊工具白名单解析(四层并集,docs/design/token-consumption-and-tool-loading.md §9.1):
 * A. baseline 常驻 —— 内核 routing.resolveExplicitTools 自动并入,这里不管;
 * B. 通用检索组 —— 按 meta.searchGroup 口径(full/research/web/none);
 * C. deps 映射 —— meta.deps 连接器 id → `mcp_<id>_*` 前缀通配(deps 是单一事实源,
 *    新工坊声明 deps 即自动获得对应 MCP 组;非 MCP / 整台禁入的走 DEPS_TOOL_OVERRIDES);
 * D. 工坊追加 —— meta.activeTools 原样并入(固定工具精确名 / MCP 精确工具名 / 前缀通配)。
 *
 * 返回值交给 runMission → orchestrator options.activeTools(routing.ts explicit 通道):
 * 白名单任务不参与关键词路由,挂载面从「正则磁铁拖进 80~100 个」收敛到声明集。
 * 未声明白名单的工坊(理论上不存在,防御)返回 undefined → 走原路由。
 */
const SEARCH_WEB_TOOLS = ['search_web', 'search_exa', 'search_tavily'];
/** 调研增强件:并行子 agent + 网页正文抓取 + 参考资料库(full/research 两档共用) */
const RESEARCH_TOOLS = ['research_subagent', 'browser_firecrawl_scrape', 'read_reference_material'];
/** 社媒热榜 MCP(仅 full 档;与 shared/sources.ts 的 TOPIC_RESEARCH_SOURCES 梯度同源) */
const SOCIAL_MCP_GROUPS = ['mcp_newsnow_*', 'mcp_zhihu_*', 'mcp_twitterapi_io_*'];

const SEARCH_GROUPS: Record<NonNullable<WorkshopDef['searchGroup']>, string[]> = {
  full: [...SEARCH_WEB_TOOLS, ...SOCIAL_MCP_GROUPS, ...RESEARCH_TOOLS],
  research: [...SEARCH_WEB_TOOLS, ...RESEARCH_TOOLS],
  web: [...SEARCH_WEB_TOOLS],
  none: [],
};

/**
 * deps id → 工具映射特例(缺省规则 = `mcp_<id>_*`):
 * - email:固定工具提供器(email_imap/email_smtp),不是 MCP;
 * - tomato_writer:本地 MCP 已撤(novel/skill.ts 注释),映射为空;
 * - github_mcp:整台 30~40 个大 schema 是 73 万事件的最大单项放大器,默认整台
 *   禁入;需要 GitHub 的工坊在 meta.activeTools 里按精确名声明(oss_radar 3 个、
 *   weekly 5 个),检索主力走 github_scan 固定工具。
 */
const DEPS_TOOL_OVERRIDES: Record<string, string[]> = {
  email: ['email_list', 'email_read', 'email_send'],
  tomato_writer: [],
  github_mcp: [],
};

export function resolveWorkshopActiveTools(id: WorkshopId): string[] | undefined {
  const meta = WORKSHOP_SKILLS[id]?.meta;
  if (!meta) return undefined;
  const tools = new Set<string>(SEARCH_GROUPS[meta.searchGroup ?? 'full']);
  for (const dep of meta.deps || []) {
    const mapped = dep.id in DEPS_TOOL_OVERRIDES ? DEPS_TOOL_OVERRIDES[dep.id] : [`mcp_${dep.id}_*`];
    for (const name of mapped) tools.add(name);
  }
  for (const name of meta.activeTools || []) tools.add(name);
  return Array.from(tools);
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
/** 带 draft 的包类交付物声明(article/note;oss-opportunity 无 draft 不参与草稿直投) */
type DraftArtifactSpec = Extract<
  ArtifactSpec,
  { kind: 'article-package' } | { kind: 'note-package' }
>;

export function resolveArtifactDraft<K extends 'article-package' | 'note-package'>(
  workshopId: string | undefined,
  kind: K
): ArtifactDraftSpec<ArtifactPkg<K>> | undefined {
  const fromWorkshop =
    workshopId && (workshopId as WorkshopId) in WORKSHOP_SKILLS
      ? (WORKSHOP_SKILLS[workshopId as WorkshopId].meta.artifacts || []).find(
          (a): a is DraftArtifactSpec => a.kind === kind
        )?.draft
      : undefined;
  if (fromWorkshop) return fromWorkshop as ArtifactDraftSpec<ArtifactPkg<K>>;
  const fallbackId: WorkshopId = kind === 'note-package' ? 'xhs' : 'wechat_mp';
  return (WORKSHOP_SKILLS[fallbackId].meta.artifacts || []).find(
    (a): a is DraftArtifactSpec => a.kind === kind
  )?.draft as
    | ArtifactDraftSpec<ArtifactPkg<K>>
    | undefined;
}

/**
 * 工坊声明的结构化交付物类型(article-package / note-package / oss-opportunity);
 * 未声明此类交付物的工坊(PPT / 小说 / 视频 / 微博 / 手输任务等)→ null。
 *
 * 服务端收尾据此决定是否把成品自动落进交付库(见 shared/deliverable-publish.ts):
 * 声明了包类交付物的内容工坊(知乎/公众号=文章包,小红书=笔记包)与声明机会清单的
 * 开源雷达(oss-opportunity)才参与,声明驱动、不靠任务标题嗅探,新增工坊自动纳入。
 */
export function resolveDeliverableKind(
  workshopId: string | undefined
): 'article-package' | 'note-package' | 'oss-opportunity' | null {
  if (!workshopId || !((workshopId as WorkshopId) in WORKSHOP_SKILLS)) return null;
  const artifacts = WORKSHOP_SKILLS[workshopId as WorkshopId].meta.artifacts || [];
  const pkg = artifacts.find(
    (a) => a.kind === 'article-package' || a.kind === 'note-package' || a.kind === 'oss-opportunity'
  );
  return pkg ? (pkg.kind as 'article-package' | 'note-package' | 'oss-opportunity') : null;
}

/**
 * cron 订阅场景声明(从各包清单汇总;cron-scenario.ts 按此分发,不再硬编码场景)。
 * 新增订阅场景 = 在包的 skill.ts 里声明 cron + 在这里加一行;CronScenarioKey union 由此派生。
 */
export const CRON_SCENARIOS = {
  [XHS_CRON_KEY]: XHS_CRON,
  [OSS_CRON_KEY]: OSS_CRON,
  [NOVEL_CRON_KEY]: NOVEL_CRON,
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
