import type { MCPServerConfig } from '@agtpilot/plugin-mcp';
import { getUserConnectors, getMcpAuth } from './user-store';
import { UserMcpOAuthProvider } from './mcp-oauth-provider';

/**
 * MCP 连接器目录（自研连接器体系 · 一期首批）
 *
 * 设计原则（对齐商业个人 Agent 产品的做法）：
 * - 能一键授权的绝不让用户跑命令行：OAuth 类走 MCP 标准授权
 *   （RFC 9728/8414 元数据发现 + RFC 7591 动态注册 + PKCE），用户只需点一次「一键授权」；
 * - 无 OAuth 的服务降级为「打开授权页 → 粘贴 Token/Key」，附引导链接与提示文案；
 * - 端点均为服务方官方托管的远程 MCP Server（Streamable HTTP），无需本地安装任何东西。
 */

export interface McpServerDef {
  /** 服务器别名（工具名前缀：mcp_{alias}_{tool}），同一连接器多服务器时区分 */
  name: string;
  /** 端点 URL；token 类可为模板函数（凭证拼进 query 或 header）。http/sse 必填，stdio 忽略 */
  url?: string | ((cred: string) => string);
  transport?: 'http' | 'sse' | 'stdio';
  /** token 类的静态凭证头模板（如腾讯文档 Authorization 原始 token、腾讯会议自定义头） */
  headers?: (cred: string) => Record<string, string>;
  /** stdio：本地子进程启动命令（如 npx） */
  command?: string;
  /** stdio：命令参数；token 类可为模板函数（把凭证拆分注入，如 lark -a <appId> -s <secret>） */
  args?: string[] | ((cred: string) => string[]);
  /** stdio：子进程环境变量；token 类可为模板函数（凭证经 env 注入，避免出现在命令行/进程列表） */
  env?: (cred: string) => Record<string, string>;
  label?: string;
}

export interface McpConnectorDef {
  id: string;
  name: string;
  icon: string;
  category: string;
  description: string;
  /** oauth = 一键授权；token = 打开授权页粘贴凭证；none = 免凭证直连 */
  authType: 'oauth' | 'token' | 'none';
  /**
   * opt-in（authType='none' 时有效）：默认不连接,需用户在卡片上显式「启用」后才挂载。
   * 用于本地子进程类重型连接器(如浏览器自动化),避免为每个用户/任务默认拉起子进程。
   * 启用状态存于 tokenEnvVar 指向的键(值为 '1')。
   */
  optIn?: boolean;
  /** token 类凭证 / optIn 开关在 user-store connectors 里的存储键 */
  tokenEnvVar?: string;
  /** OAuth scope（如企查查 mcp:tools） */
  scope?: string;
  /** 「打开授权页」引导链接（获取 Token/Key 的官方页面） */
  quickAuthUrl?: string;
  /** 弹窗内的引导文案 */
  authHint?: string;
  docUrl?: string;
  servers: McpServerDef[];
}

