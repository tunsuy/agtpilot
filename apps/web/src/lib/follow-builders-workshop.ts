/**
 * AI Builders 日报工坊 · Prompt 构建器
 *
 * 数据来自 follow-builders 开源项目(MIT)的中央 feed(上游 GitHub Action 日更):
 * AI builder 的 X 动态(上游仅存 24h)、AI 播客新集转写(14 天)、
 * Anthropic/Claude 官方博客(72h)。Agent 用只读工具
 * follow_builders_fetch_feed 拉素材,按本 prompt 的日报规范改写成
 * 指定语言的日报 —— 只总结、不发布、每条带原文链接(格式即契约,
 * 与其余工坊同款:纯函数构建,便于测试锚定)。
 */

export const FB_LANGUAGES = ['中文', '英文', '中英混合'] as const;

export const FB_RANGES = [
  { id: '24h', name: '最近 24 小时', hours: 24 },
  { id: '72h', name: '最近 3 天', hours: 72 },
  { id: '7d', name: '最近 7 天', hours: 168 },
] as const;

export const FB_CATEGORIES = [
  { id: 'x', name: 'X 动态' },
  { id: 'podcasts', name: '播客' },
  { id: 'blogs', name: '官方博客' },
] as const;

export interface FollowBuildersInput {
  /** 输出语言(FB_LANGUAGES 之一,默认中文) */
  language?: string;
  /** 时间范围 id(FB_RANGES,默认 24h) */
  range?: string;
  /** 类别 id 子集(FB_CATEGORIES,默认全部) */
  categories?: string[];
}

export function buildFollowBuildersPrompt(input: FollowBuildersInput = {}): string {
  const language = FB_LANGUAGES.includes(input.language as any)
    ? (input.language as string)
    : '中文';
  const range = FB_RANGES.find((r) => r.id === input.range) || FB_RANGES[0];
  const cats = (input.categories?.length ? input.categories : FB_CATEGORIES.map((c) => c.id))
    .map((id) => FB_CATEGORIES.find((c) => c.id === id))
    .filter(Boolean) as Array<{ id: string; name: string }>;
  const catIds = cats.map((c) => c.id);
  const catNames = cats.map((c) => c.name).join(' + ');

  // 分节规范按所选类别输出,不请求的类别不占 prompt
  const sectionSpecs: string[] = [];
  if (catIds.includes('x')) {
    sectionSpecs.push(
      '   - 「X 动态」:同一人/同一话题的多条推文合并成一个条目;每条 = 一句话摘要 + @handle + 原文链接;按信息价值排序,最多 10 条,次要的可归入一行「其他动态」简列'
    );
  }
  if (catIds.includes('podcasts')) {
    sectionSpecs.push(
      '   - 「播客」:每集 = 标题 + 3-5 条核心观点(每条一句话)+ 链接;转写被截断时只总结已有部分,不要猜测后续内容'
    );
  }
  if (catIds.includes('blogs')) {
    sectionSpecs.push('   - 「官方博客」:每篇 = 标题 + 2-3 句摘要 + 链接');
  }

  return `【AI Builders 日报】
生成一份「${range.name}」的 AI builders 日报,输出语言:${language}。

第一步(必须):调用 follow_builders_fetch_feed 工具拉取素材,参数 rangeHours=${range.hours}、categories=${JSON.stringify(catIds)}。该工具只读、返回已按时间窗过滤的 X 动态 / 播客转写摘录 / 官方博客内容,以及各 feed 的生成时间与新鲜度标记。

覆盖范围如实标注:X 动态上游只保留最近 24 小时${range.hours > 24 ? `(即使本次选了「${range.name}」,X 部分也只有 24h 的量,须在日报中注明)` : ''};播客覆盖最近 14 天;博客覆盖最近 72 小时。

第二步:把素材改写成日报,结构与要求:
1. 开头两句话总览:今天最值得注意的 1-2 件事 + 一句整体趋势感受(注明是你的判断)
2. 按类别分节输出(本次类别:${catNames}):
${sectionSpecs.join('\n')}
3. 结尾一行:数据时间(用工具返回的 generatedAt)与覆盖范围说明

硬性红线:
- 只使用工具返回的真实内容,不得编造推文、观点、数据或链接;每条信息必须附素材里的原文 url
- 工具返回 staleWarning 时,必须在日报开头用一行明确提示「⚠️ 数据可能过期(上游 feed 超 48 小时未更新)」;X 类别过期可按工具提示降级用 X 连接器/网页搜索自取,并注明数据来源已降级
- 工具返回 success=false 时,按错误信息里的降级路径执行;完全拿不到数据就如实告知,不要凭记忆编一份日报
- 翻译改写保持技术术语原意(产品名/模型名/人名保留原文);观点归属写清楚是谁说的
- 日报只展示给用户,不做任何发布动作,不调用任何发布类接口`;
}
