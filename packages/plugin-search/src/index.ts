import { Context } from '@deepseek-ai/cordis';
import '@agtpilot/core';
import Exa from 'exa-js';
import { tavily } from '@tavily/core';

export const name = 'agtpilot-plugin-search';
export const inject = ['agent'];

export interface SearchResultItem {
  title: string;
  url: string;
  snippet: string;
  score?: number;
  engine?: string;
  /** 发布时间(epoch ms):google-news RSS 的 pubDate 解析而来,时效过滤/排序用 */
  publishedAt?: number;
}

export interface SearchPluginConfig {
  defaultEngine?: 'auto' | 'exa' | 'tavily' | 'duckduckgo';
  exaApiKey?: string;
  tavilyApiKey?: string;
}

/** HTML 实体解码 + 去标签 + 压空白,产出可入上下文的纯文本摘要 */
export function stripHtml(s: string): string {
  return s
    // 标签直接抹除不补空格:CJK 摘要里 <em>词</em> 两侧不该出现空格
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&(?:#0?39|apos);/gi, "'")
    .replace(/&#(\d+);/g, (_, d: string) => {
      try {
        return String.fromCodePoint(Number(d));
      } catch {
        return '';
      }
    })
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => {
      try {
        return String.fromCodePoint(parseInt(h, 16));
      } catch {
        return '';
      }
    })
    .replace(/\s+/g, ' ')
    .trim();
}

/** Bing 出链是 /ck/a?!&&p=...&u=a1<base64url> 重定向链,解码出真实出版权 URL */
export function decodeBingUrl(href: string): string | null {
  try {
    const unescaped = href.replace(/&amp;/g, '&');
    if (!/^https?:\/\/www\.bing\.com\/ck\//.test(unescaped)) {
      return /^https?:\/\//.test(unescaped) ? unescaped : null;
    }
    const m = /[?&]u=a1([A-Za-z0-9_-]+)/.exec(unescaped);
    if (!m) return null;
    let b64 = m[1];
    // JS 的 (-len) % 4 会保留负号(与 Python 不同),必须用 (4 - len%4) % 4
    b64 += '='.repeat((4 - (b64.length % 4)) % 4);
    const decoded = Buffer.from(b64, 'base64url').toString('utf-8');
    return /^https?:\/\//.test(decoded) ? decoded : null;
  } catch {
    return null;
  }
}

const BING_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Accept-Language': 'en-US,en;q=0.9',
};

