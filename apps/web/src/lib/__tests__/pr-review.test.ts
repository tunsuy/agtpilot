import { describe, it, expect } from 'vitest';
import { renderReviewContext, fetchPrReviewContext } from '../pr-review';

const PR = 'https://github.com/vllm-project/vllm/pull/999';
const T = 1_760_000_000_000; // 2025-10-09 前后,固定时刻保证断言可复现

const review = (o: Record<string, unknown> = {}) => ({
  user: { login: 'reviewer1' },
  state: 'CHANGES_REQUESTED',
  body: '请补一个单测',
  submitted_at: '2026-10-18T08:00:00Z',
  ...o,
});

const inline = (o: Record<string, unknown> = {}) => ({
  user: { login: 'reviewer2' },
  body: '这里边界没处理',
  path: 'src/sampler.py',
  line: 42,
  created_at: '2026-10-18T09:00:00Z',
  ...o,
});

const conv = (o: Record<string, unknown> = {}) => ({
  user: { login: 'maintainer' },
  body: 'CI 挂了,看下日志',
  created_at: '2026-10-19T10:00:00Z',
  ...o,
});

describe('renderReviewContext(纯函数:GitHub 原始响应 → 跟进任务上下文)', () => {
  it('头部:PR 链接 + ISO 拉取时间 + 「已解决状态不可见、以用户取舍为准」提示', () => {
    const text = renderReviewContext({ prUrl: PR, fetchedAt: T, reviews: [review()] });
    expect(text).toContain(PR);
    expect(text).toContain(new Date(T).toISOString());
    expect(text).toContain('看不到「已解决」线程状态');
    expect(text).toContain('以此为准');
  });

  it('Review 段落:login/state/日期 + 正文;跳过无正文 APPROVED,保留无正文 CHANGES_REQUESTED', () => {
    const text = renderReviewContext({
      prUrl: PR,
      fetchedAt: T,
      reviews: [
        review({ state: 'APPROVED', body: '' }), // 无信息量 → 跳过
        review({ state: 'CHANGES_REQUESTED', body: '', user: { login: 'strict' } }), // 态度即信息 → 保留
        review({ state: 'COMMENTED', body: '命名建议改一下', user: { login: 'nit' }, submitted_at: '2026-10-17T00:00:00Z' }),
      ],
    });
    expect(text).not.toContain('reviewer1'); // 唯一一条 reviewer1 是无正文 APPROVED
    expect(text).toContain('## Review · strict · CHANGES_REQUESTED');
    expect(text).toContain('## Review · nit · COMMENTED · 2026-10-17');
    expect(text).toContain('命名建议改一下');
  });

  it('行内评论:path:line 段落 + in_reply_to 提示;line 缺失回落 original_line,再缺省无行号', () => {
    const text = renderReviewContext({
      prUrl: PR,
      fetchedAt: T,
      inlineComments: [
        inline(),
        inline({ path: 'src/other.py', line: undefined, original_line: 7, in_reply_to_id: 123 }),
        inline({ body: '   ' }), // 空正文 → 跳过
      ],
    });
    expect(text).toContain('## 行内评论(3 条)'); // 计数按原始条数(用户可对照 GitHub 页面核对)
    expect(text).toContain('### src/sampler.py:42 · reviewer2 · 2026-10-18');
    expect(text).toContain('### src/other.py:7 · reviewer2');
    expect(text).toContain('(↑ 回复某条评论');
    expect(text).not.toMatch(/### \(未知文件\)/); // path 都在
  });

  it('path 缺失 → (未知文件);user 缺失 → (未知用户);会话评论独立段落', () => {
    const text = renderReviewContext({
      prUrl: PR,
      fetchedAt: T,
      inlineComments: [{ body: 'no path no user' }],
      issueComments: [conv()],
    });
    expect(text).toContain('### (未知文件) · (未知用户)');
    expect(text).toContain('## 会话评论(1 条)');
    expect(text).toContain('### maintainer · 2026-10-19');
    expect(text).toContain('CI 挂了,看下日志');
  });

  it('单条正文超 1500 → 截断 + 标记;总长超 8000 → 尾部总截断标记', () => {
    const long = 'x'.repeat(1600);
    const t1 = renderReviewContext({ prUrl: PR, fetchedAt: T, issueComments: [conv({ body: long })] });
    expect(t1).toContain('…[截断 1600→1500]');

    const many = Array.from({ length: 12 }, (_, i) => conv({ body: 'y'.repeat(1400), user: { login: `u${i}` } }));
    const t2 = renderReviewContext({ prUrl: PR, fetchedAt: T, issueComments: many });
    expect(t2).toContain('…[截断');
    expect(t2.slice(0, 8000).length).toBe(8000); // 主体不超 TOTAL_CAP(标记在其后)
  });

  it('全空/非数组脏输入 → 占位说明(不抛错);非对象条目被过滤', () => {
    const empty = renderReviewContext({ prUrl: PR, fetchedAt: T, reviews: [], inlineComments: [], issueComments: [] });
    expect(empty).toContain('未拉到任何 review/评论');
    expect(empty).toContain('人工核对后补充');

    const dirty = renderReviewContext({ prUrl: PR, fetchedAt: T, reviews: 'nope', inlineComments: null, issueComments: [null, 42, review()] });
    expect(dirty).toContain('### reviewer1'); // 非对象条目被过滤,合法对象照常渲染(按会话评论段落)
    expect(dirty).toContain('请补一个单测');
    expect(dirty).not.toContain('未拉到');
  });
});

// ---------- fetchPrReviewContext(网络只在这里;fetchImpl 注入) ----------

function jsonResponse(status: number, data: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => data } as unknown as Response;
}

