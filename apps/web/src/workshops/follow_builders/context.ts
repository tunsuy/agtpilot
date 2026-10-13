/**
 * AI Builders 日报工坊 · 模板上下文(正文见 prompt.main.md)
 *
 * 数据来自 follow-builders 开源项目(MIT)的中央 feed(上游 GitHub Action 日更):
 * AI builder 的 X 动态(上游仅存 24h)、AI 播客新集转写(14 天)、
 * Anthropic/Claude 官方博客(72h)。Agent 用只读工具
 * follow_builders_fetch_feed 拉素材,按模板的日报规范改写成
 * 指定语言的日报 —— 只总结、不发布、每条带原文链接。
 *
 * 分节规范(sectionSpecs)是按所选类别拼装的动态列表:类别全空时
 * 输出保留一个空行(与旧构建器 join('') 行为逐字节一致),所以走变量
 * 注入而不是模板 {{#if}}——行级消隐会把这行吃掉。
 */

import prompt from './prompt.main.md';
import { renderTemplate } from '../engine';

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

  return renderTemplate(prompt, {
    language,
    rangeName: range.name,
    rangeHours: range.hours,
    rangeNote:
      range.hours > 24
        ? `(即使本次选了「${range.name}」,X 部分也只有 24h 的量,须在日报中注明)`
        : '',
    catNames,
    categoriesJson: JSON.stringify(catIds),
    sectionSpecs: sectionSpecs.join('\n'),
  });
}
