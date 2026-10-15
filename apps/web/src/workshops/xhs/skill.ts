/**
 * 小红书图文工坊 · skill 包清单(meta 从 components/workshops/registry.ts 平移,
 * run 分发体从 components/workshops/run.ts 平移;prompt 正文见 context.ts + .md 模板,
 * cron 每周选题场景在本包声明(CRON),cron-scenario 经注册表分发,不再直接引用)。
 */
import { Share2 } from 'lucide-react';
import { buildXhsWorkshopPrompt, buildXhsWeeklyTopicsPrompt } from './context';
import { buildXhsDraftReplyText } from './draft';
import { str, num } from '../shared/params';
import type { WorkshopSkill, CronScenarioSpec } from '../types';

/** cron 每周选题场景 key(注册表汇入 CRON_SCENARIOS,派生 CronScenarioKey union) */
export const CRON_KEY = 'xhs_weekly_topics' as const;

/** cron 每周选题场景:触发时按 xhs 槽位当前档案重建(缺省 7 条,3-10 钳制) */
export const CRON: CronScenarioSpec = {
  key: CRON_KEY,
  profileSlot: 'xhs',
  countMin: 3,
  countMax: 10,
  defaultCount: 7,
  build: (count, profile) => buildXhsWeeklyTopicsPrompt({ count, profile }),
  workshopId: 'xhs',
};

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
    artifacts: [
      {
        kind: 'note-package',
        label: '小红书笔记包',
        draft: {
          label: '存入草稿箱(经我审批后写入,发布由我在小红书 App 完成)',
          build: buildXhsDraftReplyText,
          deliverTool: 'xhs_save_note_draft',
          managedGate: 'xhs',
          disabledHint:
            '想直接存进小红书草稿箱?到连接器页「小红书创作者服务」开启托管写操作(需已扫码登录),这里就会出现一键存草稿按钮。',
        },
      },
    ],
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
  cron: CRON,
};