function recFetch(byUrl: (url: string) => Response) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const impl = ((url: any, init?: RequestInit) => {
    calls.push({ url: String(url), ...(init ? { init } : {}) });
    return Promise.resolve(byUrl(String(url)));
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const BASE = 'https://api.github.com/repos/vllm-project/vllm';

describe('fetchPrReviewContext(公开 API 三端点;凭据零上行)', () => {
  it('prUrl 畸形 → ok:false,零网络调用', async () => {
    const { impl, calls } = recFetch(() => jsonResponse(200, []));
    const r = await fetchPrReviewContext('https://github.com/o/r/issues/9', { fetchImpl: impl, token: null, now: T });
    expect(r.ok).toBe(false);
    expect((r as any).error).toContain('畸形');
    expect(calls).toHaveLength(0);
  });

  it('三端点 200 → ok:true + stats;URL/头正确;显式 token 才带 Authorization', async () => {
    const { impl, calls } = recFetch((url) =>
      jsonResponse(200, url.includes('/reviews') ? [review()] : url.includes('/pulls/999/comments') ? [inline()] : [conv()])
    );
    const r = await fetchPrReviewContext(PR, { fetchImpl: impl, token: 'tok_1', now: T });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.stats).toEqual({ reviews: 1, inlineComments: 1, issueComments: 1 });
    expect(r.context).toContain('请补一个单测');
    expect(calls.map((c) => c.url).sort()).toEqual(
      [`${BASE}/issues/999/comments?per_page=50`, `${BASE}/pulls/999/comments?per_page=100`, `${BASE}/pulls/999/reviews?per_page=50`].sort()
    );
    const headers = calls[0].init!.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer tok_1');
    expect(headers.Accept).toBe('application/vnd.github+json');
    expect(headers['X-GitHub-Api-Version']).toBe('2022-11-28');

    const { impl: impl2, calls: calls2 } = recFetch(() => jsonResponse(200, []));
    await fetchPrReviewContext(PR, { fetchImpl: impl2, token: null, now: T });
    expect((calls2[0].init!.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it('403/429 → 限流话术(引导手工粘贴降级);404 → 非公开仓话术;其余状态 → 状态码话术', async () => {
    for (const status of [403, 429]) {
      const { impl } = recFetch(() => jsonResponse(status, {}));
      const r = await fetchPrReviewContext(PR, { fetchImpl: impl, token: null, now: T });
      expect(r.ok).toBe(false);
      expect((r as any).error).toContain('限流');
      expect((r as any).error).toContain('手工粘贴');
    }
    const nf = recFetch(() => jsonResponse(404, {}));
    const r404 = await fetchPrReviewContext(PR, { fetchImpl: nf.impl, token: null, now: T });
    expect(r404.ok).toBe(false);
    expect((r404 as any).error).toContain('公开仓');

    const ise = recFetch(() => jsonResponse(500, {}));
    const r500 = await fetchPrReviewContext(PR, { fetchImpl: ise.impl, token: null, now: T });
    expect((r500 as any).error).toContain('500');
  });

  it('fetch 抛错(断网/DNS)→ ok:false,错误信息透传', async () => {
    const impl = (() => Promise.reject(new Error('network down'))) as unknown as typeof fetch;
    const r = await fetchPrReviewContext(PR, { fetchImpl: impl, token: null, now: T });
    expect(r.ok).toBe(false);
    expect((r as any).error).toBe('network down');
  });
});
