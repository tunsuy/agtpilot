/**
 * AI Builders 日报 · follow-builders 中央 feed 读取层
 *
 * 上游:github.com/zarazhangrui/follow-builders(MIT)——其 GitHub Action
 * 每日 6:17 UTC 用 X 官方 API + 播客转写 + 博客抓取,把聚合结果发布为三个
 * 公开 JSON feed(raw.githubusercontent 直读,无需任何凭证):
 * - feed-x.json:AI builder 的 X 动态(上游只保留最近 24h)
 * - feed-podcasts.json:AI 播客新集 + 全文转写(最近 14 天)
 * - feed-blogs.json:Anthropic / Claude 官方博客新文(最近 72h)
 *
 * 本模块只做:只读拉取 + 进程内缓存(默认 30 分钟,不重复打上游)+
 * 裁剪成 LLM 友好的日报素材(时间窗过滤、条数/字数上限、转写截断)。
 * 上游断更(generatedAt 超 48h)标记 stale,由工具结果提示降级路径
 * (X 连接器 / 网页搜索自取),不静默给旧数据。
 */
import type { ToolDefinition } from '@agtpilot/core';

export const FB_FEED_URLS = {
  x: 'https://raw.githubusercontent.com/zarazhangrui/follow-builders/main/feed-x.json',
  podcasts:
    'https://raw.githubusercontent.com/zarazhangrui/follow-builders/main/feed-podcasts.json',
  blogs: 'https://raw.githubusercontent.com/zarazhangrui/follow-builders/main/feed-blogs.json',
} as const;

/** 进程内缓存 TTL:上游日更,30 分钟足够新鲜 */
export const FB_CACHE_TTL_MS = 30 * 60 * 1000;
/** generatedAt 距今超过此值 = 上游可能断更,日报须提示 */
export const FB_STALE_MS = 48 * 3600 * 1000;
/** 单个上游请求超时 */
const FB_FETCH_TIMEOUT_MS = 15_000;

// ---------------------------------------------------------------------------
// 上游 feed 类型(字段以上游 generate-feed.js 实际输出为准;缺失字段一律容错)
// ---------------------------------------------------------------------------

export interface FbTweet {
  id: string;
  text: string;
  createdAt: string;
  url: string;
  likes?: number;
  retweets?: number;
  replies?: number;
}

export interface FbXAccount {
  source?: string;
  name: string;
  handle: string;
  bio?: string;
  tweets?: FbTweet[];
}

export interface FbPodcastEpisode {
  source?: string;
  name: string;
  title: string;
  url: string;
  publishedAt?: string | null;
  transcript?: string;
}

export interface FbBlogPost {
  source?: string;
  name: string;
  title: string;
  url: string;
  publishedAt?: string | null;
  author?: string;
  description?: string;
  content?: string;
}

interface FbFeedMeta {
  generatedAt?: string;
  lookbackHours?: number;
  errors?: string[];
  [key: string]: unknown;
}

/** 一次拉取的原始结果:三个 feed 各自可空(部分失败容忍) */
export interface FbFeedRaw {
  x: (FbFeedMeta & { x?: FbXAccount[] }) | null;
  podcasts: (FbFeedMeta & { podcasts?: FbPodcastEpisode[] }) | null;
  blogs: (FbFeedMeta & { blogs?: FbBlogPost[] }) | null;
  fetchedAt: number;
  /** 拉取层错误(网络/解析),部分失败也记录 */
  errors: string[];
}

let cache: { at: number; data: FbFeedRaw } | null = null;

/** 测试专用:清进程内缓存 */
export function resetFollowBuildersCacheForTest() {
  cache = null;
}

