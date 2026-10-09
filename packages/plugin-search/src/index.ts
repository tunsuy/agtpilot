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
}

export interface SearchPluginConfig {
  defaultEngine?: 'auto' | 'exa' | 'tavily' | 'duckduckgo';
  exaApiKey?: string;
  tavilyApiKey?: string;
}

export function apply(ctx: Context, config: SearchPluginConfig = {}) {
  // 工具路由自注册：prompt 命中搜索/资讯类关键词时挂载本插件工具组
  ctx.agent.registerToolRoute({
    id: 'search',
    prefixes: ['search_'],
    test: /(搜索|检索|查一下|查下|搜一下|查查|最新|新闻|资讯|search|news|look\s?up)/i,
  });

  // 1. 免 API Key 实时多源聚合搜索 (Google News RSS + DuckDuckGo HTML + Wikipedia)
  // 返回结果与各源的失败原因（全源失败时调用方据此给出真实报错，而非 count:0 假成功）
  async function searchFreeSources(
    query: string,
    maxResults: number
  ): Promise<{ items: SearchResultItem[]; errors: string[] }> {
    const items: SearchResultItem[] = [];
    const errors: string[] = [];

    // 优先：Google News 实时权威资讯 RSS (对新闻、热点动态极佳，无验证码限制)
    try {
      const gUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=zh-CN&gl=CN&ceid=CN:zh-Hans`;
      const gRes = await fetch(gUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        },
      });
      if (gRes.ok) {
        const xml = await gRes.text();
        const itemRegex = /<item>[\s\S]*?<title>([\s\S]*?)<\/title>[\s\S]*?<link>([\s\S]*?)<\/link>[\s\S]*?(?:<pubDate>([\s\S]*?)<\/pubDate>)?[\s\S]*?<\/item>/g;
        let match: RegExpExecArray | null;
        while ((match = itemRegex.exec(xml)) !== null && items.length < maxResults) {
          const rawTitle = match[1].replace(/<!\[CDATA\[(.*?)\]\]>/g, '$1').trim();
          const rawLink = match[2].trim();
          const pubDate = match[3]?.trim() || '';
          if (rawTitle && rawLink) {
            items.push({
              title: rawTitle,
              url: rawLink,
              snippet: pubDate ? `发布时间: ${pubDate}` : '来自 Google News 实时资讯',
              engine: 'google-news',
            });
          }
        }
      } else {
        errors.push(`google-news: HTTP ${gRes.status}`);
      }
    } catch (e: any) {
      errors.push(`google-news: ${e.message}`);
    }

    if (items.length >= maxResults) {
      return { items: items.slice(0, maxResults), errors };
    }

    // 补充：DuckDuckGo HTML 端点（零 Key 通用网页搜索，覆盖非新闻类查询）
    try {
      const ddgRes = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        },
      });
      if (ddgRes.ok) {
        const html = await ddgRes.text();
        // 结果链接形如 href="//duckduckgo.com/l/?uddg=<urlencoded>"，需解出真实目标
        const linkRegex = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
        let match: RegExpExecArray | null;
        while ((match = linkRegex.exec(html)) !== null && items.length < maxResults) {
          let realUrl = match[1];
          try {
            const parsed = new URL(realUrl.startsWith('//') ? `https:${realUrl}` : realUrl);
            const target = parsed.searchParams.get('uddg');
            if (target) realUrl = decodeURIComponent(target);
            if (!/^https?:\/\//.test(realUrl)) continue;
          } catch {
            continue;
          }
          const title = match[2].replace(/<[^>]+>/g, '').trim();
          if (title && !items.some((i) => i.url === realUrl)) {
            items.push({
              title,
              url: realUrl,
              snippet: '来自 DuckDuckGo 网页搜索',
              engine: 'duckduckgo',
            });
          }
        }
      } else {
        errors.push(`duckduckgo: HTTP ${ddgRes.status}`);
      }
    } catch (e: any) {
      errors.push(`duckduckgo: ${e.message}`);
    }

    if (items.length >= maxResults) {
      return { items: items.slice(0, maxResults), errors };
    }

    // 补充：Wikipedia 全球百科知识库 API（按查询语种选择分站）
    try {
      const isCjk = /[一-龥]/.test(query);
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
          const cleanSnippet = (entry.snippet || '').replace(/<[^>]+>/g, '').trim();
          items.push({
            title: entry.title,
            url: `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(entry.title)}`,
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
    description: '在互联网上搜索指定关键词或问题，自动在 Exa 神经语义搜索、Tavily Agent 搜索以及 DuckDuckGo 零 Key 引擎间进行多层级路由与容灾降级',
    dangerLevel: 'low',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '待搜索的关键词或自然语言问题' },
        maxResults: { type: 'number', description: '期望返回的搜索结果条目数 (默认 5)' },
      },
      required: ['query'],
    },
    execute: async ({ query, maxResults = 5 }, session?: any) => {
      ctx.agent.emitEvent({
        type: 'tool_call',
        payload: { tool: 'search_web', query, maxResults },
        timestamp: Date.now(),
      });

      // 用户级 Key 优先（session.env 来自任务发起者的个人空间，多用户隔离，绝不进 process.env）
      const exaKey = session?.env?.EXA_API_KEY || config.exaApiKey || process.env.EXA_API_KEY;
      const tavilyKey = session?.env?.TAVILY_API_KEY || config.tavilyApiKey || process.env.TAVILY_API_KEY;

      // 优先级 1: Exa.ai 语义神经搜索 (若配置了 Key)
      if (exaKey && config.defaultEngine !== 'duckduckgo' && config.defaultEngine !== 'tavily') {
        try {
          const items = await searchExa(exaKey, query, maxResults);
          if (items.length > 0) {
            return { success: true, query, count: items.length, engine: 'exa', results: items };
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
            return { success: true, query, count: items.length, engine: 'tavily', results: items };
          }
        } catch (err: any) {
          console.warn('[SearchPlugin] Tavily 搜索失败，自动降级:', err.message);
        }
      }

      // 优先级 3: 零 Key 原生多源聚合搜索引擎 (Google News RSS + DuckDuckGo + Wikipedia)
      try {
        const { items, errors: freeErrors } = await searchFreeSources(query, maxResults);
        if (items.length > 0) {
          return {
            success: true,
            query,
            count: items.length,
            engine: items[0]?.engine || 'aggregator',
            results: items,
            ...(freeErrors.length > 0 ? { degradedSources: freeErrors } : {}),
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
    description: '使用 Exa.ai 原生神经网络语义搜索引擎，基于语义 Embedding 精准匹配网页与正文 Highlight',
    dangerLevel: 'low',
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
    description: '使用 Tavily 官方 API 搜索针对大模型优化的结构化内容',
    dangerLevel: 'low',
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
