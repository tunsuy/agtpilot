/**
 * 开源贡献雷达 · GitHub 只读扫描固定工具(github_scan)
 *
 * 定位:把「按话题扫活跃仓库 + 捞未认领 good first issue」这条纯机械流水线
 * 固化成服务端代码 —— 此前模型在沙箱里现写 Python 调 GitHub REST API
 * (生产实测:思考中起草代码 3 遍,分页/限速/解析全靠临场发挥,token 花在
 * 「发明管道」上)。判断性工作(匹配技术栈、写「为什么适合你」)仍留给模型。
 *
 * 数据面(全部无凭证、纯 GET、只读):
 * - /search/repositories:topic: + pushed:>=cutoff,score/star 排序 → 活跃候选;
 * - /search/issues:state:open + label:"good first issue" + no:assignee +
 *   多个 repo: 限定符(一次检索覆盖全部候选仓)→ 未认领机会。
 *
 * 限速是硬约束(未认证 GitHub API:search 10 次/分钟)。topics 封顶 5、
 * issue 检索合并为一次调用;收到 403 限速不等待(不阻塞任务),记录
 * degraded 说明让模型继续用已有结果。进程内缓存 15 分钟,同任务内
 * 换参数重扫也只有变化的查询打上游。
 *
 * 形态对齐 follow-builders.ts(取数层 + 裁剪层 + 工具薄壳),便于单测;
 * 后续迁「标准化 skill 包」注册表时,本模块可整体搬走,调用方不变。
 */
import type { ToolDefinition } from '@agtpilot/core';

const GITHUB_API = 'https://api.github.com';

/** topics 上限(未认证 search 10 次/分钟,5 个仓库检索 + 1 次 issue 检索刚好在预算内) */
export const GH_MAX_TOPICS = 5;
/** 进程内缓存 TTL:贡献调研不需要秒级新鲜度 */
export const GH_CACHE_TTL_MS = 15 * 60 * 1000;
/** 单次请求超时 */
const GH_FETCH_TIMEOUT_MS = 15_000;
/** issue 检索最多覆盖的仓数(repo: 限定符太多会让 search 查询过长) */
const GH_ISSUE_SEARCH_MAX_REPOS = 12;

export interface GhScanInput {
  /** GitHub topic 词表(如 ai / llm / agent / rag);自动去重、封顶 5 */
  topics: string[];
  /** 活跃门槛:最近 N 天有 push(默认 90,与工坊筛选标准同口径) */
  maxAgeDays?: number;
  /** 每个 topic 取多少候选仓(默认 8) */
  reposPerTopic?: number;
  now?: () => number;
  fetchImpl?: typeof fetch;
}

export interface GhGoodFirstIssue {
  number: number;
  title: string;
  url: string;
  createdAt?: string;
  comments?: number;
  labels: string[];
}

export interface GhRepoCandidate {
  fullName: string;
  url: string;
  description?: string;
  stars: number;
  language?: string;
  topics: string[];
  pushedAt?: string;
  updatedAt?: string;
  archived: boolean;
  openIssuesCount?: number;
  goodFirstIssues: GhGoodFirstIssue[];
}

export interface GhScanResult {
  success: boolean;
  generatedAt: number;
  topics: string[];
  maxAgeDays: number;
  /** 命中 topic 搜索的仓库数(去重后) */
  repoCount: number;
  /** 未认领 good first issue 总数 */
  issueCount: number;
  repos: GhRepoCandidate[];
  /** 检索剩余额度(search 接口,来自响应头;不足时模型应减少后续检索) */
  searchRateRemaining?: number;
  /** 部分失败说明(限速/网络),非空 = 结果有降级,交付物须注明 */
  degraded: string[];
  /** 全部失败时的出口说明 */
  error?: string;
}

/** 缓存按查询签名分桶(同任务换参数重扫互不污染) */
const cache = new Map<string, { at: number; data: GhScanResult }>();

