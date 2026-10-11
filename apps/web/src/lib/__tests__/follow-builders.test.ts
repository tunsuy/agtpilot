import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  fetchFollowBuildersFeed,
  buildDigestMaterial,
  buildFollowBuildersTools,
  resetFollowBuildersCacheForTest,
  FB_STALE_MS,
  type FbFeedRaw,
} from '../follow-builders';

const NOW = Date.parse('2026-10-11T12:00:00Z');
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

/** 三个 feed 的最小合法样本(字段形状对齐上游 generate-feed.js 输出) */
function sampleFeeds(over: { xAt?: string; podAt?: string; blogAt?: string } = {}) {
  return {
    x: {
      generatedAt: over.xAt ?? iso(3600_000),
      lookbackHours: 24,
      x: [
        {
          source: 'x',
          name: 'Andrej Karpathy',
          handle: 'karpathy',
          bio: 'building stuff',
          tweets: [
            { id: 't1', text: '新推文(2h 前)', createdAt: iso(2 * 3600_000), url: 'https://x.com/karpathy/status/t1', likes: 100, retweets: 10, replies: 5 },
            { id: 't2', text: '旧推文(30h 前,超 24h 窗)', createdAt: iso(30 * 3600_000), url: 'https://x.com/karpathy/status/t2', likes: 900, retweets: 90, replies: 9 },
          ],
        },
        {
          source: 'x',
          name: 'Swyx',
          handle: 'swyx',
          tweets: [{ id: 't3', text: '中间推文(10h 前)', createdAt: iso(10 * 3600_000), url: 'https://x.com/swyx/status/t3', likes: 500, retweets: 50, replies: 20 }],
        },
      ],
      stats: { xBuilders: 2, totalTweets: 3 },
    },
    podcasts: {
      generatedAt: over.podAt ?? iso(3600_000),
      lookbackHours: 336,
      podcasts: [
        {
          source: 'podcast',
          name: 'Latent Space',
          title: 'Ep 1',
          url: 'https://youtube.com/watch?v=ep1',
          publishedAt: iso(5 * 3600_000),
          transcript: 'A'.repeat(100),
        },
        {
          source: 'podcast',
          name: 'No Priors',
          title: 'Ep old',
          url: 'https://youtube.com/watch?v=epold',
          publishedAt: iso(200 * 3600_000), // 超出 168h 窗
          transcript: 'old',
        },
      ],
    },
    blogs: {
      generatedAt: over.blogAt ?? iso(3600_000),
      lookbackHours: 72,
      blogs: [
        {
          source: 'blog',
          name: 'Anthropic Engineering',
          title: 'Post 1',
          url: 'https://www.anthropic.com/engineering/post-1',
          publishedAt: iso(6 * 3600_000),
          author: 'someone',
          description: 'desc',
          content: 'B'.repeat(80),
        },
      ],
    },
  };
}

/** mock fetch:按 URL 分发样本;failUrls 里的抛网络错 */
function mockFetch(feeds: any, failUrls: string[] = []) {
  return vi.fn(async (url: string) => {
    if (failUrls.some((f) => String(url).includes(f))) {
      throw new Error('network down');
    }
    const key = String(url).includes('feed-x')
      ? 'x'
      : String(url).includes('feed-podcasts')
        ? 'podcasts'
        : 'blogs';
    return { ok: true, json: async () => feeds[key] } as any;
  });
}

beforeEach(() => {
  resetFollowBuildersCacheForTest();
});

