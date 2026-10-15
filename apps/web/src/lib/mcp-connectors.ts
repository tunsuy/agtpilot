import type { MCPServerConfig } from '@agtpilot/plugin-mcp';
import type { RequestSigner } from '@agtpilot/plugin-mcp';
import type { ToolRoute } from '@agtpilot/core';
import { DEFAULT_MCP_ALLOW_TOOLS } from '@agtpilot/plugin-subagent';
import { getUserConnectors, getMcpAuth } from './user-store';
import { UserMcpOAuthProvider } from './mcp-oauth-provider';
import { flyaiSigner, resolveFlyaiKey } from './flyai-sign';

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
  /**
   * 子 agent 开放标记（双钥匙的人工钥匙，目录级评审、版本化可审计）。
   * true = 该用户已连接本服务器时，宿主自动把它注入子 agent MCP 白名单
   * （仍需服务器 annotations 只读声明放行具体工具；无注解服务器须另经
   * AGTPILOT_SUBAGENT_MCP_ALLOW_TOOLS 逃生口 + 实测背书）。
   * 标记原则：检索/查询类且性质只读 → true；含写操作/现实副作用/按量计费成本/
   * 行情数字（红线：报告依据数字必须主循环直拉）→ false。
   * 必填字段 = 新增连接器不显式表态就过不了编译（CI 强制同 PR 评审）。
   */
  subagentOpen: boolean;
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
  /**
   * 逐请求动态签名器工厂(http/sse 有效;stdio 忽略)。吃凭证、吐 RequestSigner,
   * 由 serverConfigFromDef 展开成 MCPServerConfig.signRequest。用于「签名网关型」
   * 远程 MCP(如飞猪 flyai:每请求现算 HMAC 头),静态 headers 表达不了逐请求签名。
   * 详见 docs/design/mcp-request-signing.md。
   */
  sign?: (cred: string) => RequestSigner;
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
  /**
   * 一键公共试用开关(仅 authType='token' 有效):置真则连接器卡片显示「启用公共试用」按钮,
   * 用户点一下即把哨兵 '1' 存进 tokenEnvVar 完成**手动启用**(而非对所有人默认常连)。
   * server 定义的凭证解析(如飞猪 resolveFlyaiKey)负责把哨兵 '1'/空串映射为内置公共试用凭证,
   * 用户粘贴的自有 key 一律优先。**手动启用而非默认常连**:避免所有用户共享同一试用身份被限流/吊销。
   * 连接判定(configs[tokenEnvVar] 非空即连)、状态展示(哨兵 '1' 显「公共试用通道」)、
   * 卡片 UI(publicTrial → 显启用按钮)三处一致消费本字段。公共试用凭证本身是共享身份,
   * 规模化应引导用户配自有 key(见 authHint);绝不用于放用户私有凭证。
   */
  publicTrial?: boolean;
  /** OAuth scope（如企查查 mcp:tools） */
  scope?: string;
  /**
   * 设备码授权通道（OAuth 2.0 Device Grant, RFC 8628）——「粘贴凭证」之外的第二种获取方式。
   * 适用:授权服务器不支持 DCR(如 GitHub)、或部署在 http/内网无法走浏览器回跳的场景。
   * 用户在服务方页面输一次 user_code,后端轮询换 token,**无回调地址、不要求 https 部署**。
   * 换到的 token 写入 tokenEnvVar 指向的键,复用粘贴凭证的全部消费链路(连接/掩码/断开)。
   * clientIdEnv/clientSecretEnv 两个环境变量齐备时本通道才可用(UI 据此显隐按钮)。
   */
  deviceFlow?: {
    /** 设备码申请端点（如 https://github.com/login/device/code） */
    deviceUrl: string;
    /** token 交换端点（如 https://github.com/login/oauth/access_token） */
    tokenUrl: string;
    /** OAuth App client_id 的环境变量名（值本身绝不进代码/前端） */
    clientIdEnv: string;
    /** OAuth App client_secret 的环境变量名（仅服务端使用） */
    clientSecretEnv: string;
    /** 默认 scope（空格分隔）；scopeEnv 设置时优先 */
    scope?: string;
    /** scope 覆盖环境变量名 */
    scopeEnv?: string;
    /** 用户输码页（前端展示引导链接；缺省时用服务端返回的 verification_uri） */
    verificationUri?: string;
  };
  /** 「打开授权页」引导链接（获取 Token/Key 的官方页面） */
  quickAuthUrl?: string;
  /** 弹窗内的引导文案 */
  authHint?: string;
  docUrl?: string;
  /** 工具路由触发词：prompt 点名这些词时挂载本连接器的 mcp_<server>_* 工具（服务器粒度路由） */
  routeWords?: string[];
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
    /** 工具路由触发词：prompt 点名这些词时挂载本连接器的 mcp_<server>_* 工具（服务器粒度路由） */
    routeWords: ["notion"],
    quickAuthUrl: 'https://www.notion.so/help/notion-mcp',
    servers: [{ name: 'notion', subagentOpen: false, url: 'https://mcp.notion.com/mcp', label: 'Notion 全量' }], // 读写页面/数据库 → 不开放
  },
  {
    id: 'dida365',
    name: '滴答清单',
    icon: 'Check',
    category: 'Productivity',
    description: '任务与日程管理：创建/查询/完成待办、清单管理，一键授权直连官方 MCP。',
    authType: 'oauth',
    /** 工具路由触发词：prompt 点名这些词时挂载本连接器的 mcp_<server>_* 工具（服务器粒度路由） */
    routeWords: ["滴答清单", "dida365", "待办"],
    servers: [{ name: 'dida365', subagentOpen: false, url: 'https://mcp.dida365.com' }], // 创建/完成待办 = 写操作
  },
  {
    id: 'openalex',
    name: 'OpenAlex 学术',
    icon: 'Search',
    category: 'Productivity',
    description: '2.5 亿+ 学术文献检索：论文、作者、机构与引用关系，科研调研利器。',
    authType: 'oauth',
    /** 工具路由触发词：prompt 点名这些词时挂载本连接器的 mcp_<server>_* 工具（服务器粒度路由） */
    routeWords: ["openalex", "学术文献", "论文检索", "引用关系"],
    servers: [{ name: 'openalex', subagentOpen: true, url: 'https://mcp.openalex.org/mcp' }], // 学术文献检索,只读
  },
  {
    id: 'qcc',
    name: '企查查',
    icon: 'Building2',
    category: 'Productivity',
    description: '企业工商信息查询：公司背景、风险、知识产权、经营与高管信息（官方 MCP，一键授权）。',
    authType: 'oauth',
    /** 工具路由触发词：prompt 点名这些词时挂载本连接器的 mcp_<server>_* 工具（服务器粒度路由） */
    routeWords: ["企查查", "工商信息", "公司背景", "企业风险"],
    scope: 'mcp:tools',
    servers: [{ name: 'qcc', subagentOpen: true, url: 'https://agent.qcc.com/mcp/company/stream', label: '企业工商' }], // 工商信息查询,只读
  },
  {
    id: 'ardot',
    name: '腾讯设计 Ardot',
    icon: 'Palette',
    category: 'Productivity',
    description: '腾讯设计平台官方 MCP：设计稿读写、设计系统与导出，一键授权直连。',
    authType: 'oauth',
    /** 工具路由触发词：prompt 点名这些词时挂载本连接器的 mcp_<server>_* 工具（服务器粒度路由） */
    routeWords: ["ardot", "腾讯设计", "设计稿", "设计系统"],
    docUrl: 'https://docs.ardot.tencent.com/ardot-mcp/introduction.html',
    servers: [{ name: 'ardot', subagentOpen: false, url: 'https://ardot.tencent.com/mcp' }], // 设计稿读写 → 不开放
  },
  {
    id: 'atlassian_mcp',
    name: 'Atlassian（Jira + Confluence）',
    icon: 'KanbanSquare',
    category: 'Productivity',
    description:
      'Atlassian 官方托管 MCP（Rovo）：Jira 工单查询/创建/流转、Confluence 页面读写与搜索、Bitbucket 仓库，一键授权直连（仅支持 Atlassian Cloud）。',
    authType: 'oauth',
    /** 工具路由触发词：prompt 点名这些词时挂载本连接器的 mcp_<server>_* 工具（服务器粒度路由） */
    routeWords: ["jira", "confluence", "atlassian", "工单"],
    quickAuthUrl: 'https://support.atlassian.com/atlassian-ai-gateway/docs/get-started-with-the-atlassian-remote-mcp-server/',
    docUrl: 'https://www.atlassian.com/platform/rovo-mcp',
    servers: [
      {
        name: 'atlassian',
        subagentOpen: false, // Jira 工单流转 / Confluence 页面写入 → 不开放
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
    /** 工具路由触发词：prompt 点名这些词时挂载本连接器的 mcp_<server>_* 工具（服务器粒度路由） */
    routeWords: ["高德", "amap", "路线规划", "poi", "地理编码"],
    tokenEnvVar: 'MCP_AMAP_KEY',
    quickAuthUrl: 'https://console.amap.com/dev/key/app',
    authHint: '在高德开放平台创建「Web 服务」类型 Key，复制后粘贴到下方',
    docUrl: 'https://lbs.amap.com/api/mcp-server/gettingstarted',
    servers: [{ name: 'amap', subagentOpen: true, url: (cred) => `https://mcp.amap.com/mcp?key=${encodeURIComponent(cred)}` }], // 地理/POI/路线/天气查询,只读
  },
  {
    id: 'baidu_map',
    name: '百度地图',
    icon: 'Map',
    category: 'Cloud',
    description: '地点检索、正/逆地理编码、路线规划、天气与行政区划（官方 MCP，粘贴 AK 即用）。',
    authType: 'token',
    /** 工具路由触发词：prompt 点名这些词时挂载本连接器的 mcp_<server>_* 工具（服务器粒度路由） */
    routeWords: ["百度地图"],
    tokenEnvVar: 'MCP_BAIDU_MAP_AK',
    quickAuthUrl: 'https://lbs.baidu.com/apiconsole/key',
    authHint: '在百度地图开放平台创建「服务端」应用获取 AK，并启用 MCP 服务，复制后粘贴到下方',
    docUrl: 'https://lbsyun.baidu.com/faq/api?title=mcpserver/quickstart',
    servers: [{ name: 'baidu_map', subagentOpen: true, url: (cred) => `https://mcp.map.baidu.com/mcp?ak=${encodeURIComponent(cred)}` }], // 地点/地理编码/路线查询,只读
  },
  {
    id: 'tencent_docs',
    name: '腾讯文档',
    icon: 'FileSpreadsheet',
    category: 'Productivity',
    description: '读写腾讯文档、智能表格与空间文件：创建、搜索、编辑、导出（官方 MCP，粘贴 Token 即用）。',
    authType: 'token',
    /** 工具路由触发词：prompt 点名这些词时挂载本连接器的 mcp_<server>_* 工具（服务器粒度路由） */
    routeWords: ["腾讯文档", "智能表格"],
    tokenEnvVar: 'MCP_TENCENT_DOCS_TOKEN',
    quickAuthUrl: 'https://docs.qq.com/open/auth/mcp.html',
    authHint: '打开授权页登录，复制页面上的 Token 并粘贴到下方',
    docUrl: 'https://developer.cloud.tencent.com/mcp/server/11803',
    servers: [
      {
        name: 'tencent_docs',
        subagentOpen: false, // 创建/编辑文档 = 写操作
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
    /** 工具路由触发词：prompt 点名这些词时挂载本连接器的 mcp_<server>_* 工具（服务器粒度路由） */
    routeWords: ["腾讯会议", "会议纪要"],
    tokenEnvVar: 'MCP_TENCENT_MEETING_TOKEN',
    quickAuthUrl: 'https://meeting.tencent.com/ai-skill.html',
    authHint: '打开授权页登录腾讯会议，复制页面上的 Token 并粘贴到下方',
    servers: [
      {
        name: 'tencent_meeting',
        subagentOpen: false, // 会议管理含创建/录制等写操作
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
    /** 工具路由触发词：prompt 点名这些词时挂载本连接器的 mcp_<server>_* 工具（服务器粒度路由） */
    routeWords: ["滴滴", "叫车", "网约车"],
    tokenEnvVar: 'MCP_DIDI_KEY',
    quickAuthUrl: 'https://mcp.didichuxing.com',
    authHint: '打开滴滴开发者控制台登录并激活个人 MCP Key，复制后粘贴到下方',
    docUrl: 'https://mcp.didichuxing.com/api',
    servers: [{ name: 'didi', subagentOpen: false, url: (cred) => `https://mcp.didichuxing.com/mcp-servers?key=${encodeURIComponent(cred)}` }], // 叫车 = 现实副作用,永不开放
  },
  {
    id: 'kuaidi100',
    name: '快递100',
    icon: 'Package',
    category: 'Life',
    description:
      '包裹物流轨迹查询（覆盖 3000+ 国内外快递公司）、寄件运费预估比价、智能时效预估（物流行业首个官方 MCP，粘贴 Key 即用）。',
    authType: 'token',
    /** 工具路由触发词：prompt 点名这些词时挂载本连接器的 mcp_<server>_* 工具（服务器粒度路由） */
    routeWords: ["快递", "包裹", "物流", "快递100", "kuaidi100", "运单", "查快递"],
    tokenEnvVar: 'MCP_KUAIDI100_KEY',
    // 凭证入口在「企业管理后台」(SPA,授权参数页),不在开放平台营销首页 ——
    // 官方 MCP 使用说明:注册 → 管理后台 → 授权参数处复制 key
    quickAuthUrl: 'https://api.kuaidi100.com/manager/v2/home',
    authHint:
      '注册/登录快递100账号 → 进入「企业管理后台」(未登录会先弹登录) → 在「授权参数」处复制 key,粘贴到下方（新用户有免费额度）。',
    docUrl: 'https://api.kuaidi100.com/document/mcp-summary',
    servers: [
      {
        name: 'kuaidi100',
        subagentOpen: false, // 按量计费(实时查询按次扣费),子 agent 批量检索产生真实费用,未评审开放(同 twitterapi_io 红线)
        // 官方主推 Streamable HTTP（比 SSE 稳），key 走 query 参数
        url: (cred) => `https://api.kuaidi100.com/mcp/streamable?key=${encodeURIComponent(cred)}`,
        label: '快递物流',
      },
    ],
  },
  {
    id: 'flyai',
    name: '飞猪旅行',
    icon: 'Plane',
    category: 'Travel',
    description:
      '飞猪官方 MCP：机票/火车票/酒店/景点/门票搜索与详情（AI 语义搜索 + 极速搜索）。点一下启用内置公共试用通道；粘贴自有 API Key 后优先用你的 Key。',
    authType: 'token',
    /** 工具路由触发词：prompt 点名这些词时挂载本连接器的 mcp_<server>_* 工具（服务器粒度路由） */
    routeWords: ["飞猪", "机票", "航班", "酒店", "火车票", "景点", "门票", "旅行", "flyai"],
    tokenEnvVar: 'MCP_FLYAI_API_KEY',
    /**
     * 一键公共试用(负责人 2026-10-14 拍板「默认公共key 用户配置了用用户的」→「改吧」= 手动启用):
     * 卡片「启用公共试用」把哨兵 '1' 存进 MCP_FLYAI_API_KEY 完成手动启用,resolveFlyaiKey('1')
     * 映射为官方公共试用 Key;用户粘贴自有 Key 则一律优先。手动启用而非对所有人默认常连 ——
     * 避免所有用户共享同一试用身份被飞猪限流/吊销(规模化引导配自有 Key,见 authHint)。
     */
    publicTrial: true,
    quickAuthUrl: 'https://flyai.open.fliggy.com/',
    authHint:
      '点「启用公共试用」即用内置公共试用通道(共享额度,人多可能被限流)。若你有飞猪 flyai 自有 API Key(经飞猪开放平台/官方 CLI @fly-ai/flyai-cli 分发),粘贴到下方即优先用你的 Key(独立额度、不受公共试用限流)。签名密钥为协议公共常量已内置,无需填写。',
    docUrl: 'https://www.npmjs.com/package/@fly-ai/flyai-cli',
    servers: [
      {
        name: 'flyai',
        // 行情数字红线:机票/酒店实时价格是报告/决策依据,必须主循环直拉、不经子 agent 转述;
        // 且旅行搜索涉及购买决策上下文 —— 永不开放给子 agent。
        subagentOpen: false,
        // Streamable HTTP;端点无需 query key(身份走 Authorization 头)
        url: 'https://flyai.open.fliggy.com/mcp',
        transport: 'http',
        // 静态凭证头:Bearer <apiKey>(SDK 并入 init.headers,签名器据此算 sha256(auth))。
        // resolveFlyaiKey:用户 Key 优先;哨兵 '1'(手动启用)/空串回退公共试用 Key。
        headers: (cred) => ({ Authorization: `Bearer ${resolveFlyaiKey(cred)}` }),
        // 逐请求 HMAC-SHA256 签名(方案 a 扩展点);apiKey 经闭包注入,签名密钥走协议常量
        sign: (cred) => flyaiSigner({ apiKey: resolveFlyaiKey(cred) }),
        label: '飞猪搜索',
      },
    ],
  },
  {
    id: 'tencent_weiyun',
    name: '腾讯微云',
    icon: 'Cloud',
    category: 'Cloud',
    description: '网盘文件管理：列表、上传、下载、分享链接与目录整理（官方 MCP，粘贴 Token 即用）。',
    authType: 'token',
    /** 工具路由触发词：prompt 点名这些词时挂载本连接器的 mcp_<server>_* 工具（服务器粒度路由） */
    routeWords: ["微云", "网盘"],
    tokenEnvVar: 'MCP_WEIYUN_TOKEN',
    quickAuthUrl: 'https://www.weiyun.com/act/openclaw',
    authHint: '打开微云 Skill 配置页登录，复制 MCP Token 并粘贴到下方（整段 env 粘贴也可以，会自动提取）',
    docUrl: 'https://www.weiyun.com/act/openclaw',
    servers: [
      {
        name: 'tencent_weiyun',
        subagentOpen: false, // 网盘上传/分享/目录整理 = 写操作
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
    /** 工具路由触发词：prompt 点名这些词时挂载本连接器的 mcp_<server>_* 工具（服务器粒度路由） */
    routeWords: ["乐享", "知识库检索"],
    tokenEnvVar: 'MCP_LEXIANG_TOKEN',
    quickAuthUrl: 'https://lexiangla.com/ai/claw',
    authHint: '打开乐享凭证页登录，复制访问令牌粘贴到下方',
    docUrl: 'https://qclaw.qq.com/docs/211858629271314432',
    servers: [
      {
        name: 'tencent_lexiang',
        subagentOpen: false, // 含知识库创建/文档管理,写面未评审
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
    /** 工具路由触发词：prompt 点名这些词时挂载本连接器的 mcp_<server>_* 工具（服务器粒度路由） */
    routeWords: ["有道云笔记", "youdao"],
    tokenEnvVar: 'MCP_YOUDAO_NOTE_KEY',
    quickAuthUrl: 'https://mopen.163.com/#/dashboard',
    authHint: '打开授权页登录 MCP 平台，在 API 管理创建 API Key 并粘贴到下方',
    docUrl: 'https://qclaw.qq.com/docs/207508177113886720',
    servers: [
      {
        name: 'youdao_note',
        subagentOpen: false, // 笔记创建/整理 = 写操作
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
      'GitHub 官方托管 MCP：仓库/Issue/PR 查询与操作、代码搜索、Actions 状态。推荐「设备码授权」（github.com/login/device 输一次码,token 自动续期,免换 key）；也支持粘贴 Fine-grained PAT（注意 PAT 有强制到期日）。',
    authType: 'token',
    /** 工具路由触发词：prompt 点名这些词时挂载本连接器的 mcp_<server>_* 工具（服务器粒度路由） */
    routeWords: ["github"],
    tokenEnvVar: 'MCP_GITHUB_PAT',
    // 设备码通道:GitHub 授权服务器无 DCR(registration_endpoint 缺失,2026-10-14 实测),
    // 走不通 authType:'oauth' 的 SDK 自动注册流;官方 README 指引设备码为无回跳客户端的授权方式,
    // 换到的 gho_ token 实测可直连 api.githubcopilot.com/mcp/(initialize+tools/list 全通)。
    deviceFlow: {
      deviceUrl: 'https://github.com/login/device/code',
      tokenUrl: 'https://github.com/login/oauth/access_token',
      clientIdEnv: 'AGTPILOT_GITHUB_OAUTH_CLIENT_ID',
      clientSecretEnv: 'AGTPILOT_GITHUB_OAUTH_SECRET',
      // 官方 github-mcp-server README 设备码示例的 code+devinfo 组合;offline_access 用于
      // 新建 OAuth App 的默认短期 token(2026-08-14 起 access 8h)换取 refresh token(6 个月轮换),
      // 由 ensureDeviceTokenFresh 自动续期。未启用 expiring tokens 的 App 会忽略该 scope。
      scope: 'repo read:org read:user user:email workflow offline_access',
      scopeEnv: 'AGTPILOT_GITHUB_OAUTH_SCOPE',
      verificationUri: 'https://github.com/login/device',
    },
    quickAuthUrl: 'https://github.com/settings/personal-access-tokens/new',
    authHint:
      '推荐用「设备码授权」：点按钮后把页面显示的 8 位码填到 github.com/login/device（手机/电脑均可），确认即完成，token 自动续期、无需再换 key。备用方式——Fine-grained PAT：GitHub → Settings → Developer settings → Fine-grained personal access tokens → Generate new token，按需勾选仓库与权限（读取选 Contents: Read / Issues: Read / Pull requests: Read，需写操作再勾选 Write），生成后粘贴到下方；注意 GitHub 强制 PAT 带到期日（最长 1 年），到期需重新生成。',
    docUrl: 'https://github.com/github/github-mcp-server',
    servers: [
      {
        name: 'github_mcp',
        subagentOpen: true, // 官方 annotations 齐全,双钥匙只会放行自报只读的查询/搜索工具
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
    /** 工具路由触发词：prompt 点名这些词时挂载本连接器的 mcp_<server>_* 工具（服务器粒度路由） */
    routeWords: ["知乎", "zhihu"],
    tokenEnvVar: 'MCP_ZHIHU_SECRET',
    quickAuthUrl: 'https://developer.zhihu.com/profile',
    authHint: '登录知乎数据开放平台个人页，复制 Access Secret 粘贴到下方（一处密钥同时开通搜索/全网/热榜三个能力）',
    docUrl: 'https://developer.zhihu.com/',
    servers: [
      {
        name: 'zhihu_search',
        subagentOpen: true, // 站内搜索,只读
        transport: 'sse',
        url: 'https://developer.zhihu.com/api/mcp/zhihu_search/v1/sse',
        headers: (cred) => ({ Authorization: `Bearer ${cred}` }),
        label: '站内搜索',
      },
      {
        name: 'zhihu_global',
        subagentOpen: true, // 全网聚合搜索,只读
        transport: 'sse',
        url: 'https://developer.zhihu.com/api/mcp/global_search/v1/sse',
        headers: (cred) => ({ Authorization: `Bearer ${cred}` }),
        label: '全网搜索',
      },
      {
        name: 'zhihu_hot',
        subagentOpen: true, // 实时热榜,只读
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
    /** 工具路由触发词：prompt 点名这些词时挂载本连接器的 mcp_<server>_* 工具（服务器粒度路由） */
    routeWords: ["deepwiki", "代码知识库"],
    servers: [{ name: 'deepwiki', subagentOpen: true, url: 'https://mcp.deepwiki.com/mcp' }], // 仓库问答,实测全只读(逃生口背书)
  },
  {
    id: 'browser_auto',
    name: '浏览器自动化 (Playwright)',
    icon: 'Globe',
    category: 'Engineering',
    description:
      'Playwright 官方 MCP：让 Agent 打开网页、点击、填表、截图、抓取动态渲染内容（本地 stdio 无头 Chromium，免凭证）。需服务器已安装 Chrome/Chromium；因是重型本地子进程，默认关闭，点「启用」后才为你的任务挂载。',
    authType: 'none',
    /** 工具路由触发词：prompt 点名这些词时挂载本连接器的 mcp_<server>_* 工具（服务器粒度路由） */
    routeWords: ["playwright", "浏览器自动化"],
    optIn: true,
    tokenEnvVar: 'MCP_BROWSER_OPTIN',
    docUrl: 'https://github.com/microsoft/playwright-mcp',
    servers: [
      {
        name: 'browser_auto',
        subagentOpen: false, // 点击/填表/导航 = 写动作,与内置 browser 排除同理
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
    /** 工具路由触发词：prompt 点名这些词时挂载本连接器的 mcp_<server>_* 工具（服务器粒度路由） */
    routeWords: ["tushare", "投研", "财务报表"],
    tokenEnvVar: 'MCP_TUSHARE_TOKEN',
    quickAuthUrl: 'https://tushare.pro/user/token',
    authHint:
      '注册/登录 Tushare Pro → 个人主页 →「接口 TOKEN」复制粘贴到下方。新用户注册即有免费积分，部分高级接口需要更高积分（捐赠/贡献可提升）。',
    docUrl: 'https://tushare.pro/document/1?doc_id=463',
    servers: [
      {
        name: 'tushare',
        subagentOpen: false, // 行情数字红线:报告依据必须主循环直拉
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
    /** 工具路由触发词：prompt 点名这些词时挂载本连接器的 mcp_<server>_* 工具（服务器粒度路由） */
    routeWords: ["alphavantage", "alpha vantage"],
    tokenEnvVar: 'MCP_ALPHAVANTAGE_KEY',
    quickAuthUrl: 'https://www.alphavantage.co/support/#api-key',
    authHint:
      '打开 Alpha Vantage 官网 API Key 页，填邮箱立即免费获取 API Key，复制粘贴到下方（免费档 25 次请求/天，付费档更高）。',
    docUrl: 'https://mcp.alphavantage.co/',
    servers: [
      {
        name: 'alphavantage',
        subagentOpen: false, // 行情数字红线:报告依据必须主循环直拉
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
    /** 工具路由触发词：prompt 点名这些词时挂载本连接器的 mcp_<server>_* 工具（服务器粒度路由） */
    routeWords: ["coingecko", "加密货币", "币价", "defi"],
    optIn: true,
    tokenEnvVar: 'MCP_COINGECKO_OPTIN',
    docUrl: 'https://docs.coingecko.com/ai-integration/mcp-server',
    servers: [{ name: 'coingecko', subagentOpen: false, url: 'https://mcp.api.coingecko.com/mcp' }], // 行情数字红线:报告依据必须主循环直拉
  },
  {
    id: 'a_stock',
    name: 'A股实时行情 (AkShare)',
    icon: 'CandlestickChart',
    category: 'Finance',
    description:
      '基于 AkShare 的开源 A股数据 MCP（本地 stdio，免凭证免注册）：实时价格、历史 K线、公司信息、大盘概览、财务数据。生产镜像已内置 python3 venv（/opt/a-stock），点「启用」即可用；本地开发需自行 pip install a-stock-mcp-server。',
    authType: 'none',
    /** 工具路由触发词：prompt 点名这些词时挂载本连接器的 mcp_<server>_* 工具（服务器粒度路由） */
    routeWords: ["akshare", "a股", "k线", "实时行情"],
    optIn: true,
    tokenEnvVar: 'MCP_ASTOCK_OPTIN',
    docUrl: 'https://github.com/Llldmiao/a-stock-mcp-server',
    servers: [
      {
        name: 'a_stock',
        subagentOpen: false, // 行情数字红线:报告依据必须主循环直拉
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
    /** 工具路由触发词：prompt 点名这些词时挂载本连接器的 mcp_<server>_* 工具（服务器粒度路由） */
    routeWords: ["alphaxiv", "arxiv"],
    tokenEnvVar: 'MCP_ALPHAXIV_TOKEN',
    quickAuthUrl: 'https://www.alphaxiv.org/',
    authHint:
      '注册/登录 alphaXiv → Settings → API Keys → 创建后复制粘贴到下方（走 Authorization: Bearer 头）。',
    docUrl: 'https://www.alphaxiv.org/docs/mcp',
    servers: [
      {
        name: 'alphaxiv',
        subagentOpen: true, // 论文语义检索/全文问答,只读
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
    /** 工具路由触发词：prompt 点名这些词时挂载本连接器的 mcp_<server>_* 工具（服务器粒度路由） */
    routeWords: ["huggingface", "hugging face", "数据集", "模型库"],
    optIn: true,
    tokenEnvVar: 'MCP_HUGGINGFACE_OPTIN',
    docUrl: 'https://huggingface.co/docs/hub/en/agents-mcp',
    servers: [{ name: 'huggingface', subagentOpen: true, url: 'https://huggingface.co/mcp' }], // 官方 4/4 工具带只读注解(2026-10-14 实测)
  },
  {
    id: 'deepl_mcp',
    name: 'DeepL 翻译润色',
    icon: 'Languages',
    category: 'Education',
    description:
      'DeepL 官方远程 MCP（OAuth 一键授权，免费计划可用）：高质量文本/文档翻译、学术润色改写、语法纠错、术语表与写作风格规则管理，读外文文献与论文润色首选。',
    authType: 'oauth',
    /** 工具路由触发词：prompt 点名这些词时挂载本连接器的 mcp_<server>_* 工具（服务器粒度路由） */
    routeWords: ["deepl", "翻译", "润色"],
    docUrl: 'https://developers.deepl.com/docs/mcp',
    servers: [{ name: 'deepl', subagentOpen: true, url: 'https://mcp.deepl.com/v1/mcp' }], // 翻译/润色性质只读;术语表管理类靠双钥匙拦(须服务器自报只读才放行)
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
    /** 工具路由触发词：prompt 点名这些词时挂载本连接器的 mcp_<server>_* 工具（服务器粒度路由） */
    routeWords: ["飞书", "lark"],
    tokenEnvVar: 'MCP_LARK_APP_CRED',
    quickAuthUrl: 'https://open.feishu.cn/app',
    authHint:
      '飞书开放平台 → 创建/选择「企业自建应用」→「凭证与基础信息」页复制 App ID 与 App Secret，按 AppID:AppSecret 格式填写到下方；并在「权限管理」开通所需 API 权限（如消息、云文档、日历）。',
    docUrl: 'https://github.com/larksuite/lark-openapi-mcp',
    servers: [
      {
        name: 'lark_suite',
        subagentOpen: false, // 办公全家桶:发消息/写文档/建日程 = 写操作
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
    /** 工具路由触发词：prompt 点名这些词时挂载本连接器的 mcp_<server>_* 工具（服务器粒度路由） */
    routeWords: ["钉钉", "dingtalk"],
    tokenEnvVar: 'MCP_DINGTALK_APP_CRED',
    quickAuthUrl: 'https://open-dev.dingtalk.com/fe/app',
    authHint:
      '钉钉开放平台 → 应用开发 → 创建/选择「企业内部应用」→「凭证与基础信息」复制 Client ID 与 Client Secret，按 ClientID:ClientSecret 格式填写到下方；并在「权限管理」添加所需接口权限。',
    docUrl: 'https://github.com/open-dingtalk/dingtalk-mcp',
    servers: [
      {
        name: 'dingtalk_mcp',
        subagentOpen: false, // 待办/群消息 = 写操作
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
    /** 工具路由触发词：prompt 点名这些词时挂载本连接器的 mcp_<server>_* 工具（服务器粒度路由） */
    routeWords: ["语雀", "yuque"],
    tokenEnvVar: 'MCP_YUQUE_TOKEN',
    quickAuthUrl: 'https://www.yuque.com/settings/tokens',
    authHint:
      '语雀 → 个人设置 → Token → 新建 Token（按需勾选读写范围），复制后粘贴到下方。',
    docUrl: 'https://github.com/yuque/yuque-mcp-server',
    servers: [
      {
        name: 'yuque',
        subagentOpen: false, // 知识库/文档读写含创建 = 写操作
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
    /** 工具路由触发词：prompt 点名这些词时挂载本连接器的 mcp_<server>_* 工具（服务器粒度路由） */
    routeWords: ["热榜", "热搜", "newsnow", "trending"],
    optIn: true,
    tokenEnvVar: 'MCP_NEWSNOW_OPTIN',
    docUrl: 'https://github.com/newsnext/newsnow',
    servers: [
      {
        name: 'newsnow',
        subagentOpen: true, // 聚合热榜,实测只读(逃生口 mcp_newsnow_ 背书)
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
    /** 工具路由触发词：prompt 点名这些词时挂载本连接器的 mcp_<server>_* 工具（服务器粒度路由） */
    routeWords: ["twitter", "推特", "推文"],
    tokenEnvVar: 'MCP_TWITTERAPI_IO_KEY',
    quickAuthUrl: 'https://twitterapi.io/dashboard',
    authHint:
      '注册/登录 twitterapi.io → Dashboard 复制 API Key 粘贴到下方（Key 经 env 注入子进程，不出现在命令行；按量计费，新用户有免费试用额度）。',
    docUrl: 'https://docs.twitterapi.io/introduction',
    servers: [
      {
        name: 'twitterapi_io',
        subagentOpen: false, // 按量计费($0.15/千条),子 agent 批量检索产生真实费用,未评审
        transport: 'stdio',
        command: 'npx',
        // 凭证经 env 注入（不出现在命令行，避免进程列表泄露）；用官方新包名（@kaitoinfra 旧包已废弃）
        args: ['-y', '@twitterapi_io/mcp-server'],
        env: (cred) => ({ TWITTERAPI_IO_API_KEY: cred }),
      },
    ],
  },

  // ---- 网文创作(小说工坊 P2 配套 · 红线:发布永远人工、不接正文抓取)----
  {
    id: 'fanqie_radar',
    name: '番茄小说榜单 (fanqie-radar)',
    icon: 'Radar',
    category: 'Content',
    description:
      '开源 fanqie-radar(本地 stdio,免凭证):番茄小说公开榜单元数据(榜单/标签/热度)与选题调研分析,供网文选题参考。只读公开数据,项目自身红线即不抓章节正文(版权红线,本产品也不接正文抓取类连接器)。生产镜像已内置 /opt/fanqie venv(固定 commit),点「启用」即可用;本地开发需 Python ≥ 3.10,源码 `pip install .` 后提供 fanqie-radar 命令;本地子进程默认关闭,点「启用」后才为你的任务挂载。',
    authType: 'none',
    /** 工具路由触发词：prompt 点名这些词时挂载本连接器的 mcp_<server>_* 工具（服务器粒度路由） */
    routeWords: ["番茄榜单", "番茄小说", "网文选题", "fanqie"],
    optIn: true,
    tokenEnvVar: 'MCP_FANQIE_RADAR_OPTIN',
    docUrl: 'https://github.com/WindXRan/fanqie-radar',
    servers: [
      {
        name: 'fanqie_radar',
        subagentOpen: true, // 公开榜单元数据,只读;项目声明不抓正文(与本产品版权红线一致)
        transport: 'stdio',
        command: 'fanqie-radar',
      },
    ],
  },
  {
    id: 'tomato_writer',
    name: '番茄作者后台 (tomato-writer-mcp)',
    icon: 'Tomato',
    category: 'Content',
    description:
      '开源 tomato-writer-mcp(本地 stdio):番茄小说作者后台的章节管理——查稿件、存草稿、发布/定时发布章节。红线:发布章节 = 真实平台副作用,subagentOpen 永不开放,每次发布都由你在主循环人工审批;AI 使用声明由作者本人在番茄后台如实勾选,本连接器不代填不绕过;平台 Cookie 约 1-2 个月过期需重取。需本机 clone 源码并 pnpm build(入口通常是仓库下 dist/index.js)。凭证只存你的本地托管钥匙,绝不入库不进日志。',
    authType: 'token',
    /** 工具路由触发词：prompt 点名这些词时挂载本连接器的 mcp_<server>_* 工具（服务器粒度路由） */
    routeWords: ["番茄作者后台", "番茄作家", "tomato writer"],
    tokenEnvVar: 'MCP_TOMATO_WRITER_CRED',
    // 作家后台是 React Router SPA(basename /main/writer/),路由表里没有
    // /index —— 打开 /main/writer/index 服务器给 200 的壳但客户端渲染
    // 「Unexpected Application Error! 404」(2026-10 实测)。工作台路由是
    // /home(取自线上 bundle 路由表,与 /、/login 并列),未登录自动转登录页
    quickAuthUrl: 'https://fanqienovel.com/main/writer/home',
    authHint:
      '先 clone fuhei/tomato-writer-mcp 并 pnpm install && pnpm build;再打开作家专区登录 → F12 Network → 任选一个 /api/author/... 请求,复制请求头里的 Cookie 与 X-Secsdk-Csrf-Token(会话级固定),按「入口文件绝对路径|||Cookie|||X-Secsdk-Csrf-Token」三段格式填到下方(如 /home/me/tomato-writer-mcp/dist/index.js|||sessionid=...|||abc123)。',
    docUrl: 'https://github.com/fuhei/tomato-writer-mcp',
    servers: [
      {
        name: 'tomato_writer',
        subagentOpen: false, // publish_chapter = 真实平台发布(现实副作用),只走主循环逐次人工审批
        transport: 'stdio',
        command: 'node',
        // 入口路径进 args(用户本机 build 产物,无 npx 包);Cookie/CSRF 经 env 注入,
        // 不出现在命令行(避免进程列表泄露),也绝不进 process.env 转发
        args: (cred) => [parseTomatoWriterCred(cred)?.entryPath || ''],
        env: (cred) => {
          const p = parseTomatoWriterCred(cred);
          return { TOMATO_COOKIE: p?.cookie || '', TOMATO_CSRF_TOKEN: p?.csrf || '' };
        },
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

/**
 * 解析番茄作者后台三段组合凭证「entryPath|||cookie|||csrf」(||| 分隔,
 * Cookie 自身含 ; 与空格所以不能用冒号/逗号分段)。任一段缺失返回 null ——
 * 调用方拿到 null 就传空值,子进程自然启动失败并显式报错,绝不静默半配置。
 */
export function parseTomatoWriterCred(
  raw: string
): { entryPath: string; cookie: string; csrf: string } | null {
  const t = (raw || '').trim();
  if (!t) return null;
  const parts = t.split('|||');
  if (parts.length !== 3) return null;
  const [entryPath, cookie, csrf] = parts.map((p) => p.trim());
  if (!entryPath || !cookie || !csrf) return null;
  return { entryPath, cookie, csrf };
}

/** MCP OAuth start → callback 之间传递 CSRF state 的 httpOnly cookie 名 */
export const MCP_OAUTH_STATE_COOKIE = 'mcp_oauth_state';

/** token 类凭证键 + optIn 开关键白名单（POST saveToken 校验用） */
export const MCP_TOKEN_ENV_VARS = new Set(
  MCP_CONNECTOR_DEFS.filter((d) => (d.authType === 'token' || d.optIn) && d.tokenEnvVar).map(
    (d) => d.tokenEnvVar!
  )
);

/**
 * 设备码授权通道是否可用：目录配了 deviceFlow **且** 部署侧 client_id/client_secret
 * 两个环境变量都已设置。未配置时 UI 隐藏「设备码授权」按钮,粘贴凭证通道不受影响。
 */
export function deviceFlowAvailable(def: McpConnectorDef): boolean {
  if (!def.deviceFlow || !def.tokenEnvVar) return false;
  return Boolean(
    (process.env[def.deviceFlow.clientIdEnv] || '').trim() &&
      (process.env[def.deviceFlow.clientSecretEnv] || '').trim()
  );
}

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
    // 逐请求签名器工厂(签名网关型 MCP):吃凭证吐签名器,与静态 headers 叠加
    signRequest: s.sign ? s.sign(cred) : undefined,
  };
}

/**
 * 依据用户已配置的凭证，构建该用户当前应连接的 MCP Server 清单。
 * - none（非 optIn）：无条件直连；
 * - none + optIn：用户显式启用（configs[key]==='1'）才连；
 * - token：已保存凭证(含哨兵 '1'=手动启用公共试用)才连（URL 模板 / 静态头注入 / stdio args+env 注入）；
 * - oauth：已完成一键授权才连（挂 OAuthClientProvider，SDK 自动带 token + 401 刷新）。
 */
export function buildUserMcpServers(userId: string): MCPServerConfig[] {
  const servers: MCPServerConfig[] = [];
  for (const { def, servers: defs } of connectedServerDefs(userId)) {
    if (def.authType === 'token') {
      // cred = 已存值(用户粘贴的自有 key,或哨兵 '1'=在卡片手动启用公共试用);server 定义自行解析
      // (如飞猪 resolveFlyaiKey 把 '1'/空映射为公共试用 key,用户 key 优先)。裸用户未启用 → cred 空,
      // 但 connectedServerDefs 已跳过未保存凭证的 token 连接器,故此处 cred 恒非空。
      const cred = (getUserConnectors(userId).configs[def.tokenEnvVar!] || '').trim();
      for (const s of defs) servers.push(serverConfigFromDef(s, cred));
    } else if (def.authType === 'oauth') {
      for (const s of defs) {
        const url = typeof s.url === 'function' ? s.url('') : s.url || '';
        servers.push(serverConfigFromDef(s, '', new UserMcpOAuthProvider(userId, def.id, url, def.scope)));
      }
    } else {
      for (const s of defs) servers.push(serverConfigFromDef(s, ''));
    }
  }
  return servers;
}

/** 该用户当前「应连接」的连接器（凭证判定与 buildUserMcpServers 完全一致） */
function connectedServerDefs(userId: string): Array<{ def: McpConnectorDef; servers: McpServerDef[] }> {
  const { configs } = getUserConnectors(userId);
  const out: Array<{ def: McpConnectorDef; servers: McpServerDef[] }> = [];
  for (const def of MCP_CONNECTOR_DEFS) {
    if (def.authType === 'token') {
      // 已保存凭证才连:用户自有 key,或哨兵 '1'(在卡片「启用公共试用」手动启用);裸用户未启用 → 不连
      if (!(configs[def.tokenEnvVar!] || '').trim()) continue;
    } else if (def.authType === 'oauth') {
      const record = getMcpAuth(userId, def.id);
      if (!record?.tokens?.access_token) continue;
    } else {
      // none
      if (def.optIn && def.tokenEnvVar && (configs[def.tokenEnvVar] || '').trim() !== '1') continue;
    }
    out.push({ def, servers: def.servers });
  }
  return out;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 子 agent MCP 白名单(双钥匙的人工钥匙)按用户动态解析:
 * 「该用户当前已连接的服务器」∩「目录 subagentOpen 标记」。
 * 由 agent-backend 注入 plugin-subagent 的 resolveMcpServers —— 用户在连接器页
 * 新配一台已标记的连接器,子 agent 下一次派发即可用,无需改 env/重启。
 * 连接判定与 buildUserMcpServers 完全一致(同一 connectedServerDefs);
 * env AGTPILOT_SUBAGENT_MCP_SERVERS 显式设置时宿主不注入本函数,env 语义优先。
 */
export function buildUserSubagentMcpServers(userId: string): string[] {
  const names: string[] = [];
  for (const { servers: defs } of connectedServerDefs(userId)) {
    for (const s of defs) {
      if (s.subagentOpen) names.push(s.name);
    }
  }
  return names;
}

// ---- 子 agent 可用性(连接器详情页展示用,2026-10-14 目录标记方案) ----

/**
 * 单台服务器对子 agent 的可用状态:
 * - escape:命中逃生口前缀(实测背书,免服务器只读注解)→ 可用
 * - ready:人工钥匙通过(env 显式设置时以 env 名单优先,否则看目录 subagentOpen),
 *   且服务器有工具声明只读(或未连接,UI 按连接状态显示「连接后可用」)→ 可用
 * - needs-measurement:有人工钥匙但已连接服务器零只读注解 → 需一次性实测评估后启用
 * - closed:无人工钥匙 → 不开放
 */
export type SubagentAvailability = 'ready' | 'escape' | 'needs-measurement' | 'closed';

/** 逃生口前缀(与 plugin-subagent 同语义:env 显式设置含 off 优先,否则内置默认;调用时读取,可测) */
function subagentEscapePrefixes(): string[] {
  const v = (process.env.AGTPILOT_SUBAGENT_MCP_ALLOW_TOOLS ?? '').trim();
  if (v === '') return [...DEFAULT_MCP_ALLOW_TOOLS];
  if (/^(off|none)$/i.test(v)) return [];
  return v.split(',').map((s) => s.trim()).filter(Boolean);
}

/** 人工钥匙(与宿主注入口径一致:env AGTPILOT_SUBAGENT_MCP_SERVERS 显式设置含 off 优先,否则目录标记) */
function subagentServerWhitelisted(serverName: string, flagged: boolean): boolean {
  const v = (process.env.AGTPILOT_SUBAGENT_MCP_SERVERS ?? '').trim();
  if (v === '') return flagged;
  if (/^(off|none)$/i.test(v)) return false;
  return v.split(',').map((s) => s.trim()).includes(serverName);
}

export function subagentAvailability(
  serverName: string,
  opts: { flagged: boolean; toolCount: number; readOnlyCount: number }
): SubagentAvailability {
  // 工具名前缀与 plugin-mcp 命名规则一致(mcp_{server}_{tool};目录服务器名均为干净 ASCII)
  const prefix = `mcp_${serverName}_`;
  if (subagentEscapePrefixes().some((p) => prefix.startsWith(p))) return 'escape';
  if (!subagentServerWhitelisted(serverName, opts.flagged)) return 'closed';
  if (opts.toolCount > 0 && opts.readOnlyCount === 0) return 'needs-measurement';
  return 'ready';
}

/**
 * 按服务器粒度注册的 MCP 工具路由：prompt 点名的数据源（"知乎热榜"、"全网热
 * 榜"、"推特趋势"…）只挂对应服务器的 mcp_<server>_* 工具组。
 *
 * 替代旧版「MCP/连接器」一网打尽的路由：114 工具目录下，任务提示词顺带提到
 * "MCP 工具（若已连接）"或"连接器页"就会把全部 MCP 服务器挂上（实测 88/114）。
 * 触发词 = 连接器 routeWords + 服务器 label；同 id 幂等覆盖；用户撤授权后的
 * 陈旧路由前缀匹配不到任务目录里的工具，天然失效（agent-backend 每次任务
 * 开始都会重注册刷新）。
 */
export function buildUserMcpToolRoutes(userId: string): ToolRoute[] {
  const routes: ToolRoute[] = [];
  for (const { def, servers } of connectedServerDefs(userId)) {
    for (const s of servers) {
      const words = new Set<string>([...(def.routeWords || []), ...(s.label ? [s.label] : [])]);
      if (words.size === 0) continue; // 无触发词则不注册：漏挂走全量兜底，不盲挂
      routes.push({
        id: `mcp_user_${s.name}`,
        prefixes: [`mcp_${s.name}_`],
        test: new RegExp(Array.from(words).map(escapeRegExp).join('|'), 'i'),
      });
    }
  }
  return routes;
}
