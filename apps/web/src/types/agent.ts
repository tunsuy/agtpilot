import type { CronScenario } from '../lib/cron-scenario';
import type { PlanData } from '@agtpilot/protocol';

export interface ConnectorApp {
  id: string;
  name: string;
  category: string;
  icon: string;
  status: 'connected' | 'unconfigured';
  /** 凭证存储键；免凭证（noCredential）/ 未接入（comingSoon）的连接器无此字段 */
  envVar?: string;
  description: string;
  keyMasked?: string;
  isModel?: boolean;
  isDefaultModel?: boolean;
  baseUrl?: string;
  baseUrlEnvVar?: string;
  customModelName?: string;
  modelNameEnvVar?: string;
  /** 思考深度档位(low|medium|high);空 = 未配置(回落全局 env / 厂商缺省) */
  reasoningEffort?: string;
  reasoningEffortEnvVar?: string;
  platformType?: 'web' | 'mobile' | 'both';
  websiteUrl?: string;
  mobileAction?: {
    scheme?: string;
    actionName?: string;
    canDirectShare?: boolean;
  };
  /** 能力尚未接入后端：隐藏配置/授权入口，展示「即将支持」 */
  comingSoon?: boolean;
  /** 免凭证连接器：仅移动端真机唤起等免密能力，不提供凭证输入 */
  noCredential?: boolean;
  /** 配置弹窗内的补充说明（凭证格式/前置条件等） */
  configHint?: string;
}

/** MCP 连接器（一键授权/粘贴凭证/免凭证直连）状态信息 */
export interface McpConnectorInfo {
  id: string;
  name: string;
  icon: string;
  category: string;
  description: string;
  authType: 'oauth' | 'token' | 'none';
  /** opt-in 免凭证连接器（如浏览器自动化）：需用户显式启用后才挂载本地子进程 */
  optIn?: boolean;
  /** token 类的一键公共试用（如飞猪）：卡片显示「启用公共试用」按钮，手动启用而非默认常连 */
  publicTrial?: boolean;
  status: 'connected' | 'unconfigured';
  keyMasked?: string;
  /** 设备码授权通道（OAuth Device Grant）：available=部署侧已配 client_id/secret，UI 据此显隐按钮 */
  deviceFlow?: { available: boolean };
  quickAuthUrl?: string;
  authHint?: string;
  docUrl?: string;
  /** 已挂载的工具数（连接成功后） */
  toolCount?: number;
  /** 最近一次连接失败原因（排障用） */
  lastError?: string;
  /** 子 agent 可用性（目录 subagentOpen 标记 × 活连接的只读注解状态,详情页展示用） */
  subagent?: {
    /** 目录标记:任一服务器 subagentOpen=true */
    open: boolean;
    /** ready/escape=可用;needs-measurement=已标记但服务器无只读注解,待实测;closed=不开放 */
    availability: 'ready' | 'escape' | 'needs-measurement' | 'closed';
    /** 已声明只读的工具数(已连接时) */
    readOnlyCount?: number;
    /** 其中由名称动词启发判定的数量(注解沉默,default-deny 分类;已连接时) */
    heuristicReadOnlyCount?: number;
  };
}

export interface MissionStep {
  id: string;
  title: string;
  tool?: string;
  role?: 'user' | 'assistant' | 'tool';
  /** UI 语义：过程叙述归入任务活动流，只有 final/intervention 使用正式消息卡。 */
  messageKind?: 'progress' | 'final' | 'intervention';
  userPrompt?: string;
  /**
   * 排队中的追问(docs/design/mid-run-user-messages.md):任务进行中发的
   * 消息先置灰显示「排队中」,不打断在飞轮次;prepareStep 边界注入或
   * 轮末派发时由后端清除,气泡转正常色。
   */
  queued?: boolean;
  /**
   * 后台子任务完成/失败通知气泡(docs/design/background-child-missions.md):
   * 派生的子 mission 收尾时插入父会话的可见系统通知卡,与回注给模型的
   * 【后台任务通知】消息同源同步落库,刷新后仍在。专用字段(不复用
   * messageKind:'intervention'——该值全仓无渲染实现),旧数据零迁移。
   */
  bgNotice?: {
    childMissionId: string;
    childTitle: string;
    outcome: 'done' | 'failed';
    /** 结果摘要(finalAnswer/错误信息截断后),通知卡 clamp-3 可展开 */
    summary?: string;
  };
  status: 'PENDING' | 'RUNNING' | 'DONE' | 'FAILED';
  /**
   * 物理工具调用 id(编排器逐调用生成,tool_call/tool_result 事件与 ToolSession
   * 双通道携带):同轮并行多工具 + 插件/编排器双广播下,步骤按它一一对应、
   * 幂等合并与精确收尾,不再按「工具名+末位位置」模糊倒查(详见 lib/tool-steps.ts)。
   */
  callId?: string;
  /** 工具步骤开始时间（用于计算真实耗时，替代旧的硬编码假值） */
  startedAt?: number;
  duration?: string;
  args?: any;
  answer?: string;
  /** 推理模型思考过程流式文本（与 answer 分开展示，可折叠） */
  reasoning?: string;
  output?: any;
  error?: string;
  /**
   * 副作用补偿声明(内核 tool_result 透传,持久状态治理不变量 I5:
   * 每个行动都留下可回滚/可追责的「把手」,随任务快照落盘供撤销与审计)
   */
  compensation?: { kind: 'reversible' | 'partially-reversible' | 'irreversible'; undoHint?: string };
}

