/**
 * 小红书内容工坊 · 模板上下文(正文见 prompt.main.md / prompt.xhs_weekly_topics.md)
 *
 * 分工:Agent 只做选题调研与内容生产;发布动作始终由用户在手机 App 内人工完成
 * (平台 2026-03 起严打「AI 托管代发」账号,辅助创作+人工发布是明确允许的形态)。
 * 选题数据源(scenario-loop P1):已登录时优先 xhs_read_creator_data 读真实热门话题/站内搜索,
 * 其余情况按 shared/sources.ts 的检索梯度(NewsNow 全网热榜/知乎/X/网页搜索)降级取材。
 * 场景档案(ScenarioProfile)注入:长期人设优先级高于单次风格选择(scenario-loop §2)。
 */
import promptMain from './prompt.main.md';
import promptWeekly from './prompt.xhs_weekly_topics.md';
import { buildMaterialsSection, parseMaterials, type WorkshopMaterial } from '../shared/materials';
import { renderTemplate } from '../engine';
import { buildProfileSection, type ScenarioProfile } from '@/lib/scenario-profile';
import { TOPIC_RESEARCH_SOURCES } from '../shared/sources';

export const XHS_WORKSHOP_STYLES = ['种草推荐', '干货教程', '测评对比', '生活分享'] as const;

export interface XhsWorkshopInput {
  /** 用户指定主题;留空则由 Agent 调研热点选题 */
  topic?: string;
  /** 笔记类型(XHS_WORKSHOP_STYLES 之一或自定义) */
  style: string;
  /** 产出篇数 1-3 */
  count: number;
  /** 场景档案;无档案或档案为空时不注入(prompt 与无档案时逐字节一致) */
  profile?: ScenarioProfile;
  /** 参考资料(会话交付物勾选);缺省/空时不拼接,prompt 与原来逐字节一致 */
  materials?: WorkshopMaterial[];
}

export function buildXhsWorkshopPrompt({ topic, style, count, profile, materials }: XhsWorkshopInput): string {
  const t = (topic || '').trim();
  const n = Math.min(3, Math.max(1, Math.round(count) || 1));
  const profileSection = profile ? buildProfileSection(profile) : null;
  return (
    renderTemplate(promptMain, {
      topic: t,
      style,
      count: n,
      profileSection: profileSection || '',
      sources: TOPIC_RESEARCH_SOURCES,
    }) + buildMaterialsSection(parseMaterials(materials))
  );
}

export interface XhsWeeklyTopicsInput {
  /** 选题条数 3-10,缺省 7 */
  count?: number;
  /** 场景档案;触发时现读 —— 选题始终贴着最新档案,不用建订阅时的过期快照 */
  profile?: ScenarioProfile;
}

/**
 * 小红书每周选题 · 订阅节奏 prompt(scenario-loop P2 模块 3)。
 *
 * 由 cron 定时触发(scenario.key = xhs_weekly_topics),服务端触发时用最新档案重建。
 * 产出是「选题清单」交付物而非成稿 —— 用户勾选后周中用工坊成稿,判断权在她。
 * 红线:本任务只读(严禁发布/写操作类浏览器工具),绝不进审批态 ——
 * 「待审」语义 = DONE mission + 交付物,完成推送走现成 DONE 分支。
 */
export function buildXhsWeeklyTopicsPrompt({ count, profile }: XhsWeeklyTopicsInput): string {
  const n = Math.min(10, Math.max(3, Math.round(count ?? 7) || 7));
  const profileSection = profile ? buildProfileSection(profile) : null;
  return renderTemplate(promptWeekly, {
    count: n,
    profileSection: profileSection || '',
    insights: Boolean(profile?.insights?.length),
    noProfileNote: profile ? '' : '(无档案时选通用高共鸣方向)',
    sources: TOPIC_RESEARCH_SOURCES,
  });
}
