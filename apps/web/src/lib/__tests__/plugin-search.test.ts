import { afterEach, describe, expect, it, vi } from 'vitest';
import { apply, decodeBingUrl, stripHtml } from '@agtpilot/plugin-search';

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

function b64u(url: string) {
  return Buffer.from(url).toString('base64url');
}

/** Bing 国际区结果块(ck/a 跳转链 + b_lineclamp 摘要) */
function bingHtml(items: Array<{ url: string; title: string; snippet?: string }>) {
  return (
    '<html><body><ol>' +
    items
      .map(
        (it) =>
          `<li class="b_algo"><div class="b_title"><h2><a href="https://www.bing.com/ck/a?!&amp;&amp;p=xx&amp;u=a1${b64u(
            it.url
          )}">${it.title}</a></h2></div>` +
          `<p class="b_lineclamp2">${it.snippet ?? ''}</p></li>`
      )
      .join('') +
    '</ol></body></html>'
  );
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

  it('decodeBingUrl:ck/a 跳转链解码出真实出版权 URL;普通直链透传;垃圾返回 null', () => {
    const href = `https://www.bing.com/ck/a?!&&p=xx&u=a1${b64u('https://openai.com/index/math')}`;
    expect(decodeBingUrl(href)).toBe('https://openai.com/index/math');
    expect(decodeBingUrl('https://www.solid.example/a')).toBe('https://www.solid.example/a');
    expect(decodeBingUrl('https://www.bing.com/ck/a?!&&p=xx')).toBeNull();
    expect(decodeBingUrl('javascript:alert(1)')).toBeNull();
  });
});

describe('免费搜索源:search_web 零 Key 聚合', () => {
  it('中文查询:Google News(来源+时间入摘要)为主,Bing(真实摘要+解码 URL)补位', async () => {
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
      'bing.com/search': () => ({
        ok: true,
        text: async () =>
          bingHtml([
            {
              url: 'https://techcrunch.example/bytedance',
              title: 'ByteDance raises round',
              snippet: 'The company closed a new round &amp; valuation jumped',
            },
          ]),
      }),
      wikipedia: () => ({ ok: true, text: async () => '{"query":{"search":[]}}' }),
    });
    const r = await setupPlugin().search_web.execute({ query: '字节跳动 融资', maxResults: 5 });
    expect(r.success).toBe(true);
    // 中文主力是 gnews:摘要含来源与时间,不再是占位文案
    expect(r.results[0].engine).toBe('google-news');
    expect(r.results[0].snippet).toContain('来源: 36氪');
    expect(r.results[0].snippet).toContain('发布时间');
    // Bing 补位:URL 已解码为真实出版权链接,摘要是真实内容
    const bing = r.results.find((x: any) => x.engine === 'bing');
    expect(bing.url).toBe('https://techcrunch.example/bytedance');
    expect(bing.snippet).toContain('valuation jumped');
  });

  it('英文查询:Bing 为主(真实摘要在前),Google News 补位', async () => {
    stubFetch({
      'news.google.com/rss/search': () => ({
        ok: true,
        text: async () =>
          gnewsRss([{ title: 'OpenAI ships GPT-6', link: 'https://news.google.com/rss/articles/CBMi2' }]),
      }),
      'bing.com/search': () => ({
        ok: true,
        text: async () =>
          bingHtml([{ url: 'https://openai.com/', title: 'OpenAI', snippet: 'Research and deployment company' }]),
      }),
      wikipedia: () => ({ ok: true, text: async () => '{"query":{"search":[]}}' }),
    });
    const r = await setupPlugin().search_web.execute({ query: 'OpenAI GPT-6', maxResults: 5 });
    expect(r.success).toBe(true);
    expect(r.results[0].engine).toBe('bing');
    expect(r.results[0].snippet).toBe('Research and deployment company');
    expect(r.results.some((x: any) => x.engine === 'google-news')).toBe(true);
  });

  it('Bing 单源失败 → 只降级不致命,degradedSources 记录原因', async () => {
    stubFetch({
      'bing.com/search': () => ({ ok: false, text: async () => '' }),
      'news.google.com/rss/search': () => ({
        ok: true,
        text: async () => gnewsRss([{ title: 't', link: 'https://news.google.com/rss/articles/CBMi3' }]),
      }),
      wikipedia: () => ({ ok: true, text: async () => '{"query":{"search":[]}}' }),
    });
    const r = await setupPlugin().search_web.execute({ query: '字节跳动', maxResults: 3 });
    expect(r.success).toBe(true);
    expect(r.results[0].engine).toBe('google-news');
    expect(String(r.degradedSources)).toContain('bing');
  });

  it('全源失败 → success:false 且报出每源失败原因(不返回 count:0 假成功)', async () => {
    stubFetch({
      'bing.com/search': () => ({ ok: false, text: async () => '' }),
      'news.google.com/rss/search': () => ({ ok: false, text: async () => '' }),
      wikipedia: () => ({ ok: false, text: async () => '' }),
    });
    const r = await setupPlugin().search_web.execute({ query: '随便什么', maxResults: 3 });
    expect(r.success).toBe(false);
    expect(r.error).toContain('bing');
    expect(r.error).toContain('google-news');
  });

  it('Wikipedia 兜底:前两源不足时补真实摘要条目', async () => {
    stubFetch({
      'bing.com/search': () => ({
        ok: true,
        text: async () => bingHtml([{ url: 'https://a.example/x', title: 'A' }]),
      }),
      'news.google.com/rss/search': () => ({
        ok: true,
        text: async () => gnewsRss([{ title: 'B', link: 'https://news.google.com/rss/articles/CBMi4' }]),
      }),
      'wikipedia.org': () => ({
        ok: true,
        text: async () =>
          '{"query":{"search":[{"title":"量子计算","snippet":"量子计算是<em>量子力学</em>的应用"}]}}',
      }),
    });
    const r = await setupPlugin().search_web.execute({ query: '量子计算 原理', maxResults: 5 });
    expect(r.success).toBe(true);
    const wiki = r.results.find((x: any) => x.engine === 'wikipedia');
    expect(wiki.title).toBe('量子计算');
    expect(wiki.snippet).toContain('量子力学的应用');
    expect(decodeURIComponent(wiki.url)).toContain('zh.wikipedia.org/wiki/量子计算');
  });
});

