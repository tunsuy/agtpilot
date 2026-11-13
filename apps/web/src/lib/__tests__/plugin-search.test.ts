import { afterEach, describe, expect, it, vi } from 'vitest';
import { apply, stripHtml } from '@agtpilot/plugin-search';

/** 挂载插件,拿回注册的工具表 */
function setupPlugin() {
  const tools: Record<string, any> = {};
  const ctx: any = {
    agent: {
      registerToolRoute: () => {},
      registerTool: (t: any) => {
        tools[t.name] = t;
      },
      emitEvent: () => {},
    },
  };
  apply(ctx, {});
  return tools;
}

function gnewsRss(items: Array<{ title: string; link: string; pubDate?: string; source?: string }>) {
  return (
    '<rss><channel>' +
    items
      .map(
        (it) =>
          `<item><title><![CDATA[${it.title}]]></title><link>${it.link}</link>` +
          (it.pubDate ? `<pubDate>${it.pubDate}</pubDate>` : '') +
          (it.source ? `<source url="https://src.example">${it.source}</source>` : '') +
          '</item>'
      )
      .join('') +
    '</channel></rss>'
  );
}

/** fetch 桩:按 URL 域名路由;自动补 json(与 text 同源) */
function stubFetch(routes: Record<string, () => { ok: boolean; text: () => Promise<string> }>) {
  const mock = vi.fn(async (url: any) => {
    const s = String(url);
    for (const [frag, factory] of Object.entries(routes)) {
      if (s.includes(frag)) {
        const r = factory();
        return { ok: r.ok, text: r.text, json: async () => JSON.parse(await r.text()) };
      }
    }
    throw new Error(`unexpected fetch: ${s}`);
  });
  vi.stubGlobal('fetch', mock);
  return mock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('免费搜索源:解析工具', () => {
  it('stripHtml:去标签 + 实体解码 + 压空白', () => {
    expect(stripHtml('<p>a&nbsp;&amp;&nbsp;b</p>')).toBe('a & b');
    expect(stripHtml('&#0183;&#x4e2d;&#25991;')).toBe('·中文');
    expect(stripHtml('  <b>x</b>\n<i>y</i> ')).toBe('x y');
  });
});

describe('免费搜索源:search 零 Key 聚合(无 Bing)', () => {
  it('中文查询:Google News(来源+时间入摘要)为主', async () => {
    stubFetch({
      'news.google.com/rss/search': () => ({
        ok: true,
        text: async () =>
          gnewsRss([
            {
              title: '字节跳动完成新一轮融资',
              link: 'https://news.google.com/rss/articles/CBMi1',
              pubDate: 'Fri, 10 Oct 2026 08:00:00 GMT',
              source: '36氪',
            },
          ]),
      }),
      wikipedia: () => ({ ok: true, text: async () => '{"query":{"search":[]}}' }),
    });
    const r = await setupPlugin().search.execute({ query: '字节跳动 融资', maxResults: 5 });
    expect(r.success).toBe(true);
    expect(r.results[0].engine).toBe('google-news');
    expect(r.results[0].snippet).toContain('来源: 36氪');
    expect(r.results[0].snippet).toContain('发布时间');
    expect(r.results.every((x: any) => x.engine !== 'bing')).toBe(true);
  });

  it('英文查询:Google News + Wikipedia 补位(不再走 Bing)', async () => {
    stubFetch({
      'news.google.com/rss/search': () => ({
        ok: true,
        text: async () =>
          gnewsRss([{ title: 'OpenAI ships GPT-6', link: 'https://news.google.com/rss/articles/CBMi2' }]),
      }),
      'wikipedia.org': () => ({
        ok: true,
        text: async () =>
          '{"query":{"search":[{"title":"OpenAI","snippet":"An AI <em>research</em> company"}]}}',
      }),
    });
    const r = await setupPlugin().search.execute({ query: 'OpenAI GPT-6', maxResults: 5 });
    expect(r.success).toBe(true);
    expect(r.results[0].engine).toBe('google-news');
    expect(r.results.some((x: any) => x.engine === 'wikipedia')).toBe(true);
    expect(r.results.every((x: any) => x.engine !== 'bing')).toBe(true);
  });

  it('Google News 失败 → Wikipedia 兜底,不报 bing', async () => {
    stubFetch({
      'news.google.com/rss/search': () => ({ ok: false, text: async () => '' }),
      'wikipedia.org': () => ({
        ok: true,
        text: async () =>
          '{"query":{"search":[{"title":"量子计算","snippet":"量子计算是<em>量子力学</em>的应用"}]}}',
      }),
    });
    const r = await setupPlugin().search.execute({ query: '量子计算 原理', maxResults: 5 });
    expect(r.success).toBe(true);
    expect(r.results[0].engine).toBe('wikipedia');
    expect(String(r.degradedSources || '')).toContain('google-news');
    expect(String(r.degradedSources || '')).not.toContain('bing');
  });

  it('全源失败 → success:false(不含 bing)', async () => {
    stubFetch({
      'news.google.com/rss/search': () => ({ ok: false, text: async () => '' }),
      wikipedia: () => ({ ok: false, text: async () => '' }),
    });
    const r = await setupPlugin().search.execute({ query: '随便什么书名测试', maxResults: 3 });
    expect(r.success).toBe(false);
    expect(r.error).toContain('google-news');
    expect(r.error).not.toContain('bing');
    expect(r.error).toContain('TAVILY_API_KEY');
  });

  it('Wikipedia 与 Google News 合流补条目', async () => {
    stubFetch({
      'news.google.com/rss/search': () => ({
        ok: true,
        text: async () =>
          gnewsRss([{ title: '量子计算新突破', link: 'https://news.google.com/rss/articles/CBMi4' }]),
      }),
      'wikipedia.org': () => ({
        ok: true,
        text: async () =>
          '{"query":{"search":[{"title":"量子计算","snippet":"量子计算是<em>量子力学</em>的应用"}]}}',
      }),
    });
    const r = await setupPlugin().search.execute({ query: '量子计算 原理', maxResults: 5 });
    expect(r.success).toBe(true);
    const wiki = r.results.find((x: any) => x.engine === 'wikipedia');
    expect(wiki.title).toBe('量子计算');
    expect(wiki.snippet).toContain('量子力学的应用');
    expect(decodeURIComponent(wiki.url)).toContain('zh.wikipedia.org/wiki/量子计算');
  });
});

describe('时效:发布时间排序、相对年龄标注与 recencyDays 过滤', () => {
  const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toUTCString();

  it('google-news 结果带 publishedAt 且按时间倒序,摘要含相对年龄', async () => {
    stubFetch({
      'news.google.com/rss/search': () => ({
        ok: true,
        text: async () =>
          gnewsRss([
            {
              title: '字节跳动三天前的新闻',
              link: 'https://news.google.com/rss/articles/a1',
              pubDate: daysAgo(3),
              source: '源A',
            },
            {
              title: '字节跳动三个月前的旧闻',
              link: 'https://news.google.com/rss/articles/a2',
              pubDate: daysAgo(90),
              source: '源B',
            },
            {
              title: '字节跳动一小时的新闻',
              link: 'https://news.google.com/rss/articles/a3',
              pubDate: daysAgo(2 / 24),
              source: '源C',
            },
          ]),
      }),
      wikipedia: () => ({ ok: true, text: async () => '{"query":{"search":[]}}' }),
    });
    const r = await setupPlugin().search.execute({ query: '字节跳动 融资', maxResults: 5 });
    expect(r.success).toBe(true);
    const gnews = r.results.filter((x: any) => x.engine === 'google-news');
    expect(gnews.map((x: any) => x.title)).toEqual([
      '字节跳动一小时的新闻',
      '字节跳动三天前的新闻',
      '字节跳动三个月前的旧闻',
    ]);
    expect(gnews[0].snippet).toContain('2 小时前');
    expect(gnews[1].snippet).toContain('3 天前');
    expect(gnews[2].snippet).toContain('约 3 个月前');
  });

  it('recencyDays 过滤旧闻,保留新鲜与无时间戳条目,recencyNote 注明过滤量', async () => {
    stubFetch({
      'news.google.com/rss/search': () => ({
        ok: true,
        text: async () =>
          gnewsRss([
            {
              title: 'AI 两条新消息最新发展',
              link: 'https://news.google.com/rss/articles/b1',
              pubDate: daysAgo(2),
              source: '源A',
            },
            {
              title: 'AI 两个月前的旧闻最新发展',
              link: 'https://news.google.com/rss/articles/b2',
              pubDate: daysAgo(60),
              source: '源B',
            },
          ]),
      }),
      wikipedia: () => ({ ok: true, text: async () => '{"query":{"search":[]}}' }),
    });
    const r = await setupPlugin().search.execute({ query: 'ai 最新发展', maxResults: 5, recencyDays: 7 });
    expect(r.success).toBe(true);
    expect(r.results.some((x: any) => x.title.includes('两个月前的旧闻'))).toBe(false);
    expect(r.results.some((x: any) => x.title.includes('两条新消息'))).toBe(true);
    expect(r.recencyNote).toContain('已过滤 1 条');
  });

  it('全滤光时退回未过滤结果并注明', async () => {
    stubFetch({
      'news.google.com/rss/search': () => ({
        ok: true,
        text: async () =>
          gnewsRss([
            {
              title: 'AI 只有旧闻最新发展',
              link: 'https://news.google.com/rss/articles/c1',
              pubDate: daysAgo(120),
              source: '源A',
            },
          ]),
      }),
      wikipedia: () => ({ ok: true, text: async () => '{"query":{"search":[]}}' }),
    });
    const r = await setupPlugin().search.execute({ query: 'ai 最新发展', maxResults: 5, recencyDays: 7 });
    expect(r.success).toBe(true);
    expect(r.results.some((x: any) => x.title.includes('只有旧闻'))).toBe(true);
    expect(r.recencyNote).toContain('近 7 天无');
  });
});

describe('P5:engine 直连缺 Key → 执行期诚实报错', () => {
  it('config 无 Key 时 search 不声明 requiredEnv', () => {
    const tools = setupPlugin();
    expect(Object.keys(tools)).toEqual(['search']);
    expect(tools.search.requiredEnv).toBeUndefined();
  });

  it('config 已带 Key 时同样只有一枚 search', () => {
    const tools: Record<string, any> = {};
    const ctx: any = {
      agent: {
        registerToolRoute: () => {},
        registerTool: (t: any) => {
          tools[t.name] = t;
        },
        emitEvent: () => {},
      },
    };
    apply(ctx, { exaApiKey: 'k1', tavilyApiKey: 'k2' });
    expect(Object.keys(tools)).toEqual(['search']);
    expect(tools.search.requiredEnv).toBeUndefined();
  });

  it('engine=exa 缺 Key → success:false 并报 EXA_API_KEY', async () => {
    delete process.env.EXA_API_KEY;
    const r = await setupPlugin().search.execute({ query: 'q', engine: 'exa' });
    expect(r.success).toBe(false);
    expect(String(r.error)).toContain('EXA_API_KEY');
  });

  it('engine=tavily 缺 Key → success:false 并报 TAVILY_API_KEY', async () => {
    delete process.env.TAVILY_API_KEY;
    const r = await setupPlugin().search.execute({ query: 'q', engine: 'tavily' });
    expect(r.success).toBe(false);
    expect(String(r.error)).toContain('TAVILY_API_KEY');
  });
});
