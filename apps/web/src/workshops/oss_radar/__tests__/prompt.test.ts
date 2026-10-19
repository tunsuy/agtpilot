import { describe, it, expect } from 'vitest';
import {
  buildOssRadarPrompt,
  buildContributorProfileSection,
  buildDispatchHistorySection,
  buildTargetReposSection,
  parseTargetRepos,
  TARGET_REPOS_LIMIT,
  OSS_INTERESTS,
  OSS_CONTRIB_KINDS,
  type RadarDispatchHistoryEntry,
} from '../context';
import type { ScenarioProfile } from '@/lib/scenario-profile';

/** 贡献者档案固定样例(niche=主力技术栈,audience=关注方向,differentiation=加分经验,taboos=排除项) */
const profile: ScenarioProfile = {
  scenarioKey: 'oss_radar',
  version: 1,
  positioning: {
    niche: 'Go / TypeScript',
    audience: 'LLM 基础设施、Agent 框架',
    differentiation: '维护过 k8s operator',
  },
  persona: { toneSamples: [], taboos: ['不碰加密货币项目'] },
  cadence: {},
  insights: [],
  createdAt: Date.now(),
  updatedAt: Date.now(),
};

describe('buildOssRadarPrompt · 格式契约(与 oss-opportunities.ts 解析器互为契约)', () => {
  const prompt = buildOssRadarPrompt({ count: 5 });

  it('八个字段头全部出现在输出格式约定里', () => {
    for (const header of [
      '【机会 N】',
      '【项目】',
      '【项目简介】',
      '【机会类型】',
      '【机会链接】',
      '【为什么适合你】',
      '【建议第一步】',
      '【难度】',
    ]) {
      expect(prompt).toContain(header);
    }
  });

  it('约定 --- 分隔与「不要输出多余段落」', () => {
    expect(prompt).toContain('---');
    expect(prompt).toContain('不要输出寒暄');
  });

  it('调研红线:只读 / 严禁编造 / 末尾注明检索时间与数据源', () => {
    expect(prompt).toContain('全程只读');
    expect(prompt).toContain('严禁编造');
    expect(prompt).toContain('不调用任何写操作');
    expect(prompt).toContain('检索时间');
    expect(prompt).toContain('数据源');
  });

  it('调研链按 GitHub MCP → DeepWiki → 网页搜索 → 自身知识降级', () => {
    expect(prompt).toContain('mcp_github_mcp_');
    expect(prompt).toContain('mcp_deepwiki_');
    expect(prompt).toContain('search_web');
    expect(prompt).toContain('链接与状态未经实时核验');
    expect(prompt).toContain('近 90 天');
    expect(prompt).toContain('good first issue');
  });

  it('肥调研引导派只读检索子 agent(连接器只读工具默认开放,不再让模型猜白名单)', () => {
    expect(prompt).toContain('research_subagent');
    expect(prompt).toContain('只读检索子 agent');
    expect(prompt).toContain('并行派发');
    // 生产实测 mission ar27n:含糊的「取决于负责人是否已加入白名单」让模型放弃子 agent、
    // 在主上下文直调 MCP,42k 字符原始 JSON 逐轮重放 ≈12 万 tokens。现在明确默认开放。
    expect(prompt).toContain('默认已对子 agent 开放');
    expect(prompt).not.toContain('取决于负责人是否已将其加入子 agent 白名单');
    expect(prompt).toContain('由你直接复核');
    expect(prompt).not.toContain('连接器检索不对子 agent 开放');
  });

  it('检索纪律:筛选期只要元数据不取 body、perPage ≤ 10,核验期才逐条补详情', () => {
    expect(prompt).toContain('检索纪律');
    expect(prompt).toContain('不要取 body');
    expect(prompt).toContain('perPage ≤ 10');
    expect(prompt).toContain('不超过产出数量的 2 倍');
    expect(prompt).toContain('重复付费');
  });

  it('收尾提醒:链接直达 Issue、起草文本发送前逐条审批、写代码由用户本地完成', () => {
    expect(prompt).toContain('直达 Issue');
    expect(prompt).toContain('发送前逐条经我审批');
    expect(prompt).toContain('写代码由我在本地完成');
  });

  it('思考经济锚点:核验留给执行阶段的真实检索,不预先推演(生产实测 7.5 分钟过度思考修复)', () => {
    expect(prompt).toContain('规划阶段只确定步骤顺序与检索关键词');
    expect(prompt).toContain('不要在思考中预先推演');
  });

  it('github_scan 固定工具优先(工坊脚本化:机械取数固化,不再让模型现写代码调 GitHub API)', () => {
    // 仓库搜索降级链首选项是 github_scan,MCP 退为补充
    expect(prompt.indexOf('github_scan')).toBeGreaterThan(0);
    expect(prompt.indexOf('github_scan')).toBeLessThan(prompt.indexOf('mcp_github_mcp_'));
    expect(prompt).toContain('不要自己写代码调 GitHub API');
    expect(prompt).toContain('searchRateRemaining');
  });
});

