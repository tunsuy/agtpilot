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
import type { NovelBook } from '@/lib/novel-context';
import type { ArticlePackage } from './shared/article-package';
import type { NotePackage } from './xhs/note-package';
import type { RadarDispatchHistoryEntry } from './oss_radar/context';

export type WorkshopId =
  | 'xhs'
  | 'wechat_mp'
  | 'zhihu'
  | 'weibo'
  | 'novel'
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

/**
 * 存草稿投递声明:结构化交付物 → 平台存草稿工具的续聊指令(工域知识,归工坊包)。
 * 卡片按 mission 的 workshopId 经注册表解析到这里,不再按任务标题嗅探目标平台。
 */
export interface ArtifactDraftSpec<Pkg> {
  /** 按钮文案(含平台特定的审批/发布提示) */
  label: string;
  /**
   * 续聊指令 builder(纯函数):选中标题索引 → 指令文本。参数逐字内嵌(零漂移),
   * 且必须带纯执行边界句(调研与标题已定稿,勿重复调研/生成新候选)——
   * 生产实例(2026-10-11):只约束参数挡不住模型对上轮工作流的模式补全。
   */
  build: (pkg: Pkg, titleIndex: number) => string;
  /** 托管写操作门:依赖的托管连接器 id;未声明 = 凭证内置,按钮恒可用 */
  managedGate?: 'xhs' | 'zhihu';
  /** managedGate 未开启时的引导文案(替代按钮) */
  disabledHint?: string;
  /**
   * 落稿工具名(xhs_save_note_draft / wechat_mp_create_draft / zhihu_save_article_draft):
   * UI 扫描 mission 步骤,该工具成功执行过(标题或正文命中本篇)→ 按钮转
   * 「已投递」不可再点 —— 防重复投递同篇。未声明时无投递态检测(按钮恒可点)。
   */
  deliverTool?: string;
}

export type ArtifactSpec =
  | { kind: 'article-package'; label: string; draft?: ArtifactDraftSpec<ArticlePackage> }
  | { kind: 'note-package'; label: string; draft?: ArtifactDraftSpec<NotePackage> }
  | { kind: 'oss-opportunity'; label: string };

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
  /**
   * 工具白名单 · D 层追加(docs/design/token-consumption-and-tool-loading.md §9.1):
   * 本工坊专属的固定工具精确名与 MCP 精确工具名(如 'github_scan'、
   * 'mcp_github_mcp_search_issues')。A 层 baseline 由内核自动并入、B 层检索组按
   * searchGroup 口径、C 层由 deps 自动映射 `mcp_<id>_*`,三层都不用手写;
   * 这里只写派生不出来的部分。整台 MCP 服务器进白名单用 '*' 结尾前缀通配。
   */
  activeTools?: string[];
  /**
   * 工具白名单 · B 层检索组口径(缺省 'full'):
   * - full:内容工坊标准检索梯度(shared/sources.ts 同源)——search 三件套 +
   *   newsnow/zhihu/twitter MCP + research_subagent + firecrawl + 参考资料;
   * - research:去掉社媒热榜 MCP,保留 search 三件套 + research_subagent +
   *   firecrawl + 参考资料(调研型工坊:雷达/投研/教研);
   * - web:仅 search 三件套(纯生成型:小说/PPT);
   * - none:不挂检索组(封闭数据源工坊:邮件分诊/周报)。
   */
  searchGroup?: 'full' | 'research' | 'web' | 'none';
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
  /**
   * 逐字段交付契约(可选):声明后派发链把 workshop_deliver_field 工具挂进任务,
   * prompt 契约与工具挂载同生共死(模板 override 热修时 server-render 显式丢弃)。
   * validator 是函数不可 JSON 化——mission 只持久化 {id, fields:[{key,label,required}]}
   * 投影,续聊/重启后经 id 从工坊注册表现场重建完整 spec。
   */
  delivery?: DeliveryContract;
}

/**
 * 逐字段交付 · 单字段声明(工坊层通用,docs 见计划「novel 工坊逐字段交付」):
 * 把"单轮巨型文本契约"拆成"每字段一步小生成 + 工具交付",推理模型的思考
 * 天然被切段有界,前端按工具步 args 跨步累积、逐字段点亮卡片。
 */
export interface DeliverableFieldSpec {
  /** 字段键(= 契约【字段头】文案,模型交付时 field 参数用它) */
  key: string;
  /** 展示名(渐进卡骨架行/进度角标) */
  label: string;
  /** 必交付字段:required 齐了才激活入库(存入书库)按钮 */
  required: boolean;
  /** 一句话交付要求(进工具 schema 的字段描述,模型交付时看) */
  hint?: string;
  /** 纯函数校验器:返回错误清单(空数组=通过)。必须无 fs/网络访问(spec 随 skill.ts 进客户端 bundle) */
  validate?: (content: string) => string[];
}

/** 逐字段交付契约:id 是重启/续聊后重建 spec 的钥匙 */
export interface DeliveryContract {
  id: string;
  fields: DeliverableFieldSpec[];
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
  /**
   * 小说工坊书状态快照(continue/review 模式必需):客户端预览由表单带
   * 已拉取的书;服务端权威渲染由 server-render 的 novel loader 现读
   * novel-store(状态永远以服务端为准,与档案现读同理)。
   */
  novelState?: NovelBook;
  /**
   * 雷达派发历史(去重黑名单):已派发处理过 / 已核实无需改动的 Issue 清单。
   * 仅服务端权威渲染注入(server-render 的 oss_radar loader 现读任务记录);
   * 客户端预览缺省不注入(buildOssRadarPrompt 无历史 → 模板段整体不渲染)。
   */
  ossDispatchHistory?: RadarDispatchHistoryEntry[];
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
  /** 派发来源工坊 id:随任务记录透传,记忆蒸馏层据此不把表单参数沉淀为长期定位 */
  workshopId: string;
  /**
   * 触发时需要服务端现读状态(如 novel 日更要现读书库):build() 只是诚实占位,
   * 纯函数 resolveCronPrompt 对它抛错,必须走 server-render 的 resolveCronPromptServer。
   */
  requiresServerState?: boolean;
}
