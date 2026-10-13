/**
 * 微博图文工坊 · skill 包清单(平移自 components/workshops/{registry,run}.ts)。
 */
import { MessagesSquare } from 'lucide-react';
import { buildWeiboWorkshopPrompt } from './context';
import { str, num } from '../shared/params';
import type { WorkshopSkill } from '../types';

export const WORKSHOP_SKILL: WorkshopSkill = {
  meta: {
    id: 'weibo',
    name: '微博图文工坊',
    category: 'content',
    desc: '热点点评/干货/种草,Agent 创作你发布,前两行自带钩子',
    icon: MessagesSquare,
    accent: 'violet',
    deps: [
      { id: 'newsnow', name: '全网热榜' },
      { id: 'zhihu', name: '知乎' },
      { id: 'twitterapi_io', name: 'X / Twitter' },
      { id: 'exa', name: '网络搜索' },
    ],
    note: 'Agent 产出正文/话题标签/配图建议。复制满意的一条 → 表单底部「唤起微博」→ 手机 App 粘贴、人工核对后发布。已连接热榜/搜索类连接器时选题走实时热点。',
  },
  run: (params) => {
    const style = str(params.style, '热点点评');
    return {
      prompt: buildWeiboWorkshopPrompt({
        topic: str(params.topic),
        style,
        count: num(params.count),
      }),
      title: `微博内容工坊 · ${style}`,
    };
  },
};