export function apply(ctx: Context, config: SearchPluginConfig = {}) {
  // 工具路由自注册：prompt 命中搜索/资讯类关键词时挂载本插件工具组
  ctx.agent.registerToolRoute({
    id: 'search',
    prefixes: ['search_'],
    test: /(搜索|检索|查一下|查下|搜一下|查查|最新|新闻|资讯|search|news|look\s?up)/i,
  });

  // 1. 免 API Key 实时多源聚合搜索 (Bing 国际区 + Google News RSS + Wikipedia)
  // 返回结果与各源的失败原因（全源失败时调用方据此给出真实报错，而非 count:0 假成功）
  //
  // 运行环境为境内服务器,2026-10 实测各免费源可用性:
  //   - Bing 国际区(mkt=en-US): 英文查询返回真实标题+摘要+可解码出链;
  //     中文查询会被折叠成推广垃圾 → 只作非中文主力/中文补充
  //   - Google News RSS: 中英文均可用、时效强,但只有标题+来源+时间(无内容摘要);
  //     链接是 news.google.com 跳转链,浏览器打开会自动跳到原文
  //   - Wikipedia: 真实摘要,百科类查询兜底
  //   - DuckDuckGo html / Baidu / Sogou / Mojeek: 境内 IP 全部反爬拦截(实测
  //     DDG 返回 anomaly 挑战页、百度返回安全验证页),已弃用


  /** Bing 国际区搜索:真实标题 + 摘要 + 解码后的真实 URL */
  async function searchBing(query: string, maxResults: number): Promise<SearchResultItem[]> {
    const items: SearchResultItem[] = [];
    const url = `https://www.bing.com/search?q=${encodeURIComponent(query)}&mkt=en-US&setlang=en-US&count=${Math.min(maxResults * 2, 30)}`;
    const res = await fetch(url, {
      headers: BING_HEADERS,
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`bing: HTTP ${res.status}`);
    const html = await res.text();
    // 每个结果块 <li class="b_algo">…<h2><a href=…>标题</a></h2>…<p class="b_lineclamp…">摘要</p>…</li>
    const blocks = html.split('<li class="b_algo"').slice(1);
    for (const block of blocks) {
      if (items.length >= maxResults) break;
      const h2 = /<h2[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/m.exec(block);
      if (!h2) continue;
      const realUrl = decodeBingUrl(h2[1]);
      const title = stripHtml(h2[2]);
      if (!realUrl || !title) continue;
      // 摘要在结果块前部的 b_lineclamp 段落里;拿不到就留空,靠标题与 URL
      const snip = /<p class="b_lineclamp[^"]*"[^>]*>([\s\S]*?)<\/p>/.exec(block);
      const snippet = snip ? stripHtml(snip[1]).slice(0, 300) : '';
      if (!items.some((i) => i.url === realUrl)) {
        items.push({ title, url: realUrl, snippet, engine: 'bing' });
      }
    }
    if (items.length === 0) throw new Error('bing: 0 results parsed');
    return items;
  }

  /** 相对年龄标注:让模型不用心算就能判断「几天前」—— 不标注时模型会把
   *  几个月前的结果也当「最新动态」作答(生产实测踩坑) */
  function relativeAge(ts: number): string {
    const days = Math.floor((Date.now() - ts) / 86_400_000);
    if (days <= 0) {
      const hours = Math.max(0, Math.floor((Date.now() - ts) / 3_600_000));
      return hours <= 1 ? '1 小时内' : `${hours} 小时前`;
    }
    if (days < 30) return `${days} 天前`;
    return `约 ${Math.floor(days / 30)} 个月前`;
  }

  /** Google News RSS:标题自带信息量,摘要位放来源+时间;链接为跳转链(浏览器可开) */
  async function searchGoogleNews(query: string, maxResults: number): Promise<SearchResultItem[]> {
    const items: SearchResultItem[] = [];
    const gUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=zh-CN&gl=CN&ceid=CN:zh-Hans`;
    const res = await fetch(gUrl, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`google-news: HTTP ${res.status}`);
    const xml = await res.text();
    const blocks = xml.split('<item>').slice(1);
    for (const block of blocks) {
      if (items.length >= maxResults) break;
      const title = /<title>([\s\S]*?)<\/title>/.exec(block)?.[1]?.replace(/<!\[CDATA\[(.*?)\]\]>/g, '$1').trim();
      const link = /<link>([\s\S]*?)<\/link>/.exec(block)?.[1]?.trim();
      if (!title || !link) continue;
      const pubDate = /<pubDate>([\s\S]*?)<\/pubDate>/.exec(block)?.[1]?.trim() || '';
      // RSS <source url="…">来源名</source>:比"来自 Google News 实时资讯"占位文案有信息量
      const source = /<source[^>]*>([\s\S]*?)<\/source>/.exec(block)?.[1]?.trim() || '';
      // 发布时间解析成 epoch(RFC822 pubDate,Date.parse 原生支持);摘要带
      // 绝对时间 + 相对年龄,模型一眼可判新旧
      const publishedAt = pubDate ? Date.parse(pubDate) : NaN;
      const snippet =
        [
          source ? `来源: ${source}` : '',
          pubDate ? `发布时间: ${pubDate}${Number.isFinite(publishedAt) ? `(${relativeAge(publishedAt)})` : ''}` : '',
        ]
          .filter(Boolean)
          .join(' · ') || '来自 Google News 实时资讯';
      items.push({
        title,
        url: link,
        snippet,
        engine: 'google-news',
        ...(Number.isFinite(publishedAt) ? { publishedAt } : {}),
      });
    }
    if (items.length === 0) throw new Error('google-news: 0 items parsed');
    // 按发布时间倒序:RSS 默认混合相关性与时间,不排的话旧闻会插在新闻前面
    items.sort((a, b) => (b.publishedAt ?? 0) - (a.publishedAt ?? 0));
    return items;
  }

  async function searchFreeSources(
    query: string,
    maxResults: number
  ): Promise<{ items: SearchResultItem[]; errors: string[] }> {
    const errors: string[] = [];

    // Bing 与 Google News 并行(互不拖慢);单源失败只降级不致命
    const isCjk = /[一-龥]/.test(query);
    const [bingR, gnewsR] = await Promise.allSettled([
      searchBing(query, maxResults).catch((e: any) => {
        errors.push(`bing: ${e?.message || e}`);
        return [] as SearchResultItem[];
      }),
      searchGoogleNews(query, maxResults).catch((e: any) => {
        errors.push(`google-news: ${e?.message || e}`);
        return [] as SearchResultItem[];
      }),
    ]);
    const bingItems = bingR.status === 'fulfilled' ? bingR.value : [];
    const gnewsItems = gnewsR.status === 'fulfilled' ? gnewsR.value : [];

    // 合流顺序按查询语种:中文主力是 Google News(中文覆盖+时效,Bing 中文查询是垃圾);
    // 英文主力是 Bing(真实摘要);另一方补位,让模型同时拿到内容与时效两层
    const primary = isCjk ? gnewsItems : bingItems;
    const secondary = isCjk ? bingItems : gnewsItems;
    const items: SearchResultItem[] = [];
    const seen = new Set<string>();
    for (const it of [...primary, ...secondary]) {
      if (items.length >= maxResults) break;
      if (seen.has(it.url)) continue;
      seen.add(it.url);
      items.push(it);
    }

    if (items.length >= maxResults) {
      return { items, errors };
    }

    // 补充：Wikipedia 全球百科知识库 API（按查询语种选择分站）
    try {
      const lang = isCjk ? 'zh' : 'en';
      const wUrl = `https://${lang}.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&format=json&srlimit=${maxResults}`;
      const wRes = await fetch(wUrl, {
        headers: { 'User-Agent': 'agtpilot-search/1.0' },
      });
      if (wRes.ok) {
        const wData: any = await wRes.json();
        const searchList = wData?.query?.search || [];
        for (const entry of searchList) {
          if (items.length >= maxResults) break;
          const cleanSnippet = stripHtml(entry.snippet || '').slice(0, 300);
          const wUrlItem = `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(entry.title)}`;
          if (seen.has(wUrlItem)) continue;
          seen.add(wUrlItem);
          items.push({
            title: entry.title,
            url: wUrlItem,
            snippet: cleanSnippet,
            engine: 'wikipedia',
          });
        }
      } else {
        errors.push(`wikipedia: HTTP ${wRes.status}`);
      }
    } catch (e: any) {
      errors.push(`wikipedia: ${e.message}`);
    }

    return { items, errors };
  }

  // 2. Exa.ai 顶级神经语义搜索
  async function searchExa(apiKey: string, query: string, maxResults: number): Promise<SearchResultItem[]> {
    const exa = new (Exa as any)(apiKey);
    const response = await exa.searchAndContents(query, {
      numResults: maxResults,
      text: true,
      highlights: true,
    });

    return (response.results || []).map((r: any) => ({
      title: r.title || 'Untitled',
      url: r.url,
      snippet: (r.highlights && r.highlights[0]) || (r.text ? r.text.slice(0, 300) : ''),
      score: r.score,
      engine: 'exa',
    }));
  }

  // 3. Tavily 顶级 Agent 针对性搜索
  async function searchTavily(apiKey: string, query: string, maxResults: number): Promise<SearchResultItem[]> {
    const tv = tavily({ apiKey });
    const response = await tv.search(query, {
      maxResults,
      searchDepth: 'basic',
    });

    return (response.results || []).map((r: any) => ({
      title: r.title,
      url: r.url,
      snippet: r.content,
      score: r.score,
      engine: 'tavily',
    }));
  }

  // 1. 统一多层级智能检索 (search_web)
  ctx.agent.registerTool({
    name: 'search_web',
    readOnly: true, // 只读并行门控:纯检索,无副作用
    description: '在互联网上搜索指定关键词或问题，自动在 Exa 神经语义搜索、Tavily Agent 搜索以及零 Key 多源聚合(Bing 国际区真实摘要 + Google News RSS 时效新闻 + Wikipedia)间进行多层级路由与容灾降级。零 Key 层返回真实内容摘要,多数情况下无需再逐个打开网页',
    dangerLevel: 'low',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '待搜索的关键词或自然语言问题' },
        maxResults: { type: 'number', description: '期望返回的搜索结果条目数 (默认 5)' },
        recencyDays: {
          type: 'number',
          description:
            '时效过滤:只保留近 N 天内发布的结果(新闻/资讯/「最新」类问题建议传 7~30)。会过滤掉带发布时间的旧结果并按时间倒序;无发布时间的结果保留',
        },
      },
      required: ['query'],
    },
    execute: async ({ query, maxResults = 5, recencyDays }, session?: any) => {
      ctx.agent.emitEvent({
        type: 'tool_call',
        payload: { tool: 'search_web', query, maxResults, recencyDays, callId: session?.callId },
        timestamp: Date.now(),
      });

      /** 时效过滤:保留近 N 天的带时间结果(无时间戳的保留,不给来源瞎判);
       *  全滤光则退回未过滤集合并注明 —— 比静默返回空更利于模型改写关键词再查 */
      const applyRecency = (items: SearchResultItem[]) => {
        if (!recencyDays || recencyDays <= 0 || items.length === 0) return { items, note: undefined as string | undefined };
        const cutoff = Date.now() - recencyDays * 86_400_000;
        const fresh = items.filter((it) => it.publishedAt === undefined || it.publishedAt >= cutoff);
        if (fresh.length === 0) {
          return { items, note: `近 ${recencyDays} 天无带发布时间的结果,以下为未过滤结果(注意甄别时效)` };
        }
        return { items: fresh, note: fresh.length < items.length ? `已过滤 ${items.length - fresh.length} 条 ${recencyDays} 天前的旧结果` : undefined };
      };

      // 用户级 Key 优先（session.env 来自任务发起者的个人空间，多用户隔离，绝不进 process.env）
      const exaKey = session?.env?.EXA_API_KEY || config.exaApiKey || process.env.EXA_API_KEY;
      const tavilyKey = session?.env?.TAVILY_API_KEY || config.tavilyApiKey || process.env.TAVILY_API_KEY;

      // 优先级 1: Exa.ai 语义神经搜索 (若配置了 Key)
      if (exaKey && config.defaultEngine !== 'duckduckgo' && config.defaultEngine !== 'tavily') {
        try {
          const items = await searchExa(exaKey, query, maxResults);
          if (items.length > 0) {
            const { items: filtered, note } = applyRecency(items);
            return { success: true, query, count: filtered.length, engine: 'exa', results: filtered, ...(note ? { recencyNote: note } : {}) };
          }
        } catch (err: any) {
          console.warn('[SearchPlugin] Exa 搜索失败，自动降级:', err.message);
        }
      }

      // 优先级 2: Tavily 结构化搜索 (若配置了 Key)
      if (tavilyKey && config.defaultEngine !== 'duckduckgo') {
        try {
          const items = await searchTavily(tavilyKey, query, maxResults);
          if (items.length > 0) {
            const { items: filtered, note } = applyRecency(items);
            return { success: true, query, count: filtered.length, engine: 'tavily', results: filtered, ...(note ? { recencyNote: note } : {}) };
          }
        } catch (err: any) {
          console.warn('[SearchPlugin] Tavily 搜索失败，自动降级:', err.message);
        }
      }

      // 优先级 3: 零 Key 原生多源聚合搜索引擎 (Bing 国际区 + Google News RSS + Wikipedia)
      try {
        const { items, errors: freeErrors } = await searchFreeSources(query, maxResults);
        if (items.length > 0) {
          const { items: filtered, note } = applyRecency(items);
          return {
            success: true,
            query,
            count: filtered.length,
            engine: filtered[0]?.engine || 'aggregator',
            results: filtered,
            ...(freeErrors.length > 0 ? { degradedSources: freeErrors } : {}),
            ...(note ? { recencyNote: note } : {}),
          };
        }
        // 零结果 + 有失败记录 = 真实失败（报出每源的失败原因），
        // 不能静默返回 success:true count:0 让模型误判"网上没有相关信息"
        return {
          success: false,
          query,
          error: `全部搜索源均无结果或不可达: ${[...freeErrors].join('; ') || '无可用源'}`,
        };
      } catch (err: any) {
        return {
          success: false,
          query,
          error: err.message,
        };
      }
    },
  });

  // 2. 独立暴露 Exa 神经语义搜索工具 (search_exa)
  ctx.agent.registerTool({
    name: 'search_exa',
    readOnly: true, // 只读并行门控:纯检索,无副作用
    description: '使用 Exa.ai 原生神经网络语义搜索引擎，基于语义 Embedding 精准匹配网页与正文 Highlight',
    dangerLevel: 'low',
    // P5:config 未带 Key 时声明 env 依赖 —— 用户个人空间(taskEnv)或
    // process.env 有 Key 才挂载,否则不挂秒败的壳
    requiredEnv: config.exaApiKey ? undefined : ['EXA_API_KEY'],
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '自然语言搜索语义描述' },
        maxResults: { type: 'number', description: '最大返回条数，默认 5' },
      },
      required: ['query'],
    },
    execute: async ({ query, maxResults = 5 }, session?: any) => {
      const exaKey = session?.env?.EXA_API_KEY || config.exaApiKey || process.env.EXA_API_KEY;
      if (!exaKey) {
        return {
          success: false,
          error: '未配置 EXA_API_KEY。请在环境变量或配置中设置 EXA_API_KEY 以开启 Exa 神经语义搜索。',
        };
      }

      try {
        const results = await searchExa(exaKey, query, maxResults);
        return { success: true, query, count: results.length, results };
      } catch (err: any) {
        return { success: false, query, error: err.message };
      }
    },
  });

  // 3. 独立暴露 Tavily 搜索工具 (search_tavily)
  ctx.agent.registerTool({
    name: 'search_tavily',
    readOnly: true, // 只读并行门控:纯检索,无副作用
    description: '使用 Tavily 官方 API 搜索针对大模型优化的结构化内容',
    dangerLevel: 'low',
    // P5:同 search_exa,缺 Key 不挂载
    requiredEnv: config.tavilyApiKey ? undefined : ['TAVILY_API_KEY'],
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '搜索关键词' },
        maxResults: { type: 'number', description: '最大返回条数，默认 5' },
      },
      required: ['query'],
    },
    execute: async ({ query, maxResults = 5 }, session?: any) => {
      const tavilyKey = session?.env?.TAVILY_API_KEY || config.tavilyApiKey || process.env.TAVILY_API_KEY;
      if (!tavilyKey) {
        return {
          success: false,
          error: '未配置 TAVILY_API_KEY。请在环境变量中配置 TAVILY_API_KEY。',
        };
      }

      try {
        const results = await searchTavily(tavilyKey, query, maxResults);
        return { success: true, query, count: results.length, results };
      } catch (err: any) {
        return { success: false, query, error: err.message };
      }
    },
  });
}
