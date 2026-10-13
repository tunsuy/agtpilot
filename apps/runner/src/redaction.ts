/**
 * 上行 redaction(§5.3,M4):事件离开本机前的最后一道过滤。
 *
 * 诚实声明(§7):根本防线是「凭据零上行零读取 + 代码内容不上传」,
 * redaction 防的是**意外**——agent 输出摘要 / 测试尾部 / stderr 里
 * 恰好带了用户环境中的密钥形态字符串。已知形态正则 + 本机 secret 值黑名单,
 * 覆盖不到的新型形态在威胁模型里如实列为「不能防」(§11)。
 *
 * 纯函数,vitest 直测(§10 M4 门禁:redaction 用例库)。
 */

export const REDACTED = '[REDACTED]';

/** 已知密钥形态(每条独立命名,便于测试与后续增补;顺序执行) */
const SECRET_PATTERNS: Array<{ name: string; re: RegExp; repl: string }> = [
  // PEM 私钥块(含未闭合的截断形态:BEGIN 之后一律吞掉)
  { name: 'pem-private-key', re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g, repl: REDACTED },
  // GitHub token(经典 ghp_/gho_/ghu_/ghs_/ghr_ + 细粒度 github_pat_)
  { name: 'github-token', re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, repl: REDACTED },
  { name: 'github-pat', re: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, repl: REDACTED },
  // AWS Access Key ID
  { name: 'aws-access-key', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, repl: REDACTED },
  // Slack token
  { name: 'slack-token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, repl: REDACTED },
  // OpenAI / Anthropic 风格 API key
  { name: 'openai-key', re: /\bsk-[A-Za-z0-9_-]{20,}\b/g, repl: REDACTED },
  { name: 'anthropic-key', re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g, repl: REDACTED },
  // Google API key(标准 35 字符,放宽到 20+ 防变体漏网)
  { name: 'google-api-key', re: /\bAIza[0-9A-Za-z_-]{20,}\b/g, repl: REDACTED },
  // npm token
  { name: 'npm-token', re: /\bnpm_[A-Za-z0-9]{30,}\b/g, repl: REDACTED },
  // Stripe live/test key
  { name: 'stripe-key', re: /\b[sr]k_(?:live|test)_[0-9a-zA-Z]{16,}\b/g, repl: REDACTED },
  // JWT(三段 base64url)
  { name: 'jwt', re: /\beyJ[A-Za-z0-9_-]{6,}\.eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\b/g, repl: REDACTED },
  // Authorization 头值(Bearer/Basic)
  { name: 'auth-header', re: /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{16,}/gi, repl: `$1 ${REDACTED}` },
  // URL 内嵌凭据 https://user:pass@host
  { name: 'url-credentials', re: /(https?:\/\/[^/@:\s]+:)([^/@\s]+)(@)/gi, repl: `$1${REDACTED}$3` },
  // key=value / key: value 形态(api_key/token/secret/password/… 关键词)
  {
    name: 'key-value',
    re: /\b(api[_-]?key|apikey|access[_-]?token|auth[_-]?token|refresh[_-]?token|secret[_-]?key|client[_-]?secret|device[_-]?secret|password|passwd|private[_-]?key)(["']?\s*[:=]\s*["']?)[^\s"',;)\]}]{6,}/gi,
    repl: `$1$2${REDACTED}`,
  },
];

/** 对单段文本做密钥形态替换(纯函数) */
export function redactText(s: string): string {
  let out = s;
  for (const p of SECRET_PATTERNS) {
    out = out.replace(p.re, p.repl);
  }
  return out;
}

/**
 * 深度 redact:递归处理对象/数组中的字符串值。
 * - blacklist:本机 secret 值(如 deviceSecret)整串命中即替换(不依赖形态);
 * - 深度上限 8 层、字符串数组防爆量:超限直接返回 REDACTED(宁可过度不上行);
 * - 非 plain object(类实例/函数等)不出现在事件 payload 里,防御性返回原值由
 *   JSON.stringify 自然丢弃函数——事件在 client 侧本来就要序列化。
 */
export function redactValue(v: unknown, blacklist: readonly string[] = [], depth = 0): unknown {
  if (depth > 8) return REDACTED;
  if (typeof v === 'string') return redactWithBlacklist(v, blacklist);
  if (Array.isArray(v)) return v.map((x) => redactValue(x, blacklist, depth + 1));
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      out[k] = redactValue(val, blacklist, depth + 1);
    }
    return out;
  }
  return v;
}

/** 形态正则之外,再按本机已知 secret 值黑名单整串替换 */
export function redactWithBlacklist(s: string, blacklist: readonly string[] = []): string {
  let out = redactText(s);
  for (const secret of blacklist) {
    if (typeof secret === 'string' && secret.length >= 8 && out.includes(secret)) {
      out = out.split(secret).join(REDACTED);
    }
  }
  return out;
}

/**
 * 单条事件 redact:只处理自由文本载体 payload(结构化字段
 * eventId/taskId/deviceId/at/type 是本机生成的受控值,不动)。
 * 非对象事件原样返回(client 侧 normalizeRunnerEvent 会拒掉)。
 */
export function redactEvent(event: unknown, blacklist: readonly string[] = []): unknown {
  if (!event || typeof event !== 'object' || Array.isArray(event)) return event;
  const e = event as Record<string, unknown>;
  if (!e.payload || typeof e.payload !== 'object') return e;
  return { ...e, payload: redactValue(e.payload, blacklist) };
}
