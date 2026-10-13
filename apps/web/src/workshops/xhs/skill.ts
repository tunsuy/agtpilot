/**
 * 小红书图文工坊 · skill 包清单(meta 从 components/workshops/registry.ts 平移,
 * run 分发体从 components/workshops/run.ts 平移;prompt 正文见 prompt.ts,
 * cron 每周选题场景的 buildXhsWeeklyTopicsPrompt 也在其中,cron-scenario 直接引用)。
 */
import { Share2 } from 'lucide-react';
import { buildXhsWorkshopPrompt } from './context';
import { str, num } from '../shared/params';
import type { WorkshopSkill } from '../types';

export const WORKSHOP_SKILL: WorkshopSkill = {
  meta: {
    id: 'xhs',
    name: '小红书图文工坊',
    category: 'content',
    desc: 'Agent 选题写文案配标签,你在手机 App 人工确认发布(合规半自动)',
    icon: Share2,
    accent: 'violet',
    deps: [
      { id: 'newsnow', name: '全网热榜' },
      { id: 'zhihu', name: '知乎' },
      { id: 'twitterapi_io', name: 'X / Twitter' },
      { id: 'exa', name: '网络搜索' },
    ],
    note: 'Agent 产出标题/正文/标签/配图建议。复制满意的一篇 → 连接器页小红书「真机唤起」→ 手机 App 粘贴、人工核对后发布。已连接热榜/搜索类连接器时选题走实时热点。',
    profileSlot: 'xhs',
    artifacts: [{ kind: 'note-package', label: '小红书笔记包' }],
  },
  run: (params, ctx) => {
    const style = str(params.style, '种草推荐');
    return {
      prompt: buildXhsWorkshopPrompt({
        topic: str(params.topic),
        style,
        count: num(params.count),
        ...(ctx?.scenarioProfile ? { profile: ctx.scenarioProfile } : {}),
      }),
      title: `小红书内容工坊 · ${style}`,
    };
  },
};