export interface Mission {
  id: string;
  userId?: string;
  title: string;
  status: 'ACTIVE' | 'DONE' | 'QUEUED' | 'WAITING_APPROVAL' | 'INTERRUPTED';
  progress: number;
  startedAt: number;
  steps: MissionStep[];
  conversationMessages?: Array<{ role: 'user' | 'assistant' | 'tool'; content: any }>;
  /** 派发来源工坊 id(/api/agent/run 服务端渲染时带上):
   *  记忆蒸馏层据此识别「首条消息是工坊表单参数拼装」,不把单次选择沉淀为长期定位 */
  workshopId?: string;
  /**
   * 工坊参考资料引用(docs/design/material-uploads.md):派发时从表单
   * params.materials 收敛透传({id,title}[],id 为 art_<missionId> 或 upl_*)。
   * 交付物页「参考资料」区据此展示输入↔产出闭环:上传件可下载原件,
   * 交付物引用可跳转对应资产。旧任务无此字段(零迁移,不显示该区)。
   */
  materialRefs?: Array<{ id: string; title: string }>;
  /**
   * 用户显式引用的技能包名列表(技能中心「引用」安装的生态技能包;canonical
   * name)。派发时经 /api/agent/run 白名单收敛落库;续聊轮不带显式引用时继承
   * 本字段,带显式引用(含空数组=清空)时覆盖并回写。非空 = 注入 SKILL.md
   * 全文块 + 挂载 skill_pack_read;旧任务无此字段(零迁移,不注入不挂载)。
   */
  skillPacks?: string[];
  /**
   * 巡航任务 id(docs/design/cruise-session-split.md):定时触发与巡航页「立即
   * 执行」派生的会话携带,是「巡航会话 vs 手动会话」分流的身份事实源 ——
   * 工作台列表过滤、state/init 下行分流、持久化分窗保留(手动 50 / 每任务 20)
   * 全读它。旧数据无此字段,按标题【自动巡航】前缀兜底识别(isCronMission)。
   */
  cronJobId?: string;
  /**
   * 父任务 id(docs/design/background-child-missions.md):经
   * launch_background_task 派生的后台子 mission 携带,是子任务身份的唯一
   * 事实源 —— 完成回注唤醒父任务、活动列表折叠分组、DONE push 抑制、
   * stop 级联、防递归挂载派发工具全部读它。普通任务无此字段(零迁移)。
   */
  parentMissionId?: string;
  /** 任务级累计 token 用量（多轮追问续跑时逐次累加；成本可观测） */
  usage?: { promptTokens: number; completionTokens: number };
  viewport?: ViewportState;
  terminalLogs?: TerminalLog[];
  /**
   * 任务看板实时状态(planner 插件 'plan' 事件镜像):看板卡数据源,
   * 保留 goal/currentTaskId 等结构(steps 合并只有扁平任务行)。重建
   * 看板自动替换(planner 同 taskKey 旧计划作废);旧任务落盘无此字段。
   */
  plan?: PlanData;
  /**
   * 逐字段交付契约的可序列化投影(novel 工坊设定包/大纲包):validator 是函数
   * 不可 JSON 化,mission 只存 {id, fields:[{key,label,required}]};续聊/重启后
   * 凭 id 经 resolveDeliveryContract 从工坊注册表现场重建完整 spec 并重挂工具,
   * 交付注册表从 steps 预灌。旧任务无此字段(零迁移)。
   */
  deliveryContract?: { id: string; fields: Array<{ key: string; label: string; required: boolean }> };
  artifact?: ArtifactState | null;
  /**
   * 线上摘要标记(lib/mission-wire.ts):state/init 对终态历史会话只发元信息,
   * steps/terminalLogs/viewport 置空 —— 选中时经 /api/agent/mission/[id]
   * 懒回水全量后本标记清除。首屏瘦身,列表渲染不依赖被剥字段。
   */
  stripped?: boolean;
  /** stripped 摘要携带:原始步骤数(占位展示/可观测) */
  stepCount?: number;
  /** stripped 摘要携带:失败尾步(step_err_)判定前置计算,子任务 chip「失败」态用 */
  hasErrorStep?: boolean;
  /**
   * 懒回水分片标记(/api/agent/mission/[id]?parts=):终态会话的重字段
   * (artifact 全文 / terminalLogs / viewport 截图)不再随 core 一起下发,
   * 各键 = 该分片是否已在客户端就位。右栏切到对应 tab 时按需取回并合并
   * 置 true;活跃会话经 SSE mission_updated 拿全量,无本标记(= 全在)。
   */
  parts?: { artifact?: boolean; terminal?: boolean; viewport?: boolean };
  /**
   * 巡航会话即时转场占位标记(app/page.tsx openCronRun):从巡航中心点开会话时,
   * 先用执行行(cronRuns)/交付摘要(cronDeliverables)就地搭一个占位并立刻切到
   * 工作台(驾驶舱显示「正在加载会话…」),再后台经 /api/agent/mission/[id] 回水
   * 全量、整行替换并清除本标记。与 stripped 刻意区分:stripped 是 state/init 下行
   * 的历史摘要(由「选中即回水」effect 处理),hydrating 是现场点开的在飞占位
   * (由 openCronRun 自身回水,不走那个 effect,避免同一会话双拉)。
   */
  hydrating?: boolean;
}

