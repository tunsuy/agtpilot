import type { MissionStep } from '../types/agent';

/**
 * 搜索来源引用(ChatGPT 式):最终答复上方渲染可跳转的来源卡(favicon +
 * 域名),点击新开标签直达原始网页。来源从本轮检索步骤的结构化输出里取 ——
 * search_web 的 tool_result 本就是 { results: [{title, url, snippet}] }。
 *
 * 归属口径:每条最终答复只引用【上一条最终答复之后】的搜索结果(逐轮归属,
 * 多轮会话里追问「再查一下」不会把上一轮的来源又挂一遍)。内联 [n] 角标
 * 需要模型配合编号,先不做;来源卡本身已可点跳转。
 */

export interface SearchSource {
  url: string;
  title: string;
  host: string;
  engine?: string;
  publishedAt?: number;
}

/** 搜索类工具判定:名字含 search 且非 mcp_ 连接器(本地服务无公开网页,narrateTool 同款口径) */
const isSearchTool = (tool?: string): boolean =>
  Boolean(tool && tool.includes('search') && !tool.startsWith('mcp_'));

/** 单步骤输出 → 结果条目列表;容错对象/JSON 字符串两种落盘形态,坏数据静默空 */
function parseOutputResults(st: MissionStep): Array<Record<string, any>> {
  let out: unknown = st.output;
  if (typeof out === 'string') {
    const trimmed = out.trim();
    if (!trimmed.startsWith('{')) return [];
    try {
      out = JSON.parse(trimmed);
    } catch {
      return [];
    }
  }
  if (!out || typeof out !== 'object') return [];
  const results = (out as any).results;
  if (!Array.isArray(results)) return [];
  return results.filter((r: any) => r && typeof r.url === 'string' && typeof r.title === 'string' && r.title);
}

/** 一段步骤区间内的搜索来源:按出现序、按 URL 去重、封顶(防刷屏) */
export function collectSearchSources(steps: MissionStep[], limit = 8): SearchSource[] {
  const seen = new Set<string>();
  const sources: SearchSource[] = [];
  for (const st of steps) {
    if (st.status === 'FAILED' || !isSearchTool(st.tool)) continue;
    for (const r of parseOutputResults(st)) {
      let host = '';
      try {
        host = new URL(r.url).hostname.replace(/^www\./, '');
      } catch {
        continue; // 非法 URL 不进来源卡
      }
      if (!host || seen.has(r.url)) continue;
      seen.add(r.url);
      sources.push({
        url: r.url,
        title: String(r.title),
        host,
        engine: typeof r.engine === 'string' ? r.engine : undefined,
        publishedAt: typeof r.publishedAt === 'number' ? r.publishedAt : undefined,
      });
      if (sources.length >= limit) return sources;
    }
  }
  return sources;
}

/**
 * 指定最终答复应引用的来源:steps[answerIndex] 之前、上一条最终答复之后的
 * 搜索步骤区间。找不到更早的最终答复时从会话开头起算(首轮任务)。
 */
export function sourcesForAnswer(steps: MissionStep[], answerIndex: number, limit = 8): SearchSource[] {
  let start = 0;
  for (let i = answerIndex - 1; i >= 0; i--) {
    if (steps[i].messageKind === 'final') {
      start = i + 1;
      break;
    }
  }
  return collectSearchSources(steps.slice(start, answerIndex), limit);
}
