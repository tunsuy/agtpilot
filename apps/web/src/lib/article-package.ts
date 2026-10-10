/**
 * 公众号文章包解析器(scenario-loop §3 同构,格式即契约)
 *
 * buildWechatMpWorkshopPrompt 约定 Agent 按【字段头】+ `---` 分隔输出文章包,
 * 本模块把该 markdown 解析回结构化;解析失败(packages 为空)时调用方降级为普通文本渲染。
 * 纯函数,无 React/浏览器依赖,便于以固定样例做契约测试。
 *
 * 与 note-package.ts 的互斥:文章包必命中【摘要】(笔记包字段头里没有摘要键,永不误判);
 * 反向不成立——文章包的四头(标题候选/封面建议/正文/发布建议)全命中 parseNotePackages,
 * 所以渲染顺序必须 article 先于 note(CockpitView 固化,测试反证锚定)。
 */

export interface ArticlePackage {
  /** 第几篇,从 1 起 */
  index: number;
  /** 标题候选(已去掉序号前缀) */
  titles: string[];
  /** 摘要(必命中字段,与笔记包的互斥锚) */
  digest: string;
  /** 正文(Markdown) */
  body: string;
  /** 封面建议 */
  coverIdea?: string;
  /** 发布建议 */
  publishAdvice?: string;
}

export interface ArticlePackageParseResult {
  packages: ArticlePackage[];
  /** 无法归入任何文章包的残余文本(开场寒暄/结尾提醒等),不丢内容 */
  fallback: string | null;
}

type FieldKey = 'titles' | 'digest' | 'body' | 'cover' | 'advice';

/** 字段头:【标题候选】/【摘要】/【正文】/【封面建议】/【发布建议】,兼容变体,允许行尾追加说明 */
const FIELD_HEADERS: Array<[FieldKey, RegExp]> = [
  ['titles', /^\s*【\s*(?:标题候选|标题)\s*[^】]*】/],
  ['digest', /^\s*【\s*(?:摘要|内容摘要)\s*[^】]*】/],
  ['body', /^\s*【\s*正文\s*[^】]*】/],
  ['cover', /^\s*【\s*(?:封面建议|封面文案|封面)\s*[^】]*】/],
  ['advice', /^\s*【\s*(?:发布建议|发布提示)\s*[^】]*】/],
];

/** 篇分隔符:独占一行的 ---(允许 3 个以上连字符与前后空白),与 note-package 相同 */
const SEPARATOR = /^\s*-{3,}\s*$/;

const TITLE_PREFIX = /^\s*(?:\d+\s*[.、)．]\s*|[-*·]\s*)?/;

const joinLines = (lines: string[]): string => lines.join('\n').trim();

function matchFieldHeader(line: string): FieldKey | null {
  for (const [key, re] of FIELD_HEADERS) {
    if (re.test(line)) return key;
  }
  return null;
}

/** 单块文本 → 文章包;不满足有效性(digest 非空 且 body ≥100 字 且命中 ≥3 字段)返回 null */
function parseBlock(block: string): { pkg: ArticlePackage | null; lead: string } {
  const lines = block.split('\n');
  const segments = new Map<FieldKey, string[]>();
  const leadLines: string[] = [];
  let current: FieldKey | null = null;

  for (const line of lines) {
    const header = matchFieldHeader(line);
    if (header) {
      current = header;
      if (!segments.has(header)) segments.set(header, []);
      continue;
    }
    if (current) {
      segments.get(current)!.push(line);
    } else {
      // 首个字段头之前的行是模型寒暄/引导语:块有效时归 fallback(不丢内容),块无效时随整块走
      leadLines.push(line);
    }
  }

  const titles = (segments.get('titles') || [])
    .map((l) => l.replace(TITLE_PREFIX, '').trim())
    .filter(Boolean);
  const digest = joinLines(segments.get('digest') || []);
  const body = joinLines(segments.get('body') || []);
  const coverIdea = joinLines(segments.get('cover') || []);
  const publishAdvice = joinLines(segments.get('advice') || []);

  const hits = [titles.length > 0, Boolean(digest), Boolean(body), Boolean(coverIdea), Boolean(publishAdvice)].filter(
    Boolean
  ).length;
  const valid = Boolean(digest) && body.replace(/\s/g, '').length >= 100 && hits >= 3;

  return {
    pkg: valid
      ? {
          index: 0,
          titles,
          digest,
          body,
          ...(coverIdea ? { coverIdea } : {}),
          ...(publishAdvice ? { publishAdvice } : {}),
        }
      : null,
    lead: leadLines.join('\n').trim(),
  };
}

/** 解析 Agent 的文章包输出;packages 为空 = 解析失败,调用方降级为普通 markdown 渲染 */
export function parseArticlePackages(text: string): ArticlePackageParseResult {
  const source = typeof text === 'string' ? text.trim() : '';
  if (!source) return { packages: [], fallback: null };

  // 一个【字段头】都没有 → 必然不是文章包,直接降级
  if (!source.includes('【')) return { packages: [], fallback: source };

  const blocks = source
    .split('\n')
    .reduce<string[][]>(
      (acc, line) => {
        if (SEPARATOR.test(line)) acc.push([]);
        else acc[acc.length - 1].push(line);
        return acc;
      },
      [[]]
    )
    .map((b) => b.join('\n').trim())
    .filter(Boolean);

  const packages: ArticlePackage[] = [];
  const fallbackParts: string[] = [];
  for (const block of blocks) {
    const { pkg, lead } = parseBlock(block);
    if (pkg) {
      pkg.index = packages.length + 1;
      packages.push(pkg);
      if (lead) fallbackParts.push(lead);
    } else {
      // 总评块/无效块:字段数不足,整块进 fallback(不丢内容)
      fallbackParts.push(block);
    }
  }

  return {
    packages,
    fallback: fallbackParts.length > 0 ? fallbackParts.join('\n\n') : null,
  };
}

/**
 * 一键整卡复制:选中标题 → 空行 → 摘要 → 空行 → 正文(Markdown 原文)。
 * 封面建议/发布建议不贴进草稿创建参数,不进整卡。
 */
export function buildArticlePackageCopyText(pkg: ArticlePackage, titleIndex = 0): string {
  const title = pkg.titles[Math.min(Math.max(titleIndex, 0), pkg.titles.length - 1)] || '';
  return [title, pkg.digest, pkg.body].filter(Boolean).join('\n\n');
}

/**
 * 「投草稿箱」续聊回复文本:指示 Agent 调用 wechat_mp_create_draft,
 * title/digest/markdown 逐字内嵌(参数零漂移,不依赖上下文回读)。
 * 工具为 dangerLevel high → 编排器审批门,用户逐次确认后才真正写入。
 */
export function buildArticlePackageReplyText(pkg: ArticlePackage, titleIndex = 0): string {
  const title = pkg.titles[Math.min(Math.max(titleIndex, 0), pkg.titles.length - 1)] || '';
  return `请把下面这篇公众号文章投入我的草稿箱:调用 wechat_mp_create_draft 工具(title/digest/markdown 严格按下文填写,不传 cover_url,封面自动生成)。调用前需经我审批确认;发布仍由我在公众平台后台人工完成,不要调用任何发布/群发类接口。

title:${title}

digest:${pkg.digest}

markdown:
${pkg.body}`;
}