/** 测试专用:清进程内缓存 */
export function resetGithubScanCacheForTest() {
  cache.clear();
}

/** topic 规范化:去空白、去 github topic 非法字符、去重、保序封顶 */
export function normalizeTopics(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of input) {
    const t = String(raw || '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '');
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
    if (out.length >= GH_MAX_TOPICS) break;
  }
  return out;
}

async function ghGet(
  path: string,
  fetchImpl: typeof fetch
): Promise<{ ok: boolean; status: number; json: any; rateRemaining?: number; retryAfter?: number }> {
  const res = await fetchImpl(`${GITHUB_API}${path}`, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'agtpilot-github-scan', // GitHub API 强制要求 UA
    },
    signal: AbortSignal.timeout(GH_FETCH_TIMEOUT_MS),
  });
  // 头缺失时 get() 返回 null,而 Number(null)===0 会被误当成「额度耗尽」,须先判空
  const rawRemaining = (res.headers as any)?.get?.('x-ratelimit-remaining');
  const rateRemaining =
    rawRemaining == null || rawRemaining === '' ? undefined : Number(rawRemaining);
  const rawRetryAfter = (res.headers as any)?.get?.('retry-after');
  const retryAfterHeader =
    rawRetryAfter == null || rawRetryAfter === '' ? undefined : Number(rawRetryAfter);
  let json: any = null;
  try {
    json = await res.json();
  } catch {
    // 非 JSON 响应(如纯限速报文)按空处理,状态码已够判断
  }
  return {
    ok: res.ok,
    status: res.status,
    json,
    rateRemaining: Number.isFinite(rateRemaining as number) ? rateRemaining : undefined,
    retryAfter: Number.isFinite(retryAfterHeader as number) ? retryAfterHeader : undefined,
  };
}

/** 从 issue 的 repository_url(https://api.github.com/repos/{owner}/{repo})提取全名 */
export function repoFullNameFromIssueUrl(url: unknown): string | null {
  if (typeof url !== 'string') return null;
  const m = url.match(/\/repos\/([^/]+\/[^/]+)$/);
  return m ? m[1] : null;
}

/** 纯函数:仓库搜索响应 → 候选(去重、容错字段) */
export function mapRepoItems(items: unknown): Array<Record<string, any>> {
  if (!Array.isArray(items)) return [];
  return items.filter(
    (r: any) => r && typeof r.full_name === 'string' && typeof r.html_url === 'string'
  );
}

/**
 * 一次扫描:每 topic 一轮仓库检索 + 全候选合并成一轮 issue 检索。
 * 部分失败容忍(限速/网络降级,degraded 记录),全部失败 success:false。
 */
