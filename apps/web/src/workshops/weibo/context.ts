/**
 * 微博图文工坊 · 模板上下文(正文见 prompt.main.md)
 *
 * 与小红书工坊(xhs 包)同一分工:Agent 只做选题调研与内容生产;
 * 发布动作始终由用户在手机 App 内人工完成(「真机唤起」→ 粘贴 → 人工核对发布)。
 * 平台无对个人开放的自动发布 API,任何「自动代发」都违反平台规则,严禁实现。
 * 选题数据源统一走 shared/sources 的检索梯度(NewsNow 全网热榜/知乎/X/网页搜索),
 * 微博工坊额外点名 NewsNow 的「微博实时热搜」;最后模型自身知识兜底。
 */

import prompt from './prompt.main.md';
import { renderTemplate } from '../engine';
import { TOPIC_RESEARCH_SOURCES } from '../shared/sources';
import { buildMaterialsSection, parseMaterials, type WorkshopMaterial } from '../shared/materials';

// ---------- 微博 ----------

export const WEIBO_WORKSHOP_STYLES = ['热点点评', '干货分享', '生活随记', '种草安利'] as const;

export interface WeiboWorkshopInput {
  /** 用户指定主题;留空则勾选了参考资料时以资料为素材编写,否则由 Agent 调研热点选题 */
  topic?: string;
  /** 微博类型(WEIBO_WORKSHOP_STYLES 之一或自定义) */
  style: string;
  /** 产出条数 1-3 */
  count: number;
  /** 参考资料(会话交付物勾选);缺省/空时不拼接,prompt 与原来逐字节一致 */
  materials?: WorkshopMaterial[];
}

export function buildWeiboWorkshopPrompt({ topic, style, count, materials }: WeiboWorkshopInput): string {
  const t = (topic || '').trim();
  const n = Math.min(3, Math.max(1, Math.round(count) || 1));
  const mats = parseMaterials(materials);
  return (
    renderTemplate(prompt, {
      topic: t,
      style,
      count: n,
      sources: TOPIC_RESEARCH_SOURCES,
      // 空主题互斥分支(引擎不支持嵌套 if,布尔在这里预计算):
      // 勾了交付物 → 以资料为素材直接编写;未勾 → 调研热点选题
      materialMode: !t && mats.length > 0,
      hotResearchMode: !t && mats.length === 0,
    }) + buildMaterialsSection(mats)
  );
}
