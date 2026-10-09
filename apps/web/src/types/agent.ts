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
  status: 'connected' | 'unconfigured';
  keyMasked?: string;
  quickAuthUrl?: string;
  authHint?: string;
  docUrl?: string;
  /** 已挂载的工具数（连接成功后） */
  toolCount?: number;
  /** 最近一次连接失败原因（排障用） */
  lastError?: string;
}

export interface MissionStep {
  id: string;
  title: string;
  tool?: string;
  role?: 'user' | 'assistant' | 'tool';
  userPrompt?: string;
  status: 'PENDING' | 'RUNNING' | 'DONE' | 'FAILED';
  /** 工具步骤开始时间（用于计算真实耗时，替代旧的硬编码假值） */
  startedAt?: number;
  duration?: string;
  args?: any;
  answer?: string;
  output?: any;
  error?: string;
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
  viewport?: ViewportState;
  terminalLogs?: TerminalLog[];
  artifact?: ArtifactState | null;
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
}

export interface ApprovalRequest {
  id: string;
  action: string;
  description: string;
  dangerLevel: 'low' | 'medium' | 'high';
  params: Record<string, any>;
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
  title?: string;
  type?: string;
  content: string;
  postMeta?: ArtifactSocialPostMeta;
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
  linkedMissionIds?: string[];
  linkedDeliverableIds?: string[];
}