/** 时效治理:google-news 按发布时间倒序 + 相对年龄标注 + recencyDays 过滤
 *  (生产踩坑:模型把几个月前的旧闻当「最新动态」作答 —— 摘要只给绝对
 *  时间不够,模型没有可靠的「今天」基准,也不做心算) */
describe('时效:发布时间排序、相对年龄标注与 recencyDays 过滤', () => {
  const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toUTCString();

  it('google-news 结果带 publishedAt 且按时间倒序,摘要含相对年龄', async () => {
    // RSS 故意乱序:3 天前 → 90 天前 → 1 小时前
    stubFetch({
      'news.google.com/rss/search': () => ({
        ok: true,
        text: async () =>
          gnewsRss([
            { title: '三天前的新闻', link: 'https://news.google.com/rss/articles/a1', pubDate: daysAgo(3), source: '源A' },
            { title: '三个月前的旧闻', link: 'https://news.google.com/rss/articles/a2', pubDate: daysAgo(90), source: '源B' },
            { title: '一小时的新闻', link: 'https://news.google.com/rss/articles/a3', pubDate: daysAgo(2 / 24), source: '源C' },
          ]),
      }),
      'bing.com/search': () => ({ ok: true, text: async () => bingHtml([]) }),
      wikipedia: () => ({ ok: true, text: async () => '{"query":{"search":[]}}' }),
    });
    const r = await setupPlugin().search_web.execute({ query: '字节跳动 融资', maxResults: 5 });
    expect(r.success).toBe(true);
    const gnews = r.results.filter((x: any) => x.engine === 'google-news');
    expect(gnews.map((x: any) => x.title)).toEqual(['一小时的新闻', '三天前的新闻', '三个月前的旧闻']);
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
            { title: '两条新消息', link: 'https://news.google.com/rss/articles/b1', pubDate: daysAgo(2), source: '源A' },
            { title: '两个月前的旧闻', link: 'https://news.google.com/rss/articles/b2', pubDate: daysAgo(60), source: '源B' },
          ]),
      }),
      'bing.com/search': () => ({ ok: true, text: async () => bingHtml([]) }),
      wikipedia: () => ({ ok: true, text: async () => '{"query":{"search":[]}}' }),
    });
    const r = await setupPlugin().search_web.execute({ query: 'ai 最新发展', maxResults: 5, recencyDays: 7 });
    expect(r.success).toBe(true);
    expect(r.results.some((x: any) => x.title === '两个月前的旧闻')).toBe(false);
    expect(r.results.some((x: any) => x.title === '两条新消息')).toBe(true);
    expect(r.recencyNote).toContain('已过滤 1 条');
  });

  it('全滤光时退回未过滤结果并注明(静默空结果会让模型误判「无新闻」)', async () => {
    stubFetch({
      'news.google.com/rss/search': () => ({
        ok: true,
        text: async () =>
          gnewsRss([
            { title: '只有旧闻', link: 'https://news.google.com/rss/articles/c1', pubDate: daysAgo(120), source: '源A' },
          ]),
      }),
      'bing.com/search': () => ({ ok: true, text: async () => bingHtml([]) }),
      wikipedia: () => ({ ok: true, text: async () => '{"query":{"search":[]}}' }),
    });
    const r = await setupPlugin().search_web.execute({ query: 'ai 最新发展', maxResults: 5, recencyDays: 7 });
    expect(r.success).toBe(true);
    expect(r.results.some((x: any) => x.title === '只有旧闻')).toBe(true);
    expect(r.recencyNote).toContain('近 7 天无');
  });
});

describe('P5:缺 Key 工具的挂载声明', () => {
  it('config 无 Key 时 search_exa/search_tavily 声明 requiredEnv(编排器据此不挂秒败的壳)', () => {
    const tools = setupPlugin();
    expect(tools.search_exa.requiredEnv).toEqual(['EXA_API_KEY']);
    expect(tools.search_tavily.requiredEnv).toEqual(['TAVILY_API_KEY']);
    // search_web 是零 Key 聚合主路径,不受影响
    expect(tools.search_web.requiredEnv).toBeUndefined();
  });

  it('config 已带 Key 时不声明(始终挂载,不进过滤清单)', () => {
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
    expect(tools.search_exa.requiredEnv).toBeUndefined();
    expect(tools.search_tavily.requiredEnv).toBeUndefined();
  });

  it('filterToolsByEnv 与插件声明联动:用户个人空间有 EXA Key 时 search_exa 挂载、search_tavily 剔除', async () => {
    delete process.env.EXA_API_KEY;
    delete process.env.TAVILY_API_KEY;
    const { filterToolsByEnv } = await import('@agtpilot/core');
    const tools = setupPlugin();
    const { mounted, missingKeyTools } = filterToolsByEnv(
      [tools.search_web, tools.search_exa, tools.search_tavily],
      { EXA_API_KEY: 'user-key' },
    );
    expect(mounted.map((t: any) => t.name)).toEqual(['search_web', 'search_exa']);
    expect(missingKeyTools.map((t: any) => t.name)).toEqual(['search_tavily']);
  });
});
