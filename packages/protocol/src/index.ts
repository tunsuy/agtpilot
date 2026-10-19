/**
 * 二进制文件产物的元信息(S2 · ppt-master 真 .pptx 交付):
 * 文件本体存服务端文件库(artifact-files.ts,按用户隔离),
 * mission JSON 里只带 fileId 与展示元数据,不落二进制内容。
 */
export interface ArtifactFileMeta {
  /** 服务端文件库内的文件 id(下载路由凭此定位) */
  fileId: string;
  /** 下载/展示用文件名(含扩展名) */
  fileName: string;
  /** MIME 类型(如 application/vnd.openxmlformats-officedocument.presentationml.presentation) */
  mime: string;
  /** 文件字节数(前端展示体积) */
  sizeBytes: number;
}

export interface ArtifactData {
  id: string;
  title: string;
  /** file:二进制文件产物(如 .pptx),content 只放人类可读摘要,本体走 fileMeta.fileId 下载 */
  type: 'code' | 'html' | 'markdown' | 'chart' | 'file';
  content: string;
  language?: string;
  description?: string;
  timestamp: number;
  /** 产生该产物的任务键（多用户部署时前端按其归属任务，避免串台） */
  taskId?: string;
  /** type='file' 时必带:服务端文件库定位信息 */
  fileMeta?: ArtifactFileMeta;
}

export interface PlanTask {
  id: string;
  title: string;
  description?: string;
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  result?: string;
}

export interface PlanData {
  id: string;
  goal: string;
  tasks: PlanTask[];
  currentTaskId?: string;
  createdAt: number;
  updatedAt: number;
  /** 所属任务键（= orchestrator taskId；多用户部署时前端按其过滤归属任务） */
  taskKey?: string;
}

export interface AgentEvent {
  type:
    | 'thought'
    | 'tool_call'
    | 'tool_result'
    | 'ui_card'
    | 'artifact'
    | 'plan'
    | 'approval_request'
    | 'approval_resolved'
    | 'connector_suggestion'
    | 'connector_suggestion_resolved'
    /** agent 主动向用户提问(ask_user 工具):payload = UserQuestion */
    | 'question_request'
    /** 问题已回答/超时/中止:payload = { id, outcome: 'answered' | 'timeout' | 'aborted', answer? } */
    | 'question_resolved'
    | 'viewport_update'
    | 'terminal_output'
    | 'sandbox_deny'
    | 'done'
    | 'error'
    /** 每步模型调用开始（前端"正在思考"指示）；payload: { stepNumber?, reason?: 'model-step' | 'wrap-up' } */
    | 'step_started'
    /** 模型流式增量；payload: { delta: string, kind: 'text' | 'reasoning' }。taskId 由编排器统一盖章 */
    | 'assistant_delta'
    /**
     * 模型流遥测（轻量打点，docs/design/observability.md）：TTFT / 静默告警 / 流错误 /
     * 看门狗中止；payload: { kind: 'ttft' | 'stall-warn' | 'stream-error' | 'stream-abort',
     * ms?: number, awaitingFirstToken?: boolean, error?: string }
     */
    | 'model_telemetry';
  payload: Record<string, any>;
  timestamp: number;
}

/** 任务中途连接器授权建议（connector_suggestion 事件 payload） */
export interface ConnectorSuggestion {
  /** 去重键：`${userId}::${connectorId}` */
  id: string;
  connectorId: string;
  connectorName: string;
  /** oauth = 一键授权直达；token = 需到连接器中心粘贴凭证 */
  authType: 'oauth' | 'token' | 'none';
  /** Agent 说明为什么需要这个连接器 */
  reason: string;
  /** oauth 类的一键授权跳转地址 */
  authorizeUrl?: string;
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

/** agent 主动提问卡(question_request 事件 payload):模糊需求先问后猜,
 *  形状对齐 core/contracts.ts 的 DecisionQuestion(消费方从模型换成人)。
 *  一次调用可打包 1-3 个相关问题(方向/范围/形式一起问清),一张卡答完一次提交 */
export interface QuestionOption {
  /** 机器值(回答回填用);缺省时前端以 label 兜底 */
  value: string;
  /** 展示文案 */
  label: string;
  /** 一句话说明该选项的含义/后果 */
  description?: string;
  /** 推荐项徽章(每问至多一个;超时兜底也按它自动继续) */
  recommended?: boolean;
  /** 选项对照物(markdown 文本:布局示意/代码片段/图表描述),选中时展示。
   *  对齐 Claude Code AskUserQuestion 的 preview 字段;仅视觉对比真有帮助时带 */
  preview?: string;
}

/** 问题卡里的单个问题 */
export interface QuestionItem {
  /** 问题正文(面向用户的一句话) */
  question: string;
  /** 为什么需要问(补充上下文,可空) */
  context?: string;
  options: QuestionOption[];
  /** 该问允许多选(答案按选中项顿号拼接);缺省 false 单选 */
  multiSelect?: boolean;
  /** 允许该问自由文本回答(前端展示输入框);缺省 true */
  allowFreeText?: boolean;
}

/** 单问的回答(index 对应 questions 数组序) */
export interface QuestionAnswerItem {
  index: number;
  answer: string;
  via: 'option' | 'free_text';
}

export interface UserQuestion {
  id: string;
  /** 卡类型:question=澄清提问(缺省),plan=计划确认门(confirm_plan,方案批准后才动手) */
  kind?: 'question' | 'plan';
  /** 1-3 个问题;单问也走数组(统一形状)。plan 卡固定一问(按计划执行吗) */
  questions: QuestionItem[];
  /** plan 卡的任务清单(看板要点,展示用;答案仍走 questions[0]) */
  planTasks?: string[];
  /** 发起提问的任务键(SSE 按用户/会话过滤归属) */
  taskId?: string;
  userId?: string;
  missionId?: string;
  /** 超时时刻(ms epoch):到点未答按各问推荐项自动继续 */
  expiresAt?: number;
}

export interface UICardData {
  component: string;
  props: Record<string, any>;
}

export interface ModelStepResult {
  text: string;
  reasoning?: string;
  toolCalls: Array<{
    toolCallId: string;
    toolName: string;
    args: Record<string, any>;
  }>;
  finishReason: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
  };
}

/** 本地 Runner 桥接协议(docs/design/local-runner-bridge.md §5):类型+清洗函数+状态机 */
export * from './runner';

/** 任务包渲染器(执行指令 / T0 交接包 / PR 终稿提取,web 与 runner 同源) */
export * from './runner-taskpack';

/** Phase 2 发布命令集(固化/白名单校验/PR 链接提取,web 与 runner 同源) */
export * from './runner-publish';