/**
 * 巡航会话执行历史行(state/init 的 cronRuns 下行,docs/design/cruise-session-split.md)。
 * 巡航会话不再进工作台 missions 列表,巡航中心任务卡下的「最近执行」读本行;
 * 刻意不带 steps/artifact 正文 —— 详情经 /api/agent/mission/[id] 懒回水,
 * 交付物走独立的 cronDeliverables 摘要行。
 */
export interface CronRunMeta {
  /** 会话(mission)id */
  id: string;
  /** 归属巡航任务 id;旧数据(标题前缀兜底识别的)无此字段,前端按任务名匹配 */
  jobId?: string;
  title: string;
  status: Mission['status'];
  startedAt: number;
  /** 失败尾步标记(列表红点) */
  hasErrorStep?: boolean;
  /** 是否带交付物(列表 chip;正文在 cronDeliverables / 懒回水里) */
  hasArtifact?: boolean;
}

export interface ViewportState {
  activeTab: 'browser' | 'terminal';
  url: string;
  title?: string;
  status: 'idle' | 'navigating' | 'interacting' | 'scraping';
  screenshotBase64?: string;
}

export interface TerminalLog {
  id: string;
  timestamp: number;
  type: 'command' | 'stdout' | 'stderr' | 'system';
  text: string;
  /** 归属用户（多用户部署时 SSE 按其过滤，未标记的全局系统日志除外） */
  userId?: string;
}

export interface ApprovalRequest {
  id: string;
  action: string;
  description: string;
  dangerLevel: 'low' | 'medium' | 'high';
  params: Record<string, any>;
  /** 发起该审批的任务键（多用户部署时 SSE 按其归属过滤，避免串台/泄露） */
  taskId?: string;
  /** 归属用户（SSE 过滤锚点） */
  userId?: string;
  /** 来源会话任务(runner 发布审批从任务记录带上):审批卡只在该会话展示,
   *  切会话不再全局跟随;缺省(会话内安全审批/历史单)保持全局可见 */
  missionId?: string;
}

/** 任务中途连接器授权建议（驾驶舱实时弹卡片，一键授权后任务原地继续） */
export interface ConnectorSuggestion {
  /** 去重键：`${userId}::${connectorId}` */
  id: string;
  connectorId: string;
  connectorName: string;
  authType: 'oauth' | 'token' | 'none';
  reason: string;
  authorizeUrl?: string;
}

/** ask_user 问题卡选项(镜像 @agtpilot/protocol 的 QuestionOption) */
export interface QuestionOption {
  value: string;
  label: string;
  description?: string;
  recommended?: boolean;
  /** 选项对照物(markdown),选中时展示(版式/结构类决策的可视化对比) */
  preview?: string;
}

/** ask_user 问题卡里的单个问题(镜像 @agtpilot/protocol 的 QuestionItem) */
export interface QuestionItem {
  question: string;
  context?: string;
  options: QuestionOption[];
  /** 该问多选(答案按选中项顿号拼接);缺省单选 */
  multiSelect?: boolean;
  allowFreeText?: boolean;
}

/** ask_user 问题卡(模糊需求先问后猜;镜像 @agtpilot/protocol 的 UserQuestion)。
 *  一次调用可打包 1-3 个相关问题,一张卡答完一次提交;kind='plan' 为计划确认门 */
