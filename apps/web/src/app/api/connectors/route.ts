import { NextRequest, NextResponse } from 'next/server';

export interface ConnectorInfo {
  id: string;
  name: string;
  icon: string;
  category: 'Cloud' | 'Productivity' | 'Engineering' | 'Communication' | 'AI & MicroVM';
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

const CONNECTOR_DEFS: Array<Omit<ConnectorInfo, 'status' | 'keyMasked' | 'isDefaultModel'>> = [
  {
    id: 'deepseek',
    name: 'DeepSeek',
    icon: 'Brain',
    category: 'AI & MicroVM',
    envVar: 'DEEPSEEK_API_KEY',
    baseUrlEnvVar: 'DEEPSEEK_BASE_URL',
    modelNameEnvVar: 'DEEPSEEK_MODEL_NAME',
    description: 'DeepSeek 官方或中转推理核心，支持 DeepSeek-V3 与 R1 深度思考模型。',
    isModel: true,
  },
  {
    id: 'openai',
    name: 'OpenAI',
    icon: 'Bot',
    category: 'AI & MicroVM',
    envVar: 'OPENAI_API_KEY',
    baseUrlEnvVar: 'OPENAI_BASE_URL',
    modelNameEnvVar: 'OPENAI_MODEL_NAME',
    description: '官方或中转 OpenAI 接口，支持 GPT-4o、o1、o3-mini 等任意模型。',
    isModel: true,
  },
  {
    id: 'custom_llm',
    name: '自定义模型 (OpenAI 兼容)',
    icon: 'Cpu',
    category: 'AI & MicroVM',
    envVar: 'CUSTOM_LLM_API_KEY',
    baseUrlEnvVar: 'CUSTOM_LLM_BASE_URL',
    modelNameEnvVar: 'CUSTOM_LLM_MODEL_NAME',
    description: '接入任何兼容 OpenAI 标准的中转站、OneAPI、Ollama、SiliconFlow 或本地模型。',
    isModel: true,
  },
  {
    id: 'e2b',
    name: 'E2B Code Interpreter',
    icon: 'Terminal',
    category: 'AI & MicroVM',
    envVar: 'E2B_API_KEY',
    description: 'Firecracker isolated microVM for secure multi-language code execution.',
  },
  {
    id: 'github',
    name: 'GitHub Workspace',
    icon: 'GitPullRequest',
    category: 'Engineering',
    envVar: 'GITHUB_TOKEN',
    authType: 'oauth',
    oauthProvider: 'github',
    description: 'Repository access, git diff, patch commit, and pull request automation.',
  },
  {
    id: 'notion',
    name: 'Notion Workspace',
    icon: 'FileText',
    category: 'Productivity',
    envVar: 'NOTION_TOKEN',
    authType: 'oauth',
    oauthProvider: 'notion',
    description: 'Autonomous documentation sync, database query, and page creation.',
  },
  {
    id: 'slack',
    name: 'Slack Webhook',
    icon: 'MessageSquare',
    category: 'Communication',
    envVar: 'SLACK_WEBHOOK_URL',
    authType: 'oauth',
    oauthProvider: 'slack',
    description: 'Direct channel broadcasts, escalation alerts, and approval notifications.',
  },
  {
    id: 'feishu',
    name: '飞书 / Lark Bot',
    icon: 'Bell',
    category: 'Communication',
    envVar: 'FEISHU_WEBHOOK_URL',
    description: 'Enterprise IM webhook notifications and card messaging.',
  },
  {
    id: 'exa',
    name: 'Exa Neural Search',
    icon: 'Search',
    category: 'Productivity',
    envVar: 'EXA_API_KEY',
    description: 'Semantic neural search engine for real-time web intelligence.',
  },
  {
    id: 'tavily',
    name: 'Tavily AI Search',
    icon: 'Globe',
    category: 'Productivity',
    envVar: 'TAVILY_API_KEY',
    description: 'Search engine designed for autonomous agent RAG scraping.',
  },
  {
    id: 'firecrawl',
    name: 'Firecrawl Scraper',
    icon: 'Layers',
    category: 'Productivity',
    envVar: 'FIRECRAWL_API_KEY',
    description: 'Deep web scraping, dynamic JS rendering, and markdown distillation.',
  },
];

function getActiveModelId(): string {
  if (process.env.ACTIVE_MODEL_ID) {
    return process.env.ACTIVE_MODEL_ID;
  }
  if (process.env.DEEPSEEK_API_KEY) return 'deepseek';
  if (process.env.OPENAI_API_KEY) return 'openai';
  return 'deepseek';
}

import { auth } from '@/auth';
import { getUserConnectors, saveUserConnector, setUserActiveModel } from '@/lib/user-store';

function getConnectorStatusList(userId?: string): ConnectorInfo[] {
  const userConfigs = userId ? getUserConnectors(userId) : { configs: {}, activeModelId: 'deepseek' };
  const activeModel = userConfigs.activeModelId || getActiveModelId();

  return CONNECTOR_DEFS.map((def) => {
    // 优先读取用户独立配置，若未设置则回退全局默认配置
    const val = (userId && userConfigs.configs[def.envVar]) || process.env[def.envVar] || '';
    const isSet = Boolean(val && val.trim().length > 0 && !val.includes('dummy'));
    const keyMasked = isSet
      ? `${val.slice(0, 4)}...${val.slice(-4)}`
      : undefined;

    const baseUrl = def.baseUrlEnvVar
      ? (userId && userConfigs.configs[def.baseUrlEnvVar]) || process.env[def.baseUrlEnvVar] || ''
      : undefined;
    const customModelName = def.modelNameEnvVar
      ? (userId && userConfigs.configs[def.modelNameEnvVar]) || process.env[def.modelNameEnvVar] || ''
      : undefined;

    return {
      ...def,
      status: isSet ? 'connected' : 'unconfigured',
      keyMasked,
      isDefaultModel: def.isModel ? def.id === activeModel : undefined,
      baseUrl,
      customModelName,
    };
  });
}

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json(
      { success: false, error: 'Unauthorized: 请先登录后查看个人连接器' },
      { status: 401 }
    );
  }

  const userId = session.user.id;
  const connectors = getConnectorStatusList(userId);
  const userConfigs = getUserConnectors(userId);

  return NextResponse.json({
    success: true,
    total: connectors.length,
    connectedCount: connectors.filter((c) => c.status === 'connected').length,
    activeModelId: userConfigs.activeModelId,
    connectors,
  });
}

