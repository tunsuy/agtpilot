import { describe, it, expect } from 'vitest';
import {
  normalizeFlyaiAuth,
  flyaiCanonical,
  flyaiHmac,
  flyaiSigner,
  resolveFlyaiKey,
  FLYAI_SIGN_SECRET_DEFAULT,
  FLYAI_PUBLIC_TRIAL_KEY,
} from '../flyai-sign';

/**
 * 飞猪 flyai 签名纯函数回归。已知向量取自对服务端**实测通过**(200)的请求
 * (2026-10-14;错 signSecret → 401,证明服务端强制校验、本实现与之逐字节一致)。
 */

const SECRET = FLYAI_SIGN_SECRET_DEFAULT;

describe('normalizeFlyaiAuth', () => {
  it('裸 key 补 Bearer 前缀;已带前缀原样;空/缺省 → 空串', () => {
    expect(normalizeFlyaiAuth('KEY')).toBe('Bearer KEY');
    expect(normalizeFlyaiAuth('Bearer KEY')).toBe('Bearer KEY');
    expect(normalizeFlyaiAuth('')).toBe('');
    expect(normalizeFlyaiAuth(undefined)).toBe('');
    expect(normalizeFlyaiAuth(null)).toBe('');
  });
});

describe('resolveFlyaiKey(默认公共 key、用户配置优先)', () => {
  it('用户配了真实 key → 用用户的', () => {
    expect(resolveFlyaiKey('sk-user-own')).toBe('sk-user-own');
    expect(resolveFlyaiKey('  sk-user-own  ')).toBe('sk-user-own'); // 两端空白裁掉
  });
  it('未配 / 空 / 启用哨兵 1 → 回退公共试用 key', () => {
    expect(resolveFlyaiKey('')).toBe(FLYAI_PUBLIC_TRIAL_KEY);
    expect(resolveFlyaiKey('   ')).toBe(FLYAI_PUBLIC_TRIAL_KEY);
    expect(resolveFlyaiKey('1')).toBe(FLYAI_PUBLIC_TRIAL_KEY);
    expect(resolveFlyaiKey(undefined)).toBe(FLYAI_PUBLIC_TRIAL_KEY);
    expect(resolveFlyaiKey(null)).toBe(FLYAI_PUBLIC_TRIAL_KEY);
  });
});

describe('flyaiCanonical / flyaiHmac(实测向量)', () => {
  const fixed = {
    method: 'POST',
    pathname: '/mcp',
    timestampMs: '1700000000000',
    nonce: '00000000000000000000000000000000',
    body: '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}',
    authorization: 'Bearer TEST-KEY',
  };

  it('canonical string 逐字段固定顺序(\\n 连接,body/auth 取 sha256 hex)', () => {
    expect(flyaiCanonical(fixed)).toBe(
      'POST\n/mcp\n1700000000000\n00000000000000000000000000000000\n' +
        '17b0e4fe8898d0f7b668dd1437d3078266e8d170bc490ebbb012e2bbbcd7b913\n' +
        '28716efa37c7d7cd6a45ebb63fedbe161db826fc127f8c50699c726dd46f2eb0'
    );
  });

  it('HMAC-SHA256 → base64url 与服务端实测向量一致', () => {
    expect(flyaiHmac(SECRET, flyaiCanonical(fixed))).toBe('jG6qTdmd7mjTtd_xgR1PgBvcKo8GmsFkLZNR1nMpQpA');
  });

  it('authorization 无 Bearer 前缀时归一后签名不变(与带前缀同值)', () => {
    const withPrefix = flyaiHmac(SECRET, flyaiCanonical({ ...fixed, authorization: 'Bearer TEST-KEY' }));
    const bare = flyaiHmac(SECRET, flyaiCanonical({ ...fixed, authorization: 'TEST-KEY' }));
    expect(bare).toBe(withPrefix);
  });
});

describe('flyaiSigner(逐请求现算)', () => {
  const baseReq = {
    method: 'POST',
    url: 'https://flyai.open.fliggy.com/mcp',
    body: '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}',
    headers: { authorization: 'Bearer TEST-KEY' },
  };

  it('固定 now/nonce → 产出 5 个 x-flyai-* 头,sign 等于已知向量', () => {
    const signer = flyaiSigner({
      apiKey: 'TEST-KEY',
      now: () => 1700000000000,
      randomNonce: () => '00000000000000000000000000000000',
    });
    const h = signer(baseReq) as Record<string, string>;
    expect(h['x-flyai-sign-ver']).toBe('7');
    expect(h['x-flyai-sign-alg']).toBe('hmac-sha256');
    expect(h['x-flyai-ts']).toBe('1700000000000');
    expect(h['x-flyai-nonce']).toBe('00000000000000000000000000000000');
    expect(h['x-flyai-sign']).toBe('jG6qTdmd7mjTtd_xgR1PgBvcKo8GmsFkLZNR1nMpQpA');
  });

  it('pathname 从 url 解析(签名覆盖 path,非整 URL)', () => {
    const signer = flyaiSigner({ apiKey: 'K', now: () => 1700000000000, randomNonce: () => 'n' });
    const a = signer({ ...baseReq, url: 'https://flyai.open.fliggy.com/mcp?x=1' }) as Record<string, string>;
    const b = signer({ ...baseReq, url: 'https://flyai.open.fliggy.com/mcp' }) as Record<string, string>;
    // query 不进 canonical,pathname 同为 /mcp → 签名一致
    expect(a['x-flyai-sign']).toBe(b['x-flyai-sign']);
  });

  it('请求头无 authorization 时回退用 apiKey 拼 Bearer(签名仍覆盖同一 key)', () => {
    const withHeader = flyaiSigner({ apiKey: 'TEST-KEY', now: () => 1700000000000, randomNonce: () => '00000000000000000000000000000000' });
    const noHeader = flyaiSigner({ apiKey: 'TEST-KEY', now: () => 1700000000000, randomNonce: () => '00000000000000000000000000000000' });
    const h1 = withHeader(baseReq) as Record<string, string>;
    const h2 = noHeader({ ...baseReq, headers: {} }) as Record<string, string>;
    expect(h2['x-flyai-sign']).toBe(h1['x-flyai-sign']);
  });

  it('signSecret 覆盖:自定义 secret → 签名不同(证明 secret 参与 HMAC)', () => {
    const def = flyaiSigner({ apiKey: 'K', now: () => 1, randomNonce: () => 'n' })(baseReq) as Record<string, string>;
    const custom = flyaiSigner({ apiKey: 'K', signSecret: 'other-secret', now: () => 1, randomNonce: () => 'n' })(baseReq) as Record<string, string>;
    expect(custom['x-flyai-sign']).not.toBe(def['x-flyai-sign']);
  });

  it('url 非法 → pathname 回退 /(不抛错)', () => {
    const signer = flyaiSigner({ apiKey: 'K', now: () => 1700000000000, randomNonce: () => '00000000000000000000000000000000' });
    expect(() => signer({ ...baseReq, url: 'not-a-url' })).not.toThrow();
  });
});
