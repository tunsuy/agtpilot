/**
 * 开源贡献机会解析器(格式即契约,与 topic-picks.ts 同构)。
 *
 * buildOssRadarPrompt 约定 Agent 按【机会 N】+ 字段头 + `---` 分隔输出贡献机会清单,
 * 本模块把该 markdown 解析回结构化;解析失败(opportunities 为空)时调用方降级为
 * 普通 markdown 渲染。纯函数,无 React/浏览器依赖,便于以固定样例做契约测试。
 *
 * 与既有三种格式的互斥(测试双向锚定):
 * - 有效性要求【项目】+【机会链接】里至少一条 URL —— 文章包/笔记包/选题清单都没有这两个头;
 * - 反向:本格式的字段头(机会 N/项目/项目简介/机会类型/机会链接/为什么适合你/建议第一步/难度)
 *   不含标题/摘要/正文/标签/选题方向/依据,三个既有解析器全部解析失败。
 * 注意【项目简介】以「项目」开头:FIELD_HEADERS 顺序上 summary 必须排在 project 之前。
 */

export interface OssOpportunity {
  /** 【机会 N】的 N;块内缺失时按出现顺序 1..n 递补 */
  number: number;
  /** 【项目】owner/repo */
  project: string;
  /** 【项目简介】 */
  summary?: string;
  /** 【机会类型】 */
  kind?: string;
  /** 【机会链接】中提取的 URL(至少一条才成块;交付物核心价值 = 直达链接) */
  links: string[];
  /** 【为什么适合你】 */
  fit?: string;
  /** 【建议第一步】 */
  firstStep?: string;
  /** 【难度】 */
  difficulty?: string;
}

export interface OssOpportunityParseResult {
  opportunities: OssOpportunity[];
  /** 无法归入任何机会的残余文本(开场寒暄/检索时间与数据源说明等),不丢内容 */
  fallback: string | null;
}

type FieldKey = 'number' | 'project' | 'summary' | 'kind' | 'links' | 'fit' | 'firstStep' | 'difficulty';

/** 字段头:兼容简写变体,允许行尾追加说明;summary 必须先于 project 匹配(【项目简介】以「项目」开头) */
const FIELD_HEADERS: Array<[FieldKey, RegExp]> = [
  ['number', /^\s*【\s*机会\s*(\d+)\s*[^】]*】/],
  ['summary', /^\s*【\s*(?:项目简介|简介)\s*[^】]*】/],
  ['project', /^\s*【\s*项目\s*[^】]*】/],
  ['kind', /^\s*【\s*(?:机会类型|类型)\s*[^】]*】/],
  ['links', /^\s*【\s*(?:机会链接|Issue\s*链接|链接)\s*[^】]*】/],
  ['fit', /^\s*【\s*(?:为什么适合你|适合理由)\s*[^】]*】/],
  ['firstStep', /^\s*【\s*(?:建议第一步|第一步)\s*[^】]*】/],
  ['difficulty', /^\s*【\s*难度\s*[^】]*】/],
];

/** 条目分隔符:独占一行的 ---(允许 3 个以上连字符与前后空白),与其余解析器相同 */
const SEPARATOR = /^\s*-{3,}\s*$/;

/** URL 提取:排除中文引号/括号/字段头字符,剥掉尾随标点 */
const URL_RE = /https?:\/\/[^\s<>【】「」()\[\]]+/g;
const TRAILING_PUNCT = /[.,;:!?，。;:、]+$/;

const joinLines = (lines: string[]): string => lines.join('\n').trim();

function extractLinks(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of text.match(URL_RE) || []) {
    const url = raw.replace(TRAILING_PUNCT, '');
    if (!seen.has(url)) {
      seen.add(url);
      out.push(url);
    }
  }
  return out;
}

function matchFieldHeader(line: string): { key: FieldKey; number?: number } | null {
  for (const [key, re] of FIELD_HEADERS) {
    const m = line.match(re);
    if (m) return { key, number: m[1] ? Number(m[1]) : undefined };
  }
  return null;
}

