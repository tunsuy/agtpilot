/**
 * 知乎专栏工坊 · skill 包清单(平移自 components/workshops/{registry,run}.ts)。
 */
import { PenLine } from 'lucide-react';
import { buildZhihuWorkshopPrompt, ZHIHU_ARTICLE_STYLES } from './context';
import {
  buildZhihuDraftReplyText,
  buildZhihuDraftPayload,
  buildZhihuDraftConfirm,
} from './draft';
import { str, num } from '../shared/params';
import { parseMaterials } from '../shared/materials';
import type { WorkshopSkill } from '../types';

export const WORKSHOP_SKILL: WorkshopSkill = {
  meta: {
    id: 'zhihu',
    name: '知乎专栏工坊',
    category: 'content',
    desc: 'Agent 选题成稿存进知乎草稿箱,你逐次审批放行,发布由你在知乎人工完成',
    icon: PenLine,
    accent: 'violet',
    searchGroup: 'research',
    deps: [
      { id: 'newsnow', name: '全网热榜' },
      { id: 'zhihu', name: '知乎官方 MCP' },
      { id: 'twitterapi_io', name: 'X / Twitter' },
      { id: 'exa', name: '网络搜索' },
    ],
    // 工具白名单 D 层(docs §9.1):托管存草稿固定工具;选题调研的热榜/搜索 MCP
    // 走缺省 full 档 + deps 自动映射
    activeTools: ['zhihu_save_article_draft'],
    note: 'Agent 产出标题候选/摘要/Markdown 正文/封面建议/发布建议(含话题)。满意的一篇点「存入知乎草稿」——经你逐次审批后填进知乎专栏编辑器并停在草稿箱(每日有次数上限,跨端可见),最终发布由你在知乎草稿箱人工完成,Agent 不碰任何发布动作。无需凭证:到连接器页「知乎」卡片扫码登录网页版并开启托管模式即可;知乎官方 MCP(搜索/热榜)可选配,用于选题调研。',
    profileSlot: 'zhihu',
    artifacts: [
      {
        kind: 'article-package',
        label: '知乎文章包',
        draft: {
          label: '存入知乎草稿(直连填入,发布由我在知乎人工完成)',
          build: buildZhihuDraftReplyText,
          direct: {
            platform: 'zhihu',
            buildPayload: buildZhihuDraftPayload,
            confirmText: buildZhihuDraftConfirm,
          },
          deliverTool: 'zhihu_save_article_draft',
          managedGate: 'zhihu',
          disabledHint:
            '想直接存进知乎草稿箱?到连接器页「知乎」卡片扫码登录并开启托管模式后,这里就会出现「存入知乎草稿」按钮;现在可以先「复制全文」手动粘贴。',
        },
      },
    ],
  },
  run: (params, ctx) => {
    const style = str(params.style, ZHIHU_ARTICLE_STYLES[0]);
    return {
      prompt: buildZhihuWorkshopPrompt({
        topic: str(params.topic),
        style,
        count: num(params.count),
        materials: parseMaterials(params.materials),
        ...(ctx?.scenarioProfile ? { profile: ctx.scenarioProfile } : {}),
      }),
      title: `知乎专栏工坊 · ${style}`,
    };
  },
};