export const MCP_CONNECTOR_DEFS: McpConnectorDef[] = [
  // ---- OAuth 一键授权 ----
  {
    id: 'notion_mcp',
    name: 'Notion（官方 MCP）',
    icon: 'FileText',
    category: 'Productivity',
    description: 'Notion 官方托管 MCP：读写页面与数据库、搜索工作区，一键授权免填 Key。',
    authType: 'oauth',
    quickAuthUrl: 'https://www.notion.so/help/notion-mcp',
    servers: [{ name: 'notion', url: 'https://mcp.notion.com/mcp', label: 'Notion 全量' }],
  },
  {
    id: 'dida365',
    name: '滴答清单',
    icon: 'Check',
    category: 'Productivity',
    description: '任务与日程管理：创建/查询/完成待办、清单管理，一键授权直连官方 MCP。',
    authType: 'oauth',
    servers: [{ name: 'dida365', url: 'https://mcp.dida365.com' }],
  },
  {
    id: 'openalex',
    name: 'OpenAlex 学术',
    icon: 'Search',
    category: 'Productivity',
    description: '2.5 亿+ 学术文献检索：论文、作者、机构与引用关系，科研调研利器。',
    authType: 'oauth',
    servers: [{ name: 'openalex', url: 'https://mcp.openalex.org/mcp' }],
  },
  {
    id: 'qcc',
    name: '企查查',
    icon: 'Building2',
    category: 'Productivity',
    description: '企业工商信息查询：公司背景、风险、知识产权、经营与高管信息（官方 MCP，一键授权）。',
    authType: 'oauth',
    scope: 'mcp:tools',
    servers: [{ name: 'qcc', url: 'https://agent.qcc.com/mcp/company/stream', label: '企业工商' }],
  },
  {
    id: 'ardot',
    name: '腾讯设计 Ardot',
    icon: 'Palette',
    category: 'Productivity',
    description: '腾讯设计平台官方 MCP：设计稿读写、设计系统与导出，一键授权直连。',
    authType: 'oauth',
    docUrl: 'https://docs.ardot.tencent.com/ardot-mcp/introduction.html',
    servers: [{ name: 'ardot', url: 'https://ardot.tencent.com/mcp' }],
  },
  {
    id: 'atlassian_mcp',
    name: 'Atlassian（Jira + Confluence）',
    icon: 'KanbanSquare',
    category: 'Productivity',
    description:
      'Atlassian 官方托管 MCP（Rovo）：Jira 工单查询/创建/流转、Confluence 页面读写与搜索、Bitbucket 仓库，一键授权直连（仅支持 Atlassian Cloud）。',
    authType: 'oauth',
    quickAuthUrl: 'https://support.atlassian.com/atlassian-ai-gateway/docs/get-started-with-the-atlassian-remote-mcp-server/',
    docUrl: 'https://www.atlassian.com/platform/rovo-mcp',
    servers: [
      {
        name: 'atlassian',
        // v2 端点(2026-02 GA;v1/SSE 2026-06-30 停用)。tools=all 返回全量工具(默认是精选子集)
        url: 'https://mcp.atlassian.com/v2/mcp?tools=all',
        label: 'Jira + Confluence',
      },
    ],
  },

  // ---- 打开授权页粘贴凭证 ----
  {
    id: 'amap',
    name: '高德地图',
    icon: 'MapPin',
    category: 'Cloud',
    description: '地理编码、POI 搜索、驾车/公交/步行路线规划、天气查询（官方 MCP，粘贴 Key 即用）。',
    authType: 'token',
    tokenEnvVar: 'MCP_AMAP_KEY',
    quickAuthUrl: 'https://console.amap.com/dev/key/app',
    authHint: '在高德开放平台创建「Web 服务」类型 Key，复制后粘贴到下方',
    docUrl: 'https://lbs.amap.com/api/mcp-server/gettingstarted',
    servers: [{ name: 'amap', url: (cred) => `https://mcp.amap.com/mcp?key=${encodeURIComponent(cred)}` }],
  },
  {
    id: 'baidu_map',
    name: '百度地图',
    icon: 'Map',
    category: 'Cloud',
    description: '地点检索、正/逆地理编码、路线规划、天气与行政区划（官方 MCP，粘贴 AK 即用）。',
    authType: 'token',
    tokenEnvVar: 'MCP_BAIDU_MAP_AK',
    quickAuthUrl: 'https://lbs.baidu.com/apiconsole/key',
    authHint: '在百度地图开放平台创建「服务端」应用获取 AK，并启用 MCP 服务，复制后粘贴到下方',
    docUrl: 'https://lbsyun.baidu.com/faq/api?title=mcpserver/quickstart',
    servers: [{ name: 'baidu_map', url: (cred) => `https://mcp.map.baidu.com/mcp?ak=${encodeURIComponent(cred)}` }],
  },
  {
    id: 'tencent_docs',
    name: '腾讯文档',
    icon: 'FileSpreadsheet',
    category: 'Productivity',
    description: '读写腾讯文档、智能表格与空间文件：创建、搜索、编辑、导出（官方 MCP，粘贴 Token 即用）。',
    authType: 'token',
    tokenEnvVar: 'MCP_TENCENT_DOCS_TOKEN',
    quickAuthUrl: 'https://docs.qq.com/open/auth/mcp.html',
    authHint: '打开授权页登录，复制页面上的 Token 并粘贴到下方',
    docUrl: 'https://developer.cloud.tencent.com/mcp/server/11803',
    servers: [
      {
        name: 'tencent_docs',
        url: 'https://docs.qq.com/openapi/mcp',
        // 腾讯文档要求 Authorization 头直接放原始 token（不带 Bearer 前缀）
        headers: (cred) => ({ Authorization: cred }),
      },
    ],
  },
  {
    id: 'tencent_meeting',
    name: '腾讯会议',
    icon: 'Video',
    category: 'Communication',
    description: '会议管理、查询、录制与智能纪要（官方 MCP，粘贴 Token 即用）。',
    authType: 'token',
    tokenEnvVar: 'MCP_TENCENT_MEETING_TOKEN',
    quickAuthUrl: 'https://meeting.tencent.com/ai-skill.html',
    authHint: '打开授权页登录腾讯会议，复制页面上的 Token 并粘贴到下方',
    servers: [
      {
        name: 'tencent_meeting',
        url: 'https://mcp.meeting.tencent.com/mcp/wemeet-open/v1',
        headers: (cred) => ({ 'X-Tencent-Meeting-Token': cred, 'X-Skill-Version': 'v1.0.1' }),
      },
    ],
  },

  {
    id: 'didi',
    name: '滴滴出行',
    icon: 'Car',
    category: 'Cloud',
    description: '网约车预估/叫车、地点检索与出行路线规划（官方 MCP，粘贴 Key 即用）。',
    authType: 'token',
    tokenEnvVar: 'MCP_DIDI_KEY',
    quickAuthUrl: 'https://mcp.didichuxing.com',
    authHint: '打开滴滴开发者控制台登录并激活个人 MCP Key，复制后粘贴到下方',
    docUrl: 'https://mcp.didichuxing.com/api',
    servers: [{ name: 'didi', url: (cred) => `https://mcp.didichuxing.com/mcp-servers?key=${encodeURIComponent(cred)}` }],
  },
  {
    id: 'tencent_weiyun',
    name: '腾讯微云',
    icon: 'Cloud',
    category: 'Cloud',
    description: '网盘文件管理：列表、上传、下载、分享链接与目录整理（官方 MCP，粘贴 Token 即用）。',
    authType: 'token',
    tokenEnvVar: 'MCP_WEIYUN_TOKEN',
    quickAuthUrl: 'https://www.weiyun.com/act/openclaw',
    authHint: '打开微云 Skill 配置页登录，复制 MCP Token 并粘贴到下方（整段 env 粘贴也可以，会自动提取）',
    docUrl: 'https://www.weiyun.com/act/openclaw',
    servers: [
      {
        name: 'tencent_weiyun',
        url: 'https://www.weiyun.com/api/v3/mcpserver',
        headers: (cred) => ({ WyHeader: `mcp_token=${normalizeWeiyunToken(cred)}` }),
      },
    ],
  },
  {
    id: 'tencent_lexiang',
    name: '腾讯乐享',
    icon: 'Library',
    category: 'Productivity',
    description: '企业知识库检索、阅读、创建与文档管理（官方 MCP，粘贴 Token 即用）。',
    authType: 'token',
    tokenEnvVar: 'MCP_LEXIANG_TOKEN',
    quickAuthUrl: 'https://lexiangla.com/ai/claw',
    authHint: '打开乐享凭证页登录，复制访问令牌粘贴到下方',
    docUrl: 'https://qclaw.qq.com/docs/211858629271314432',
    servers: [
      {
        name: 'tencent_lexiang',
        url: 'https://mcp.lexiang-app.com/mcp?preset=meta',
        headers: (cred) => ({ Authorization: `Bearer ${cred}` }),
      },
    ],
  },
  {
    id: 'youdao_note',
    name: '有道云笔记',
    icon: 'NotebookPen',
    category: 'Productivity',
    description: '笔记创建、搜索、整理与管理（官方 MCP，粘贴 API Key 即用）。',
    authType: 'token',
    tokenEnvVar: 'MCP_YOUDAO_NOTE_KEY',
    quickAuthUrl: 'https://mopen.163.com/#/dashboard',
    authHint: '打开授权页登录 MCP 平台，在 API 管理创建 API Key 并粘贴到下方',
    docUrl: 'https://qclaw.qq.com/docs/207508177113886720',
    servers: [
      {
        name: 'youdao_note',
        transport: 'sse',
        url: 'https://open.mail.163.com/api/ynote/mcp/sse',
        headers: (cred) => ({ 'x-api-key': cred }),
      },
    ],
  },

  {
    id: 'github_mcp',
    name: 'GitHub（官方 MCP）',
    icon: 'Github',
    category: 'Engineering',
    description:
      'GitHub 官方托管 MCP：仓库/Issue/PR 查询与操作、代码搜索、Actions 状态（粘贴 Fine-grained Personal Access Token 即用）。',
    authType: 'token',
    tokenEnvVar: 'MCP_GITHUB_PAT',
    quickAuthUrl: 'https://github.com/settings/personal-access-tokens/new',
    authHint:
      'GitHub → Settings → Developer settings → Fine-grained personal access tokens → Generate new token：按需勾选仓库与权限（读取选 Contents: Read / Issues: Read / Pull requests: Read，需写操作再勾选 Write），生成后粘贴到下方。',
    docUrl: 'https://github.com/github/github-mcp-server',
    servers: [
      {
        name: 'github_mcp',
        url: 'https://api.githubcopilot.com/mcp/',
        headers: (cred) => ({ Authorization: `Bearer ${cred}` }),
      },
    ],
  },

  {
    id: 'zhihu',
    name: '知乎',
    icon: 'MessagesSquare',
    category: 'Productivity',
    description:
      '知乎数据开放平台官方 MCP：站内搜索问答/文章、全网聚合搜索、实时热榜（粘贴 Access Secret 即用，每天免费 1000 次）。',
    authType: 'token',
    tokenEnvVar: 'MCP_ZHIHU_SECRET',
    quickAuthUrl: 'https://developer.zhihu.com/profile',
    authHint: '登录知乎数据开放平台个人页，复制 Access Secret 粘贴到下方（一处密钥同时开通搜索/全网/热榜三个能力）',
    docUrl: 'https://developer.zhihu.com/',
    servers: [
      {
        name: 'zhihu_search',
        transport: 'sse',
        url: 'https://developer.zhihu.com/api/mcp/zhihu_search/v1/sse',
        headers: (cred) => ({ Authorization: `Bearer ${cred}` }),
        label: '站内搜索',
      },
      {
        name: 'zhihu_global',
        transport: 'sse',
        url: 'https://developer.zhihu.com/api/mcp/global_search/v1/sse',
        headers: (cred) => ({ Authorization: `Bearer ${cred}` }),
        label: '全网搜索',
      },
      {
        name: 'zhihu_hot',
        transport: 'sse',
        url: 'https://developer.zhihu.com/api/mcp/hot_list/v1/sse',
        headers: (cred) => ({ Authorization: `Bearer ${cred}` }),
        label: '热榜',
      },
    ],
  },

  // ---- 免凭证直连 ----
  {
    id: 'deepwiki',
    name: 'DeepWiki 代码知识库',
    icon: 'BookOpen',
    category: 'Engineering',
    description: 'Devin 团队出品：对任意 GitHub 公开仓库提问，理解大型开源代码库（免凭证直连）。',
    authType: 'none',
    servers: [{ name: 'deepwiki', url: 'https://mcp.deepwiki.com/mcp' }],
  },
  {
    id: 'browser_auto',
    name: '浏览器自动化 (Playwright)',
    icon: 'Globe',
    category: 'Engineering',
    description:
      'Playwright 官方 MCP：让 Agent 打开网页、点击、填表、截图、抓取动态渲染内容（本地 stdio 无头 Chromium，免凭证）。需服务器已安装 Chrome/Chromium；因是重型本地子进程，默认关闭，点「启用」后才为你的任务挂载。',
    authType: 'none',
    optIn: true,
    tokenEnvVar: 'MCP_BROWSER_OPTIN',
    docUrl: 'https://github.com/microsoft/playwright-mcp',
    servers: [
      {
        name: 'browser_auto',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@playwright/mcp@latest', '--headless', '--isolated'],
      },
    ],
  },

  // ---- 投研行情数据（投资理财场景：官方托管优先，本地 stdio 兜底）----
  {
    id: 'tushare',
    name: 'Tushare 投研数据',
    icon: 'TrendingUp',
    category: 'Finance',
    description:
      'Tushare Pro 官方 MCP：A股/基金/期货行情、财务报表、宏观与指数数据（官方托管远程直连，粘贴个人 Token；积分制，注册即有免费额度）。',
    authType: 'token',
    tokenEnvVar: 'MCP_TUSHARE_TOKEN',
    quickAuthUrl: 'https://tushare.pro/user/token',
    authHint:
      '注册/登录 Tushare Pro → 个人主页 →「接口 TOKEN」复制粘贴到下方。新用户注册即有免费积分，部分高级接口需要更高积分（捐赠/贡献可提升）。',
    docUrl: 'https://tushare.pro/document/1?doc_id=463',
    servers: [
      {
        name: 'tushare',
        // 官方端点把 token 拼在 URL 路径里（非 header）
        url: (cred) => `https://api.tushare.pro/mcp/token=${encodeURIComponent(cred)}`,
        label: '投研数据',
      },
    ],
  },
  {
    id: 'alphavantage_mcp',
    name: 'Alpha Vantage（美股/外汇/加密）',
    icon: 'LineChart',
    category: 'Finance',
    description:
      'Alpha Vantage 官方托管 MCP：全球股票、外汇、大宗商品、加密货币的实时报价与 20 年历史数据、技术指标、基本面（免费 API Key 直连，已收录 Anthropic 官方 MCP 目录）。',
    authType: 'token',
    tokenEnvVar: 'MCP_ALPHAVANTAGE_KEY',
    quickAuthUrl: 'https://www.alphavantage.co/support/#api-key',
    authHint:
      '打开 Alpha Vantage 官网 API Key 页，填邮箱立即免费获取 API Key，复制粘贴到下方（免费档 25 次请求/天，付费档更高）。',
    docUrl: 'https://mcp.alphavantage.co/',
    servers: [
      {
        name: 'alphavantage',
        // 官方端点用 query 参数传 API Key
        url: (cred) => `https://mcp.alphavantage.co/mcp?apikey=${encodeURIComponent(cred)}`,
      },
    ],
  },
  {
    id: 'coingecko_mcp',
    name: 'CoinGecko 加密行情',
    icon: 'Coins',
    category: 'Finance',
    description:
      'CoinGecko 官方 MCP（免凭证远程直连）：100 万+ 加密资产实时/历史价格、市值与成交量、DeFi 池与链上数据。免费档为共享限流；工具数量多，默认关闭，点「启用」后才为你的任务挂载。',
    authType: 'none',
    optIn: true,
    tokenEnvVar: 'MCP_COINGECKO_OPTIN',
    docUrl: 'https://docs.coingecko.com/ai-integration/mcp-server',
    servers: [{ name: 'coingecko', url: 'https://mcp.api.coingecko.com/mcp' }],
  },
  {
    id: 'a_stock',
    name: 'A股实时行情 (AkShare)',
    icon: 'CandlestickChart',
    category: 'Finance',
    description:
      '基于 AkShare 的开源 A股数据 MCP（本地 stdio，免凭证免注册）：实时价格、历史 K线、公司信息、大盘概览、财务数据。需服务器预装 Python 包 a-stock-mcp-server（pip install a-stock-mcp-server）；本地子进程默认关闭，点「启用」后才挂载。',
    authType: 'none',
    optIn: true,
    tokenEnvVar: 'MCP_ASTOCK_OPTIN',
    docUrl: 'https://github.com/Llldmiao/a-stock-mcp-server',
    servers: [
      {
        name: 'a_stock',
        transport: 'stdio',
        command: 'python3',
        args: ['-m', 'a_stock_mcp_server'],
      },
    ],
  },

  // ---- 学习教研（教育场景：论文全文 / AI 学习资源 / 翻译润色，均为官方托管远程端点）----
  {
    id: 'alphaxiv',
    name: 'alphaXiv 论文库',
    icon: 'FileText',
    category: 'Education',
    description:
      'alphaXiv 官方 MCP：300 万+ arXiv 论文语义检索、PDF 全文问答、热门论文速览、研究者追踪与个人文献库管理（免费注册拿 API Key，检索分析计入免费额度）。',
    authType: 'token',
    tokenEnvVar: 'MCP_ALPHAXIV_TOKEN',
    quickAuthUrl: 'https://www.alphaxiv.org/',
    authHint:
      '注册/登录 alphaXiv → Settings → API Keys → 创建后复制粘贴到下方（走 Authorization: Bearer 头）。',
    docUrl: 'https://www.alphaxiv.org/docs/mcp',
    servers: [
      {
        name: 'alphaxiv',
        url: 'https://api.alphaxiv.org/mcp/v1',
        headers: (cred) => ({ Authorization: `Bearer ${cred}` }),
      },
    ],
  },
  {
    id: 'huggingface_mcp',
    name: 'Hugging Face（官方 MCP）',
    icon: 'Bot',
    category: 'Education',
    description:
      'Hugging Face 官方 MCP（免凭证远程直连）：搜索模型/数据集/Spaces/论文、官方文档语义检索、调用社区 Gradio 工具，AI 学习与科研提效利器。工具数量多，默认关闭，点「启用」后才为你的任务挂载。',
    authType: 'none',
    optIn: true,
    tokenEnvVar: 'MCP_HUGGINGFACE_OPTIN',
    docUrl: 'https://huggingface.co/docs/hub/en/agents-mcp',
    servers: [{ name: 'huggingface', url: 'https://huggingface.co/mcp' }],
  },
  {
    id: 'deepl_mcp',
    name: 'DeepL 翻译润色',
    icon: 'Languages',
    category: 'Education',
    description:
      'DeepL 官方远程 MCP（OAuth 一键授权，免费计划可用）：高质量文本/文档翻译、学术润色改写、语法纠错、术语表与写作风格规则管理，读外文文献与论文润色首选。',
    authType: 'oauth',
    docUrl: 'https://developers.deepl.com/docs/mcp',
    servers: [{ name: 'deepl', url: 'https://mcp.deepl.com/v1/mcp' }],
  },

  // ---- 官方 stdio MCP（本地子进程，凭证按用户注入 env/args，绝不进 process.env）----
  {
    id: 'lark_suite',
    name: '飞书 / Lark（官方全家桶）',
    icon: 'Feather',
    category: 'Productivity',
    description:
      '飞书官方 lark-mcp：消息、云文档、多维表格、日历、任务、邮箱等全套办公能力（本地 stdio 运行，粘贴企业自建应用 AppID:AppSecret）。',
    authType: 'token',
    tokenEnvVar: 'MCP_LARK_APP_CRED',
    quickAuthUrl: 'https://open.feishu.cn/app',
    authHint:
      '飞书开放平台 → 创建/选择「企业自建应用」→「凭证与基础信息」页复制 App ID 与 App Secret，按 AppID:AppSecret 格式填写到下方；并在「权限管理」开通所需 API 权限（如消息、云文档、日历）。',
    docUrl: 'https://github.com/larksuite/lark-openapi-mcp',
    servers: [
      {
        name: 'lark_suite',
        transport: 'stdio',
        command: 'npx',
        args: (cred) => {
          const c = parseAppCredential(cred);
          return ['-y', '@larksuiteoapi/lark-mcp', 'mcp', '-a', c?.id || '', '-s', c?.secret || ''];
        },
      },
    ],
  },
  {
    id: 'dingtalk_mcp',
    name: '钉钉（官方 MCP）',
    icon: 'Zap',
    category: 'Productivity',
    description:
      '钉钉官方 dingtalk-mcp：待办、日历、通讯录、群机器人消息、考勤、日志等能力（本地 stdio 运行，粘贴企业内部应用 ClientID:ClientSecret）。',
    authType: 'token',
    tokenEnvVar: 'MCP_DINGTALK_APP_CRED',
    quickAuthUrl: 'https://open-dev.dingtalk.com/fe/app',
    authHint:
      '钉钉开放平台 → 应用开发 → 创建/选择「企业内部应用」→「凭证与基础信息」复制 Client ID 与 Client Secret，按 ClientID:ClientSecret 格式填写到下方；并在「权限管理」添加所需接口权限。',
    docUrl: 'https://github.com/open-dingtalk/dingtalk-mcp',
    servers: [
      {
        name: 'dingtalk_mcp',
        transport: 'stdio',
        command: 'npx',
        // 凭证经 env 注入（不出现在命令行，避免进程列表泄露）
        args: ['-y', 'dingtalk-mcp@latest'],
        env: (cred) => {
          const c = parseAppCredential(cred);
          return {
            DINGTALK_Client_ID: c?.id || '',
            DINGTALK_Client_Secret: c?.secret || '',
            ACTIVE_PROFILES:
              'dingtalk-tasks,dingtalk-calendar,dingtalk-robot-send-message,dingtalk-contacts',
          };
        },
      },
    ],
  },
  {
    id: 'yuque',
    name: '语雀（官方 MCP）',
    icon: 'BookMarked',
    category: 'Productivity',
    description:
      '语雀官方 yuque-mcp：知识库/文档读写、搜索、目录与小记管理（本地 stdio 运行，粘贴语雀 API Token）。',
    authType: 'token',
    tokenEnvVar: 'MCP_YUQUE_TOKEN',
    quickAuthUrl: 'https://www.yuque.com/settings/tokens',
    authHint:
      '语雀 → 个人设置 → Token → 新建 Token（按需勾选读写范围），复制后粘贴到下方。',
    docUrl: 'https://github.com/yuque/yuque-mcp-server',
    servers: [
      {
        name: 'yuque',
        transport: 'stdio',
        command: 'npx',
        // 凭证经 env 注入（不出现在命令行，避免进程列表泄露）
        args: ['-y', 'yuque-mcp'],
        env: (cred) => ({ YUQUE_TOKEN: cred }),
      },
    ],
  },

  // ---- 信息源热榜 / 海外社媒数据（本地 stdio：聚合热榜免凭证，X 数据按量计费）----
  {
    id: 'newsnow',
    name: '全网热榜 (NewsNow)',
    icon: 'Newspaper',
    category: 'Productivity',
    description:
      'NewsNow 官方 MCP（本地 stdio，免凭证免注册）：一个连接器聚合 40+ 全网热榜——微博实时热搜、今日头条、知乎、百度热搜、抖音、哔哩哔哩、快手、腾讯新闻、澎湃、36氪、华尔街见闻、财联社、雪球热门股票、金十数据、Hacker News、GitHub Trending 等。默认走 NewsNow 公共实例；本地子进程默认关闭，点「启用」后才为你的任务挂载。',
    authType: 'none',
    optIn: true,
    tokenEnvVar: 'MCP_NEWSNOW_OPTIN',
    docUrl: 'https://github.com/newsnext/newsnow',
    servers: [
      {
        name: 'newsnow',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', 'newsnow-mcp-server'],
        // 数据源默认走 NewsNow 作者维护的公共实例；若公共实例限流/下线，
        // 自部署一个 NewsNow 后端并设置 NEWSNOW_BASE_URL 即可无缝切换（只进子进程，不碰全局 env）
        env: () => ({ BASE_URL: process.env.NEWSNOW_BASE_URL || 'https://newsnow.busiyi.world' }),
      },
    ],
  },
  {
    id: 'twitterapi_io',
    name: 'X / Twitter 数据',
    icon: 'Twitter',
    category: 'Productivity',
    description:
      'twitterapi.io 官方 MCP（本地 stdio）：12 个只读工具——推文搜索（支持 from:/since:/lang: 等高级语法）、用户资料与最新推文、粉丝/关注/提及列表、推文回复/引用/转推者、趋势话题。无需注册 X 开发者账号，twitterapi.io 注册即拿 API Key，按量计费（约 $0.15/千条推文），注册送免费试用额度。与「X / Twitter 客户端」连接器（仅唤起 App 发推）互补。',
    authType: 'token',
    tokenEnvVar: 'MCP_TWITTERAPI_IO_KEY',
    quickAuthUrl: 'https://twitterapi.io/dashboard',
    authHint:
      '注册/登录 twitterapi.io → Dashboard 复制 API Key 粘贴到下方（Key 经 env 注入子进程，不出现在命令行；按量计费，新用户有免费试用额度）。',
    docUrl: 'https://docs.twitterapi.io/introduction',
    servers: [
      {
        name: 'twitterapi_io',
        transport: 'stdio',
        command: 'npx',
        // 凭证经 env 注入（不出现在命令行，避免进程列表泄露）；用官方新包名（@kaitoinfra 旧包已废弃）
        args: ['-y', '@twitterapi_io/mcp-server'],
        env: (cred) => ({ TWITTERAPI_IO_API_KEY: cred }),
      },
    ],
  },
];

