/**
 * 小红书每周选题解析器(docs/design/workshop-scenario-loop.md §4.1,scenario-loop P1)。
 *
 * 「格式即契约」:buildXhsWeeklyTopicsPrompt 约定 Agent 按【选题 N】+ 六字段头 + `---` 分隔
 * 输出选题清单,本模块把该 markdown 解析回结构化;解析失败(picks 为空)时调用方降级为
 * 普通 markdown 渲染。纯函数,无 React/浏览器依赖,便于以固定样例做契约测试。
 *
 * 与 note-package.ts 的字段头不相交(选题头 vs 笔记包头),两种格式不会互相误判。
 */

export const MAX_TOPIC_PICKS = 3;

export interface TopicPick {
  /** 【选题 N】的 N;块内缺失时按出现顺序 1..n 递补 */
  number: number;
  /** 【选题方向】 */
  direction: string;
  /** 【标题钩子】行(已去掉序号前缀) */
  hooks: string[];
  /** 【切入角度】 */
  angle?: string;
  /** 【依据】 */
  basis?: string;
  /** 【配图建议】 */
  imageIdea?: string;
  /** 【建议发布日】 */
  publishDay?: string;
}

export interface TopicPickParseResult {
  picks: TopicPick[];
  /** 无法归入任何选题的残余文本(开场寒暄/结尾总评等),不丢内容 */
  fallback: string | null;
}

type FieldKey = 'number' | 'direction' | 'hooks' | 'angle' | 'basis' | 'imageIdea' | 'publishDay';

/** 字段头:【选题 N】/【选题方向】/【标题钩子】…,兼容简写变体,允许行尾追加说明 */
const FIELD_HEADERS: Array<[FieldKey, RegExp]> = [
  ['number', /^\s*【\s*选题\s*(\d+)\s*[^】]*】/],
  ['direction', /^\s*【\s*(?:选题方向|方向)\s*[^】]*】/],
  ['hooks', /^\s*【\s*(?:标题钩子|标题)\s*[^】]*】/],
  ['angle', /^\s*【\s*切入角度\s*[^】]*】/],
  ['basis', /^\s*【\s*依据\s*[^】]*】/],
  ['imageIdea', /^\s*【\s*(?:配图建议|配图)\s*[^】]*】/],
  ['publishDay', /^\s*【\s*(?:建议发布日|发布日)\s*[^】]*】/],
];

/** 条目分隔符:独占一行的 ---(允许 3 个以上连字符与前后空白),与 note-package 相同 */
const SEPARATOR = /^\s*-{3,}\s*$/;

/** 标题钩子的序号前缀(「1. xxx」「- xxx」等) */
const HOOK_PREFIX = /^\s*(?:\d+\s*[.、)．]\s*|[-*·]\s*)?/;

const joinLines = (lines: string[]): string => lines.join('\n').trim();

function matchFieldHeader(line: string): { key: FieldKey; number?: number } | null {
  for (const [key, re] of FIELD_HEADERS) {
    const m = line.match(re);
    if (m) return { key, number: m[1] ? Number(m[1]) : undefined };
  }
  return null;
}

/** 单块文本 → 选题;不满足有效性(direction 非空 且命中 ≥3 字段)返回 null */
function parseBlock(block: string): { pick: TopicPick | null; lead: string } {
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

  const direction = joinLines(segments.get('direction') || []);
  const hooks = (segments.get('hooks') || [])
    .map((l) => l.replace(HOOK_PREFIX, '').trim())
    .filter(Boolean);
  const hits = [
    Boolean(direction),
    hooks.length > 0,
    segments.has('angle'),
    segments.has('basis'),
    segments.has('imageIdea'),
    segments.has('publishDay'),
  ].filter(Boolean).length;
  const valid = Boolean(direction) && hits >= 3;

  return {
    pick: valid
      ? {
          number: declaredNumber !== undefined && declaredNumber > 0 ? declaredNumber : 0, // 0 = 未声明,由 parseTopicPicks 按顺序补
          direction,
          hooks,
          ...(joinLines(segments.get('angle') || []) ? { angle: joinLines(segments.get('angle') || []) } : {}),
          ...(joinLines(segments.get('basis') || []) ? { basis: joinLines(segments.get('basis') || []) } : {}),
          ...(joinLines(segments.get('imageIdea') || [])
            ? { imageIdea: joinLines(segments.get('imageIdea') || []) }
            : {}),
          ...(joinLines(segments.get('publishDay') || [])
            ? { publishDay: joinLines(segments.get('publishDay') || []) }
            : {}),
        }
      : null,
    lead: leadLines.join('\n').trim(),
  };
}

/** 解析 Agent 的选题清单输出;picks 为空 = 解析失败,调用方降级为普通 markdown 渲染 */
export function parseTopicPicks(text: string): TopicPickParseResult {
  const source = typeof text === 'string' ? text.trim() : '';
  if (!source) return { picks: [], fallback: null };

  // 一个【字段头】都没有 → 必然不是选题清单,直接降级
  if (!source.includes('【')) return { picks: [], fallback: source };

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

  const picks: TopicPick[] = [];
  const fallbackParts: string[] = [];
  for (const block of blocks) {
    const { pick, lead } = parseBlock(block);
    if (pick) {
      if (pick.number < 1) pick.number = picks.length + 1; // 块内未声明(或非法)编号 → 按顺序补
      picks.push(pick);
      if (lead) fallbackParts.push(lead);
    } else {
      // 总评块/无效块:字段数不足,整块进 fallback(不丢内容)
      fallbackParts.push(block);
    }
  }

  return {
    picks,
    fallback: fallbackParts.length > 0 ? fallbackParts.join('\n\n') : null,
  };
}

/**
 * 勾选成稿的续聊回复文本(格式即契约,可被 parseNotePackages 渲染续答)。
 *
 * 关键设计:每周选题任务的会话历史里没有笔记包字段规格,所以这里把规格内嵌进回复,
 * 续答(同一 mission 的 assistant 消息)才能按【标题候选】… 字段头输出、被渲染成笔记卡。
 * 同时逐字引用勾选原文(方向+钩子),即使上下文丢失也能独立成稿。
 */
export function buildTopicPickReplyText(selected: TopicPick[]): string {
  const picks = selected.slice(0, MAX_TOPIC_PICKS);
  const quoted = picks
    .map((p) => {
      const hooks = p.hooks.map((h) => `「${h}」`).join('');
      return `第 ${p.number} 条:选题方向「${p.direction}」;标题钩子:${hooks}`;
    })
    .join('\n');
  const numbers = picks.map((p) => `第 ${p.number} 条`).join('、');

  return `请把我勾选的${numbers}选题写成完整笔记包(共 ${picks.length} 篇)。延续本任务的账号档案、创作红线与只读边界,不要调用任何写操作类工具。
每篇严格按以下字段顺序与字段头输出(字段头用【】,必须独占一行;除以下字段外不要输出寒暄或多余段落):
【标题候选】
5 个备选,每行一个,口语化、有钩子、不超过 20 字
【封面文案】
封面主文案一句话(12 字以内优先)
【正文】
300-600 字,小红书风格:第一人称、短段落、适度 emoji、有真实信息增量,结尾带互动提问
【标签】
8-10 个,以 # 开头,空格分隔,单行
【发布建议】
建议发布时段 + 一句理由

篇与篇之间用单独一行的 --- 分隔(三个连字符,行内无其他字符)。

我勾选的选题(原文):
${quoted}`;
}
