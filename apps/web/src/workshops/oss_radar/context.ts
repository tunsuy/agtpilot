/**
 * 开源贡献雷达工坊 · 模板上下文(正文见 prompt.main.md)
 *
 * 产品定位:Agent 没有代码执行环境,「自动贡献代码」做不到;但「自动找贡献机会」
 * 用现有连接器就能闭环 —— GitHub 官方 MCP(搜仓库/搜 Issue)+ DeepWiki(理解代码库)
 * + 网页搜索(社区动态),产出结构化「贡献机会」清单,每条带 Issue 直达链接。
 * 实际贡献由用户本地动手;Agent 最多起草认领留言 / PR 描述(对外发送前逐条审批)。
 *
 * 红线:全程只读(不 fork / 不建 Issue / 不评论),严禁编造链接(必须来自真实检索),
 * 清单末尾注明检索时间与数据源 —— 与内容工坊「发布永远人工」同一套三层围栏思路。
 * 交付物格式与 oss-opportunities.ts 解析器互为契约(【机会 N】+ 八字段头 + --- 分隔)。
 */
import prompt from './prompt.main.md';
import { renderTemplate } from '../engine';
import type { ScenarioProfile } from '@/lib/scenario-profile';

/** 关注方向(chip 多选;id 进参数、name 进 prompt) */
export const OSS_INTERESTS = [
  { id: 'llm_infra', name: 'LLM 基础设施' },
  { id: 'agent', name: 'Agent 框架' },
  { id: 'rag', name: 'RAG 与检索' },
  { id: 'training', name: '训练与微调' },
  { id: 'inference', name: '推理与部署' },
  { id: 'data', name: '数据工程' },
  { id: 'devtool', name: '开发者工具' },
  { id: 'ai_frontend', name: 'AI 前端与可视化' },
] as const;

/** 机会类型偏好(chip 多选;与交付物【机会类型】字段同一套词表) */
export const OSS_CONTRIB_KINDS = [
  { id: 'good_first_issue', name: 'good first issue' },
  { id: 'bug', name: 'Bug 修复' },
  { id: 'docs', name: '文档改进' },
  { id: 'feature', name: '功能开发' },
  { id: 'community', name: '社区支持' },
] as const;

export interface OssRadarInput {
  /** 主力技术栈自由文本;留空时用档案里的技术栈,再无则按 AI 通用方向 */
  stack?: string;
  /** 关注方向 id(OSS_INTERESTS);空 = 不限 */
  interests?: string[];
  /** 机会类型 id(OSS_CONTRIB_KINDS);空 = 不限 */
  kinds?: string[];
  /** 产出条数,钳制 3-7 */
  count?: number;
  /** 贡献者档案(scenarioKey='oss_radar');无档案或档案为空时不注入 */
  profile?: ScenarioProfile;
}

/**
 * 贡献者档案 → Prompt 注入段。
 * 不复用 buildProfileSection(其字段口径是内容账号:赛道/目标人群/语气样例);
 * 这里把同一份 ScenarioProfile 结构按开发者语义重新措辞:
 * niche=主力技术栈,audience=关注方向,differentiation=加分经验,taboos=排除项。
 */
export function buildContributorProfileSection(profile: ScenarioProfile): string | null {
  const lines: string[] = [];
  if (profile.positioning.niche) lines.push(`- 主力技术栈:${profile.positioning.niche}`);
  if (profile.positioning.audience) lines.push(`- 关注方向:${profile.positioning.audience}`);
  if (profile.positioning.differentiation) lines.push(`- 加分经验:${profile.positioning.differentiation}`);
  if (profile.persona.taboos.length > 0) {
    lines.push(`- 排除项(一票否决,不要推荐):${profile.persona.taboos.join(';')}`);
  }
  if (lines.length === 0) return null;
  return `【贡献者档案】以下是我的长期技术设定,筛选机会时优先级高于单次表单选择:
${lines.join('\n')}`;
}

const interestName = (id: string): string | null =>
  OSS_INTERESTS.find((i) => i.id === id)?.name || null;
const kindName = (id: string): string | null =>
  OSS_CONTRIB_KINDS.find((k) => k.id === id)?.name || null;

export function buildOssRadarPrompt({ stack, interests, kinds, count, profile }: OssRadarInput): string {
  const n = Math.min(7, Math.max(3, Math.round(count ?? 5) || 5));
  const profileSection = profile ? buildContributorProfileSection(profile) : null;
  const stackText =
    (stack || '').trim() || profile?.positioning.niche?.trim() || '未指定(按 AI 通用方向,结合档案与检索结果自行判断)';
  const interestNames = (interests || []).map(interestName).filter((s): s is string => Boolean(s));
  const kindNames = (kinds || []).map(kindName).filter((s): s is string => Boolean(s));
  return renderTemplate(prompt, {
    count: n,
    profileSection: profileSection || '',
    stackText,
    interestNames: interestNames.length > 0 ? interestNames.join('、') : '不限,AI 领域均可',
    kindNames: kindNames.length > 0 ? kindNames.join('、') : '不限',
  });
}