export interface PendingQuestion {
  id: string;
  /** question=澄清提问(缺省),plan=计划确认(confirm_plan) */
  kind?: 'question' | 'plan';
  questions: QuestionItem[];
  /** plan 卡的任务清单(展示用) */
  planTasks?: string[];
  taskId?: string;
  userId?: string;
  missionId?: string;
  /** 超时时刻(ms epoch):到点未答按各问推荐项自动继续 */
  expiresAt?: number;
}

export interface ArtifactVisualSlide {
  title?: string;
  subtitle?: string;
  badge?: string;
  points?: string[];
  quote?: string;
  footnote?: string;
  theme?: 'red' | 'amber' | 'emerald' | 'blue' | 'purple' | 'dark';
}

export interface ArtifactSocialPostMeta {
  platform?: 'xiaohongshu' | 'wechat' | 'twitter' | 'zhihu' | 'general';
  title?: string;
  coverTitle?: string;
  coverSubtitle?: string;
  tags?: string[];
  emojiCount?: number;
  wordCount?: number;
  slides?: ArtifactVisualSlide[];
}

export interface ArtifactState {
  /** 产物 id(服务端 payload 为完整 ArtifactData,art_<ts>_<rand>;续聊轮
   *  自动落地刷新按原 id 就地更新,交付库不长重复记录) */
  id?: string;
  title?: string;
  type?: string;
  content: string;
  /** 产物描述(服务端 ArtifactData 透传;「收尾自动落入交付库」标记是
   *  自动抽取产物的身份锚,续聊刷新只覆盖带此标记的,不碰模型显式发布的) */
  description?: string;
  postMeta?: ArtifactSocialPostMeta;
  /** type='file' 时携带:二进制文件本体在服务端文件库,凭 fileId 走 /api/artifacts/file 下载 */
  fileMeta?: {
    fileId: string;
    fileName: string;
    mime: string;
    sizeBytes: number;
  };
  /** 产物归属的任务 id（核心层盖章）——历史会话切换时按它防串台 */
  taskId?: string;
  /**
   * 摘要投影标记(lib/mission-wire.ts toArtifactSummary):state/init 与懒回水
   * core 对终态会话的长正文只带开头摘录 —— 交付库列表/搜索占位够用,全文在
   * 打开详情/复制/下载时经 /api/agent/mission/[id]?parts=artifact 按需取回。
   * 短正文(≤ 摘录阈值)原样下发,不带本标记。
   */
  contentTruncated?: boolean;
  /** 截断前原始正文字符数(contentTruncated 时携带;UI 展示「全文 x 字」) */
  contentChars?: number;
}

export interface User {
  id: string;
  name: string;
  email: string;
  avatar?: string;
  role: 'user' | 'admin';
  tier: 'Starter' | 'Pro' | 'Enterprise';
  tokensUsed: number;
  tokensLimit: number;
  createdAt: string;
}

export interface MemoryItem {
  id: string;
  category: 'preference' | 'project' | 'fact' | 'rule';
  title: string;
  content: string;
  confidence: number;
  updatedAt: number;
  /** manual = 记忆库页面手动添加；auto = 会话结束自动提炼沉淀 */
  source?: 'manual' | 'auto';
  /** 记忆主体：user = 用户事实记忆（画像/偏好）；agent = Agent 经验记忆（环境/工具/流程） */
  subject?: 'user' | 'agent';
  /** 来源任务引用（自动提炼时记录，构成情景记忆的时间锚点） */
  missionId?: string;
  /** 被召回（检索或注入）的累计次数，用于衰减与「疑似过时」判定 */
  hitCount?: number;
  /** 最近一次被召回的时间 */
  lastHitAt?: number;
}

export interface CronJobItem {
  id: string;
  name: string;
  pattern: string;
  prompt: string;
  /** 订阅类任务标记:触发时按最新档案重建 prompt(如 xhs_weekly_topics 每周选题、oss_radar_weekly 雷达周扫) */
  scenario?: CronScenario;
  /** 普通任务显式引用的技能包名(canonical name;场景订阅任务 = 内置 SOP,永不携带) */
  skillPacks?: string[];
  nextRun?: string;
  runCount: number;
  lastRunAt?: number;
  status: 'active' | 'paused' | 'cancelled';
}

export interface GoalMilestone {
  id: string;
  title: string;
  description?: string;
  status: 'pending' | 'in_progress' | 'completed';
  dueDate?: string;
  completedAt?: number;
}

export interface GoalItem {
  id: string;
  title: string;
  description: string;
  category?: 'engineering' | 'learning' | 'career' | 'efficiency' | 'finance' | 'custom';
  status: 'active' | 'completed' | 'paused';
  progress: number;
  targetDate?: string;
  createdAt: number;
  updatedAt: number;
  milestones: GoalMilestone[];
  /** 「推进此里程碑」派发时透传给任务的技能包引用(canonical name) */
  skillPacks?: string[];
  linkedMissionIds?: string[];
  linkedDeliverableIds?: string[];
}

