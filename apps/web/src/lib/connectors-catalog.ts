/**
 * 连接器目录与状态装配（从 /api/connectors 路由抽出，
 * 供该路由与首屏聚合接口 /api/bootstrap 共用，避免重复实现漂移）。
 */
import { getUserConnectors } from '@/lib/user-store';

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
  /** 思考深度档位(low|medium|high);空 = 未配置(回落全局 env / 厂商缺省) */
  reasoningEffort?: string;
  reasoningEffortEnvVar?: string;
  platformType?: 'web' | 'mobile' | 'both';
  /** 官网 / Key 获取页：配置弹窗内展示「打开官网获取 Key」跳转 */
  websiteUrl?: string;
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
    reasoningEffortEnvVar: 'DEEPSEEK_REASONING_EFFORT',
    description: 'DeepSeek 官方或中转推理核心，支持 DeepSeek-V3 与 R1 深度思考模型。',
    websiteUrl: 'https://platform.deepseek.com/api_keys',
    configHint: '打开 DeepSeek 开放平台登录，在 API Keys 页创建 Key 后粘贴到下方。用中转站时 Key 填中转的，并在下方 Base URL 填中转地址。',
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
    reasoningEffortEnvVar: 'OPENAI_REASONING_EFFORT',
    description: '官方或中转 OpenAI 接口，支持 GPT-4o、o1、o3-mini 等任意模型。',
    websiteUrl: 'https://platform.openai.com/api-keys',
    configHint: '打开 OpenAI 平台登录，在 API Keys 页创建 Key 后粘贴到下方。国内中转站请把 Key 与 Base URL 都换成中转的。',
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
    reasoningEffortEnvVar: 'CUSTOM_LLM_REASONING_EFFORT',
    description: '接入任何兼容 OpenAI 标准的中转站、OneAPI、Ollama、SiliconFlow 或本地模型。',
    isModel: true,
  },
  {
    id: 'e2b',
    name: 'E2B Code Interpreter',
    icon: 'Terminal',
    category: 'AI & MicroVM',
    envVar: 'E2B_API_KEY',
    websiteUrl: 'https://e2b.dev/dashboard?tab=keys',
    configHint: '打开 E2B 控制台登录，在 API Keys 页复制 Key 粘贴到下方（有免费额度）。',
    description: 'Firecracker isolated microVM for secure multi-language code execution.',
  },
  {
    id: 'github',
    name: 'GitHub Workspace',
    icon: 'GitPullRequest',
    category: 'Engineering',
    comingSoon: true,
    description: '仓库、Issue 与 PR 自动化（原生工具接入开发中；现在可用下方「GitHub（官方 MCP）」连接器粘贴 PAT 直连，公开仓库问答可用 DeepWiki）。',
  },
  {
    id: 'slack',
    name: 'Slack Webhook',
    icon: 'MessageSquare',
    category: 'Communication',
    envVar: 'SLACK_WEBHOOK_URL',
    platformType: 'both',
    websiteUrl: 'https://api.slack.com/messaging/webhooks',
    description: '群机器人 Webhook：任务完成、定时巡检与告警经 notify_send_webhook 推送到 Slack 频道。',
  },
  {
    id: 'feishu',
    name: '飞书群机器人',
    icon: 'Bell',
    category: 'Communication',
    envVar: 'FEISHU_WEBHOOK_URL',
    platformType: 'both',
    websiteUrl: 'https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot',
    description: '群机器人 Webhook：任务完成、定时巡检与告警经 notify_send_webhook 以卡片推送到飞书群。',
  },
  {
    id: 'dingtalk',
    name: '钉钉群机器人',
    icon: 'Bell',
    category: 'Communication',
    envVar: 'DINGTALK_WEBHOOK_URL',
    platformType: 'both',
    websiteUrl: 'https://open.dingtalk.com/document/robots/custom-robot-access',
    description: '群机器人 Webhook：任务完成、定时巡检与告警经 notify_send_webhook 以 Markdown 推送到钉钉群（群设置 → 智能群助手 → 添加自定义机器人获取地址）。',
  },
  {
    id: 'wecom',
    name: '企业微信群机器人',
    icon: 'Bell',
    category: 'Communication',
    envVar: 'WECOM_WEBHOOK_URL',
    platformType: 'both',
    websiteUrl: 'https://developer.work.weixin.qq.com/document/path/99110',
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
    id: 'email_imap',
    name: '电子邮件收件 (IMAP)',
    icon: 'Mail',
    category: 'Communication',
    envVar: 'EMAIL_IMAP_CREDENTIAL',
    platformType: 'both',
    configHint:
      '按 账号:授权码 格式填写(QQ/163/Gmail/Outlook 等自动识别 IMAP 服务器)。授权码与 SMTP 通常相同:QQ 需开启 IMAP/SMTP 服务、163 开启 POP3/IMAP/SMTP、Gmail 用应用专用密码。留空则自动复用已配置的「电子邮件 (SMTP)」凭证。自建/企业邮箱可写 账号:授权码:主机:端口(993=SSL,143=STARTTLS)。',
    description:
      'Agent 读你的收件箱:email_list 列最新/未读/按关键词搜邮件,email_read 按 uid 读全文与附件清单(默认不改已读状态)。未单独配置时自动复用 SMTP 凭证。',
  },
  {
    id: 'exa',
    name: 'Exa Neural Search',
    icon: 'Search',
    category: 'Productivity',
    envVar: 'EXA_API_KEY',
    platformType: 'web',
    websiteUrl: 'https://dashboard.exa.ai/onboarding-guest',
    configHint: '打开 Exa 注册页（每月 $10 免费额度，无需绑卡），按引导注册后在 Dashboard 复制 API Key 粘贴到下方。',
    description: 'Semantic neural search engine for real-time web intelligence.',
  },
  {
    id: 'tavily',
    name: 'Tavily AI Search',
    icon: 'Globe',
    category: 'Productivity',
    envVar: 'TAVILY_API_KEY',
    platformType: 'web',
    websiteUrl: 'https://app.tavily.com/home',
    configHint: '打开 Tavily 控制台注册（有免费额度），在 Home 页复制 API Key 粘贴到下方。',
    description: 'Search engine designed for autonomous agent RAG scraping.',
  },
  {
    id: 'firecrawl',
    name: 'Firecrawl Scraper',
    icon: 'Layers',
    category: 'Productivity',
    envVar: 'FIRECRAWL_API_KEY',
    platformType: 'web',
    websiteUrl: 'https://www.firecrawl.dev/app/api-keys',
    configHint: '打开 Firecrawl 的 API Keys 页注册（有免费额度），复制 API Key 粘贴到下方。',
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
    websiteUrl: 'https://mp.weixin.qq.com/',
    mobileAction: {
      scheme: 'weixin://',
      actionName: '唤起微信直接分享',
      canDirectShare: true,
    },
    configHint:
      '按 AppID:AppSecret 格式填写(公众平台 → 设置与开发 → 基本配置);并把本服务器出口 IP 加入该页「IP 白名单」,否则会报 40164。草稿箱接口仅对已认证公众号开放。配置后可在「工坊 → 公众号文章工坊」表单点「测试连接」验证。',
    description:
      '官方草稿箱 API:公众号文章工坊成稿后一键投草稿箱(Agent 调用前经你审批),你在公众平台后台人工审核发布(需已认证公众号 + IP 白名单);移动端仍可唤起微信分享。',
  },
];