describe('buildOssRadarPrompt · 参数', () => {
  it('count 钳制在 3-7,四舍五入取整,非法值回落 5', () => {
    expect(buildOssRadarPrompt({ count: 99 })).toContain('产出数量:7 条机会');
    expect(buildOssRadarPrompt({ count: 1 })).toContain('产出数量:3 条机会');
    expect(buildOssRadarPrompt({ count: 4.4 })).toContain('产出数量:4 条机会');
    expect(buildOssRadarPrompt({})).toContain('产出数量:5 条机会');
    expect(buildOssRadarPrompt({ count: NaN })).toContain('产出数量:5 条机会');
  });

  it('interests/kinds 按词表映射为中文名称,未知 id 过滤', () => {
    const prompt = buildOssRadarPrompt({
      interests: ['agent', 'rag', 'unknown_id'],
      kinds: ['good_first_issue', 'docs'],
    });
    expect(prompt).toContain('Agent 框架、RAG 与检索');
    expect(prompt).not.toContain('unknown_id');
    expect(prompt).toContain('good first issue、文档改进');
  });

  it('interests/kinds 为空 = 不限', () => {
    const prompt = buildOssRadarPrompt({ interests: [], kinds: [] });
    expect(prompt).toContain('关注方向:不限,AI 领域均可');
    expect(prompt).toContain('机会类型偏好:不限');
  });

  it('词表本身:方向 8 项、类型 5 项,id 唯一', () => {
    expect(OSS_INTERESTS).toHaveLength(8);
    expect(OSS_CONTRIB_KINDS).toHaveLength(5);
    const ids = [...OSS_INTERESTS, ...OSS_CONTRIB_KINDS].map((o) => o.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('buildOssRadarPrompt · 技术栈回落链与档案注入', () => {
  it('stack 参数优先于档案', () => {
    const prompt = buildOssRadarPrompt({ stack: 'Rust', profile });
    expect(prompt).toContain('我的技术栈:Rust');
  });

  it('无 stack 时回落档案 niche', () => {
    expect(buildOssRadarPrompt({ profile })).toContain('我的技术栈:Go / TypeScript');
  });

  it('无 stack 无档案时按 AI 通用方向', () => {
    expect(buildOssRadarPrompt({})).toContain('我的技术栈:未指定');
  });

  it('有档案:注入贡献者档案段(在调研路径之前),排除项标注一票否决', () => {
    const prompt = buildOssRadarPrompt({ profile });
    expect(prompt).toContain('【贡献者档案】');
    expect(prompt).toContain('主力技术栈:Go / TypeScript');
    expect(prompt).toContain('关注方向:LLM 基础设施、Agent 框架');
    expect(prompt).toContain('加分经验:维护过 k8s operator');
    expect(prompt).toContain('排除项(一票否决,不要推荐):不碰加密货币项目');
    expect(prompt.indexOf('【贡献者档案】')).toBeLessThan(prompt.indexOf('调研路径'));
  });

  it('无档案:不出现贡献者档案段', () => {
    expect(buildOssRadarPrompt({ stack: 'Go' })).not.toContain('贡献者档案');
  });
});

describe('buildContributorProfileSection', () => {
  it('档案各字段全空 → null(prompt 不注入空段)', () => {
    const empty: ScenarioProfile = {
      scenarioKey: 'oss_radar',
      version: 1,
      positioning: { niche: '', audience: '' },
      persona: { toneSamples: [], taboos: [] },
      cadence: {},
      insights: [],
      createdAt: 0,
      updatedAt: 0,
    };
    expect(buildContributorProfileSection(empty)).toBeNull();
  });

  it('多个排除项用分号连接', () => {
    const p: ScenarioProfile = { ...profile, persona: { toneSamples: [], taboos: ['不碰前端样式', '不碰加密货币项目'] } };
    expect(buildContributorProfileSection(p)).toContain('排除项(一票否决,不要推荐):不碰前端样式;不碰加密货币项目');
  });
});

// ---------- 派发历史注入(milvus #52049:修复已合并但 Issue 没人关,雷达每轮重复推荐重复派发) ----------

describe('buildDispatchHistorySection(派发历史 → 去重黑名单段)', () => {
  const entries: RadarDispatchHistoryEntry[] = [
    { issueUrl: 'https://github.com/milvus-io/milvus/issues/52049', outcome: '已核实无需改动(上游已修复)' },
    { issueUrl: 'https://github.com/o/r/issues/7', outcome: '已派发并完成(PR 已发布)' },
  ];

  it('有历史:段头点名「不要重复推荐」+ 逐条 url — 结局 + 收尾「换别的项目不硬凑」', () => {
    const section = buildDispatchHistorySection(entries)!;
    expect(section).toContain('【派发历史】');
    expect(section).toContain('不要重复推荐(即使检索命中)');
    expect(section).toContain('- https://github.com/milvus-io/milvus/issues/52049 — 已核实无需改动(上游已修复)');
    expect(section).toContain('- https://github.com/o/r/issues/7 — 已派发并完成(PR 已发布)');
    expect(section).toContain('换别的项目,不要硬凑');
  });

  it('空数组/缺省 → null(模板 {{#if}} 整段不渲染)', () => {
    expect(buildDispatchHistorySection([])).toBeNull();
    expect(buildDispatchHistorySection(undefined)).toBeNull();
  });

  it('脏条目过滤:url 或 outcome 为空不进名单;全脏 → null', () => {
    const dirty: RadarDispatchHistoryEntry[] = [
      { issueUrl: '', outcome: '已派发但失败' },
      { issueUrl: 'https://github.com/o/r/issues/8', outcome: '' },
    ];
    expect(buildDispatchHistorySection(dirty)).toBeNull();
    expect(buildDispatchHistorySection([...entries, ...dirty])!.split('\n')).toHaveLength(4); // 段头 + 2 条 + 收尾
  });
});

describe('buildOssRadarPrompt · 派发历史注入与静默修复筛查', () => {
  const history: RadarDispatchHistoryEntry[] = [
    { issueUrl: 'https://github.com/milvus-io/milvus/issues/52049', outcome: '已核实无需改动(上游已修复)' },
  ];

  it('带历史:prompt 出现【派发历史】段与 url/结局;档案段与历史段共存互不挤占', () => {
    const prompt = buildOssRadarPrompt({ count: 5, profile, dispatchHistory: history });
    expect(prompt).toContain('【派发历史】');
    expect(prompt).toContain('https://github.com/milvus-io/milvus/issues/52049');
    expect(prompt).toContain('已核实无需改动(上游已修复)');
    expect(prompt).toContain('【贡献者档案】');
  });

  it('无历史:不出现【派发历史】,也不漏模板占位符', () => {
    const prompt = buildOssRadarPrompt({ count: 5 });
    expect(prompt).not.toContain('【派发历史】');
    expect(prompt).not.toContain('{{historySection}}');
  });

  it('筛选标准含「未被上游静默修复」:核查交叉引用/已合并修复 PR,拿不准的注明需先核实', () => {
    const prompt = buildOssRadarPrompt({ count: 5 });
    expect(prompt).toContain('未被上游静默修复');
    expect(prompt).toContain('交叉引用');
    expect(prompt).toContain('需先核实是否已修复');
  });
});

// ---------- 指定项目(手动扫描聚焦某几个仓库;留空=广扫) ----------

describe('parseTargetRepos(指定项目输入清洗:owner/repo 归一 + 去重 + 上限)', () => {
  it('裸 owner/repo、GitHub 链接(带 issues/tree 尾巴)、.git 后缀都归一;空白/逗号/换行分隔', () => {
    expect(parseTargetRepos('milvus-io/milvus')).toEqual(['milvus-io/milvus']);
    expect(parseTargetRepos('https://github.com/vllm-project/vllm')).toEqual(['vllm-project/vllm']);
    expect(parseTargetRepos('https://github.com/milvus-io/milvus/issues/52049')).toEqual(['milvus-io/milvus']);
    expect(parseTargetRepos('github.com/owner/repo/tree/main')).toEqual(['owner/repo']);
    expect(parseTargetRepos('owner/repo.git')).toEqual(['owner/repo']);
    expect(parseTargetRepos('a/b, c/d\ne/f   g/h')).toEqual(['a/b', 'c/d', 'e/f', 'g/h']);
  });

  it('畸形剔除:非 owner/repo、路径穿越、空段、非字符串;大小写去重保留首写法', () => {
    expect(parseTargetRepos('not a repo')).toEqual([]);
    expect(parseTargetRepos('a/b/c/d')).toEqual([]); // URL 之外的多段不认
    expect(parseTargetRepos('../evil/x')).toEqual([]);
    expect(parseTargetRepos('Owner/Repo\nowner/repo OWNER/REPO')).toEqual(['Owner/Repo']);
    expect(parseTargetRepos(undefined)).toEqual([]);
    expect(parseTargetRepos(42)).toEqual([]);
    expect(parseTargetRepos(['a/b', 7, null])).toEqual(['a/b']);
  });

  it('超过上限截断到 TARGET_REPOS_LIMIT', () => {
    const many = Array.from({ length: TARGET_REPOS_LIMIT + 5 }, (_, i) => `o/r${i}`).join('\n');
    expect(parseTargetRepos(many)).toHaveLength(TARGET_REPOS_LIMIT);
  });
});

describe('buildTargetReposSection / buildOssRadarPrompt · 指定项目注入', () => {
  it('有指定项目:section 点名「只深挖这些仓库、不做话题广扫、不擅自替换」', () => {
    const section = buildTargetReposSection(['milvus-io/milvus', 'vllm-project/vllm'])!;
    expect(section).toContain('【本次指定项目】');
    expect(section).toContain('- milvus-io/milvus');
    expect(section).toContain('- vllm-project/vllm');
    expect(section).toContain('不做话题广扫');
    expect(section).toContain('不要擅自替换成别的项目');
  });

  it('指定项目 = 用户已选定:跳过项目级尽调(star/活跃度/口碑/DeepWiki),只留 Issue 级核验', () => {
    const section = buildTargetReposSection(['milvus-io/milvus'])!;
    // 生产实测 mission ar27n:旧措辞「star 数 / 最近推送照常核验」驱动模型对已指定仓库
    // 跑 list_commits + deepwiki + search_web 三发项目级尽调 → 全部砍掉
    expect(section).toContain('不做项目级尽调');
    expect(section).toContain('不要检索 star 数、提交活跃度与社区口碑');
    expect(section).toContain('「近 90 天有实质提交」一条对指定项目不适用');
    expect(section).toContain('可认领性核验');
    expect(section).not.toContain('照常核验');
    // 红旗零成本兜底:顺带发现只注记,不专门检索;归档如实说明不硬凑
    expect(section).toContain('风险提示');
    expect(section).toContain('不要专门检索确认');
    expect(section).toContain('已归档');
  });

  it('空列表 → null(模板 {{#if}} 整段不渲染)', () => {
    expect(buildTargetReposSection([])).toBeNull();
  });

  it('prompt 带 targetRepos:出现【本次指定项目】与归一后的仓库;留空则整段不渲染不漏占位符', () => {
    const withRepos = buildOssRadarPrompt({ count: 5, targetRepos: 'milvus-io/milvus' });
    expect(withRepos).toContain('【本次指定项目】');
    expect(withRepos).toContain('- milvus-io/milvus');
    const noRepos = buildOssRadarPrompt({ count: 5 });
    expect(noRepos).not.toContain('【本次指定项目】');
    expect(noRepos).not.toContain('{{targetReposSection}}');
  });

  it('指定项目与档案/派发历史三段可共存(互不挤占)', () => {
    const prompt = buildOssRadarPrompt({
      count: 5,
      profile,
      targetRepos: 'milvus-io/milvus',
      dispatchHistory: [{ issueUrl: 'https://github.com/o/r/issues/1', outcome: '已派发但失败' }],
    });
    expect(prompt).toContain('【贡献者档案】');
    expect(prompt).toContain('【本次指定项目】');
    expect(prompt).toContain('【派发历史】');
  });
});
