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
  type: 'thought' | 'tool_call' | 'tool_result' | 'ui_card' | 'artifact' | 'plan' | 'approval_request' | 'done' | 'error';
  payload: Record<string, any>;
  timestamp: number;
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
