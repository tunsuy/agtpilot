import { describe, it, expect, beforeEach } from 'vitest';
import {
  scanGithub,
  buildGithubScanTools,
  normalizeTopics,
  repoFullNameFromIssueUrl,
  resetGithubScanCacheForTest,
  GH_CACHE_TTL_MS,
} from '../github-scan';

/**
 * github_scan 固定工具(工坊脚本化):此前模型在沙箱现写 Python 调
 * GitHub REST API —— 限速/分页/解析全靠临场发挥。这里把机械取数固化,
 * 测试锚定:topic 规范化、去重合并、issue 归仓、限速降级不阻塞、
 * 全失败给出 search_web 降级出口、缓存命中不打上游。
 */

const NOW = Date.parse('2026-10-13T10:00:00.000Z');
const now = () => NOW;

/** 极简 Headers 桩:GitHub 限速相关字段 */
class HeadersStub {
  private map = new Map<string, string>();
  constructor(init: Record<string, string> = {}) {
    for (const [k, v] of Object.entries(init)) this.map.set(k.toLowerCase(), v);
  }
  get(name: string): string | null {
    return this.map.get(String(name).toLowerCase()) ?? null;
  }
}

interface StubResponse {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
}

/** 请求记录 + 可编程响应的 fetch 桩(响应循环使用,适配缓存重扫场景) */
function makeFetch(responses: Array<(url: string) => StubResponse>) {
  const calls: string[] = [];
  const impl = (async (url: string) => {
    calls.push(String(url));
    const next = responses[(calls.length - 1) % responses.length];
    const { status = 200, body = {}, headers = {} } = next(String(url));
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: new HeadersStub(headers),
      json: async () => body,
    };
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const repo = (over: Record<string, any> = {}) => ({
  full_name: 'o/r',
  html_url: 'https://github.com/o/r',
  stargazers_count: 100,
  topics: ['ai'],
  archived: false,
  ...over,
});

const issue = (over: Record<string, any> = {}) => ({
  number: 1,
  title: 't',
  html_url: 'https://github.com/o/r/issues/1',
  repository_url: 'https://api.github.com/repos/o/r',
  created_at: '2026-10-01T00:00:00Z',
  comments: 0,
  labels: [{ name: 'good first issue' }],
  ...over,
});

beforeEach(() => {
  resetGithubScanCacheForTest();
});

describe('normalizeTopics', () => {
  it('去空白、非法字符、去重、保序封顶 5', () => {
    expect(normalizeTopics([' AI ', 'ai', 'LLM!', 'agent framework', 'RAG', 'dev tool', '', 'x'])).toEqual([
      'ai',
      'llm',
      'agentframework',
      'rag',
      'devtool',
    ]);
    // 连字符是合法 GitHub topic 字符,保留
    expect(normalizeTopics(['agent-framework'])).toEqual(['agent-framework']);
  });

  it('非数组输入 → 空数组(触发 success:false 出口)', () => {
    expect(normalizeTopics('ai')).toEqual([]);
    expect(normalizeTopics(undefined)).toEqual([]);
  });
});

describe('repoFullNameFromIssueUrl', () => {
  it('从 api repos URL 提取 owner/repo', () => {
    expect(repoFullNameFromIssueUrl('https://api.github.com/repos/langgenius/dify')).toBe(
      'langgenius/dify'
    );
  });

  it('非字符串或不匹配 → null', () => {
    expect(repoFullNameFromIssueUrl(123)).toBeNull();
    expect(repoFullNameFromIssueUrl('https://example.com/foo')).toBeNull();
  });
});

describe('scanGithub', () => {
  it('单 topic:仓库检索 + 合并 issue 检索,issue 归到对应仓', async () => {
    const { impl, calls } = makeFetch([
      () => ({
        body: { items: [repo({ full_name: 'a/x', stargazers_count: 50 })] },
        headers: { 'x-ratelimit-remaining': '8' },
      }),
      () => ({
        body: {
          items: [
            issue({
              number: 7,
              title: 'fix docs',
              repository_url: 'https://api.github.com/repos/a/x',
              html_url: 'https://github.com/a/x/issues/7',
            }),
          ],
        },
      }),
    ]);
    const r = await scanGithub({ topics: ['ai'], now, fetchImpl: impl });

    expect(r.success).toBe(true);
    expect(r.repoCount).toBe(1);
    expect(r.issueCount).toBe(1);
    expect(r.repos[0].goodFirstIssues[0]).toMatchObject({ number: 7, title: 'fix docs' });
    expect(r.searchRateRemaining).toBe(8);
    // 请求形态:topic 搜索 + 一轮合并 issue 检索
    expect(calls[0]).toContain('/search/repositories?q=topic%3Aai');
    expect(calls[1]).toContain('/search/issues?q=');
    expect(calls[1]).toContain('state%3Aopen');
    expect(decodeURIComponent(calls[1])).toContain('repo:a/x');
  });

  it('多 topic 去重合并 + 按 star 排序 + 空值字段剔除', async () => {
    const { impl, calls } = makeFetch([
      () => ({ body: { items: [repo({ full_name: 'a/low', stargazers_count: 10 })] } }),
      () => ({
        body: {
          items: [repo({ full_name: 'b/high', stargazers_count: 900, language: null, description: null })],
        },
      }),
      () => ({ body: { items: [] } }),
    ]);
    const r = await scanGithub({ topics: ['ai', 'llm'], now, fetchImpl: impl });

    expect(r.repoCount).toBe(2);
    expect(r.repos.map((x) => x.fullName)).toEqual(['b/high', 'a/low']); // star 降序
    expect(r.repos[0]).not.toHaveProperty('language'); // null 字段剔除
    expect(r.degraded).toEqual([]); // issue 检索空结果不算降级
    expect(calls).toHaveLength(3);
  });

  it('issue 检索限速(403)→ 仓库候选仍可用 + degraded 注明', async () => {
    const { impl } = makeFetch([
      () => ({ body: { items: [repo({ full_name: 'a/x' })] } }),
      () => ({ status: 403, body: { message: 'rate limit' }, headers: { 'retry-after': '60' } }),
    ]);
    const r = await scanGithub({ topics: ['ai'], now, fetchImpl: impl });

    expect(r.success).toBe(true);
    expect(r.repos[0].goodFirstIssues).toEqual([]);
    expect(r.degraded.join(' ')).toContain('限速');
  });

  it('仓库检索部分失败(某 topic 403)→ 其余 topic 继续', async () => {
    const { impl } = makeFetch([
      () => ({ status: 403, body: {} }),
      () => ({ body: { items: [repo({ full_name: 'b/ok' })] } }),
      () => ({ body: { items: [] } }),
    ]);
    const r = await scanGithub({ topics: ['ai', 'llm'], now, fetchImpl: impl });

    expect(r.success).toBe(true);
    expect(r.repoCount).toBe(1);
    expect(r.degraded[0]).toContain('topic:ai');
  });

  it('仓库检索全部失败 → success:false + search_web 降级出口', async () => {
    const { impl } = makeFetch([() => ({ status: 403, body: {} })]);
    const r = await scanGithub({ topics: ['ai'], now, fetchImpl: impl });

    expect(r.success).toBe(false);
    expect(r.repos).toEqual([]);
    expect(r.error).toContain('search_web');
  });

  it('topics 为空 → 直接失败,不发任何请求', async () => {
    const { impl, calls } = makeFetch([() => ({ body: {} })]);
    const r = await scanGithub({ topics: [], now, fetchImpl: impl });

    expect(r.success).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('网络异常按降级处理,不抛出(工具层不能让任务崩)', async () => {
    const failing = (async () => {
      throw new Error('ECONNRESET');
    }) as unknown as typeof fetch;
    const r = await scanGithub({ topics: ['ai'], now, fetchImpl: failing });

    expect(r.success).toBe(false);
    expect(r.degraded.join(' ')).toContain('ECONNRESET');
  });

  it('缓存:同参数 15 分钟内命中,不打上游;TTL 过期重扫', async () => {
    let clock = NOW;
    const { impl, calls } = makeFetch([
      () => ({ body: { items: [repo({ full_name: 'a/x' })] } }),
      () => ({ body: { items: [] } }),
    ]);
    const first = await scanGithub({ topics: ['ai'], now: () => clock, fetchImpl: impl });
    expect(calls).toHaveLength(2);

    const second = await scanGithub({ topics: ['ai'], now: () => clock, fetchImpl: impl });
    expect(second).toBe(first); // 命中缓存对象,零新请求
    expect(calls).toHaveLength(2);

    clock = NOW + GH_CACHE_TTL_MS + 1;
    await scanGithub({ topics: ['ai'], now: () => clock, fetchImpl: impl });
    expect(calls).toHaveLength(4); // TTL 过期重扫
  });

  it('单仓 good first issue 封顶 5 条(防头部仓霸榜)', async () => {
    const items = Array.from({ length: 8 }, (_, i) =>
      issue({ number: i + 1, html_url: `https://github.com/o/r/issues/${i + 1}` })
    );
    const { impl } = makeFetch([
      () => ({ body: { items: [repo()] } }),
      () => ({ body: { items } }),
    ]);
    const r = await scanGithub({ topics: ['ai'], now, fetchImpl: impl });

    expect(r.repos[0].goodFirstIssues).toHaveLength(5);
    expect(r.issueCount).toBe(5);
  });
});

describe('buildGithubScanTools', () => {
  it('工具定义:只读、低风险、topics 必填', () => {
    const tools = buildGithubScanTools();
    expect(tools).toHaveLength(1);
    const t = tools[0] as any;
    expect(t.name).toBe('github_scan');
    expect(t.readOnly).toBe(true);
    expect(t.dangerLevel).toBe('low');
    expect(t.parameters.required).toEqual(['topics']);
  });

  it('execute 透传参数;失败时返回 error 而不抛出', async () => {
    const tools = buildGithubScanTools() as any[];
    const failing = (async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;

    // 注入失败 fetch:通过临时替换全局 fetch 验证 execute 出口
    const origFetch = globalThis.fetch;
    globalThis.fetch = failing;
    try {
      const out = await tools[0].execute({ topics: ['ai'] });
      expect(out.success).toBe(false);
      expect(out.error).toContain('search_web');
    } finally {
      globalThis.fetch = origFetch;
    }
    resetGithubScanCacheForTest();
  });
});
