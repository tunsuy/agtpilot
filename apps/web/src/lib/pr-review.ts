import { parsePrUrl } from '@agtpilot/protocol';

/**
 * PR review 评论拉取(「响应 review」跟进派发数据源,2026-10-20)。
 *
 * 红线边界:只走 GitHub **公开 REST API**(公开仓匿名可读)—— 不需要、也绝不
 * 携带任何用户凭据(凭据零上行红线不变)。未认证限流 60 次/时/IP,一次拉取
 * 3 个请求;限流/404 如实报错(用户可稍后重试,或直接在弹窗里手工粘贴评论)。
 * 部署侧若设了 GITHUB_TOKEN 环境变量(部署者自己的 token,与用户凭据无关)
 * 则自动带上以提高配额。
 *
 * 已知局限(如实):REST 拿不到 review 线程的 resolved 状态(需要 GraphQL),
 * 策略是拉全量近期 review/行内评论/会话评论,渲染成结构化文本后由用户在派发
 * 弹窗里自行取舍增删 —— 人工挑选本来就是派发门的设计意图。
 *
 * 渲染是纯函数(renderReviewContext,vitest 直测);网络只在 fetchPrReviewContext。
 */

/** 单条评论正文上限(渲染时截断;总长再受 issueContext 同款 8000 上限约束) */
const BODY_CAP = 1500;
/** 渲染总长上限:与 pack.issueContext 的 capText 上限一致(进包不再二次截断) */
const TOTAL_CAP = 8000;

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function loginOf(o: Record<string, unknown>): string {
  const u = asRecord(o.user);
  const login = typeof u?.login === 'string' ? u.login.trim() : '';
  return login || '(未知用户)';
}

function bodyOf(o: Record<string, unknown>): string {
  const b = typeof o.body === 'string' ? o.body.trim() : '';
  if (!b) return '';
  return b.length > BODY_CAP ? `${b.slice(0, BODY_CAP)}…[截断 ${b.length}→${BODY_CAP}]` : b;
}

function dateOf(o: Record<string, unknown>, key: string): string {
  const v = o[key];
  return typeof v === 'string' && v ? v.slice(0, 10) : '';
}

function records(v: unknown): Record<string, unknown>[] {
  if (!Array.isArray(v)) return [];
  return v.map(asRecord).filter((x): x is Record<string, unknown> => x !== null);
}

export interface PrReviewStats {
  reviews: number;
  inlineComments: number;
  issueComments: number;
}

/**
 * GitHub API 原始响应 → 跟进任务的 review 上下文文本(纯函数)。
 * 结构:Review(带 state)→ 行内评论(path:line)→ 会话评论;单条正文 ≤1500,
 * 总长 ≤8000(与 issueContext capText 同限,进包后不再被截)。
 * 头部注明「已解决状态不可见、以用户取舍后为准」—— agent 不该盲信这是全部待办。
 */
