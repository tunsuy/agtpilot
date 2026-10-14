import { createHash, createHmac, randomBytes } from 'node:crypto';
import type { RequestSigner, SignableRequest } from '@agtpilot/plugin-mcp';

/**
 * 飞猪 flyai MCP 逐请求签名(方案 a 消费方)。
 *
 * 复刻官方 CLI @fly-ai/flyai-cli(MIT)的请求签名协议:HMAC-SHA256 over
 *   method \n pathname \n timestampMs \n nonce \n sha256hex(body) \n sha256hex(normalizedAuth)
 * 输出 base64url,附 5 个 x-flyai-* 头。实测(2026-10-14)服务端强制校验:
 * 正确 signSecret → 200,错误 → 401「Authorization verification failed」。
 *
 * 安全边界(docs/design/mcp-request-signing.md §5):
 * - signSecret 是**协议级公共常量**(须与服务端一致、对所有客户端同值、随官方
 *   MIT CLI 公开分发),不是用户凭证 —— 内置默认值可被 FLYAI_SIGN_SECRET 覆盖;
 * - **API key(用户身份)绝不内置**,由连接器 token 通道经闭包注入(本文件不读
 *   process.env 里的任何用户凭证,apiKey 只从入参来);
 * - 纯函数 + 可注入 now/nonce,vitest 直测(对服务端实测向量回归)。
 *
 * x-ff-ctx(加密设备指纹)/ x-ttid / User-Agent 实测均**非必需**(省略仍 200),
 * 故不采集 —— 少一处主机信息采集,契合隐私红线。
 */

/** 协议级公共常量:官方 MIT CLI 内置、须与服务端一致;可被 FLYAI_SIGN_SECRET 覆盖 */
export const FLYAI_SIGN_SECRET_DEFAULT = 'XSbdYnucPARDc9knhD8+X6hxdD1Nh6ZGI6Hadg25kBw=';

/**
 * 飞猪官方 CLI 出厂内置的**公共试用 API Key**(MIT 许可、随 npm 包公开分发)。
 *
 * 产品决策(负责人 2026-10-14 拍板:「默认公共 key,用户配置了用用户的」):
 * 作为缺省身份让用户零配置即可试用飞猪搜索;用户在连接器里粘贴自己的
 * FLYAI_API_KEY 后一律优先用户 key。注意这是**共享试用身份**——可能被飞猪
 * 限流/吊销,生产/规模使用应引导用户配置自有 key(见连接器 authHint)。
 * 与 signSecret 区分:signSecret 是协议常量(所有客户端同值),本 key 是身份凭证。
 */
export const FLYAI_PUBLIC_TRIAL_KEY = 'sk-faRn8Kp2QzXvLm9YtA4EjHcWbS7oUdG5iF3xNqV6rZ';

/**
 * 解析飞猪 API Key:用户配置了(连接器粘贴的真实 key)→ 用用户的;
 * 未配置 / 仅启用哨兵 '1' → 回退公共试用 key。
 */
export function resolveFlyaiKey(cred: string | undefined | null): string {
  const c = (cred ?? '').trim();
  return c && c !== '1' ? c : FLYAI_PUBLIC_TRIAL_KEY;
}

export const FLYAI_SIGN_VER = '7';
export const FLYAI_SIGN_ALG = 'hmac-sha256';

const sha256hex = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

/** Authorization 归一:补全 `Bearer ` 前缀;空/缺省 → 空串(与 CLI normAuth 一致) */
export function normalizeFlyaiAuth(auth: string | undefined | null): string {
  const c = (auth ?? '').trim();
  return c ? (c.startsWith('Bearer ') ? c : `Bearer ${c}`) : '';
}

/** canonical string(逐字段固定顺序,\n 连接;body/auth 取 sha256 hex) */
export function flyaiCanonical(req: {
  method: string;
  pathname: string;
  timestampMs: string;
  nonce: string;
  body: string;
  authorization: string;
}): string {
  return [
    req.method,
    req.pathname,
    req.timestampMs,
    req.nonce,
    sha256hex(req.body),
    sha256hex(normalizeFlyaiAuth(req.authorization)),
  ].join('\n');
}

/** HMAC-SHA256(signSecret, canonical) → base64url */
export function flyaiHmac(signSecret: string, canonical: string): string {
  return createHmac('sha256', signSecret.trim()).update(canonical, 'utf8').digest('base64url');
}

export interface FlyaiSignerOpts {
  /** 用户身份凭证(API key);经闭包注入,本模块不从 env 读取用户凭证 */
  apiKey: string;
  /** 签名密钥;缺省 = FLYAI_SIGN_SECRET_DEFAULT,可被 FLYAI_SIGN_SECRET 覆盖 */
  signSecret?: string;
  /** 测试注入:时间戳(毫秒) */
  now?: () => number;
  /** 测试注入:nonce(16 字节 hex) */
  randomNonce?: () => string;
}

/**
 * 构造飞猪签名器(RequestSigner)。apiKey 经闭包捕获,每次请求现算 5 个头。
 * Authorization 优先取请求头(SDK 已把静态 Authorization 并入 init.headers),
 * 缺失时回退用 apiKey 拼 Bearer —— 两路都指向同一 key,签名一致。
 */
export function flyaiSigner(opts: FlyaiSignerOpts): RequestSigner {
  const secret = (opts.signSecret ?? process.env.FLYAI_SIGN_SECRET ?? FLYAI_SIGN_SECRET_DEFAULT).trim();
  const now = opts.now ?? ((): number => Date.now());
  const randomNonce = opts.randomNonce ?? ((): string => randomBytes(16).toString('hex'));
  const apiKeyBearer = opts.apiKey ? `Bearer ${opts.apiKey.trim()}` : '';

  return (req: SignableRequest): Record<string, string> => {
    const timestampMs = String(now());
    const nonce = randomNonce();
    let pathname = '/';
    try {
      pathname = new URL(req.url).pathname || '/';
    } catch {
      pathname = '/';
    }
    const authorization = req.headers['authorization'] || apiKeyBearer;
    const canonical = flyaiCanonical({
      method: req.method,
      pathname,
      timestampMs,
      nonce,
      body: req.body,
      authorization,
    });
    return {
      'x-flyai-sign-ver': FLYAI_SIGN_VER,
      'x-flyai-sign-alg': FLYAI_SIGN_ALG,
      'x-flyai-ts': timestampMs,
      'x-flyai-nonce': nonce,
      'x-flyai-sign': flyaiHmac(secret, canonical),
    };
  };
}
