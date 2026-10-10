/**
 * 小红书笔记包解析器(docs/design/workshop-scenario-loop.md §3)
 *
 * 「格式即契约」:buildXhsWorkshopPrompt 约定 Agent 按【字段头】+ `---` 分隔输出笔记包,
 * 本模块把该 markdown 解析回结构化;解析失败(packages 为空)时调用方降级为普通文本渲染。
 * 纯函数,无 React/浏览器依赖,便于以固定样例做契约测试。
 */

export interface NotePackage {
  /** 第几篇,从 1 起 */
  index: number;
  /** 标题候选(已去掉序号前缀) */
  titles: string[];
  /** 封面主文案 */
  coverCopy?: string;
  /** 正文 */
  body: string;
  /** 标签(已去掉 # 前缀,去重) */
  tags: string[];
  /** 发布建议 */
  publishAdvice?: string;
}

export interface NotePackageParseResult {
  packages: NotePackage[];
  /** 无法归入任何笔记包的残余文本(开场寒暄/结尾提醒等),不丢内容 */
  fallback: string | null;
}

type FieldKey = 'titles' | 'cover' | 'body' | 'tags' | 'advice';

/** 字段头:【标题候选】/【封面文案】/【正文】/【标签】/【发布建议】,兼容旧字段名,允许行尾追加说明 */
const FIELD_HEADERS: Array<[FieldKey, RegExp]> = [
  ['titles', /^\s*【\s*(?:标题候选|标题)\s*[^】]*】/],
  ['cover', /^\s*【\s*(?:封面文案|封面建议|封面)\s*[^】]*】/],
  ['body', /^\s*【\s*正文\s*[^】]*】/],
  ['tags', /^\s*【\s*(?:标签|话题)\s*[^】]*】/],
  ['advice', /^\s*【\s*(?:发布建议|发布提示)\s*[^】]*】/],
];

/** 篇分隔符:独占一行的 ---(允许 3 个以上连字符与前后空白) */
const SEPARATOR = /^\s*-{3,}\s*$/;

const TITLE_PREFIX = /^\s*(?:\d+\s*[.、)．]\s*|[-*·]\s*)?/;

/** 从文本提取 #标签,去 # 前缀、去重、保序 */
const extractTags = (text: string): string[] => {
  const found = text.match(/#[^\s#【】]+/g) || [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of found) {
    const clean = t.replace(/^#+/, '');
    if (clean && !seen.has(clean)) {
      seen.add(clean);
      out.push(clean);
    }
  }
  return out;
};

const joinLines = (lines: string[]): string => lines.join('\n').trim();

function matchFieldHeader(line: string): FieldKey | null {
  for (const [key, re] of FIELD_HEADERS) {
    if (re.test(line)) return key;
  }
  return null;
}

/** 单块文本 → 笔记包;不满足有效性(body ≥50 字 且命中 ≥3 字段)返回 null */
function parseBlock(block: string): { pkg: NotePackage | null; lead: string } {
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
  const coverCopy = joinLines(segments.get('cover') || []);
  const body = joinLines(segments.get('body') || []);
  const advice = joinLines(segments.get('advice') || []);

  // 标签:优先标签字段,为空时从正文兜底提取
  let tags = extractTags((segments.get('tags') || []).join(' '));
  if (tags.length === 0 && body) tags = extractTags(body);

  const hits = [titles.length > 0, Boolean(coverCopy), Boolean(body), tags.length > 0, Boolean(advice)].filter(
    Boolean
  ).length;
  const valid = body.replace(/\s/g, '').length >= 50 && hits >= 3;

  return {
    pkg: valid
      ? {
          index: 0,
          titles,
          ...(coverCopy ? { coverCopy } : {}),
          body,
          tags,
          ...(advice ? { publishAdvice: advice } : {}),
        }
      : null,
    lead: leadLines.join('\n').trim(),
  };
}

/** 解析 Agent 的笔记包输出;packages 为空 = 解析失败,调用方降级为普通 markdown 渲染 */
export function parseNotePackages(text: string): NotePackageParseResult {
  const source = typeof text === 'string' ? text.trim() : '';
  if (!source) return { packages: [], fallback: null };

  // 一个【字段头】都没有 → 必然不是笔记包,直接降级
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

  const packages: NotePackage[] = [];
  const fallbackParts: string[] = [];
  for (const block of blocks) {
    const { pkg, lead } = parseBlock(block);
    if (pkg) {
      pkg.index = packages.length + 1;
      packages.push(pkg);
      if (lead) fallbackParts.push(lead);
    } else {
      fallbackParts.push(block);
    }
  }

  return {
    packages,
    fallback: fallbackParts.length > 0 ? fallbackParts.join('\n\n') : null,
  };
}

/**
 * 一键整卡复制:标题 → 空行 → 正文 → 空行 → 标签串。
 * 顺序与小红书发布页粘贴顺序对齐;封面文案/发布建议不贴进发布框,不进整卡。
 */
export function buildNotePackageCopyText(pkg: NotePackage, titleIndex = 0): string {
  const title = pkg.titles[Math.min(Math.max(titleIndex, 0), pkg.titles.length - 1)] || '';
  const tags = pkg.tags.map((t) => `#${t}`).join(' ');
  return [title, pkg.body, tags].filter(Boolean).join('\n\n');
}
