/**
 * Connector OAuth 适配器体系
 * 统一抽象层，隔离具体的 OAuth 实现（Native, Composio, Nango 等）
 */

export interface OAuthAuthorizeUrlParams {
  provider: string;
  callbackUrl: string;
  state: string;
  scope?: string;
}

export interface OAuthCallbackParams {
  provider: string;
  code: string;
  callbackUrl: string;
}

export interface OAuthTokenResult {
  accessToken: string;
  refreshToken?: string;
  expiresIn?: number;
  tokenType?: string;
  scope?: string;
  raw?: Record<string, any>;
}

export interface IConnectorOAuthAdapter {
  readonly name: string;
  getAuthorizationUrl(params: OAuthAuthorizeUrlParams): Promise<string>;
  exchangeCodeForToken(params: OAuthCallbackParams): Promise<OAuthTokenResult>;
}

/**
 * 1. 原生轻量级适配器 (Native Adapter)
 * 无需外部中间件，直接支持 GitHub, Slack, Notion 等核心 OAuth 流程
 */
export class NativeConnectorOAuthAdapter implements IConnectorOAuthAdapter {
  readonly name = 'native';

  async getAuthorizationUrl({
    provider,
    callbackUrl,
    state,
    scope,
  }: OAuthAuthorizeUrlParams): Promise<string> {
    switch (provider) {
      case 'github': {
        const clientId = process.env.AUTH_GITHUB_ID || process.env.GITHUB_CLIENT_ID;
        if (!clientId) {
          throw new Error('未配置 AUTH_GITHUB_ID 环境变量');
        }
        const defaultScope = scope || 'repo,read:user,user:email';
        const params = new URLSearchParams({
          client_id: clientId,
          redirect_uri: callbackUrl,
          scope: defaultScope,
          state,
        });
        return `https://github.com/login/oauth/authorize?${params.toString()}`;
      }

      case 'notion': {
        const clientId = process.env.NOTION_CLIENT_ID;
        if (!clientId) {
          throw new Error('未配置 NOTION_CLIENT_ID 环境变量');
        }
        const params = new URLSearchParams({
          client_id: clientId,
          redirect_uri: callbackUrl,
          response_type: 'code',
          owner: 'user',
          state,
        });
        return `https://api.notion.com/v1/oauth/authorize?${params.toString()}`;
      }

      case 'slack': {
        const clientId = process.env.SLACK_CLIENT_ID;
        if (!clientId) {
          throw new Error('未配置 SLACK_CLIENT_ID 环境变量');
        }
        const defaultScope = scope || 'chat:write,channels:read,incoming-webhook';
        const params = new URLSearchParams({
          client_id: clientId,
          redirect_uri: callbackUrl,
          scope: defaultScope,
          state,
        });
        return `https://slack.com/oauth/v2/authorize?${params.toString()}`;
      }

      default:
        throw new Error(`暂不支持该提供商的原生 OAuth: ${provider}`);
    }
  }

