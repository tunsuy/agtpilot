/**
 * Connector OAuth 适配器体系
 * 统一抽象层，隔离具体的 OAuth 实现（Native, Composio, Nango 等）
 */

/** 当前原生适配器支持的 OAuth 提供商白名单 */
export const SUPPORTED_OAUTH_PROVIDERS = ['github', 'notion', 'slack'] as const;

/** start → callback 之间传递 CSRF state 的 httpOnly cookie 名 */
export const OAUTH_STATE_COOKIE = 'connector_oauth_state';

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
 * 2. 外部统一平台适配器（Composio / Nango 预留位）
 * 尚未与真实平台 API 对接。为避免静默产生假 token / 假授权链接，
 * 所有方法在被调用时显式抛错，直到真实实现落地。
 */
export class UnifiedPlatformOAuthAdapter implements IConnectorOAuthAdapter {
  readonly name: string;

  constructor(driver: 'composio' | 'nango') {
    this.name = driver;
  }

  async getAuthorizationUrl(_params: OAuthAuthorizeUrlParams): Promise<string> {
    throw new Error(
      `${this.name} 驱动尚未实现：请将 CONNECTOR_AUTH_DRIVER 设为 native，或等待 Composio/Nango 对接完成`
    );
  }

  async exchangeCodeForToken(_params: OAuthCallbackParams): Promise<OAuthTokenResult> {
    throw new Error(`${this.name} 驱动尚未实现，无法交换 Token`);
  }
}

/**
 * 驱动工厂：根据环境变量选择适配器
 */
export function getConnectorOAuthAdapter(): IConnectorOAuthAdapter {
  const driver = (process.env.CONNECTOR_AUTH_DRIVER || 'native').toLowerCase();
  if (driver === 'composio' || driver === 'nango') {
    return new UnifiedPlatformOAuthAdapter(driver as 'composio' | 'nango');
  }
  return new NativeConnectorOAuthAdapter();
}
