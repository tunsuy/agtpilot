export interface ConnectorApp {
  id: string;
  name: string;
  category: string;
  icon: string;
  status: 'connected' | 'unconfigured';
  envVar: string;
  description: string;
  keyMasked?: string;
  isModel?: boolean;
  isDefaultModel?: boolean;
  baseUrl?: string;
  baseUrlEnvVar?: string;
  customModelName?: string;
  modelNameEnvVar?: string;
  authType?: 'api_key' | 'oauth';
  oauthProvider?: string;
  oauthScope?: string;
}

export interface MissionStep {
  id: string;
  title: string;
  tool?: string;
  status: 'PENDING' | 'RUNNING' | 'DONE' | 'FAILED';
  duration?: string;
  args?: any;
  answer?: string;
  output?: any;
}

export interface Mission {
  id: string;
  userId?: string;
  title: string;
  status: 'ACTIVE' | 'DONE' | 'QUEUED' | 'WAITING_APPROVAL';
  progress: number;
  startedAt: number;
  steps: MissionStep[];
  conversationMessages?: Array<{ role: 'user' | 'assistant' | 'tool'; content: any }>;
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

export interface ArtifactState {
  title?: string;
  type?: string;
  content: string;
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

