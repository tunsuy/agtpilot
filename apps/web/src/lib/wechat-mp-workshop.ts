/**
 * 微信公众号内容工坊 · 半自动运营(官方草稿箱直投路线)
 *
 * 分工:Agent 负责选题、撰写与排版投草稿;wechat_mp_create_draft 升 dangerLevel high
 * (编排器审批门,投递前用户逐次确认);最终发布永远由用户在公众平台后台人工完成
 * —— 代码层面不存在 freepublish 调用,群发/发布接口是合规红线。
 * 场景档案(ScenarioProfile)注入:长期人设优先级高于单次风格选择(scenario-loop §2)。
 */
import { buildProfileSection, type ScenarioProfile } from './scenario-profile';

export const WECHAT_MP_ARTICLE_STYLES = ['深度长文', '干货教程', '热点解读', '观点评论'] as const;

export interface WechatMpWorkshopInput {
  /** 用户指定主题;留空则由 Agent 调研热点选题 */
  topic?: string;
  /** 文章风格(WECHAT_MP_ARTICLE_STYLES 之一或自定义) */
  style: string;
  /** 产出篇数 1-3 */
  count: number;
  /** 场景档案;无档案或档案为空时不注入(prompt 与无档案时逐字节一致) */
  profile?: ScenarioProfile;
}

export function buildWechatMpWorkshopPrompt({ topic, style, count, profile }: WechatMpWorkshopInput): string {
  const t = (topic || '').trim();
  const n = Math.min(3, Math.max(1, Math.round(count) || 1));
  const profileSection = profile ? buildProfileSection(profile) : null;
  const topicSection = t
    ? `主题:${t}`
    : `主题:未指定。请先调研热点选题——优先使用知乎热榜/站内搜索类 MCP 工具(若已连接),其次使用可用的网页搜索工具;都没有则基于你自身知识选一个适合「${style}」的高共鸣主题,并注明选题数据来源。`;

  return `【微信公众号内容工坊 · 草稿箱直投】
你负责选题、撰写公众号文章并整理成结构化文章包;把文章写入我的草稿箱用 wechat_mp_create_draft 工具,调用前我会收到审批确认;最终发布永远由我在公众平台后台人工完成,严禁调用任何群发/发布(freepublish)类接口。
${profileSection ? `\n${profileSection}\n` : ''}
${topicSection}
文章风格:${style}
产出数量:${n} 篇

每篇文章是一个「文章包」,严格按以下字段顺序与字段头输出(字段头用【】,必须独占一行;除以下字段外不要输出寒暄、总结或任何多余段落):
【标题候选】
5 个备选,每行一个,格式「数字. 标题」;每个不超过 64 字(公众号标题上限),有信息增量、不标题党
【摘要】
必填,不超过 120 字(公众号摘要上限);概括核心观点,让读者决定是否点开
【正文】
Markdown 格式,1500-3000 字;支持二级标题/列表/引用/代码块;公众号排版风格:段落短、信息密度高
【封面建议】
封面图方向一句话(构图/主体/情绪;不提供图片 URL 时系统自动生成占位封面,用户可在后台替换)
【发布建议】
建议发布时段 + 一句理由 + 该主题的合规注意点

篇与篇之间用单独一行的 --- 分隔(三个连字符,行内无其他字符)。

创作红线(必须遵守):
- 不得编造数据、事实或引用;不确定的信息要么不写,要么明确标注存疑
- 不得撰写医疗、金融等领域的违规断言;主观判断须注明是个人观点
- 标题与摘要不做夸大诱导(微信平台对标题党有明确处罚规则)

全部完成后提醒我:满意的一篇可在文章卡片上点「投草稿箱」——经我审批确认后写入公众号草稿箱,发布由我在公众平台后台人工完成。`;
}
