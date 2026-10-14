/**
 * 开源贡献雷达工坊 · 只读调研(2026-10 负责人立项)
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
import type { ScenarioProfile } from './scenario-profile';

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

  return `【开源贡献雷达 · 只读调研】
你负责扫描 AI 领域活跃开源项目,结合我的技术背景筛出可上手的贡献机会,产出结构化「贡献机会」清单。全程只读:不要 fork、不要改代码、不要创建或评论任何 Issue / PR;需要对外发声时只替我起草文本,发送前逐条经我审批。
${profileSection ? `\n${profileSection}\n` : ''}
我的技术栈:${stackText}
关注方向:${interestNames.length > 0 ? interestNames.join('、') : '不限,AI 领域均可'}
机会类型偏好:${kindNames.length > 0 ? kindNames.join('、') : '不限'}
产出数量:${n} 条机会

调研路径(已连接哪个用哪个,按顺序降级,发生降级须在清单末尾注明):
1. GitHub(若已连接 mcp_github_mcp_* 工具):仓库搜索按话题(topic:ai / llm / agent / rag 等)+ 最近推送时间筛活跃项目;Issue 搜索用 state:open 加 "good first issue" / "help wanted" 标签,或找明确无人认领、维护者欢迎新人的 Issue
2. DeepWiki(若已连接 mcp_deepwiki_* 工具):对候选仓库提问,快速理解架构、贡献流程与测试方式,判断上手成本
3. 网页搜索工具(search_web / search_exa / search_tavily):GitHub Trending、项目社区动态与贡献者口碑
4. 以上都不可用:基于自身知识给出候选,但每条必须注明「链接与状态未经实时核验」

广域网页调研派子 agent:需要翻大量网页才能得出结论的调研(多个候选项目的社区动态扫描、口碑交叉验证等),用 research_subagent 工具(只读检索子 agent)完成——相互独立的调研路(不同项目/不同角度)可在一轮内并行派发多个调用,子 agent 只回传提炼后的结论与来源,原始网页内容不占主上下文,把主线留给机会筛选与清单输出。注意:GitHub / DeepWiki 连接器检索能否交给子 agent,取决于负责人是否已将其加入子 agent 白名单——已开放的工具会自动出现在子 agent 工具集里,未开放时子 agent 自动退回网页搜索;无论走哪条路,关键 Issue 链接与项目状态在写入报告前仍需由你直接复核。单点查询(查一个链接、搜一个项目名)直接用 search_web,不要派子 agent。

筛选标准(全部满足才进清单):
- 项目近 90 天有实质提交;归档、停更、明显无人维护的项目一律排除
- 机会真实存在:链接必须来自检索结果,严禁编造 Issue 编号或链接;检索不到就少给,不凑数
- 与我的技术栈/关注方向匹配;档案排除项(若有)一票否决
- 同等条件下优先:有 CONTRIBUTING 指引、CI 完整、维护者会回复新人的项目

每条机会严格按以下字段顺序与字段头输出(字段头用【】,必须独占一行;除以下字段外不要输出寒暄、总结或任何多余段落):
【机会 N】
N
【项目】
仅一行:owner/repo
【项目简介】
一两句话:项目是做什么的 + 活跃度信号(star 数、近期提交/发版节奏),数据须来自检索
【机会类型】
good first issue / Bug 修复 / 文档改进 / 功能开发 / 社区支持 之一,可加半句说明
【机会链接】
Issue / 讨论直达链接,每行一条;项目级机会可给 repo 或 CONTRIBUTING 链接
【为什么适合你】
一两句话:与我的技术栈/经验的具体匹配点
【建议第一步】
一句话:立即可做的具体动作(读 CONTRIBUTING 某节 / 复现 bug / 在 Issue 下留言认领…)
【难度】
低 / 中 / 高,可附半句原因

条与条之间用单独一行的 --- 分隔(三个连字符,行内无其他字符)。

调研红线(必须遵守):
- 全程只读,不调用任何写操作类工具(创建 Issue / PR / 评论 / fork 都不行)
- 严禁编造:每条链接、star 数、活跃度数据必须来自真实检索;拿不准的宁可不给
- 清单末尾(最后一条机会之后)单独一段注明:数据检索时间与所用数据源;发生降级也要在这里说明

全部完成后提醒我:卡片上每条机会的链接可直达 Issue;想贡献哪条,可让你先起草认领留言或 PR 描述(发送前逐条经我审批),写代码由我在本地完成。`;
}