async function fetchJson(url: string, fetchImpl: typeof fetch): Promise<any> {
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(FB_FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/**
 * 拉取三个中央 feed(并行、部分失败容忍、进程内缓存)。
 * 全部失败且有旧缓存 → 返回旧缓存并带 errors(聊胜于无,材料里会标注时间)。
 */
export async function fetchFollowBuildersFeed(
  opts: { fetchImpl?: typeof fetch; ttlMs?: number; now?: () => number } = {}
): Promise<FbFeedRaw> {
  const fetchImpl = opts.fetchImpl || fetch;
  const ttl = opts.ttlMs ?? FB_CACHE_TTL_MS;
  const nowMs = (opts.now || Date.now)();

  if (cache && nowMs - cache.at < ttl) return cache.data;

  const errors: string[] = [];
  const [xRes, podRes, blogRes] = await Promise.allSettled([
    fetchJson(FB_FEED_URLS.x, fetchImpl),
    fetchJson(FB_FEED_URLS.podcasts, fetchImpl),
    fetchJson(FB_FEED_URLS.blogs, fetchImpl),
  ]);
  if (xRes.status === 'rejected') errors.push(`feed-x: ${xRes.reason?.message || xRes.reason}`);
  if (podRes.status === 'rejected')
    errors.push(`feed-podcasts: ${podRes.reason?.message || podRes.reason}`);
  if (blogRes.status === 'rejected')
    errors.push(`feed-blogs: ${blogRes.reason?.message || blogRes.reason}`);

  const data: FbFeedRaw = {
    x: xRes.status === 'fulfilled' ? xRes.value : null,
    podcasts: podRes.status === 'fulfilled' ? podRes.value : null,
    blogs: blogRes.status === 'fulfilled' ? blogRes.value : null,
    fetchedAt: nowMs,
    errors,
  };

  const allFailed = !data.x && !data.podcasts && !data.blogs;
  if (allFailed) {
    if (cache) {
      // 上游临时不可达:退回旧缓存,把本次错误一并带出(材料层会显示 generatedAt)
      return { ...cache.data, errors: [...cache.data.errors, ...errors] };
    }
    return data; // 无缓存可用:调用方按失败处理
  }
  cache = { at: nowMs, data };
  return data;
}

// ---------------------------------------------------------------------------
// 材料裁剪(纯函数,便于契约测试)
// ---------------------------------------------------------------------------

export interface FbDigestOptions {
  /** 只保留最近 N 小时的内容(默认 24;X feed 上游本就只有 24h) */
  rangeHours?: number;
  /** 类别过滤:x / podcasts / blogs(默认全部) */
  categories?: string[];
  /** 单集播客转写截断长度(默认 6000 字符) */
  transcriptChars?: number;
  /** 单篇博客正文截断长度(默认 4000 字符) */
  blogContentChars?: number;
  /** 推文总条数上限,按互动量取高(默认 60) */
  maxTweets?: number;
  now?: number;
}

export interface FbDigestMaterial {
  /** 各类别 feed 的生成时间(上游 Action 跑批时刻) */
  generatedAt: { x?: string; podcasts?: string; blogs?: string };
  /** 上游各类别实际覆盖窗口(小时) */
  coverageHours: { x?: number; podcasts?: number; blogs?: number };
  /** generatedAt 超 48h 的类别(上游可能断更) */
  stale: string[];
  x: Array<{ name: string; handle: string; bio?: string; tweets: FbTweet[] }>;
  podcasts: Array<{
    name: string;
    title: string;
    url: string;
    publishedAt?: string | null;
    transcriptExcerpt?: string;
    transcriptTruncated?: boolean;
  }>;
  blogs: Array<{
    name: string;
    title: string;
    url: string;
    publishedAt?: string | null;
    author?: string;
    description?: string;
    contentExcerpt?: string;
    contentTruncated?: boolean;
  }>;
  errors: string[];
}

const DEFAULT_CATEGORIES = ['x', 'podcasts', 'blogs'];

function withinRange(iso: string | null | undefined, cutoff: number): boolean {
  if (!iso) return true; // 无时间戳的内容不因过滤丢失,交给 LLM 判断
  const t = Date.parse(iso);
  return Number.isNaN(t) || t >= cutoff;
}

function truncate(text: string, max: number): { excerpt: string; truncated: boolean } {
  if (text.length <= max) return { excerpt: text, truncated: false };
  return { excerpt: `${text.slice(0, max)}…`, truncated: true };
}

/** 原始 feed → 日报素材:时间窗过滤 + 条数/字数上限 + 新鲜度标注 */
export function buildDigestMaterial(
  raw: FbFeedRaw,
  opts: FbDigestOptions = {}
): FbDigestMaterial {
  const now = opts.now ?? Date.now();
  const rangeHours = opts.rangeHours && opts.rangeHours > 0 ? opts.rangeHours : 24;
  const cutoff = now - rangeHours * 3600 * 1000;
  const categories = (opts.categories?.length ? opts.categories : DEFAULT_CATEGORIES).map((c) =>
    String(c).trim().toLowerCase()
  );
  const transcriptChars = opts.transcriptChars ?? 6000;
  const blogContentChars = opts.blogContentChars ?? 4000;
  const maxTweets = opts.maxTweets ?? 60;

  const material: FbDigestMaterial = {
    generatedAt: {},
    coverageHours: {},
    stale: [],
    x: [],
    podcasts: [],
    blogs: [],
    errors: [...raw.errors],
  };

  const markFreshness = (key: 'x' | 'podcasts' | 'blogs', generatedAt?: string, lookback?: number) => {
    if (generatedAt) {
      material.generatedAt[key] = generatedAt;
      const t = Date.parse(generatedAt);
      if (!Number.isNaN(t) && now - t > FB_STALE_MS) material.stale.push(key);
    } else {
      // 拿不到 generatedAt(该 feed 拉取失败)也按过期处理,提示用户
      material.stale.push(key);
    }
    if (typeof lookback === 'number' && lookback > 0) material.coverageHours[key] = lookback;
  };

  if (categories.includes('x') && raw.x) {
    markFreshness('x', raw.x.generatedAt, raw.x.lookbackHours);
    const accounts = Array.isArray(raw.x.x) ? raw.x.x : [];
    const flat: Array<{ acc: FbXAccount; tweet: FbTweet }> = [];
    for (const acc of accounts) {
      for (const tw of acc.tweets || []) {
        if (withinRange(tw.createdAt, cutoff)) flat.push({ acc, tweet: tw });
      }
    }
    // 总量上限:按互动量(赞+转+评)取高,不牺牲头部信号
    flat.sort(
      (a, b) =>
        (b.tweet.likes || 0) + (b.tweet.retweets || 0) + (b.tweet.replies || 0) -
        ((a.tweet.likes || 0) + (a.tweet.retweets || 0) + (a.tweet.replies || 0))
    );
    const kept = flat.slice(0, maxTweets);
    // 还原按账号分组(保持上游账号顺序)
    for (const acc of accounts) {
      const tweets = kept
        .filter((k) => k.acc === acc)
        .map((k) => k.tweet)
        // 组内按时间新→旧
        .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
      if (tweets.length > 0) {
        material.x.push({
          name: acc.name,
          handle: acc.handle,
          ...(acc.bio ? { bio: acc.bio } : {}),
          tweets,
        });
      }
    }
  } else if (categories.includes('x')) {
    material.stale.push('x');
  }

  if (categories.includes('podcasts') && raw.podcasts) {
    markFreshness('podcasts', raw.podcasts.generatedAt, raw.podcasts.lookbackHours);
    const episodes = (Array.isArray(raw.podcasts.podcasts) ? raw.podcasts.podcasts : []).filter(
      (ep) => withinRange(ep.publishedAt, cutoff)
    );
    for (const ep of episodes) {
      const t = ep.transcript || '';
      const { excerpt, truncated } = truncate(t, transcriptChars);
      material.podcasts.push({
        name: ep.name,
        title: ep.title,
        url: ep.url,
        publishedAt: ep.publishedAt ?? null,
        ...(t ? { transcriptExcerpt: excerpt, transcriptTruncated: truncated } : {}),
      });
    }
  } else if (categories.includes('podcasts')) {
    material.stale.push('podcasts');
  }

  if (categories.includes('blogs') && raw.blogs) {
    markFreshness('blogs', raw.blogs.generatedAt, raw.blogs.lookbackHours);
    const posts = (Array.isArray(raw.blogs.blogs) ? raw.blogs.blogs : []).filter((p) =>
      withinRange(p.publishedAt, cutoff)
    );
    for (const p of posts) {
      const c = p.content || '';
      const { excerpt, truncated } = truncate(c, blogContentChars);
      material.blogs.push({
        name: p.name,
        title: p.title,
        url: p.url,
        publishedAt: p.publishedAt ?? null,
        ...(p.author ? { author: p.author } : {}),
        ...(p.description ? { description: p.description } : {}),
        ...(c ? { contentExcerpt: excerpt, contentTruncated: truncated } : {}),
      });
    }
  } else if (categories.includes('blogs')) {
    material.stale.push('blogs');
  }

  return material;
}

// ---------------------------------------------------------------------------
// Mission 工具(只读,dangerLevel low,无需凭证 → 始终注入)
// ---------------------------------------------------------------------------

const FALLBACK_HINT =
  '降级路径:改用已连接的 X / Twitter 连接器(mcp_twitterapi_io_*)或网页搜索工具自行检索相关账号最近动态,并在日报开头注明「中央 feed 不可用,数据来源已降级」。';

export function buildFollowBuildersTools(): ToolDefinition[] {
  return [
    {
      name: 'follow_builders_fetch_feed',
      description:
        '拉取 follow-builders 中央 feed(上游每日更新的公开聚合数据,MIT,只读、无需凭证):' +
        'AI builder 的 X 动态(上游仅存最近 24h)、AI 播客新集与转写摘录(最近 14 天)、' +
        'Anthropic/Claude 官方博客新文(最近 72h)。返回按时间窗过滤、裁剪好的日报素材,' +
        '含各 feed 生成时间与新鲜度标记(stale 非空 = 上游可能断更,须在日报中提示)。' +
        '服务端有 30 分钟缓存,重复调用不增加上游压力。',
      dangerLevel: 'low',
      readOnly: true, // 只读并行门控:纯拉取公共 feed,无副作用
      parameters: {
        type: 'object',
        properties: {
          rangeHours: {
            type: 'number',
            description: '只保留最近 N 小时的内容(默认 24;注意 X feed 上游只有 24h)',
          },
          categories: {
            type: 'array',
            items: { type: 'string' },
            description: '内容类别:x / podcasts / blogs 的子集(默认全部)',
          },
        },
      },
      execute: async ({ rangeHours, categories }: any) => {
        let raw: FbFeedRaw;
        try {
          raw = await fetchFollowBuildersFeed();
        } catch (e: any) {
          return {
            success: false,
            error: `follow-builders feed 拉取异常: ${e?.message || e}。${FALLBACK_HINT}`,
          };
        }
        if (!raw.x && !raw.podcasts && !raw.blogs) {
          return {
            success: false,
            error: `follow-builders feed 拉取失败(上游不可达):${raw.errors.join('; ')}。${FALLBACK_HINT}`,
          };
        }
        const material = buildDigestMaterial(raw, {
          ...(typeof rangeHours === 'number' && rangeHours > 0 ? { rangeHours } : {}),
          ...(Array.isArray(categories) && categories.length > 0
            ? { categories: categories.map(String) }
            : {}),
        });
        const counts = {
          xAccounts: material.x.length,
          tweets: material.x.reduce((n, a) => n + a.tweets.length, 0),
          podcasts: material.podcasts.length,
          blogs: material.blogs.length,
        };
        return {
          success: true,
          ...material,
          counts,
          ...(material.stale.length > 0
            ? {
                staleWarning: `以下类别的 feed 数据超过 48 小时未更新(上游可能断更):${material.stale.join(', ')}。请在日报开头明确提示数据可能过期;X 类别过期时可${FALLBACK_HINT}`,
              }
            : {}),
        };
      },
    },
  ];
}

/** 工具提供方注册表条目(tool-providers.ts);build 签名与上面导出保持一对一 */
export const TOOL_PROVIDER: import('./tool-providers').ToolProvider = {
  id: 'follow_builders',
  deps: [],
  build: () => buildFollowBuildersTools(),
};
