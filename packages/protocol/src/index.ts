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
    | 'viewport_update'
    | 'terminal_output'
    | 'sandbox_deny'
    | 'done'
    | 'error'
    /** 每步模型调用开始（前端"正在思考"指示）；payload: { stepNumber?, reason?: 'model-step' | 'wrap-up' } */
    | 'step_started'
    /** 模型流式增量；payload: { delta: string, kind: 'text' | 'reasoning' }。taskId 由编排器统一盖章 */
    | 'assistant_delta';
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
