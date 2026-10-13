/**
 * PPT 演示稿工坊 · 模板上下文(正文见 prompt.options.md / prompt.main.md / prompt.pptx.md)
 *
 * 与办公工坊(weekly/email_triage 包)同一模式:UI 收集结构化选项 → 生成 Prompt →
 * 作为新任务交给 Agent 执行。产出双路线(方案见 docs/design/univer-office-integration-plan.md §4):
 * - bento(网页演示页):镜像预装 qiaomu-bento-ppt skill(MIT,纯 Python 标准库),
 *   Agent 经 sandbox_run_command/sandbox_write_file 构建单文件 .bento.html,
 *   再用 ppt_publish_deck 工具(ppt-deck.ts)服务端读文件挂上中央画布 —— 严禁让模型
 *   把 ~600KB 的 HTML 壳回显进 artifact_render content(撑爆上下文);
 * - pptx(S2,ppt-master 路线):镜像预装 ppt-master skill(MIT)+ 独立 venv,
 *   Agent 按 Quick Generate profile(全程无交互)手写 SVG → 质检 → 导出原生
 *   可编辑 .pptx,用 ppt_publish_pptx 收进服务端文件库(type=file,前端下载卡片)。
 *
 * 模板拆分:选项/材料段两路线共用(prompt.options.md 单源);两条路线各自一个模板
 * 文件,「内容红线」段在两文件中重复出现 —— 改动时两处同步(golden 快照锁双路线)。
 * 红线:数据不编造、图表注来源、大纲先行再排版、无外链媒体(离线单文件承诺)。
 */
import optionsTpl from './prompt.options.md';
import bentoTpl from './prompt.main.md';
import pptxTpl from './prompt.pptx.md';
import { renderTemplate } from '../engine';
import {
  bentoSkillDir,
  pptMasterSkillDir,
  PPT_MASTER_PYTHON,
  BENTO_SKILL_DIR,
  PPT_MASTER_SKILL_DIR,
} from './paths';

export { bentoSkillDir, pptMasterSkillDir, PPT_MASTER_PYTHON, BENTO_SKILL_DIR, PPT_MASTER_SKILL_DIR };

export const PPT_PURPOSES = [
  { id: 'report', name: '汇报提案' },
  { id: 'launch', name: '产品发布' },
  { id: 'training', name: '培训课件' },
  { id: 'data', name: '数据报告' },
] as const;

export const PPT_STYLES = [
  { id: 'business', name: '商务' },
  { id: 'minimal', name: '简约' },
  { id: 'dark', name: '深色' },
] as const;

export const PPT_PAGE_OPTIONS = [8, 12, 20] as const;

/** 输出形态:bento 网页演示页 / pptx 真文件(ppt-master,S2 已接入) */
export const PPT_OUTPUTS = [
  { id: 'bento', name: '网页演示页', hint: 'bento 单文件 HTML,画布直接放映,可下载离线编辑' },
  { id: 'pptx', name: 'PPTX 文件', hint: 'ppt-master 导出原生可编辑 .pptx,Office/WPS 可直接二改' },
] as const;

export type PptPurpose = (typeof PPT_PURPOSES)[number]['id'];
export type PptStyle = (typeof PPT_STYLES)[number]['id'];
export type PptOutput = (typeof PPT_OUTPUTS)[number]['id'];

export interface PptWorkshopInput {
  /** 主题(建议必填;与材料都为空时 Agent 会先询问) */
  topic?: string;
  /** 用户粘贴的材料原文(文档文字/要点/数据) */
  material?: string;
  purpose: PptPurpose | string;
  style: PptStyle | string;
  /** 约多少页(含封面/结尾) */
  pages: number;
  output?: PptOutput | string;
}

/** 用途 → 叙事结构建议(与 bento workflow.md 的 1a/2b/3c 方向卡对齐) */
const PURPOSE_NARRATIVE: Record<string, string> = {
  report: '决策型叙事:现状 → 选项/进展 → 权衡 → 建议 → 下一步',
  launch: '叙事型:一个冲突 → 一条变化 → 一项结论,情绪曲线递进,主视觉突出',
  training: '教学型:概念 → 机制 → 示例 → 练习 → 总结,每页一个知识点,信息密度克制',
  data: '数据看板型:总览结论先行 → 趋势 → 归因 → 行动建议,数字尽量图表化',
};

/** 风格 → 视觉方向(一套主色、最多两套字体;bento theme 与 SVG 配色通用) */
const STYLE_THEME: Record<string, string> = {
  business: '深蓝主色 + 灰白底,克制留白,数据图表为主视觉',
  minimal: '黑白灰 + 单一强调色,大字号标题,大量留白,拒绝装饰性元素',
  dark: '深黑/炭色底 + 高亮强调色(如橙/青),适合发布会与暗场演示',
};

export function buildPptWorkshopPrompt({
  topic,
  material,
  purpose,
  style,
  pages,
  output,
}: PptWorkshopInput): string {
  const purposeName = PPT_PURPOSES.find((p) => p.id === purpose)?.name || '演示稿';
  const styleName = PPT_STYLES.find((s) => s.id === style)?.name || '商务';
  const narrative = PURPOSE_NARRATIVE[purpose] || PURPOSE_NARRATIVE.report;
  const themeHint = STYLE_THEME[style] || STYLE_THEME.business;
  const pageCount = PPT_PAGE_OPTIONS.includes(pages as never) ? pages : 12;
  const topicText = (topic || '').trim();
  const materialText = (material || '').trim();

  // 选项/材料段两路线单源(prompt.options.md),先渲染再注入路线模板
  const optionsSection = renderTemplate(optionsTpl, {
    purposeName,
    topicText: topicText || '未指定(材料中也提炼不出主题时,先在对话里问我,不要凭空自拟开跑)',
    narrative,
    styleName,
    themeHint,
    pageCount,
    materialText,
  });

  if (output === 'pptx') {
    return renderTemplate(pptxTpl, {
      optionsSection,
      pptSkillDir: pptMasterSkillDir(),
      pptMasterPython: PPT_MASTER_PYTHON,
      bentoSkillDir: bentoSkillDir(),
    });
  }

  return renderTemplate(bentoTpl, {
    optionsSection,
    bentoSkillDir: bentoSkillDir(),
  });
}