describe('fetchFollowBuildersFeed · 拉取与缓存', () => {
  it('三路并行拉取成功;TTL 内二次调用命中缓存不重复打上游', async () => {
    const f = mockFetch(sampleFeeds());
    const first = await fetchFollowBuildersFeed({ fetchImpl: f as any, now: () => NOW });
    expect(first.x?.x).toHaveLength(2);
    expect(first.podcasts?.podcasts).toHaveLength(2);
    expect(first.blogs?.blogs).toHaveLength(1);
    expect(first.errors).toEqual([]);
    expect(f).toHaveBeenCalledTimes(3);

    const second = await fetchFollowBuildersFeed({ fetchImpl: f as any, now: () => NOW + 60_000 });
    expect(second).toBe(first);
    expect(f).toHaveBeenCalledTimes(3);
  });

  it('TTL 过期后重新拉取', async () => {
    const f = mockFetch(sampleFeeds());
    await fetchFollowBuildersFeed({ fetchImpl: f as any, now: () => NOW, ttlMs: 1000 });
    await fetchFollowBuildersFeed({ fetchImpl: f as any, now: () => NOW + 2000, ttlMs: 1000 });
    expect(f).toHaveBeenCalledTimes(6);
  });

  it('部分失败容忍:feed-x 挂了 → x 为 null,其余照常,errors 记录', async () => {
    const f = mockFetch(sampleFeeds(), ['feed-x.json']);
    const raw = await fetchFollowBuildersFeed({ fetchImpl: f as any, now: () => NOW });
    expect(raw.x).toBeNull();
    expect(raw.podcasts).not.toBeNull();
    expect(raw.blogs).not.toBeNull();
    expect(raw.errors.join()).toContain('feed-x');
    expect(raw.errors.join()).toContain('network down');
  });

  it('全部失败且无缓存 → 三路全 null + errors(调用方按失败处理)', async () => {
    const f = mockFetch(sampleFeeds(), ['feed-x.json', 'feed-podcasts.json', 'feed-blogs.json']);
    const raw = await fetchFollowBuildersFeed({ fetchImpl: f as any, now: () => NOW });
    expect(raw.x).toBeNull();
    expect(raw.podcasts).toBeNull();
    expect(raw.blogs).toBeNull();
    expect(raw.errors).toHaveLength(3);
  });

  it('全部失败但有旧缓存 → 退回旧数据并叠加本次错误', async () => {
    const ok = mockFetch(sampleFeeds());
    // 先成功拉取建立缓存
    const fresh = await fetchFollowBuildersFeed({ fetchImpl: ok as any, now: () => NOW });
    expect(fresh.x).not.toBeNull();
    // 缓存过期后上游全挂 → 回退旧缓存,错误叠加带出
    const broken = mockFetch(sampleFeeds(), ['feed-x.json', 'feed-podcasts.json', 'feed-blogs.json']);
    const stale = await fetchFollowBuildersFeed({
      fetchImpl: broken as any,
      now: () => NOW + 10 * 60 * 1000,
      ttlMs: 1000,
    });
    expect(stale.x).not.toBeNull(); // 缓存兜底
    expect(stale.errors.join()).toContain('network down');
  });
});

describe('buildDigestMaterial · 裁剪契约', () => {
  const raw = (feeds: any): FbFeedRaw => ({
    x: feeds.x,
    podcasts: feeds.podcasts,
    blogs: feeds.blogs,
    fetchedAt: NOW,
    errors: [],
  });

  it('时间窗过滤:超 rangeHours 的推文/播客被丢弃', () => {
    const m = buildDigestMaterial(raw(sampleFeeds()), { rangeHours: 24, now: NOW });
    // t2(30h 前)出局;t1、t3 保留
    const allTweets = m.x.flatMap((a) => a.tweets.map((t) => t.id));
    expect(allTweets).toEqual(expect.arrayContaining(['t1', 't3']));
    expect(allTweets).not.toContain('t2');
    // 播客 Ep old(200h 前)出局
    expect(m.podcasts.map((p) => p.title)).toEqual(['Ep 1']);
  });

  it('rangeHours=168 时 30h 前推文回来、200h 前播客仍出局', () => {
    const m = buildDigestMaterial(raw(sampleFeeds()), { rangeHours: 168, now: NOW });
    const allTweets = m.x.flatMap((a) => a.tweets.map((t) => t.id));
    expect(allTweets).toContain('t2');
    expect(m.podcasts.map((p) => p.title)).toEqual(['Ep 1']);
  });

  it('maxTweets 总量上限按互动量取高', () => {
    const m = buildDigestMaterial(raw(sampleFeeds()), { rangeHours: 168, maxTweets: 2, now: NOW });
    const allTweets = m.x.flatMap((a) => a.tweets.map((t) => t.id));
    expect(allTweets).toHaveLength(2);
    // t2(999 互动)> t3(570)> t1(115):留 t2、t3
    expect(allTweets).toEqual(expect.arrayContaining(['t2', 't3']));
    expect(allTweets).not.toContain('t1');
  });

  it('categories 过滤:只要 x → 播客/博客为空且不标 stale', () => {
    const m = buildDigestMaterial(raw(sampleFeeds()), { categories: ['x'], now: NOW });
    expect(m.x.length).toBeGreaterThan(0);
    expect(m.podcasts).toEqual([]);
    expect(m.blogs).toEqual([]);
    expect(m.stale).toEqual([]);
  });

  it('feed 缺失但类别被请求 → 该类别标 stale(不静默缺失)', () => {
    const feeds = sampleFeeds();
    const m = buildDigestMaterial(
      { x: null, podcasts: feeds.podcasts, blogs: feeds.blogs, fetchedAt: NOW, errors: ['feed-x: down'] },
      { now: NOW }
    );
    expect(m.stale).toContain('x');
    expect(m.errors.join()).toContain('down');
  });

  it('转写与正文截断:超限截断并打 truncated 标记', () => {
    const m = buildDigestMaterial(raw(sampleFeeds()), { transcriptChars: 10, blogContentChars: 20, now: NOW });
    expect(m.podcasts[0].transcriptExcerpt).toHaveLength(11); // 10 + 省略号
    expect(m.podcasts[0].transcriptTruncated).toBe(true);
    expect(m.blogs[0].contentExcerpt).toHaveLength(21);
    expect(m.blogs[0].contentTruncated).toBe(true);
  });

  it('新鲜度:generatedAt 超 48h → stale;新鲜 → 不进 stale,coverageHours 透传', () => {
    const fresh = buildDigestMaterial(raw(sampleFeeds()), { now: NOW });
    expect(fresh.stale).toEqual([]);
    expect(fresh.coverageHours).toEqual({ x: 24, podcasts: 336, blogs: 72 });

    const old = buildDigestMaterial(
      raw(sampleFeeds({ xAt: iso(FB_STALE_MS + 3600_000) })),
      { now: NOW }
    );
    expect(old.stale).toEqual(['x']);
  });
});

