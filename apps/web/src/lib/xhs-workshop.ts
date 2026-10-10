/**
 * 小红书内容工坊 · 半自动运营(合规路线)
 *
 * 分工:Agent 只做选题调研与内容生产;发布动作始终由用户在手机 App 内人工完成
 * (平台 2026-03 起严打「AI 托管代发」账号,辅助创作+人工发布是明确允许的形态)。
 * 选题优先走已连接的知乎热榜/搜索类 MCP 工具,其次网页搜索工具,最后模型自身知识。
 * 场景档案(ScenarioProfile)注入:长期人设优先级高于单次风格选择(scenario-loop §2)。
 */
import { buildProfileSection, type ScenarioProfile } from './scenario-profile';

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
}

export function buildXhsWorkshopPrompt({ topic, style, count, profile }: XhsWorkshopInput): string {
  const t = (topic || '').trim();
  const n = Math.min(3, Math.max(1, Math.round(count) || 1));
  const profileSection = profile ? buildProfileSection(profile) : null;
  const topicSection = t
    ? `主题:${t}`
    : `主题:未指定。请先调研热点选题——优先使用知乎热榜/站内搜索类 MCP 工具(若已连接),其次使用可用的网页搜索工具;都没有则基于你自身知识选一个适合「${style}」的高共鸣主题,并简述选题理由。`;

  return `【小红书内容工坊 · 半自动运营】
你只负责选题与内容生产;最终发布由我在手机小红书 App 内人工确认完成,严禁替我自动发布或调用任何自动发帖工具。
${profileSection ? `\n${profileSection}\n` : ''}
${topicSection}
笔记类型:${style}
产出数量:${n} 篇

每篇笔记是一个「笔记包」,严格按以下字段顺序与字段头输出(字段头用【】,必须独占一行;除以下字段外不要输出寒暄、总结或任何多余段落):
【标题候选】
5 个备选,每行一个,格式「数字. 标题」;每个不超过 20 字,含 1-2 个 emoji,口语化、有钩子、不造假不标题党
【封面文案】
封面主文案一句话(对应发布页封面文字,12 字以内优先)
【正文】
300-600 字,小红书风格:第一人称、短段落、适度 emoji、有真实信息增量,结尾带一个互动提问
【标签】
8-10 个,以 # 开头,空格分隔,单行,大中小热度混搭
【发布建议】
建议发布时段 + 一句理由 + 该主题需注意的社区规范要点

篇与篇之间用单独一行的 --- 分隔(三个连字符,行内无其他字符)。

创作红线(必须遵守):
- 不得编造虚假消费体验、虚假种草或夸大功效(尤其医疗/美妆功效断言)
- 不得使用诱导互动、水军引流话术
- 主观评价需注明是个人感受

全部完成后提醒我:复制满意的一篇 → 连接器页小红书「真机唤起」→ 手机 App 粘贴、人工核对后发布。`;
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
  const insightsNote = profile?.insights?.length
    ? '- 优先结合账号档案中的经验结论(见【账号档案】段落),它们是被验证过的判断。\n'
    : '';

  return `【小红书每周选题 · 自动巡航】
这是你为我的小红书账号准备的本周选题会。你只做调研与选题策划,不写完整笔记。
本任务全程只读:严禁发布、严禁调用任何写操作类浏览器工具(填表/上传/点击提交类动作一律禁止)。

${profileSection ? `${profileSection}\n\n` : ''}选题调研要求:
- 优先使用知乎热榜/站内搜索类 MCP 工具(若已连接)调研近期热点,其次使用可用的网页搜索工具;都没有则基于你自身知识判断
${insightsNote}
产出 ${n} 条选题,每条严格按以下字段顺序与字段头输出(字段头用【】,必须独占一行;除以下字段外不要输出寒暄、总结或任何多余段落):
【选题方向】
一句话点明这条选题写什么(不超过 20 字)
【标题钩子】
2 个备选标题,每行一个,口语化、有钩子、不超过 20 字
【切入角度】
这一条与网上同类内容的不同之处(1-2 句)
【依据】
选题理由:热点/搜索量/竞品笔记表现/档案经验结论(1-2 句,注明来源)
【配图建议】
封面与内页图片的拍摄或素材方向(1 句)
【建议发布日】
建议本周哪天发布 + 一句理由

条与条之间用单独一行的 --- 分隔(三个连字符,行内无其他字符)。

创作红线(必须遵守):
- 不得编造数据、虚假趋势或夸大功效
- 选题必须与账号档案的赛道和人群一致${profile ? '' : '(无档案时选通用高共鸣方向)'}

全部完成后用 2-3 句总评本周选题结构(题材分布/发布节奏是否均衡),并提示我:回复勾选想写的编号,周中用「小红书内容工坊」成稿。`;
}
