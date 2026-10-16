/**
 * 知乎专栏内容工坊 · 模板上下文(正文见 prompt.main.md)
 *
 * 知乎没有官方写 API(developer.zhihu.com 开放平台只读;站内草稿接口有
 * x-zse-96 签名墙,不逆向)。分工:Agent 负责选题、撰写与整理文章包;
 * zhihu_save_article_draft 为 dangerLevel high(编排器审批门,存草稿前用户
 * 逐次确认),填进专栏编辑器后停在服务端自动保存的草稿 —— 发布永远由用户
 * 在知乎草稿箱人工完成,代码层面不存在发布调用。
 * 场景档案(ScenarioProfile)注入:长期人设优先级高于单次风格选择(scenario-loop §2)。
 */
import prompt from './prompt.main.md';
import { renderTemplate } from '../engine';
import { buildProfileSection, type ScenarioProfile } from '@/lib/scenario-profile';
import { TOPIC_RESEARCH_SOURCES } from '../shared/sources';
import { buildMaterialsSection, parseMaterials, type WorkshopMaterial } from '../shared/materials';

export const ZHIHU_ARTICLE_STYLES = ['专业干货', '深度分析', '热点解读', '经验分享'] as const;

/**
 * 主题方向预设(与公众号工坊同款三视角,知乎语境微调;chip 填入后 Agent 在该方向下挑具体新题)
 */
export const ZHIHU_TOPIC_PRESETS = [
  'AI 行业观察与判断',
  'AI 工具与开源项目实测',
  '工程实践与方法论',
] as const;

export interface ZhihuWorkshopInput {
  /** 用户指定主题;留空则由 Agent 调研热点选题 */
  topic?: string;
  /** 文章风格(ZHIHU_ARTICLE_STYLES 之一或自定义) */
  style: string;
  /** 产出篇数 1-3 */
  count: number;
  /** 场景档案;无档案或档案为空时不注入(prompt 与无档案时逐字节一致) */
  profile?: ScenarioProfile;
  /** 参考资料(会话交付物勾选);缺省/空时不拼接,prompt 与原来逐字节一致 */
  materials?: WorkshopMaterial[];
}

export function buildZhihuWorkshopPrompt({ topic, style, count, profile, materials }: ZhihuWorkshopInput): string {
  const t = (topic || '').trim();
  const n = Math.min(3, Math.max(1, Math.round(count) || 1));
  const profileSection = profile ? buildProfileSection(profile) : null;
  return (
    renderTemplate(prompt, {
      topic: t,
      style,
      count: n,
      profileSection: profileSection || '',
      sources: TOPIC_RESEARCH_SOURCES,
    }) + buildMaterialsSection(parseMaterials(materials))
  );
}
