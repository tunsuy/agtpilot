export interface AgentEvent {
  type: 'thought' | 'tool_call' | 'tool_result' | 'ui_card' | 'approval_request' | 'done' | 'error';
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