/** 单块文本 → 机会;有效性 = 项目非空 且 至少一条链接 且 命中 ≥4 字段,否则 null */
function parseBlock(block: string): { opp: OssOpportunity | null; lead: string } {
  const lines = block.split('\n');
  const segments = new Map<FieldKey, string[]>();
  const leadLines: string[] = [];
  let current: FieldKey | null = null;
  let declaredNumber: number | undefined;

  for (const line of lines) {
    const header = matchFieldHeader(line);
    if (header) {
      current = header.key;
      if (header.number !== undefined) declaredNumber = header.number;
      if (!segments.has(header.key)) segments.set(header.key, []);
      continue;
    }
    if (current) {
      segments.get(current)!.push(line);
    } else {
      // 首个字段头之前的行是模型寒暄/引导语:块有效时归 fallback(不丢内容),块无效时随整块走
      leadLines.push(line);
    }
  }

  const project = joinLines(segments.get('project') || []);
  const links = extractLinks(joinLines(segments.get('links') || []));
  const summary = joinLines(segments.get('summary') || []);
  const kind = joinLines(segments.get('kind') || []);
  const fit = joinLines(segments.get('fit') || []);
  const firstStep = joinLines(segments.get('firstStep') || []);
  const difficulty = joinLines(segments.get('difficulty') || []);
  const hits = [
    Boolean(project),
    Boolean(summary),
    Boolean(kind),
    links.length > 0,
    Boolean(fit),
    Boolean(firstStep),
    Boolean(difficulty),
  ].filter(Boolean).length;
  const valid = Boolean(project) && links.length > 0 && hits >= 4;

  return {
    opp: valid
      ? {
          number: declaredNumber !== undefined && declaredNumber > 0 ? declaredNumber : 0, // 0 = 未声明,按顺序补
          project,
          links,
          ...(summary ? { summary } : {}),
          ...(kind ? { kind } : {}),
          ...(fit ? { fit } : {}),
          ...(firstStep ? { firstStep } : {}),
          ...(difficulty ? { difficulty } : {}),
        }
      : null,
    lead: leadLines.join('\n').trim(),
  };
}

/** 解析 Agent 的贡献机会清单;opportunities 为空 = 解析失败,调用方降级为普通 markdown 渲染 */
export function parseOssOpportunities(text: string): OssOpportunityParseResult {
  const source = typeof text === 'string' ? text.trim() : '';
  if (!source) return { opportunities: [], fallback: null };

  // 一个【字段头】都没有 → 必然不是机会清单,直接降级
  if (!source.includes('【')) return { opportunities: [], fallback: source };

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

  const opportunities: OssOpportunity[] = [];
  const fallbackParts: string[] = [];
  for (const block of blocks) {
    const { opp, lead } = parseBlock(block);
    if (opp) {
      if (opp.number < 1) opp.number = opportunities.length + 1; // 块内未声明(或非法)编号 → 按顺序补
      opportunities.push(opp);
      if (lead) fallbackParts.push(lead);
    } else {
      // 寒暄块/检索时间说明块/无效块:整块进 fallback(不丢内容)
      fallbackParts.push(block);
    }
  }

  return {
    opportunities,
    fallback: fallbackParts.length > 0 ? fallbackParts.join('\n\n') : null,
  };
}

/**
 * 单条机会 → 可粘贴文本(卡片「复制整条」):
 * 项目行 + 类型/难度 + 简介 + 链接 + 匹配点 + 第一步,空行分隔,移动端粘到笔记/聊天即用。
 */
export function buildOssOpportunityCopyText(opp: OssOpportunity): string {
  const parts: string[] = [opp.project];
  const meta = [opp.kind, opp.difficulty ? `难度:${opp.difficulty}` : ''].filter(Boolean).join(' · ');
  if (meta) parts.push(meta);
  if (opp.summary) parts.push(opp.summary);
  parts.push(opp.links.join('\n'));
  if (opp.fit) parts.push(`为什么适合我:${opp.fit}`);
  if (opp.firstStep) parts.push(`第一步:${opp.firstStep}`);
  return parts.join('\n\n');
}