export async function POST(req: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json(
        { success: false, error: 'Unauthorized: 请先登录后操作' },
        { status: 401 }
      );
    }

    const userId = session.user.id;
    const body = await req.json();

    // 1. 设置默认模型
    if (body.action === 'setDefaultModel' && typeof body.modelId === 'string') {
      setUserActiveModel(userId, body.modelId);
      return NextResponse.json({
        success: true,
        message: `Default model switched to ${body.modelId}`,
        activeModelId: body.modelId,
        connectors: getConnectorStatusList(userId),
      });
    }

    // 2. 支持批量更新（针对带有 API Key, Base URL, Model Name 的连接器）
    if (body.action === 'saveConnectorConfig' && typeof body.envVar === 'string') {
      const { envVar, value, baseUrlEnvVar, baseUrl, modelNameEnvVar, modelName } = body;
      if (typeof value === 'string') {
        saveUserConnector(userId, envVar, value.trim());
      }
      if (baseUrlEnvVar && typeof baseUrl === 'string') {
        saveUserConnector(userId, baseUrlEnvVar, baseUrl.trim());
      }
      if (modelNameEnvVar && typeof modelName === 'string') {
        saveUserConnector(userId, modelNameEnvVar, modelName.trim());
      }
      const userConfigs = getUserConnectors(userId);
      return NextResponse.json({
        success: true,
        message: `Connector ${envVar} updated successfully`,
        activeModelId: userConfigs.activeModelId,
        connectors: getConnectorStatusList(userId),
      });
    }

    // 3. 单个环境变量更新
    const { envVar, value } = body;
    if (!envVar || typeof value !== 'string') {
      return NextResponse.json({ success: false, error: 'Invalid parameters' }, { status: 400 });
    }

    saveUserConnector(userId, envVar, value.trim());
    const userConfigs = getUserConnectors(userId);

    return NextResponse.json({
      success: true,
      message: `Connector ${envVar} updated successfully`,
      activeModelId: userConfigs.activeModelId,
      connectors: getConnectorStatusList(userId),
    });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