  async exchangeCodeForToken({
    provider,
    code,
    callbackUrl,
  }: OAuthCallbackParams): Promise<OAuthTokenResult> {
    switch (provider) {
      case 'github': {
        const clientId = process.env.AUTH_GITHUB_ID || process.env.GITHUB_CLIENT_ID;
        const clientSecret = process.env.AUTH_GITHUB_SECRET || process.env.GITHUB_CLIENT_SECRET;
        if (!clientId || !clientSecret) {
          throw new Error('未配置 GitHub OAuth Client ID 或 Secret');
        }

        const res = await fetch('https://github.com/login/oauth/access_token', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: JSON.stringify({
            client_id: clientId,
            client_secret: clientSecret,
            code,
            redirect_uri: callbackUrl,
          }),
        });

        const data = await res.json();
        if (data.error || !data.access_token) {
          throw new Error(data.error_description || data.error || 'GitHub Token 交换失败');
        }

        return {
          accessToken: data.access_token,
          tokenType: data.token_type,
          scope: data.scope,
          raw: data,
        };
      }

      case 'notion': {
        const clientId = process.env.NOTION_CLIENT_ID;
        const clientSecret = process.env.NOTION_CLIENT_SECRET;
        if (!clientId || !clientSecret) {
          throw new Error('未配置 Notion OAuth Client ID 或 Secret');
        }

        const authHeader = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
        const res = await fetch('https://api.notion.com/v1/oauth/token', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Basic ${authHeader}`,
          },
          body: JSON.stringify({
            grant_type: 'authorization_code',
            code,
            redirect_uri: callbackUrl,
          }),
        });

        const data = await res.json();
        if (data.error || !data.access_token) {
          throw new Error(data.error_description || data.error || 'Notion Token 交换失败');
        }

        return {
          accessToken: data.access_token,
          raw: data,
        };
      }

      case 'slack': {
        const clientId = process.env.SLACK_CLIENT_ID;
        const clientSecret = process.env.SLACK_CLIENT_SECRET;
        if (!clientId || !clientSecret) {
          throw new Error('未配置 Slack OAuth Client ID 或 Secret');
        }

        const params = new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          code,
          redirect_uri: callbackUrl,
        });

        const res = await fetch('https://slack.com/api/oauth.v2.access', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: params.toString(),
        });

        const data = await res.json();
        if (!data.ok || !data.access_token) {
          throw new Error(data.error || 'Slack Token 交换失败');
        }

        return {
          accessToken: data.access_token,
          tokenType: data.token_type,
          scope: data.scope,
          raw: data,
        };
      }

      default:
        throw new Error(`暂不支持该提供商的原生 Token 交换: ${provider}`);
    }
  }
}

/**
 * 2. 外部统一平台适配器（Composio / Nango 准备层）
 * 当后续需要对接上千个 SaaS 时，直接配置 CONNECTOR_AUTH_DRIVER=composio 或 nango 即可平滑切换
 */
export class UnifiedPlatformOAuthAdapter implements IConnectorOAuthAdapter {
  readonly name: string;
  private apiKey: string;
  private serverUrl: string;

  constructor(driver: 'composio' | 'nango') {
    this.name = driver;
    this.apiKey = (driver === 'composio' ? process.env.COMPOSIO_API_KEY : process.env.NANGO_SECRET_KEY) || '';
    this.serverUrl = (driver === 'composio' ? process.env.COMPOSIO_BASE_URL : process.env.NANGO_SERVER_URL) || '';
  }

  async getAuthorizationUrl({ provider, callbackUrl, state }: OAuthAuthorizeUrlParams): Promise<string> {
    // 预留与 Composio / Nango Connect API 的通信协议
    if (!this.apiKey) {
      throw new Error(`已启用 ${this.name} 驱动，但尚未配置 ${this.name.toUpperCase()}_API_KEY`);
    }
    // 演示代理调用：未来通过平台 SDK 或 REST API 直接获取统一托管授权 URL
    return `${this.serverUrl || 'https://api.' + this.name + '.dev'}/connect/${provider}?redirect_uri=${encodeURIComponent(callbackUrl)}&state=${state}`;
  }

  async exchangeCodeForToken(params: OAuthCallbackParams): Promise<OAuthTokenResult> {
    // 预留与统一平台交换托管连接的逻辑
    return {
      accessToken: `token_from_${this.name}_${params.provider}`,
    };
  }
}

/**
 * 驱动工厂单例：根据环境变量自动选择适配器
 */
export function getConnectorOAuthAdapter(): IConnectorOAuthAdapter {
  const driver = (process.env.CONNECTOR_AUTH_DRIVER || 'native').toLowerCase();
  if (driver === 'composio' || driver === 'nango') {
    return new UnifiedPlatformOAuthAdapter(driver as 'composio' | 'nango');
  }
  return new NativeConnectorOAuthAdapter();
}
