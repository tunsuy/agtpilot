/**
 * 公众号文章工坊 · skill 包清单(平移自 components/workshops/{registry,run}.ts)。
 */
import { Newspaper } from 'lucide-react';
import { buildWechatMpWorkshopPrompt } from './prompt';
import { str, num } from '../shared/params';
import type { WorkshopSkill } from '../types';

export const WORKSHOP_SKILL: WorkshopSkill = {
  meta: {
    id: 'wechat_mp',
    name: '公众号文章工坊',
    category: 'content',
    desc: 'Agent 选题成稿投草稿箱,你逐次审批放行,公众平台后台人工发布',
    icon: Newspaper,
    accent: 'violet',
    deps: [
      { id: 'newsnow', name: '全网热榜' },
      { id: 'zhihu', name: '知乎' },
      { id: 'twitterapi_io', name: 'X / Twitter' },
      { id: 'exa', name: '网络搜索' },
    ],
    note: 'Agent 产出标题候选/摘要/Markdown 正文/封面建议/发布建议。满意的一篇点「投草稿箱」——经你逐次审批后写入公众号草稿箱(每日有次数上限),最终发布由你在公众平台后台人工完成,Agent 不碰任何发布/群发接口。凭证(AppID:AppSecret,需已认证公众号 + IP 白名单)在连接器页「微信公众号(草稿箱直连)」卡片配置,表单内可查看状态并测试连接。',
    profileSlot: 'wechat_mp',
    artifacts: [{ kind: 'article-package', label: '公众号文章包' }],
  },
  run: (params, ctx) => {
    const style = str(params.style, '深度长文');
    return {
      prompt: buildWechatMpWorkshopPrompt({
        topic: str(params.topic),
        style,
        count: num(params.count),
        ...(params.theme ? { theme: str(params.theme) } : {}),
        ...(ctx?.scenarioProfile ? { profile: ctx.scenarioProfile } : {}),
      }),
      title: `公众号文章工坊 · ${style}`,
    };
  },
};
