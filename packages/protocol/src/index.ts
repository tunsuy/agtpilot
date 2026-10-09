export interface ArtifactData {
  id: string;
  title: string;
  type: 'code' | 'html' | 'markdown' | 'chart';
  content: string;
  language?: string;
  description?: string;
  timestamp: number;
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
}

export interface AgentEvent {
  type: 'thought' | 'tool_call' | 'tool_result' | 'ui_card' | 'artifact' | 'plan' | 'approval_request' | 'approval_resolved' | 'connector_suggestion' | 'connector_suggestion_resolved' | 'viewport_update' | 'terminal_output' | 'done' | 'error';
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
