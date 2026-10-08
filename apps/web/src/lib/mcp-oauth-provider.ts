import type {
  OAuthClientProvider,
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from '@agtpilot/plugin-mcp';
import { getMcpAuth, saveMcpAuth, deleteMcpAuth, type McpAuthRecord } from './user-store';

/**
 * 用户级 MCP OAuthClientProvider（MCP 标准授权，一键授权核心）
 *
 * 把 MCP SDK 要求的全部持久化回调（DCR 客户端信息 / tokens / PKCE verifier /
 * discovery 缓存）落到当前用户的 user-store 加密空间，做到：
 * - 多用户隔离：每个 (userId, connectorId) 一条加密记录；
 * - 重启不丢：授权一次，长期可用（SDK 自动刷新 token）；
 * - start 路由复用：redirectToAuthorization 不真正跳转，把授权 URL 暂存在
 *   实例上（pendingAuthorizationUrl），由 Next 路由读取后 302。
 */
export class UserMcpOAuthProvider implements OAuthClientProvider {
  /** start 流程中捕获的授权跳转 URL（由路由读取并 302） */
  pendingAuthorizationUrl?: URL;

  constructor(
    private readonly userId: string,
    readonly connectorId: string,
    readonly serverUrl: string,
    private readonly scope?: string
  ) {}

  private get record(): McpAuthRecord {
    return getMcpAuth(this.userId, this.connectorId) || {};
  }

  private patch(partial: Partial<McpAuthRecord>) {
    saveMcpAuth(this.userId, this.connectorId, { ...this.record, ...partial });
  }

  /** 回调地址：`{baseUrl}/api/connectors/mcp/callback`（DCR 注册给远端授权服务器） */
  private get callbackUrl(): string {
    const fromEnv = process.env.APP_BASE_URL || process.env.NEXTAUTH_URL || process.env.AUTH_URL;
    let base = fromEnv ? fromEnv.replace(/\/+$/, '') : '';
    if (!base) {
      // 无显式部署地址时退而求其次用 MCP 服务端同源不可行，只能要求配置；
      // 本地开发兜底 http://localhost:3000
      base = 'http://localhost:3000';
    }
    return `${base}/api/connectors/mcp/callback`;
  }

  get redirectUrl(): string {
    return this.callbackUrl;
  }

  get clientMetadata(): OAuthClientMetadata {
    const origin = new URL(this.callbackUrl).origin;
    return {
      client_name: 'AgtPilot 个人智能体',
      client_uri: origin,
      redirect_uris: [this.callbackUrl],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      ...(this.scope ? { scope: this.scope } : {}),
    };
  }

  async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    return this.record.clientInfo;
  }

  saveClientInformation(clientInformation: OAuthClientInformationMixed): void {
    this.patch({ clientInfo: clientInformation });
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    return this.record.tokens;
  }

  saveTokens(tokens: OAuthTokens): void {
    this.patch({ tokens });
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    // 服务端路由场景：不直接跳转，捕获 URL 交给 Next 路由 302
    this.pendingAuthorizationUrl = authorizationUrl;
  }

  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    this.patch({ codeVerifier });
  }

  async codeVerifier(): Promise<string> {
    const v = this.record.codeVerifier;
    if (!v) {
      throw new Error('未找到已保存的 PKCE code verifier，请重新发起授权');
    }
    return v;
  }

  /** 凭证失效时按范围清理（SDK 在刷新失败等场景调用，避免脏凭证反复撞墙） */
  invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): void {
    if (scope === 'all') {
      deleteMcpAuth(this.userId, this.connectorId);
      return;
    }
    const rec = this.record;
    if (scope === 'client') delete rec.clientInfo;
    if (scope === 'tokens') delete rec.tokens;
    if (scope === 'verifier') delete rec.codeVerifier;
    this.patch(rec);
  }
}