export function getActiveModelId(): string {
  if (process.env.ACTIVE_MODEL_ID) {
    return process.env.ACTIVE_MODEL_ID;
  }
  if (process.env.DEEPSEEK_API_KEY) return 'deepseek';
  if (process.env.OPENAI_API_KEY) return 'openai';
  return 'deepseek';
}


/** 允许用户写入的凭证键白名单（防止 POST 任意 envVar 键名注入配置） */
export const ALLOWED_ENV_VARS = new Set<string>(
  CONNECTOR_DEFS.flatMap((d) =>
    [d.envVar, d.baseUrlEnvVar, d.modelNameEnvVar, d.reasoningEffortEnvVar].filter(
      (v): v is string => Boolean(v)
    )
  )
);

/** '' = 默认(跟随全局/厂商缺省);none = 显式关闭思考(gpt-5 系口径,deepseek 分支无此档自动不下发) */
export const VALID_REASONING_EFFORTS = new Set(['', 'low', 'medium', 'high', 'none']);

/** 合法的默认模型 ID */
export const VALID_MODEL_IDS = new Set<string>(
  CONNECTOR_DEFS.filter((d) => d.isModel).map((d) => d.id)
);

/** 脱敏：只保留末 4 位，其余全部打码（原实现暴露首 4 + 尾 4，泄露面过大） */
export function maskSecret(val: string): string {
  return val.length > 8 ? `****${val.slice(-4)}` : '****';
}

export function getConnectorStatusList(userId?: string): ConnectorInfo[] {
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
    // 思考深度回显:只认合法档位(env 里被塞了脏值也不透传给前端下拉)
    const rawEffort = lookup(def.reasoningEffortEnvVar);
    const reasoningEffort =
      rawEffort && VALID_REASONING_EFFORTS.has(rawEffort) && rawEffort !== ''
        ? rawEffort
        : undefined;

    return {
      ...def,
      status: isSet ? 'connected' : 'unconfigured',
      keyMasked,
      isDefaultModel: def.isModel ? def.id === activeModel : undefined,
      baseUrl,
      customModelName,
      reasoningEffort,
    };
  });
}
