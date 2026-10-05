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
}

const CONNECTOR_DEFS: Array<Omit<ConnectorInfo, 'status' | 'keyMasked'>> = [
  {
    id: 'deepseek',
    name: 'DeepSeek LLM (Kernel)',
    icon: 'Brain',
    category: 'AI & MicroVM',
    envVar: 'DEEPSEEK_API_KEY',
    description: 'DeepSeek-V3 / R1 reasoning core for Cordis microkernel orchestration.',
  },
  {
    id: 'openai',
    name: 'OpenAI (GPT-4o)',
    icon: 'Bot',
    category: 'AI & MicroVM',
    envVar: 'OPENAI_API_KEY',
    description: 'Vercel AI SDK fallback model provider for multimodal reasoning.',
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
    description: 'Repository access, git diff, patch commit, and pull request automation.',
  },
  {
    id: 'notion',
    name: 'Notion Workspace',
    icon: 'FileText',
    category: 'Productivity',
    envVar: 'NOTION_TOKEN',
    description: 'Autonomous documentation sync, database query, and page creation.',
  },
  {
    id: 'slack',
    name: 'Slack Webhook',
    icon: 'MessageSquare',
    category: 'Communication',
    envVar: 'SLACK_WEBHOOK_URL',
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

function getConnectorStatusList(): ConnectorInfo[] {
  return CONNECTOR_DEFS.map((def) => {
    const val = process.env[def.envVar] || '';
    const isSet = Boolean(val && val.trim().length > 0 && !val.includes('dummy'));
    const keyMasked = isSet
      ? `${val.slice(0, 4)}...${val.slice(-4)}`
      : undefined;

    return {
      ...def,
      status: isSet ? 'connected' : 'unconfigured',
      keyMasked,
    };
  });
}

export async function GET() {
  const connectors = getConnectorStatusList();
  return NextResponse.json({
    success: true,
    total: connectors.length,
    connectedCount: connectors.filter((c) => c.status === 'connected').length,
    connectors,
  });
}

export async function POST(req: NextRequest) {
  try {
    const { envVar, value } = await req.json();
    if (!envVar || typeof value !== 'string') {
      return NextResponse.json({ success: false, error: 'Invalid parameters' }, { status: 400 });
    }

    // 更新当前进程的内存环境变量
    process.env[envVar] = value.trim();

    return NextResponse.json({
      success: true,
      message: `Connector ${envVar} updated successfully`,
      connectors: getConnectorStatusList(),
    });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
