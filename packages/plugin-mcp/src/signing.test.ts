import { describe, it, expect, vi } from 'vitest';
import { buildSignedFetch, type RequestSigner, type SignableRequest } from './index';

/**
 * buildSignedFetch —— 逐请求签名 fetch 包装(签名网关型 MCP 扩展点)。
 * 不触网:用假 baseFetch 断言「签名器收到什么 / 附加头如何合并」。
 */

/** 捕获 baseFetch 实际收到的 (url, init),并回一个空 200 */
function spyFetch() {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const base = (async (url: any, init: any) => {
    calls.push({ url: String(url), init });
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { base, calls };
}

/** 把 Headers/HeadersInit 归一成小写键 record 便于断言 */
function headerRecord(h: HeadersInit | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  new Headers(h as HeadersInit).forEach((v, k) => (out[k.toLowerCase()] = v));
  return out;
}

describe('buildSignedFetch', () => {
  it('签名器收到 method/body/Authorization(headers 小写键快照)', async () => {
    const seen: SignableRequest[] = [];
    const signer: RequestSigner = (req) => {
      seen.push(req);
      return { 'x-sign': 'abc' };
    };
    const { base, calls } = spyFetch();
    const sf = buildSignedFetch(signer, base);

    await sf('https://api.example.com/mcp', {
      method: 'POST',
      headers: { Authorization: 'Bearer KEY', 'Content-Type': 'application/json' },
      body: '{"jsonrpc":"2.0","id":1}',
    });

    expect(seen).toHaveLength(1);
    expect(seen[0].method).toBe('POST');
    expect(seen[0].url).toBe('https://api.example.com/mcp');
    expect(seen[0].body).toBe('{"jsonrpc":"2.0","id":1}');
    // Authorization 归一为小写键,签名器可读到用于 HMAC
    expect(seen[0].headers['authorization']).toBe('Bearer KEY');
    // 附加头合并进真实请求
    expect(headerRecord(calls[0].init.headers)['x-sign']).toBe('abc');
    // 原静态头保留
    expect(headerRecord(calls[0].init.headers)['authorization']).toBe('Bearer KEY');
  });

  it('签名头覆盖同名静态头(后置覆盖)', async () => {
    const signer: RequestSigner = () => ({ 'x-shared': 'signed' });
    const { base, calls } = spyFetch();
    const sf = buildSignedFetch(signer, base);
    await sf('https://x.test/mcp', { method: 'POST', headers: { 'x-shared': 'static' }, body: '' });
    expect(headerRecord(calls[0].init.headers)['x-shared']).toBe('signed');
  });

  it('GET/无 body → 签名器 body 为空串', async () => {
    let gotBody = 'UNSET';
    const signer: RequestSigner = (req) => {
      gotBody = req.body;
      return {};
    };
    const { base } = spyFetch();
    const sf = buildSignedFetch(signer, base);
    await sf('https://x.test/mcp', { method: 'GET' });
    expect(gotBody).toBe('');
  });

  it('method 缺省 → 归一为 GET', async () => {
    let gotMethod = '';
    const signer: RequestSigner = (req) => {
      gotMethod = req.method;
      return {};
    };
    const { base } = spyFetch();
    await buildSignedFetch(signer, base)('https://x.test/mcp', {});
    expect(gotMethod).toBe('GET');
  });

  it('异步签名器(Promise)被 await', async () => {
    const signer: RequestSigner = async () => ({ 'x-async': 'ok' });
    const { base, calls } = spyFetch();
    await buildSignedFetch(signer, base)('https://x.test/mcp', { method: 'POST', body: '{}' });
    expect(headerRecord(calls[0].init.headers)['x-async']).toBe('ok');
  });

  it('签名器每次请求都重新调用(逐请求现算,非缓存)', async () => {
    const signer = vi.fn<RequestSigner>(() => ({ 'x-n': '1' }));
    const { base } = spyFetch();
    const sf = buildSignedFetch(signer, base);
    await sf('https://x.test/mcp', { method: 'POST', body: '{"a":1}' });
    await sf('https://x.test/mcp', { method: 'POST', body: '{"a":2}' });
    expect(signer).toHaveBeenCalledTimes(2);
    expect(signer.mock.calls[0][0].body).toBe('{"a":1}');
    expect(signer.mock.calls[1][0].body).toBe('{"a":2}');
  });
});
