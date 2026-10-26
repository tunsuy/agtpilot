/**
 * 域名级网络熔断(2026-10-26 oss_radar 生产实例的止血层):
 *
 * 主循环/子 agent 用 browser_navigate 反复撞反爬墙(GitHub 对无头浏览器回
 * ERR_ABORTED,一次任务 66 连败、烧穿 60 万 token)——classifyBrowserFailure
 * 的「不要原地重试」是软提示,生产证明模型不照办。这里是硬闸:同域名连续
 * N 次网络层失败即熔断,冷却窗内后续导航直接结构化拒绝(不再发起请求),
 * 并指路替代信息源;成功一次即清零,冷却窗过后放行探测(站点故障多为
 * 间歇性,不搞终身封禁)。
 *
 * 纯逻辑独立成模块:plugin-browser 装配,测试直测(vitest,now 注入)。
 * 进程级共享:反爬封锁的是出口 IP,不分用户。
 */

export const CIRCUIT_TRIP_THRESHOLD = 3;
export const CIRCUIT_COOLDOWN_MS = 10 * 60 * 1000;

/** 常见双段后缀(ccTLD 下还挂二级):取注册域时倒数第三段才有效 */
const MULTIPART_SUFFIXES = new Set([
  'co.uk', 'org.uk', 'ac.uk', 'com.cn', 'net.cn', 'org.cn', 'com.au', 'net.au',
  'co.jp', 'or.jp', 'ne.jp', 'co.kr', 'or.kr', 'com.br', 'com.tw', 'com.hk',
  'co.nz', 'co.za', 'com.sg', 'co.in',
]);

/** 从 hostname 提取注册域(api.github.com → github.com;不合法输入返回空串) */
export function registrableDomain(hostname: string): string {
  let host = String(hostname || '').trim().toLowerCase();
  if (!host) return '';
  try {
    // host 形态而非完整 URL 时 URL 构造会当路径处理,先归一成可解析形态
    host = new URL(`http://${host}`).hostname;
  } catch {
    return '';
  }
  host = host.replace(/^www\./, '');
  const labels = host.split('.');
  if (labels.length < 2) return host;
  const lastTwo = labels.slice(-2).join('.');
  if (labels.length >= 3 && MULTIPART_SUFFIXES.has(lastTwo)) return labels.slice(-3).join('.');
  return lastTwo;
}

/** 从 URL 提取注册域;解析失败返回空串(熔断按「不拦」处理,fail-open) */
export function domainOfUrl(url: string): string {
  const raw = String(url || '').trim();
  if (!raw) return '';
  try {
    return registrableDomain(new URL(raw).hostname);
  } catch {
    // 无协议头的裸域名(github.com/tunsuy/agtpilot 形态)也放行探测
    const head = raw.split(/[/?#]/)[0];
    if (!head.includes('.')) return '';
    try {
      return registrableDomain(new URL(`http://${head}`).hostname);
    } catch {
      return '';
    }
  }
}

interface DomainState {
  /** 连续网络层失败次数(成功即清零) */
  consecutiveFails: number;
  lastFailAt: number;
}

export interface CircuitCheck {
  blocked: boolean;
  domain: string;
  /** 熔断依据的连续失败次数(blocked 时 ≥ 阈值) */
  consecutiveFails: number;
  /** 冷却剩余毫秒(blocked 时 > 0) */
  retryAfterMs: number;
}

export interface DomainCircuitOptions {
  /** 连续网络层失败多少次熔断;默认 3 */
  threshold?: number;
  /** 熔断冷却窗(毫秒),窗过后放行探测;默认 10 分钟 */
  cooldownMs?: number;
  /** 时钟注入(测试用);默认 Date.now */
  now?: () => number;
}

export class DomainCircuit {
  private readonly threshold: number;
  private readonly cooldownMs: number;
  private readonly now: () => number;
  private readonly states = new Map<string, DomainState>();

  constructor(opts: DomainCircuitOptions = {}) {
    this.threshold = Math.max(1, opts.threshold ?? CIRCUIT_TRIP_THRESHOLD);
    this.cooldownMs = Math.max(0, opts.cooldownMs ?? CIRCUIT_COOLDOWN_MS);
    this.now = opts.now ?? Date.now;
  }

  /** 域名当前是否熔断中(冷却窗内且连续失败达阈值);解析失败一律不拦 */
  check(url: string): CircuitCheck {
    const domain = domainOfUrl(url);
    if (!domain) return { blocked: false, domain: '', consecutiveFails: 0, retryAfterMs: 0 };
    const state = this.states.get(domain);
    if (!state) return { blocked: false, domain, consecutiveFails: 0, retryAfterMs: 0 };
    const sinceFail = this.now() - state.lastFailAt;
    const stillHot = state.consecutiveFails >= this.threshold && sinceFail < this.cooldownMs;
    return {
      blocked: stillHot,
      domain,
      consecutiveFails: state.consecutiveFails,
      retryAfterMs: stillHot ? this.cooldownMs - sinceFail : 0,
    };
  }

  /** 记一次网络层失败(只应由 network 类失败调用;其他类失败不计数) */
  recordFailure(url: string): void {
    const domain = domainOfUrl(url);
    if (!domain) return;
    const state = this.states.get(domain);
    if (state) {
      state.consecutiveFails += 1;
      state.lastFailAt = this.now();
    } else {
      this.states.set(domain, { consecutiveFails: 1, lastFailAt: this.now() });
    }
  }

  /** 记一次成功:清零并解除熔断(探测通过 = 站点恢复) */
  recordSuccess(url: string): void {
    this.states.delete(domainOfUrl(url));
  }
}
