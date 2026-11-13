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

/** 查询是否含汉字(决定 Key 引擎优先级与维基分站) */
export function isCjkQuery(query: string): boolean {
  return /[一-龥]/.test(query);
}

/**
 * 从查询抽出用于相关性比对的 token:
 * - 连续汉字段(≥2 字)整段保留(书名/专名不被拆成单字)
 * - 拉丁词 ≥3 字符
 */
export function extractQueryTokens(query: string): string[] {
  const cjk = query.match(/[\u4e00-\u9fff]{2,}/g) || [];
  const latin = (query.toLowerCase().match(/[a-z0-9]{3,}/g) || []).filter(Boolean);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of [...cjk, ...latin]) {
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

/**
 * 判断单条结果是否与查询相关。
 * 无 token 可抽时放行;有 token 时要求至少一半命中,或命中一条 ≥4 字专名。
 */
export function isRelevantSearchResult(
  query: string,
  item: Pick<SearchResultItem, 'title' | 'snippet' | 'url'>
): boolean {
  const tokens = extractQueryTokens(query);
  if (tokens.length === 0) return true;
  const hay = `${item.title || ''} ${item.snippet || ''} ${item.url || ''}`.toLowerCase();
  const hits = tokens.filter((t) => hay.includes(t.toLowerCase()));
  if (hits.some((t) => t.length >= 4)) return true;
  return hits.length >= Math.max(1, Math.ceil(tokens.length / 2));
}

/** 过滤掉与查询无关的结果;原序保留 */
export function filterRelevantResults(
  query: string,
  items: SearchResultItem[]
): SearchResultItem[] {
  return items.filter((it) => isRelevantSearchResult(query, it));
}

/**
 * 免费聚合源(Google News RSS / Wikipedia)总开关。
 * AGTPILOT_SEARCH_FREE_SOURCES=0 → 整层停用:境内部署免费源可用性不稳时,
 * 与其挂超时拿空结果,不如关层让调用方拿到诚实报错(去配 EXA/TAVILY Key)。
 * 调用时求值,测试可 vi.stubEnv。
 *
 * Bing HTML 抓取已移除(中文假结果/反爬不稳,2026-11 生产实测)。
 */
export function freeSourcesEnabled(): boolean {
  return process.env.AGTPILOT_SEARCH_FREE_SOURCES !== '0';
}

export function apply(ctx: Context, config: SearchPluginConfig = {}) {
  // 工具路由自注册：prompt 命中搜索/资讯类关键词时挂载本插件工具组
  ctx.agent.registerToolRoute({
    id: 'search',
    prefixes: ['search', 'search_'],
    test: /(搜索|检索|查一下|查下|搜一下|查查|最新|新闻|资讯|search|news|look\s?up)/i,
  });

  // 1. 免 API Key 聚合:Google News RSS + Wikipedia
  // 综搜可靠路径 = 配 TAVILY_API_KEY / EXA_API_KEY(auto 路由优先走 Key 源)

  /** 相对年龄标注:让模型不用心算就能判断「几天前」 */
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
      const source = /<source[^>]*>([\s\S]*?)<\/source>/.exec(block)?.[1]?.trim() || '';
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
    items.sort((a, b) => (b.publishedAt ?? 0) - (a.publishedAt ?? 0));
    return items;
  }

  async function searchFreeSources(
    query: string,
    maxResults: number
  ): Promise<{ items: SearchResultItem[]; errors: string[] }> {
    const errors: string[] = [];

    if (!freeSourcesEnabled()) {
      return { items: [], errors: ['free-sources: AGTPILOT_SEARCH_FREE_SOURCES=0 已停用免费聚合层'] };
    }

    const cjk = isCjkQuery(query);
    const items: SearchResultItem[] = [];
    const seen = new Set<string>();

    try {
      const gnewsItems = filterRelevantResults(query, await searchGoogleNews(query, maxResults));
      for (const it of gnewsItems) {
        if (items.length >= maxResults) break;
        if (seen.has(it.url)) continue;
        seen.add(it.url);
        items.push(it);
      }
    } catch (e: any) {
      errors.push(`google-news: ${e?.message || e}`);
    }

    if (items.length >= maxResults) {
      return { items, errors };
    }

    // Wikipedia 补位(按查询语种选分站)
    try {
      const lang = cjk ? 'zh' : 'en';
      const wUrl = `https://${lang}.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&format=json&srlimit=${maxResults}`;
      const wRes = await fetch(wUrl, {
        headers: { 'User-Agent': 'agtpilot-search/1.0' },
        signal: AbortSignal.timeout(10_000),
      });
      if (wRes.ok) {
        const wData: any = await wRes.json();
        const searchList = wData?.query?.search || [];
        for (const entry of searchList) {
          if (items.length >= maxResults) break;
          const cleanSnippet = stripHtml(entry.snippet || '').slice(0, 300);
          const wUrlItem = `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(entry.title)}`;
          if (seen.has(wUrlItem)) continue;
          const wikiItem: SearchResultItem = {
            title: entry.title,
            url: wUrlItem,
            snippet: cleanSnippet,
            engine: 'wikipedia',
          };
          if (!isRelevantSearchResult(query, wikiItem)) continue;
          seen.add(wUrlItem);
          items.push(wikiItem);
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

  // 统一搜索 (search):engine=auto 走多层级路由;engine=exa/tavily 直连单引擎
  ctx.agent.registerTool({
    name: 'search',
    readOnly: true,
    fallback: true,
    description:
      '在互联网上搜索指定关键词或问题。engine=auto(缺省)优先走已配置的 Tavily/Exa(中文查询优先 Tavily),再降级到零 Key 聚合(Google News RSS + Wikipedia)。engine=exa/tavily 强制单引擎(需对应 API Key)。综搜(尤其中文)请配置 TAVILY_API_KEY——免费层只有新闻/百科,覆盖有限。基于检索结果作答时在结论句末以 markdown 链接标注原始 url。若返回 success:false,如实告诉用户检索不可用,不要编造「网上查不到」',
    dangerLevel: 'low',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '待搜索的关键词或自然语言问题' },
        engine: {
          type: 'string',
          enum: ['auto', 'exa', 'tavily'],
          description: '搜索引擎:auto(缺省,自动路由与降级) / exa(神经语义,需 EXA_API_KEY) / tavily(结构化,需 TAVILY_API_KEY)',
        },
        maxResults: { type: 'number', description: '期望返回的搜索结果条目数 (默认 5)' },
        recencyDays: {
          type: 'number',
          description:
            '时效过滤:只保留近 N 天内发布的结果(新闻/资讯/「最新」类问题建议传 7~30)。会过滤掉带发布时间的旧结果并按时间倒序;无发布时间的结果保留',
        },
      },
      required: ['query'],
    },
    execute: async ({ query, engine = 'auto', maxResults = 5, recencyDays }, session?: any) => {
      ctx.agent.emitEvent({
        type: 'tool_call',
        payload: { tool: 'search', engine, query, maxResults, recencyDays, callId: session?.callId },
        timestamp: Date.now(),
      });

      const applyRecency = (items: SearchResultItem[]) => {
        if (!recencyDays || recencyDays <= 0 || items.length === 0) return { items, note: undefined as string | undefined };
        const cutoff = Date.now() - recencyDays * 86_400_000;
        const fresh = items.filter((it) => it.publishedAt === undefined || it.publishedAt >= cutoff);
        if (fresh.length === 0) {
          return { items, note: `近 ${recencyDays} 天无带发布时间的结果,以下为未过滤结果(注意甄别时效)` };
        }
        return { items: fresh, note: fresh.length < items.length ? `已过滤 ${items.length - fresh.length} 条 ${recencyDays} 天前的旧结果` : undefined };
      };

      const exaKey = session?.env?.EXA_API_KEY || config.exaApiKey || process.env.EXA_API_KEY;
      const tavilyKey = session?.env?.TAVILY_API_KEY || config.tavilyApiKey || process.env.TAVILY_API_KEY;

      if (engine === 'exa' || engine === 'tavily') {
        const key = engine === 'exa' ? exaKey : tavilyKey;
        if (!key) {
          return {
            success: false,
            query,
            error:
              engine === 'exa'
                ? '未配置 EXA_API_KEY。请在环境变量或配置中设置 EXA_API_KEY 以开启 Exa 神经语义搜索。'
                : '未配置 TAVILY_API_KEY。请在环境变量中配置 TAVILY_API_KEY。',
          };
        }
        try {
          const items =
            engine === 'exa' ? await searchExa(key, query, maxResults) : await searchTavily(key, query, maxResults);
          const { items: filtered, note } = applyRecency(items);
          return {
            success: true,
            query,
            count: filtered.length,
            engine,
            results: filtered,
            ...(note ? { recencyNote: note } : {}),
          };
        } catch (err: any) {
          return { success: false, query, error: err.message };
        }
      }

      // Key 源:中文 Tavily 优先;英文/语义 Exa 优先
      const preferTavilyFirst =
        config.defaultEngine === 'tavily' ||
        (config.defaultEngine !== 'exa' && isCjkQuery(query));
      const tryKeyEngines: Array<'tavily' | 'exa'> = preferTavilyFirst
        ? ['tavily', 'exa']
        : ['exa', 'tavily'];

      for (const eng of tryKeyEngines) {
        if (config.defaultEngine === 'duckduckgo') break;
        if (eng === 'exa' && config.defaultEngine === 'tavily') continue;
        if (eng === 'tavily' && config.defaultEngine === 'exa') continue;
        const key = eng === 'exa' ? exaKey : tavilyKey;
        if (!key) continue;
        try {
          const items = eng === 'exa' ? await searchExa(key, query, maxResults) : await searchTavily(key, query, maxResults);
          if (items.length > 0) {
            const { items: filtered, note } = applyRecency(items);
            return {
              success: true,
              query,
              count: filtered.length,
              engine: eng,
              results: filtered,
              ...(note ? { recencyNote: note } : {}),
            };
          }
        } catch (err: any) {
          console.warn(`[SearchPlugin] ${eng} 搜索失败，自动降级:`, err.message);
        }
      }

      // 零 Key:Google News + Wikipedia
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
        const hint =
          !tavilyKey && !exaKey
            ? '。建议配置 TAVILY_API_KEY 或 EXA_API_KEY 以获得稳定综搜;勿把本次失败理解为「网上没有相关内容」'
            : '';
        return {
          success: false,
          query,
          error: `全部搜索源均无相关结果或不可达: ${[...freeErrors].join('; ') || '无可用源'}${hint}`,
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
}