describe('follow_builders_fetch_feed 工具', () => {
  function tool() {
    return buildFollowBuildersTools()[0];
  }

  it('工具契约:只读 low、并行门控 readOnly、参数为 rangeHours/categories', () => {
    const t = tool();
    expect(t.name).toBe('follow_builders_fetch_feed');
    expect(t.dangerLevel).toBe('low');
    expect(t.readOnly).toBe(true);
    expect((t.parameters as any).properties.rangeHours).toBeDefined();
    expect((t.parameters as any).properties.categories).toBeDefined();
  });

  it('成功路径:返回 counts 与素材;rangeHours/categories 透传生效', async () => {
    const f = mockFetch(sampleFeeds());
    resetFollowBuildersCacheForTest();
    // 通过全局 fetch 注入(工具内部走默认 fetch)
    const origFetch = globalThis.fetch;
    globalThis.fetch = f as any;
    try {
      const res: any = await (tool().execute as any)({ rangeHours: 168, categories: ['x'] });
      expect(res.success).toBe(true);
      expect(res.counts.tweets).toBe(3); // 168h 窗内 t1/t2/t3 全在
      expect(res.counts.podcasts).toBe(0); // categories 只要 x
      expect(res.x.length).toBeGreaterThan(0);
    } finally {
      globalThis.fetch = origFetch;
      resetFollowBuildersCacheForTest();
    }
  });

  it('上游全挂且无缓存 → success:false,错误里带降级路径', async () => {
    const f = mockFetch(sampleFeeds(), ['feed-x.json', 'feed-podcasts.json', 'feed-blogs.json']);
    const origFetch = globalThis.fetch;
    globalThis.fetch = f as any;
    try {
      const res: any = await (tool().execute as any)({});
      expect(res.success).toBe(false);
      expect(res.error).toContain('降级');
      expect(res.error).toContain('mcp_twitterapi_io_');
    } finally {
      globalThis.fetch = origFetch;
      resetFollowBuildersCacheForTest();
    }
  });

  it('stale 数据 → success 但带 staleWarning(要求日报提示过期)', async () => {
    // 工具 execute 用真实时钟:留足裕量(48h 阈值 + 72h),不受测试运行时刻影响
    const old = iso(FB_STALE_MS + 72 * 3600_000);
    const f = mockFetch(sampleFeeds({ xAt: old, podAt: old, blogAt: old }));
    const origFetch = globalThis.fetch;
    globalThis.fetch = f as any;
    try {
      const res: any = await (tool().execute as any)({});
      expect(res.success).toBe(true);
      expect(res.stale).toEqual(['x', 'podcasts', 'blogs']);
      expect(res.staleWarning).toContain('48 小时');
      expect(res.staleWarning).toContain('日报开头');
    } finally {
      globalThis.fetch = origFetch;
      resetFollowBuildersCacheForTest();
    }
  });
});
