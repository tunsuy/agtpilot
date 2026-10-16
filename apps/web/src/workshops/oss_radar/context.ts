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
  /**
   * 派发历史(去重黑名单):已派发处理过 / 已核实无需改动的 Issue 清单,
   * 由服务端(server-render oss_radar loader)现读任务记录注入;客户端预览缺省不注入。
   */
  dispatchHistory?: RadarDispatchHistoryEntry[];
  /**
   * 指定项目(可选):只深挖这些仓库、不做话题广扫。接受原始文本(一行一个
   * owner/repo,也容忍 GitHub 链接)或已解析的 string[];留空 = 不限(维持广扫)。
   * 仅手动扫描生效,不进周扫订阅(与 stack/interests/kinds 同:订阅触发按档案广扫)。
   */
  targetRepos?: string[] | string;
}

/** 指定项目单次上限(防 prompt 被塞爆;超出截断,前端同口径提示) */
export const TARGET_REPOS_LIMIT = 10;

/** owner/repo 合法性(与 runner-dispatch REPO_RE 同口径,避免接受畸形仓库名) */
const TARGET_REPO_RE = /^[\w.-]{1,100}\/[\w.-]{1,100}$/;

/**
 * 原始输入 → 规范化 owner/repo 列表。
 * 容忍:一行一个、逗号/空格分隔、完整 GitHub 链接(https://github.com/owner/repo/…)、
 * 带 .git 后缀。逐个抽 owner/repo 过 REPO_RE + 拒 ./..,大小写去重(保留首个写法),截上限。
 * 非字符串/数组 → []。解析是幂等纯函数,客户端预览与服务端 skill.run 同一入口。
 */
export function parseTargetRepos(raw: unknown): string[] {
  const tokens: string[] = [];
  if (typeof raw === 'string') {
    tokens.push(...raw.split(/[\s,]+/));
  } else if (Array.isArray(raw)) {
    for (const x of raw) if (typeof x === 'string') tokens.push(...x.split(/[\s,]+/));
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of tokens) {
    const repo = extractRepo(t.trim());
    if (!repo) continue;
    const key = repo.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(repo);
    if (out.length >= TARGET_REPOS_LIMIT) break;
  }
  return out;
}

/** 单个 token → owner/repo 或 null(GitHub 链接抽路径段;裸 owner/repo 直接校验) */
function extractRepo(token: string): string | null {
  if (!token) return null;
  let candidate = token;
  const ghPrefix = /^(?:https?:\/\/)?(?:www\.)?github\.com\//i;
  if (ghPrefix.test(token)) {
    // 去掉协议/域名前缀,再按 / ? # 切段,取前两段 owner/repo(丢掉 issues/tree/query 尾巴)
    const segs = token.replace(ghPrefix, '').split(/[/?#]/).filter(Boolean);
    candidate = segs.length >= 2 ? `${segs[0]}/${segs[1]}` : '';
  }
  candidate = candidate.replace(/\.git$/i, '');
  if (!TARGET_REPO_RE.test(candidate)) return null;
  if (candidate.split('/').some((s) => s === '.' || s === '..')) return null;
  return candidate;
}

/**
 * 指定项目 → Prompt 注入段(无指定 → null,模板 {{#if}} 整段不渲染)。
 * 明确改写发现模式:只查这些 repo 的 open Issue,不话题广扫、不擅自换成别的项目。
 */
export function buildTargetReposSection(repos: string[]): string | null {
  if (repos.length === 0) return null;
  const lines = repos.map((r) => `- ${r}`);
  return `【本次指定项目】只深挖以下仓库,不做话题广扫(上面的关注方向仅作背景参考):
${lines.join('\n')}
调研路径第 1 步相应改为:直接用 github_scan / GitHub MCP 查这些 repo 的 open Issue(优先 good first issue、help wanted 标签与近期活跃 Issue),star 数 / 最近推送 / Issue 链接照常核验;指定项目产不出足够机会就少给、不凑数,也不要擅自替换成别的项目。`;
}

/** 派发历史单条:Issue 链接 + 处置结果话术(runner-dispatch radarDispatchHistory 产出) */
export interface RadarDispatchHistoryEntry {
  issueUrl: string;
  outcome: string;
}

/**
 * 派发历史 → Prompt 注入段(无历史 → null,模板 {{#if}} 整段不渲染)。
 * 生产背景:milvus #52049 修复已合并但 Issue 没人关,雷达每轮都再扫出来重复派发。
 */
export function buildDispatchHistorySection(entries?: RadarDispatchHistoryEntry[]): string | null {
  const lines = (entries ?? [])
    .filter((e) => e.issueUrl && e.outcome)
    .map((e) => `- ${e.issueUrl} — ${e.outcome}`);
  if (lines.length === 0) return null;
  return `【派发历史】以下 Issue 此前已派发处理过、或已由本地 agent 核实无需改动,不要重复推荐(即使检索命中):
${lines.join('\n')}
若某项目扫出来的机会全在上面的名单里,换别的项目,不要硬凑。`;
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

export function buildOssRadarPrompt({ stack, interests, kinds, count, profile, dispatchHistory, targetRepos }: OssRadarInput): string {
  const n = Math.min(7, Math.max(3, Math.round(count ?? 5) || 5));
  const profileSection = profile ? buildContributorProfileSection(profile) : null;
  const stackText =
    (stack || '').trim() || profile?.positioning.niche?.trim() || '未指定(按 AI 通用方向,结合档案与检索结果自行判断)';
  const interestNames = (interests || []).map(interestName).filter((s): s is string => Boolean(s));
  const kindNames = (kinds || []).map(kindName).filter((s): s is string => Boolean(s));
  const repos = parseTargetRepos(targetRepos);
  return renderTemplate(prompt, {
    count: n,
    profileSection: profileSection || '',
    historySection: buildDispatchHistorySection(dispatchHistory) || '',
    targetReposSection: buildTargetReposSection(repos) || '',
    stackText,
    interestNames: interestNames.length > 0 ? interestNames.join('、') : '不限,AI 领域均可',
    kindNames: kindNames.length > 0 ? kindNames.join('、') : '不限',
  });
}
