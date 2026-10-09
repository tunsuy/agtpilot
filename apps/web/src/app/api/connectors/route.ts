import { NextRequest, NextResponse } from 'next/server';

export interface ConnectorInfo {
  id: string;
  name: string;
  icon: string;
  category: 'Cloud' | 'Productivity' | 'Engineering' | 'Communication' | 'AI & MicroVM';
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
  mobileAction?: {
    scheme?: string;
    actionName?: string;
    canDirectShare?: boolean;
  };
  /** 能力尚未接入后端：隐藏配置/授权入口，展示「即将支持」 */
  comingSoon?: boolean;
  /** 免凭证连接器：仅有移动端真机唤起等免密能力，不提供任何凭证输入 */
  noCredential?: boolean;
  /** 配置弹窗内的补充说明（凭证格式/前置条件等） */
  configHint?: string;
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
    comingSoon: true,
    description: '仓库、Issue 与 PR 自动化（后端工具接入开发中；公开仓库问答可先用下方 DeepWiki MCP 连接器）。',
  },
  {
    id: 'slack',
    name: 'Slack Webhook',
    icon: 'MessageSquare',
    category: 'Communication',
    envVar: 'SLACK_WEBHOOK_URL',
    platformType: 'both',
    description: '群机器人 Webhook：任务完成、定时巡检与告警经 notify_send_webhook 推送到 Slack 频道。',
  },
  {
    id: 'feishu',
    name: '飞书 / Lark Bot',
    icon: 'Bell',
    category: 'Communication',
    envVar: 'FEISHU_WEBHOOK_URL',
    platformType: 'both',
    description: '群机器人 Webhook：任务完成、定时巡检与告警经 notify_send_webhook 以卡片推送到飞书群。',
  },
  {
    id: 'dingtalk',
    name: '钉钉群机器人',
    icon: 'Bell',
    category: 'Communication',
    envVar: 'DINGTALK_WEBHOOK_URL',
    platformType: 'both',
    description: '群机器人 Webhook：任务完成、定时巡检与告警经 notify_send_webhook 以 Markdown 推送到钉钉群（群设置 → 智能群助手 → 添加自定义机器人获取地址）。',
  },
  {
    id: 'wecom',
    name: '企业微信群机器人',
    icon: 'Bell',
    category: 'Communication',
    envVar: 'WECOM_WEBHOOK_URL',
    platformType: 'both',
    description: '群机器人 Webhook：任务完成、定时巡检与告警经 notify_send_webhook 以 Markdown 推送到企业微信群（群聊 → 右键群机器人 → 添加获取地址）。',
  },
  {
    id: 'email_smtp',
    name: '电子邮件 (SMTP)',
    icon: 'Mail',
    category: 'Communication',
    envVar: 'EMAIL_SMTP_CREDENTIAL',
    platformType: 'both',
    configHint:
      '按 账号:授权码 格式填写(QQ/163/Gmail/Outlook 等自动识别服务器)。QQ:邮箱设置→账户→开启 SMTP 并生成授权码;163:设置→POP3/SMTP→开启并获取授权码;Gmail:开启两步验证后生成应用专用密码——均不是登录密码。自建/企业邮箱可写 账号:授权码:主机:端口。',
    description:
      'Agent 用你的邮箱直接发信:任务报告、内容投递、通知提醒,email_send 工具支持 Markdown 自动排版 HTML 邮件与多收件人抄送。',
  },
  {
    id: 'exa',
    name: 'Exa Neural Search',
    icon: 'Search',
    category: 'Productivity',
    envVar: 'EXA_API_KEY',
    platformType: 'web',
    description: 'Semantic neural search engine for real-time web intelligence.',
  },
  {
    id: 'tavily',
    name: 'Tavily AI Search',
    icon: 'Globe',
    category: 'Productivity',
    envVar: 'TAVILY_API_KEY',
    platformType: 'web',
    description: 'Search engine designed for autonomous agent RAG scraping.',
  },
  {
    id: 'firecrawl',
    name: 'Firecrawl Scraper',
    icon: 'Layers',
    category: 'Productivity',
    envVar: 'FIRECRAWL_API_KEY',
    platformType: 'web',
    description: 'Deep web scraping, dynamic JS rendering, and markdown distillation.',
  },
  {
    id: 'xiaohongshu',
    name: '小红书创作者服务',
    icon: 'Share2',
    category: 'Communication',
    noCredential: true,
    platformType: 'mobile',
    mobileAction: {
      scheme: 'xhsdiscover://',
      actionName: '唤起手机小红书 App',
      canDirectShare: true,
    },
    description: '移动端免凭证：一键唤起手机小红书 App 发布笔记与导入相册图集（网页端自动发布暂未接入）。',
  },
  {
    id: 'wechat_mp',
    name: '微信公众号(草稿箱直连)',
    icon: 'Share2',
    category: 'Communication',
    envVar: 'WECHAT_MP_CREDENTIAL',
    platformType: 'both',
    mobileAction: {
      scheme: 'weixin://',
      actionName: '唤起微信直接分享',
      canDirectShare: true,
    },
    configHint:
      '按 AppID:AppSecret 格式填写(公众平台 → 设置与开发 → 基本配置);并把本服务器出口 IP 加入该页「IP 白名单」,否则会报 40164。草稿箱接口仅对已认证公众号开放。',
    description:
      '官方草稿箱 API:Agent 自动撰文、排版并写入公众号草稿箱,人工审核后发布(需已认证公众号 + IP 白名单);移动端仍可唤起微信分享。',
  },
  {
    id: 'twitter',
    name: 'X / Twitter 客户端',
    icon: 'Share2',
    category: 'Communication',
    noCredential: true,
    platformType: 'mobile',
    mobileAction: {
      scheme: 'twitter://',
      actionName: '唤起 X App 发推',
      canDirectShare: true,
    },
    description: '移动端免凭证：一键唤起 X 客户端带参编辑发推（Developer API 自动发推暂未接入）。',
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

/** 允许用户写入的凭证键白名单（防止 POST 任意 envVar 键名注入配置） */
const ALLOWED_ENV_VARS = new Set<string>(
  CONNECTOR_DEFS.flatMap((d) =>
    [d.envVar, d.baseUrlEnvVar, d.modelNameEnvVar].filter(
      (v): v is string => Boolean(v)
    )
  )
);

/** 合法的默认模型 ID */
const VALID_MODEL_IDS = new Set<string>(
  CONNECTOR_DEFS.filter((d) => d.isModel).map((d) => d.id)
);

/** 脱敏：只保留末 4 位，其余全部打码（原实现暴露首 4 + 尾 4，泄露面过大） */
function maskSecret(val: string): string {
  return val.length > 8 ? `****${val.slice(-4)}` : '****';
}

function getConnectorStatusList(userId?: string): ConnectorInfo[] {
  const userConfigs = userId ? getUserConnectors(userId) : { configs: {}, activeModelId: 'deepseek' };
  const activeModel = userConfigs.activeModelId || getActiveModelId();

  return CONNECTOR_DEFS.map((def) => {
    // 优先读取用户独立配置，若未设置则回退全局默认配置
    const lookup = (key?: string) =>
      key ? (userId && userConfigs.configs[key]) || process.env[key] || '' : '';
    const val = lookup(def.envVar);
    const isSet = Boolean(val && val.trim().length > 0 && !val.includes('dummy'));
    const keyMasked = isSet ? maskSecret(val) : undefined;

    const baseUrl = lookup(def.baseUrlEnvVar) || undefined;
    const customModelName = lookup(def.modelNameEnvVar) || undefined;

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
      if (!VALID_MODEL_IDS.has(body.modelId)) {
        return NextResponse.json(
          { success: false, error: `无效的模型 ID: ${body.modelId}` },
          { status: 400 }
        );
      }
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
      if (!ALLOWED_ENV_VARS.has(envVar)) {
        return NextResponse.json(
          { success: false, error: `不允许写入的配置键: ${envVar}` },
          { status: 400 }
        );
      }
      if (typeof value === 'string') {
        saveUserConnector(userId, envVar, value.trim());
      }
      if (baseUrlEnvVar && typeof baseUrl === 'string' && ALLOWED_ENV_VARS.has(baseUrlEnvVar)) {
        saveUserConnector(userId, baseUrlEnvVar, baseUrl.trim());
      }
      if (modelNameEnvVar && typeof modelName === 'string' && ALLOWED_ENV_VARS.has(modelNameEnvVar)) {
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
    if (!ALLOWED_ENV_VARS.has(envVar)) {
      return NextResponse.json(
        { success: false, error: `不允许写入的配置键: ${envVar}` },
        { status: 400 }
      );
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