export function getMcpConnectorDef(id: string): McpConnectorDef | undefined {
  return MCP_CONNECTOR_DEFS.find((d) => d.id === id);
}

/** 微云 Token 归一化：用户可能整段粘贴 `WEIYUN_MCP_TOKEN=xx` / `mcp_token=xx` 片段，自动提取裸 token */
export function normalizeWeiyunToken(raw: string): string {
  const text = (raw || '').trim().replace(/^["']|["']$/g, '');
  if (!text) return '';
  const m = text.match(/mcp_token=([^\s;,&"']+)/i) || text.match(/WEIYUN_MCP_TOKEN\s*=\s*['"]?([^'"\s]+)/i);
  return m ? m[1].trim() : text;
}

/** 解析「ID:Secret」组合凭证（飞书 AppID:AppSecret / 钉钉 ClientID:ClientSecret），容忍中文冒号与空格 */
export function parseAppCredential(raw: string): { id: string; secret: string } | null {
  const t = (raw || '').trim();
  if (!t) return null;
  const parts = t.split(/\s*[:：]\s*/);
  if (parts.length < 2 || !parts[0].trim() || !parts[1].trim()) return null;
  return { id: parts[0].trim(), secret: parts.slice(1).join(':').trim() };
}

/** MCP OAuth start → callback 之间传递 CSRF state 的 httpOnly cookie 名 */
export const MCP_OAUTH_STATE_COOKIE = 'mcp_oauth_state';

/** token 类凭证键 + optIn 开关键白名单（POST saveToken 校验用） */
export const MCP_TOKEN_ENV_VARS = new Set(
  MCP_CONNECTOR_DEFS.filter((d) => (d.authType === 'token' || d.optIn) && d.tokenEnvVar).map(
    (d) => d.tokenEnvVar!
  )
);

/** 把 McpServerDef 按凭证展开成 plugin-mcp 的 MCPServerConfig（http/sse 拼 url+headers，stdio 拼 command/args/env） */
function serverConfigFromDef(
  s: McpServerDef,
  cred: string,
  authProvider?: MCPServerConfig['authProvider']
): MCPServerConfig {
  const transport = s.transport || 'http';
  if (transport === 'stdio') {
    if (!s.command) throw new Error(`stdio 类型 MCP Server ${s.name} 缺少 command`);
    return {
      name: s.name,
      transport: 'stdio',
      command: s.command,
      args: typeof s.args === 'function' ? s.args(cred) : s.args || [],
      env: s.env ? s.env(cred) : undefined,
    };
  }
  const url = typeof s.url === 'function' ? s.url(cred) : s.url || '';
  return {
    name: s.name,
    transport,
    url,
    headers: s.headers ? s.headers(cred) : undefined,
    authProvider,
  };
}

/**
 * 依据用户已配置的凭证，构建该用户当前应连接的 MCP Server 清单。
 * - none（非 optIn）：无条件直连；
 * - none + optIn：用户显式启用（configs[key]==='1'）才连；
 * - token：已保存凭证才连（URL 模板 / 静态头注入 / stdio args+env 注入）；
 * - oauth：已完成一键授权才连（挂 OAuthClientProvider，SDK 自动带 token + 401 刷新）。
 */
export function buildUserMcpServers(userId: string): MCPServerConfig[] {
  const { configs } = getUserConnectors(userId);
  const servers: MCPServerConfig[] = [];

  for (const def of MCP_CONNECTOR_DEFS) {
    if (def.authType === 'token') {
      const cred = (configs[def.tokenEnvVar!] || '').trim();
      if (!cred) continue;
      for (const s of def.servers) servers.push(serverConfigFromDef(s, cred));
    } else if (def.authType === 'oauth') {
      const record = getMcpAuth(userId, def.id);
      if (!record?.tokens?.access_token) continue;
      for (const s of def.servers) {
        const url = typeof s.url === 'function' ? s.url('') : s.url || '';
        servers.push(
          serverConfigFromDef(s, '', new UserMcpOAuthProvider(userId, def.id, url, def.scope))
        );
      }
    } else {
      // none
      if (def.optIn && def.tokenEnvVar && (configs[def.tokenEnvVar] || '').trim() !== '1') continue;
      for (const s of def.servers) servers.push(serverConfigFromDef(s, ''));
    }
  }
  return servers;
}
