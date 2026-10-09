/**
 * 连接器 OAuth 共用工具
 *
 * 历史上这里承载 GitHub / Notion / Slack 的原生 OAuth 适配器体系，
 * 但换来的 token 从未被任何后端工具消费（授权了也是假连接），已于本批次移除：
 * - Notion → 改用官方托管 MCP 一键授权（见 lib/mcp-connectors.ts notion_mcp）
 * - GitHub → 标记「即将支持」，待真实 API 工具落地
 * - Slack  → 降级为纯 Webhook 通知（notify_send_webhook 真实消费）
 * MCP 连接器的 OAuth（RFC 9728/8414/7591 + PKCE）在 lib/mcp-oauth-provider.ts，与此文件无关。
 */

/**
 * 计算应用对外 Base URL。
 * 优先使用部署侧显式配置（APP_BASE_URL / NEXTAUTH_URL / AUTH_URL），
 * 避免直接信任可被伪造的 Host 请求头（host header injection / open redirect）。
 */
export function getAppBaseUrl(req: { url: string }): string {
  const fromEnv = process.env.APP_BASE_URL || process.env.NEXTAUTH_URL || process.env.AUTH_URL;
  if (fromEnv) return fromEnv.replace(/\/+$/, '');
  return new URL(req.url).origin;
}