export async function scanGithub(input: GhScanInput): Promise<GhScanResult> {
  const topics = normalizeTopics(input.topics);
  const fetchImpl = input.fetchImpl || fetch;
  const nowMs = (input.now || Date.now)();
  const maxAgeDays = Math.min(365, Math.max(1, Math.round(input.maxAgeDays ?? 90) || 90));
  const reposPerTopic = Math.min(30, Math.max(1, Math.round(input.reposPerTopic ?? 8) || 8));
  const cutoff = new Date(nowMs - maxAgeDays * 86400_000).toISOString().slice(0, 10);

  if (topics.length === 0) {
    return {
      success: false,
      generatedAt: nowMs,
      topics: [],
      maxAgeDays,
      repoCount: 0,
      issueCount: 0,
      repos: [],
      degraded: [],
      error: 'topics 为空或全部非法(小写字母/数字/连字符,如 ai / llm / agent / rag)',
    };
  }

  const cacheKey = JSON.stringify({ topics, maxAgeDays, reposPerTopic });
  const hit = cache.get(cacheKey);
  if (hit && nowMs - hit.at < GH_CACHE_TTL_MS) return hit.data;

  const degraded: string[] = [];
  let searchRateRemaining: number | undefined;

  // ---- 1. 每 topic 仓库检索(串行,对 search 限速友好) ----
  const repoMap = new Map<string, any>();
  for (const topic of topics) {
    const q = encodeURIComponent(`topic:${topic} pushed:>=${cutoff}`);
    let res: Awaited<ReturnType<typeof ghGet>>;
    try {
      res = await ghGet(
        `/search/repositories?q=${q}&sort=stars&order=desc&per_page=${reposPerTopic}`,
        fetchImpl
      );
    } catch (e: any) {
      degraded.push(`topic:${topic} 仓库检索网络异常(${e?.message || e})`);
      continue;
    }
    if (res.rateRemaining !== undefined) searchRateRemaining = res.rateRemaining;
    if (!res.ok) {
      if (res.status === 403 || res.status === 429) {
        degraded.push(
          `topic:${topic} 命中 GitHub API 限速(search 未认证 10 次/分钟)${res.retryAfter ? `,约 ${res.retryAfter}s 后可用` : ''}`
        );
      } else {
        degraded.push(`topic:${topic} 仓库检索失败(HTTP ${res.status})`);
      }
      continue;
    }
    for (const r of mapRepoItems(res.json?.items)) {
      if (!repoMap.has(r.full_name)) repoMap.set(r.full_name, r);
    }
  }

  // ---- 2. 活跃候选按 star 排序,取头部合并一轮 issue 检索 ----
  const ranked = [...repoMap.values()].sort(
    (a, b) => (b.stargazers_count || 0) - (a.stargazers_count || 0)
  );
  const issuesByRepo = new Map<string, GhGoodFirstIssue[]>();
  const issueSearchRepos = ranked.slice(0, GH_ISSUE_SEARCH_MAX_REPOS).map((r) => r.full_name as string);
  if (issueSearchRepos.length > 0) {
    const q = encodeURIComponent(
      `state:open label:"good first issue" no:assignee ${issueSearchRepos.map((r) => `repo:${r}`).join(' ')}`
    );
    let res: Awaited<ReturnType<typeof ghGet>>;
    try {
      res = await ghGet(`/search/issues?q=${q}&sort=created&order=desc&per_page=50`, fetchImpl);
      if (res.rateRemaining !== undefined) searchRateRemaining = res.rateRemaining;
      if (res.ok && Array.isArray(res.json?.items)) {
        for (const it of res.json.items) {
          if (!it || typeof it.html_url !== 'string' || typeof it.title !== 'string') continue;
          const repo = repoFullNameFromIssueUrl(it.repository_url);
          if (!repo) continue;
          const issue: GhGoodFirstIssue = {
            number: typeof it.number === 'number' ? it.number : 0,
            title: String(it.title),
            url: String(it.html_url),
            ...(typeof it.created_at === 'string' ? { createdAt: it.created_at } : {}),
            ...(typeof it.comments === 'number' ? { comments: it.comments } : {}),
            labels: Array.isArray(it.labels)
              ? it.labels.map((l: any) => String(l?.name || '')).filter(Boolean)
              : [],
          };
          if (!issuesByRepo.has(repo)) issuesByRepo.set(repo, []);
          const list = issuesByRepo.get(repo)!;
          if (list.length < 5) list.push(issue); // 单仓封顶 5 条,防头部仓霸榜
        }
      } else if (!res.ok) {
        degraded.push(
          res.status === 403 || res.status === 429
            ? 'good first issue 检索命中 GitHub API 限速,本次无 Issue 明细(仓库候选仍可用)'
            : `good first issue 检索失败(HTTP ${res.status})`
        );
      }
    } catch (e: any) {
      degraded.push(`issue 检索网络异常(${e?.message || e})`);
    }
  }

  // ---- 3. 组装(LLM 友好:剔除空值字段,避免大段 null) ----
  const repos: GhRepoCandidate[] = ranked.map((r) => {
    const issues = issuesByRepo.get(r.full_name) || [];
    const c: GhRepoCandidate = {
      fullName: r.full_name,
      url: r.html_url,
      stars: r.stargazers_count ?? 0,
      topics: Array.isArray(r.topics) ? r.topics.map(String).slice(0, 8) : [],
      archived: Boolean(r.archived),
      goodFirstIssues: issues,
    };
    if (r.description) c.description = String(r.description);
    if (r.language) c.language = String(r.language);
    if (r.pushed_at) c.pushedAt = r.pushed_at;
    if (r.updated_at) c.updatedAt = r.updated_at;
    if (typeof r.open_issues_count === 'number') c.openIssuesCount = r.open_issues_count;
    return c;
  });

  const issueCount = repos.reduce((n, r) => n + r.goodFirstIssues.length, 0);
  const result: GhScanResult = {
    success: repos.length > 0,
    generatedAt: nowMs,
    topics,
    maxAgeDays,
    repoCount: repos.length,
    issueCount,
    repos,
    ...(searchRateRemaining !== undefined ? { searchRateRemaining } : {}),
    degraded,
    ...(repos.length === 0
      ? {
          error:
            'GitHub 仓库检索全部失败(常见:未认证 API 限速或网络不可达)。降级路径:用 search_web 检索 GitHub Trending 与具体仓库页,或基于自身知识给候选并注明「链接与状态未经实时核验」',
        }
      : {}),
  };

  if (result.success) cache.set(cacheKey, { at: nowMs, data: result });
  return result;
}