export function renderReviewContext(input: {
  prUrl: string;
  fetchedAt: number;
  reviews?: unknown;
  inlineComments?: unknown;
  issueComments?: unknown;
}): string {
  const lines: string[] = [];
  lines.push(
    `【PR review 评论】拉取于 ${new Date(input.fetchedAt).toISOString()},来源 ${input.prUrl}` +
      '(公开 API 拉取,看不到「已解决」线程状态;以下内容已经用户取舍,以此为准)'
  );

  const reviews = records(input.reviews);
  let reviewCount = 0;
  for (const o of reviews) {
    const state = typeof o.state === 'string' && o.state ? o.state : 'COMMENTED';
    const body = bodyOf(o);
    // 无正文的 APPROVED 没有信息量,跳过;CHANGES_REQUESTED 即使无正文也保留(态度本身是信息)
    if (!body && state !== 'CHANGES_REQUESTED') continue;
    reviewCount++;
    const date = dateOf(o, 'submitted_at');
    lines.push('');
    lines.push(`## Review · ${loginOf(o)} · ${state}${date ? ` · ${date}` : ''}`);
    if (body) lines.push(body);
  }

  const inline = records(input.inlineComments);
  if (inline.length > 0) {
    lines.push('');
    lines.push(`## 行内评论(${inline.length} 条)`);
    for (const o of inline) {
      const body = bodyOf(o);
      if (!body) continue;
      const pathSeg = typeof o.path === 'string' && o.path ? o.path : '(未知文件)';
      const line = typeof o.line === 'number' ? `:${o.line}` : typeof o.original_line === 'number' ? `:${o.original_line}` : '';
      const date = dateOf(o, 'created_at');
      lines.push(`### ${pathSeg}${line} · ${loginOf(o)}${date ? ` · ${date}` : ''}`);
      lines.push(body);
      if (typeof o.in_reply_to_id === 'number') lines.push('(↑ 回复某条评论,上文找同文件段落)');
    }
  }

  const conv = records(input.issueComments);
  if (conv.length > 0) {
    lines.push('');
    lines.push(`## 会话评论(${conv.length} 条)`);
    for (const o of conv) {
      const body = bodyOf(o);
      if (!body) continue;
      const date = dateOf(o, 'created_at');
      lines.push(`### ${loginOf(o)}${date ? ` · ${date}` : ''}`);
      lines.push(body);
    }
  }

  if (reviewCount === 0 && inline.length === 0 && conv.length === 0) {
    lines.push('');
    lines.push('(公开 API 未拉到任何 review/评论 —— 可能是限流、私有仓,或线程都已解决;请人工核对后补充)');
  }

  let text = lines.join('\n');
  if (text.length > TOTAL_CAP) {
    text = `${text.slice(0, TOTAL_CAP)}…[截断 ${text.length}→${TOTAL_CAP}]`;
  }
  return text;
}

export type PrReviewFetchResult =
  | { ok: true; context: string; stats: PrReviewStats }
  | { ok: false; error: string };

/**
 * 拉取一个 PR 的 review 上下文(3 个公开 API 端点并行)。
 * fetchImpl/token 可注入(测试/部署侧覆写);token 缺省读 process.env.GITHUB_TOKEN。
 */
export async function fetchPrReviewContext(
  prUrl: string,
  opts: { fetchImpl?: typeof fetch; token?: string | null; now?: number } = {}
): Promise<PrReviewFetchResult> {
  const parsed = parsePrUrl(prUrl);
  if (!parsed) return { ok: false, error: 'PR 链接畸形(应为 https://github.com/owner/repo/pull/N)' };

  const doFetch = opts.fetchImpl ?? fetch;
  const token = opts.token === undefined ? process.env.GITHUB_TOKEN?.trim() || null : opts.token;
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  const base = `https://api.github.com/repos/${parsed.owner}/${parsed.repo}`;
  const getJson = async (path: string): Promise<unknown> => {
    const res = await doFetch(`${base}${path}`, { headers });
    if (!res.ok) {
      if (res.status === 403 || res.status === 429) {
        throw new Error('GitHub API 限流(未认证 60 次/时/IP),稍后再试,或直接在下方手工粘贴 review 评论');
      }
      if (res.status === 404) {
        throw new Error('PR 不存在,或仓库不是公开仓(公开 API 只读得到公开仓)');
      }
      throw new Error(`GitHub API 返回 ${res.status}`);
    }
    return res.json();
  };

  try {
    const [reviews, inline, conv] = await Promise.all([
      getJson(`/pulls/${parsed.prNumber}/reviews?per_page=50`),
      getJson(`/pulls/${parsed.prNumber}/comments?per_page=100`),
      getJson(`/issues/${parsed.prNumber}/comments?per_page=50`),
    ]);
    const context = renderReviewContext({
      prUrl,
      fetchedAt: opts.now ?? Date.now(),
      reviews,
      inlineComments: inline,
      issueComments: conv,
    });
    return {
      ok: true,
      context,
      stats: {
        reviews: records(reviews).length,
        inlineComments: records(inline).length,
        issueComments: records(conv).length,
      },
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
