import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  fetchWithEffortFallback,
  __resetEffortFallbackCount,
  effortFallbackCount,
} from './effort-fallback';

/**
 * 思考深度中转容错测试(生产实测 ai.ctaigw.cn:多渠道网关随机 400 拒
 * reasoning_effort=medium,兜底 = 剥参数原地重试一次,任务不中断)。
 */

const jsonRes = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

const err400 = (msg: string) => jsonRes(400, { error: { message: msg, type: 'invalid_request_error' } });

const init = (body: Record<string, unknown>): RequestInit => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

const BODY_WITH_EFFORT = { model: 'm', messages: [], reasoning_effort: 'medium' };

describe('fetchWithEffortFallback(reasoning_effort 400 降级重试)', () => {
  beforeEach(() => {
    __resetEffortFallbackCount();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('400 点名 reasoning_effort → 剥掉该参数重试一次,返回重试的 200;warning 落日志', async () => {
    const calls: string[] = [];
    const base = vi.fn(async (_input: any, i?: any) => {
      calls.push(i?.body);
      if (calls.length === 1) return err400("'reasoning_effort' must be one of: 'low', 'high', 'max'");
      return jsonRes(200, { ok: true });
    });
    const f = fetchWithEffortFallback(base as any);
    const res = await f('https://relay/v1/chat/completions', init(BODY_WITH_EFFORT));
    expect(res.status).toBe(200);
    expect(base).toHaveBeenCalledTimes(2);
    // 重试体:reasoning_effort 被剥掉,其余字段原样保留
    const retryBody = JSON.parse(calls[1]);
    expect(retryBody.reasoning_effort).toBeUndefined();
    expect(retryBody.model).toBe('m');
    expect(effortFallbackCount()).toBe(1);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('reasoning_effort'));
  });

  it('400 与 reasoning_effort 无关 → 原样透传,不重试(不误伤参数错误)', async () => {
    const base = vi.fn(async () => err400("'temperature' must be <= 2"));
    const f = fetchWithEffortFallback(base as any);
    const res = await f('https://x/v1', init(BODY_WITH_EFFORT));
    expect(res.status).toBe(400);
    expect(base).toHaveBeenCalledTimes(1);
    expect(effortFallbackCount()).toBe(0);
  });

  it('请求体没带 reasoning_effort → 400 也不读错误体、零开销透传', async () => {
    const base = vi.fn(async () => err400("'reasoning_effort' must be one of: 'low', 'high', 'max'"));
    const f = fetchWithEffortFallback(base as any);
    const res = await f('https://x/v1', init({ model: 'm', messages: [] }));
    expect(res.status).toBe(400);
    expect(base).toHaveBeenCalledTimes(1);
  });

  it('200 正常响应 → 直接透传,不碰响应体', async () => {
    const base = vi.fn(async () => jsonRes(200, { ok: true }));
    const f = fetchWithEffortFallback(base as any);
    const res = await f('https://x/v1', init(BODY_WITH_EFFORT));
    expect(res.status).toBe(200);
    expect(base).toHaveBeenCalledTimes(1);
  });

  it('只重试一次:重试仍 400 → 原样返回第二次响应,不循环', async () => {
    const base = vi.fn(async () => err400('reasoning_effort not supported at all'));
    const f = fetchWithEffortFallback(base as any);
    const res = await f('https://x/v1', init(BODY_WITH_EFFORT));
    expect(res.status).toBe(400);
    expect(base).toHaveBeenCalledTimes(2);
    expect(effortFallbackCount()).toBe(1);
  });

  it('非字符串请求体(流/FormData)→ 不拦截', async () => {
    const base = vi.fn(async () => err400('reasoning_effort bad'));
    const f = fetchWithEffortFallback(base as any);
    const res = await f('https://x/v1', { method: 'POST', body: new Uint8Array([1, 2, 3]) as any });
    expect(res.status).toBe(400);
    expect(base).toHaveBeenCalledTimes(1);
  });

  it('错误体点名但请求体 JSON 里没有 reasoning_effort 键(字符串只是巧合出现)→ 透传', async () => {
    const base = vi.fn(async () => err400('reasoning_effort rejected'));
    const f = fetchWithEffortFallback(base as any);
    // body 字符串含 reasoning_effort 字样(如消息内容里提到),但 JSON 键里没有
    const res = await f(
      'https://x/v1',
      init({ model: 'm', messages: [{ role: 'user', content: 'what is reasoning_effort' }] })
    );
    expect(res.status).toBe(400);
    expect(base).toHaveBeenCalledTimes(1);
  });

  it('透传时原响应体仍可读(clone 不消耗原体)', async () => {
    const base = vi.fn(async () => err400("'temperature' must be <= 2"));
    const f = fetchWithEffortFallback(base as any);
    const res = await f('https://x/v1', init(BODY_WITH_EFFORT));
    await expect(res.json()).resolves.toMatchObject({ error: { type: 'invalid_request_error' } });
  });
});