const GH_TOOL_FALLBACK_HINT =
  '降级路径:用 search_web 检索 GitHub Trending/仓库页,或换一组 topics 重试';

/** 工具薄壳:开源贡献调研专用取数(只读、无需凭证、服务端缓存 15 分钟) */
export function buildGithubScanTools(): ToolDefinition[] {
  return [
    {
      name: 'github_scan',
      description:
        '按 GitHub 话题(topic)一次性扫描活跃开源仓库与未认领的 good first issue(纯 GET 只读、无需凭证、服务端缓存 15 分钟)。' +
        '返回按 star 排序的候选仓库(star/语言/最近推送/topic)与每个仓库的开放 good first issue(标题/链接/创建时间/评论数,已过滤无人认领)。' +
        '适合贡献机会调研的机械取数部分;筛选判断(匹配技术栈、评估上手成本)由你完成。' +
        'topics 用 GitHub topic 词(如 ai / llm / agent / rag / devtool,最多 5 个)。' +
        'GitHub API 未认证限速 10 次/分钟,返回里的 searchRateRemaining 是剩余额度,额度不足时减少扫描或改用 search_web。',
      dangerLevel: 'low',
      readOnly: true, // 只读并行门控:纯拉取公共 API,无副作用
      parameters: {
        type: 'object',
        properties: {
          topics: {
            type: 'array',
            items: { type: 'string' },
            description: 'GitHub topic 词表,如 ["ai","llm","agent"];最多 5 个',
          },
          maxAgeDays: {
            type: 'number',
            description: '活跃门槛:最近 N 天有 push(默认 90)',
          },
          reposPerTopic: {
            type: 'number',
            description: '每个 topic 取多少候选仓库(默认 8,上限 30)',
          },
        },
        required: ['topics'],
      },
      execute: async (args: any) => {
        const result = await scanGithub({
          topics: Array.isArray(args?.topics) ? args.topics : [],
          ...(typeof args?.maxAgeDays === 'number' ? { maxAgeDays: args.maxAgeDays } : {}),
          ...(typeof args?.reposPerTopic === 'number' ? { reposPerTopic: args.reposPerTopic } : {}),
        });
        if (!result.success) {
          return { success: false, error: `${result.error}。${GH_TOOL_FALLBACK_HINT}` };
        }
        return result;
      },
    },
  ];
}

/** 工具提供方注册表条目(tool-providers.ts);build 签名与上面导出保持一对一 */
export const TOOL_PROVIDER: import('./tool-providers').ToolProvider = {
  id: 'github_scan',
  deps: [],
  build: () => buildGithubScanTools(),
};
