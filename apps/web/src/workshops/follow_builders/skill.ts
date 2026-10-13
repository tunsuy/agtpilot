/**
 * AI Builders 日报工坊 · skill 包清单(平移自 components/workshops/{registry,run}.ts)。
 */
import { Rss } from 'lucide-react';
import { buildFollowBuildersPrompt, FB_RANGES, FB_LANGUAGES, FB_CATEGORIES } from './context';
import { str } from '../shared/params';
import type { WorkshopSkill } from '../types';

export const WORKSHOP_SKILL: WorkshopSkill = {
  meta: {
    id: 'follow_builders',
    name: 'AI Builders 日报',
    category: 'office',
    desc: '聚合 AI builder 的 X 动态 / 播客 / 官方博客,一键出日报,每条带原文链接',
    icon: Rss,
    accent: 'sky',
    deps: [
      { id: 'twitterapi_io', name: 'X / Twitter' },
      { id: 'exa', name: '网络搜索' },
    ],
    note: '数据来自 follow-builders 开源项目(MIT)的公共中央 feed,上游每日用 X 官方 API + 播客转写 + 博客抓取更新,读取无需任何凭证。Agent 用只读工具拉取素材后按你选的语言/时间范围/类别改写成日报:同一人多条动态合并、每条带原文链接、结尾注明数据时间;上游超 48 小时未更新会在日报开头明示数据可能过期,并可降级到已连接的 X 连接器/网页搜索自取(注明降级)。全程只读、无任何发布动作。',
  },
  run: (params) => {
    const range = str(params.range, FB_RANGES[0].id);
    const language = str(params.language, FB_LANGUAGES[0]);
    return {
      prompt: buildFollowBuildersPrompt({
        language,
        range,
        ...(Array.isArray(params.categories) && params.categories.length > 0
          ? {
              categories: (params.categories as unknown[]).filter(
                (c): c is string =>
                  typeof c === 'string' && FB_CATEGORIES.some((fc) => fc.id === c)
              ),
            }
          : {}),
      }),
      title: `AI Builders 日报 · ${FB_RANGES.find((r) => r.id === range)?.name || '最近 24 小时'}`,
    };
  },
};
