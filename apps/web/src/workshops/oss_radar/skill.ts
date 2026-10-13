/**
 * 开源贡献雷达工坊 · skill 包清单(平移自 components/workshops/{registry,run}.ts)。
 * 注意标题钳制(3-10)与正文钳制(3-7)不对称——保留旧语义,勿「顺手统一」。
 */
import { Radar } from 'lucide-react';
import {
  buildOssRadarPrompt,
  OSS_INTERESTS,
  OSS_CONTRIB_KINDS,
} from './context';
import { str, num } from '../shared/params';
import type { WorkshopSkill, CronScenarioSpec } from '../types';

/** cron 雷达周扫场景 key(注册表汇入 CRON_SCENARIOS,派生 CronScenarioKey union) */
export const CRON_KEY = 'oss_radar_weekly' as const;

/** cron 雷达周扫场景:技术栈/排除项来自贡献者档案;关注方向与机会类型不在 cron 标记里存快照,触发时不限(档案优先) */
export const CRON: CronScenarioSpec = {
  key: CRON_KEY,
  profileSlot: 'oss_radar',
  countMin: 3,
  countMax: 10,
  defaultCount: 5,
  build: (count, profile) => buildOssRadarPrompt({ count, profile }),
};

export const WORKSHOP_SKILL: WorkshopSkill = {
  meta: {
    id: 'oss_radar',
    name: '开源贡献雷达',
    category: 'dev',
    desc: 'Agent 扫描 AI 领域活跃开源项目,按你的技术栈筛出可上手贡献机会,每条带 Issue 直达链接',
    icon: Radar,
    accent: 'sky',
    deps: [
      { id: 'github_mcp', name: 'GitHub' },
      { id: 'deepwiki', name: 'DeepWiki' },
      { id: 'exa', name: '网络搜索' },
    ],
    note: '生成后跳转任务页,Agent 用 GitHub MCP 搜活跃仓库与 good first issue、DeepWiki 理解代码库、网页搜索补充社区动态(缺哪个自动降级并注明),产出结构化「贡献机会」卡片:项目/机会类型/Issue 直达链接/为什么适合你/建议第一步/难度。全程只读:不 fork、不建 Issue、不评论;链接必须来自真实检索并在清单末尾注明检索时间与数据源。想贡献哪条:链接直达 Issue 人工核对,或让 Agent 起草认领留言/PR 描述——对外发送前逐条经你审批,代码由你本地动手。',
    profileSlot: 'oss_radar',
  },
  run: (params, ctx) => {
    const count = num(params.count, 5);
    const validIds = (v: unknown, allowed: readonly string[]) =>
      Array.isArray(v)
        ? (v as unknown[]).filter((x): x is string => typeof x === 'string' && allowed.includes(x))
        : [];
    return {
      prompt: buildOssRadarPrompt({
        stack: str(params.stack),
        interests: validIds(params.interests, OSS_INTERESTS.map((i) => i.id)),
        kinds: validIds(params.kinds, OSS_CONTRIB_KINDS.map((k) => k.id)),
        count,
        ...(ctx?.scenarioProfile ? { profile: ctx.scenarioProfile } : {}),
      }),
      title: `开源贡献雷达 · ${Math.min(7, Math.max(3, count))} 条机会`,
    };
  },
  cron: CRON,
};
