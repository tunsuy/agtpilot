/**
 * 微博 / 抖音 / B站 内容工坊 · 半自动运营(合规路线)
 *
 * 与小红书工坊(xhs-workshop.ts)同一分工:Agent 只做选题调研与内容生产;
 * 发布动作始终由用户在手机 App 内人工完成(「真机唤起」→ 粘贴 → 人工核对发布)。
 * 各平台均无对个人开放的自动发布 API,任何「自动代发」都违反平台规则,严禁实现。
 * 选题优先走已连接的知乎热榜/搜索类 MCP 工具,其次网页搜索工具,最后模型自身知识。
 */

// ---------- 微博 ----------

export const WEIBO_WORKSHOP_STYLES = ['热点点评', '干货分享', '生活随记', '种草安利'] as const;

export interface WeiboWorkshopInput {
  /** 用户指定主题;留空则由 Agent 调研热点选题 */
  topic?: string;
  /** 微博类型(WEIBO_WORKSHOP_STYLES 之一或自定义) */
  style: string;
  /** 产出条数 1-3 */
  count: number;
}

export function buildWeiboWorkshopPrompt({ topic, style, count }: WeiboWorkshopInput): string {
  const t = (topic || '').trim();
  const n = Math.min(3, Math.max(1, Math.round(count) || 1));
  const topicSection = t
    ? `主题:${t}`
    : `主题:未指定。请先调研热点选题——优先使用知乎热榜/站内搜索类 MCP 工具(若已连接),其次使用可用的网页搜索工具;都没有则基于你自身知识选一个适合「${style}」、有公共讨论度的主题,并简述选题理由。`;

  return `【微博内容工坊 · 半自动运营】
你只负责选题与内容生产;最终发布由我在手机微博 App 内人工确认完成,严禁替我自动发布或调用任何自动发帖工具。

${topicSection}
微博类型:${style}
产出数量:${n} 条

每条按以下结构输出,条与条之间用 --- 分隔:
1.【正文】不超过 500 字:开头一句抓人(微博信息流只露出前两行),短段落、口语化;热点点评需给出明确观点与依据,干货分享用「结论先行 + 分点」结构
2.【话题标签】2-4 个,以 # 开头(格式 #话题# ),优先真实存在的热门话题词,不要生造冷门话题
3.【配图建议】一句话描述配图内容(1/3/4/6/9 张的建议数量与构图,我自行配图)
4.【发布提示】建议发布时段 + 该主题的舆论/社区规范风险点(如涉时事需注明以官方通报为准)

创作红线(必须遵守):
- 不得编造事实、散布未经核实的传闻;涉公共事件只评述已公开确认的信息
- 不得使用营销号式煽动对立、诱导转发抽奖话术
- 种草安利需注明利益相关(如有),主观评价注明是个人感受

全部完成后提醒我:复制满意的一条 → 连接器页微博「真机唤起」→ 手机 App 粘贴、人工核对后发布。`;
}

// ---------- 抖音 / B站 短视频脚本 ----------

export const VIDEO_PLATFORMS = [
  { id: 'douyin', name: '抖音' },
  { id: 'bilibili', name: 'B站' },
] as const;

export type VideoPlatformId = (typeof VIDEO_PLATFORMS)[number]['id'];

export const VIDEO_SCRIPT_DURATIONS = ['30 秒', '60 秒', '3 分钟'] as const;

export interface VideoScriptInput {
  /** 用户指定主题;留空则由 Agent 调研热点选题 */
  topic?: string;
  platform: VideoPlatformId | string;
  /** 时长(VIDEO_SCRIPT_DURATIONS 之一) */
  duration: string;
  /** 产出脚本数 1-3 */
  count: number;
}

const PLATFORM_NOTES: Record<string, { name: string; style: string; tags: string }> = {
  douyin: {
    name: '抖音',
    style:
      '抖音风格:竖屏 9:16、快节奏强钩子——前 3 秒必须抛出冲突/悬念/利益点,单镜头不超过 3 秒,信息口语化高密度,结尾引导点赞关注要自然',
    tags: '标签 4-6 个,以 # 开头,热门泛流量话题 + 垂类话题混搭;建议投放的 DOU+ 人群方向一句话',
  },
  bilibili: {
    name: 'B站',
    style:
      'B站风格:横屏 16:9、信息密度优先——开头 15 秒内说清「这期讲什么、你能得到什么」,中段允许展开论证与玩梗,预留 2-3 个弹幕互动点(提问/投票/名场面),结尾一键三连引导',
    tags: '标签 5-8 个;建议投稿分区(如知识/科技/生活);封面标题党程度需克制(B站社区反感纯标题党)',
  },
};

export function buildVideoScriptPrompt({ topic, platform, duration, count }: VideoScriptInput): string {
  const t = (topic || '').trim();
  const n = Math.min(3, Math.max(1, Math.round(count) || 1));
  const p = PLATFORM_NOTES[platform] || PLATFORM_NOTES.douyin;
  const topicSection = t
    ? `主题:${t}`
    : `主题:未指定。请先调研热点选题——优先使用知乎热榜/站内搜索类 MCP 工具(若已连接),其次使用可用的网页搜索工具;都没有则基于你自身知识选一个适合${p.name}「${duration}」时长、有传播潜力的主题,并简述选题理由。`;

  return `【${p.name}短视频脚本工坊 · 半自动运营】
你只负责选题与脚本创作;拍摄与发布由我人工完成,严禁替我自动发布或调用任何自动投稿工具。

${topicSection}
目标平台:${p.name}
视频时长:${duration}
产出数量:${n} 个脚本

${p.style}

每个脚本按以下结构输出,脚本之间用 --- 分隔:
1.【标题】3 个备选:${p.name === 'B站' ? '每个不超过 20 字,信息明确、可带适度悬念' : '每个不超过 15 字,强钩子、口语化、不造假不标题党'}
2.【脚本分镜】按时间轴输出 Markdown 表格,列:时间 | 画面 | 台词/口播 | 字幕要点。总时长严格控制在 ${duration} 以内,台词按正常语速(约 4-5 字/秒)估算字数
3.【口播开头】前 15 秒完整逐字稿(黄金钩子,直接可用)
4.【标签与分区】${p.tags}
5.【封面文案】主标题 + 副标题各一句(大字报风格,我自行制作)
6.【发布提示】建议发布时段 + 拍摄难度/素材获取提示(哪些镜头可用现成素材替代)

创作红线(必须遵守):
- 不得编造数据、案例与用户评价;引用事实需注明可信来源
- 医疗/财经/法律类内容只做科普框架,注明「不构成专业建议」
- 不得使用低俗擦边、恐吓营销、诱导点击话术

全部完成后提醒我:挑一个脚本拍摄剪辑 → 连接器页${p.name}「真机唤起」→ 手机 App 上传、人工核对后发布。`;
}
