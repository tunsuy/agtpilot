import { Context } from '@deepseek-ai/cordis';
import '@agtpilot/core';

export const name = 'agtpilot-plugin-search';
export const inject = ['agent'];

export interface SearchResultItem {
  title: string;
  url: string;
  snippet: string;
}

export interface SearchPluginConfig {
  defaultEngine?: 'duckduckgo' | 'tavily' | 'serper';
  tavilyApiKey?: string;
  serperApiKey?: string;
}

export function apply(ctx: Context, config: SearchPluginConfig = {}) {
  // 1. DuckDuckGo 免 API Key 原生网页抓取解析
  async function searchDuckDuckGo(query: string, maxResults: number): Promise<SearchResultItem[]> {
    const url = 'https://html.duckduckgo.com/html/?q=' + encodeURIComponent(query);
    const res = await fetch(url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      },
    });

    if (!res.ok) {
      throw new Error(`DuckDuckGo 搜索失败，HTTP 状态码: ${res.status}`);
    }

    const html = await res.text();
    const titleRegex = /<a[^>]*class=\"result__a\"[^>]*href=\"([^\"]+)\"[^>]*>([\s\S]*?)<\/a>/g;
    const snippetRegex = /<a[^>]*class=\"result__snippet\"[^>]*>([\s\S]*?)<\/a>/g;

    const titles: Array<{ url: string; title: string }> = [];
    let m: RegExpExecArray | null;

    while ((m = titleRegex.exec(html)) !== null) {
      const rawUrl = m[1];
      let actualUrl = rawUrl;
      const uddgMatch = rawUrl.match(/uddg=([^&]+)/);
      if (uddgMatch) {
        actualUrl = decodeURIComponent(uddgMatch[1]);
      }
      const title = m[2].replace(/<[^>]+>/g, '').trim();
      titles.push({ url: actualUrl, title });
    }

    const snippets: string[] = [];
    while ((m = snippetRegex.exec(html)) !== null) {
      snippets.push(m[1].replace(/<[^>]+>/g, '').trim());
    }

    const items: SearchResultItem[] = [];
    const count = Math.min(titles.length, maxResults);
    for (let i = 0; i < count; i++) {
      items.push({
        title: titles[i].title,
        url: titles[i].url,
        snippet: snippets[i] || '',
      });
    }

    return items;
  }

  // 2. Tavily 结构化 API 搜索 (若配置了 Key)
  async function searchTavily(apiKey: string, query: string, maxResults: number): Promise<SearchResultItem[]> {
    const res = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: apiKey,
        query,
        max_results: maxResults,
        search_depth: 'basic',
      }),
    });

    if (!res.ok) {
      throw new Error(`Tavily 搜索失败: ${res.statusText}`);
    }

    const data: any = await res.json();
    return (data.results || []).map((r: any) => ({
      title: r.title,
      url: r.url,
      snippet: r.content,
    }));
  }

  // 注册 search_web 工具
  ctx.agent.registerTool({
    name: 'search_web',
    description: '在互联网上搜索指定关键词或问题，返回排名靠前的网页标题、直达链接与内容摘要 (免 Key 极速检索，支持外接 Tavily 等引擎)',
    dangerLevel: 'low',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '待搜索的关键词或自然语言问题' },
        maxResults: { type: 'number', description: '期望返回的搜索结果条目数 (默认 5)' },
      },
      required: ['query'],
    },
    execute: async ({ query, maxResults = 5 }) => {
      ctx.agent.emitEvent({
        type: 'tool_call',
        payload: { tool: 'search_web', query, maxResults },
        timestamp: Date.now(),
      });

      const tavilyKey = config.tavilyApiKey || process.env.TAVILY_API_KEY;

      try {
        let items: SearchResultItem[] = [];

        if (tavilyKey && config.defaultEngine === 'tavily') {
          items = await searchTavily(tavilyKey, query, maxResults);
        } else {
          // 默认免 Key 优先使用 DuckDuckGo 深度蒸馏
          items = await searchDuckDuckGo(query, maxResults);
        }

        return {
          success: true,
          query,
          count: items.length,
          results: items,
        };
      } catch (err: any) {
        // 如果 DDG 偶发超时且有 Tavily Key，则自动降级熔断至 Tavily
        if (tavilyKey) {
          try {
            const fallbackItems = await searchTavily(tavilyKey, query, maxResults);
            return {
              success: true,
              query,
              count: fallbackItems.length,
              results: fallbackItems,
              fallback: 'tavily',
            };
          } catch {
            // ignore
          }
        }

        return {
          success: false,
          query,
          error: err.message,
        };
      }
    },
  });
}
