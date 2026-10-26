import { describe, it, expect } from 'vitest';
import { DomainCircuit, CIRCUIT_TRIP_THRESHOLD, CIRCUIT_COOLDOWN_MS, registrableDomain, domainOfUrl } from './domain-circuit';

/**
 * 域名熔断纯逻辑直测(2026-10-26 oss_radar 生产实例的止血层):
 * 3 连败熔断 → 冷却窗内拒绝 → 窗后放行探测 → 成功清零。
 * 时钟注入,不起浏览器。
 */

const t0 = 1_700_000_000_000;

describe('registrableDomain / domainOfUrl', () => {
  it('注册域归一:子域折叠到注册域,www 剥离', () => {
    expect(registrableDomain('api.github.com')).toBe('github.com');
    expect(registrableDomain('github.com')).toBe('github.com');
    expect(registrableDomain('www.zhihu.com')).toBe('zhihu.com');
  });
  it('双段后缀(ccTLD)取倒数第三段', () => {
    expect(registrableDomain('news.baidu.com.cn')).toBe('baidu.com.cn');
    expect(registrableDomain('shop.example.co.uk')).toBe('example.co.uk');
  });
  it('domainOfUrl:完整 URL / 裸域名路径形态都解析;垃圾输入返回空串(fail-open)', () => {
    expect(domainOfUrl('https://github.com/tunsuy/agtpilot/issues')).toBe('github.com');
    expect(domainOfUrl('github.com/tunsuy/agtpilot')).toBe('github.com');
    expect(domainOfUrl('http://API.Example.COM/x')).toBe('example.com');
    expect(domainOfUrl('')).toBe('');
    expect(domainOfUrl('not a url at all')).toBe('');
    expect(domainOfUrl('localhost:3000')).toBe('');
  });
});

describe('DomainCircuit · 连败熔断', () => {
  it('阈值默认 3 次;3 连败后熔断,拒绝带剩余冷却时长', () => {
    let now = t0;
    const c = new DomainCircuit({ now: () => now });
    expect(CIRCUIT_TRIP_THRESHOLD).toBe(3);
    const url = 'https://github.com/foo/bar';
    c.recordFailure(url);
    c.recordFailure(url);
    expect(c.check(url).blocked).toBe(false);
    c.recordFailure('https://api.github.com/other'); // 子域共用同一注册域计数
    const gate = c.check(url);
    expect(gate.blocked).toBe(true);
    expect(gate.domain).toBe('github.com');
    expect(gate.consecutiveFails).toBe(3);
    expect(gate.retryAfterMs).toBe(CIRCUIT_COOLDOWN_MS);
    // 熔断是域名级:换路径/换子域同样被拦
    expect(c.check('https://github.com/anything/else').blocked).toBe(true);
  });

  it('冷却窗过后放行探测;窗内再失败续接冷却窗', () => {
    let now = t0;
    const c = new DomainCircuit({ now: () => now });
    const url = 'https://example.com/a';
    for (let i = 0; i < 3; i++) c.recordFailure(url);
    now += CIRCUIT_COOLDOWN_MS + 1;
    expect(c.check(url).blocked).toBe(false);
    // 探测失败:计数 +1,冷却窗从现在重新起算
    c.recordFailure(url);
    expect(c.check(url).blocked).toBe(true);
    expect(c.check(url).retryAfterMs).toBe(CIRCUIT_COOLDOWN_MS);
  });

  it('成功一次即清零解封', () => {
    const c = new DomainCircuit({ now: () => t0 });
    const url = 'https://example.com/a';
    c.recordFailure(url);
    c.recordFailure(url);
    c.recordFailure(url);
    c.recordSuccess(url);
    expect(c.check(url).blocked).toBe(false);
    expect(c.check(url).consecutiveFails).toBe(0);
  });

  it('不同域名互不串扰;非 URL 输入不计数不拦(fail-open)', () => {
    const c = new DomainCircuit({ now: () => t0 });
    for (let i = 0; i < 3; i++) c.recordFailure('https://github.com/x');
    expect(c.check('https://zhihu.com/question/1').blocked).toBe(false);
    c.recordFailure('::bad url::');
    expect(c.check('::bad url::').blocked).toBe(false);
  });
});
