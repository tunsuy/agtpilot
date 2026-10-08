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
  /** 端点 URL；token 类可为模板函数（凭证拼进 query 或 header） */
  url: string | ((cred: string) => string);
  transport?: 'http' | 'sse';
  /** token 类的静态凭证头模板（如腾讯文档 Authorization 原始 token、腾讯会议自定义头） */
  headers?: (cred: string) => Record<string, string>;
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
  /** token 类凭证在 user-store connectors 里的存储键 */
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
];

export function getMcpConnectorDef(id: string): McpConnectorDef | undefined {
  return MCP_CONNECTOR_DEFS.find((d) => d.id === id);
}

/** MCP OAuth start → callback 之间传递 CSRF state 的 httpOnly cookie 名 */
export const MCP_OAUTH_STATE_COOKIE = 'mcp_oauth_state';

/** token 类凭证键白名单（POST 校验用） */
export const MCP_TOKEN_ENV_VARS = new Set(
  MCP_CONNECTOR_DEFS.filter((d) => d.authType === 'token' && d.tokenEnvVar).map((d) => d.tokenEnvVar!)
);

/**
 * 依据用户已配置的凭证，构建该用户当前应连接的 MCP Server 清单。
 * - none：无条件直连；
 * - token：已保存凭证才连（URL 模板 / 静态头注入）；
 * - oauth：已完成一键授权才连（挂 OAuthClientProvider，SDK 自动带 token + 401 刷新）。
 */
export function buildUserMcpServers(userId: string): MCPServerConfig[] {
  const { configs } = getUserConnectors(userId);
  const servers: MCPServerConfig[] = [];

  for (const def of MCP_CONNECTOR_DEFS) {
    if (def.authType === 'token') {
      const cred = (configs[def.tokenEnvVar!] || '').trim();
      if (!cred) continue;
      for (const s of def.servers) {
        servers.push({
          name: s.name,
          transport: s.transport || 'http',
          url: typeof s.url === 'function' ? s.url(cred) : s.url,
          headers: s.headers ? s.headers(cred) : undefined,
        });
      }
    } else if (def.authType === 'oauth') {
      const record = getMcpAuth(userId, def.id);
      if (!record?.tokens?.access_token) continue;
      for (const s of def.servers) {
        const url = typeof s.url === 'function' ? s.url('') : s.url;
        servers.push({
          name: s.name,
          transport: s.transport || 'http',
          url,
          authProvider: new UserMcpOAuthProvider(userId, def.id, url, def.scope),
        });
      }
    } else {
      for (const s of def.servers) {
        servers.push({
          name: s.name,
          transport: s.transport || 'http',
          url: typeof s.url === 'function' ? s.url('') : s.url,
        });
      }
    }
  }
  return servers;
}
