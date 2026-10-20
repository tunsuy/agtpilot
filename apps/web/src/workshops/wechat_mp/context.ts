/**
 * 微信公众号内容工坊 · 模板上下文(正文见 prompt.main.md)
 *
 * 分工:Agent 负责选题、撰写与排版投草稿;wechat_mp_create_draft 升 dangerLevel high
 * (编排器审批门,投递前用户逐次确认);最终发布永远由用户在公众平台后台人工完成
 * —— 代码层面不存在 freepublish 调用,群发/发布接口是合规红线。
 * 场景档案(ScenarioProfile)注入:长期人设优先级高于单次风格选择(scenario-loop §2)。
 */
import prompt from './prompt.main.md';
import { renderTemplate } from '../engine';
import { buildProfileSection, type ScenarioProfile } from '@/lib/scenario-profile';
import { WECHAT_MD_THEMES, DEFAULT_WECHAT_MD_THEME_ID } from '@/lib/wechat-md-themes';
import { TOPIC_RESEARCH_SOURCES } from '../shared/sources';
import { buildMaterialsSection, parseMaterials, type WorkshopMaterial } from '../shared/materials';

export const WECHAT_MP_ARTICLE_STYLES = ['深度长文', '干货教程', '热点解读', '观点评论'] as const;

/** 排版主题选项(供表单 chip 与 prompt 共用;id 透传 wechat_mp_create_draft 的 theme 参数) */
export const WECHAT_MP_THEME_OPTIONS = WECHAT_MD_THEMES.map((t) => ({ id: t.id, name: t.name }));

/**
 * 主题方向预设(2026-10-10 与负责人定:先 AI 垂类,「看行业/追新/上手」三视角不重样)。
 * 弹窗里点 chip 填入主题,Agent 在该方向下每次挑具体新题;常量增删改即可调整,
 * 后续可升级为从场景档案自配。
 */
export const WECHAT_MP_TOPIC_PRESETS = [
  'AI 行业观察与判断',
  'AI 最新产品介绍',
  'AI 工具与开源项目介绍',
] as const;

export interface WechatMpWorkshopInput {
  /** 用户指定主题;留空则由 Agent 调研热点选题 */
  topic?: string;
  /** 文章风格(WECHAT_MP_ARTICLE_STYLES 之一或自定义) */
  style: string;
  /** 产出篇数 1-3 */
  count: number;
  /** 排版主题 id(wechat-md-themes);缺省默认主题 */
  theme?: string;
  /** 场景档案;无档案或档案为空时不注入(prompt 与无档案时逐字节一致) */
  profile?: ScenarioProfile;
  /** 参考资料(会话交付物勾选);缺省/空时不拼接,prompt 与原来逐字节一致 */
  materials?: WorkshopMaterial[];
}

export function buildWechatMpWorkshopPrompt({ topic, style, count, theme, profile, materials }: WechatMpWorkshopInput): string {
  const t = (topic || '').trim();
  const n = Math.min(3, Math.max(1, Math.round(count) || 1));
  const profileSection = profile ? buildProfileSection(profile) : null;
  const themeId = WECHAT_MD_THEMES.some((x) => x.id === (theme || '').trim()) ? (theme || '').trim() : DEFAULT_WECHAT_MD_THEME_ID;
  const mats = parseMaterials(materials);
  return (
    renderTemplate(prompt, {
      topic: t,
      style,
      count: n,
      theme: themeId,
      profileSection: profileSection || '',
      sources: TOPIC_RESEARCH_SOURCES,
      // 空主题互斥分支(引擎不支持嵌套 if,布尔在这里预计算):
      // 勾了交付物 → 以资料为素材直接编写;未勾 → 调研热点选题
      materialMode: !t && mats.length > 0,
      hotResearchMode: !t && mats.length === 0,
    }) + buildMaterialsSection(mats)
  );
}
