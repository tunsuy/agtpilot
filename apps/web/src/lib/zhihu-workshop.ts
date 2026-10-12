/**
 * 知乎专栏内容工坊 · 半自动运营(浏览器托管存草稿路线)
 *
 * 知乎没有官方写 API(developer.zhihu.com 开放平台只读;站内草稿接口有
 * x-zse-96 签名墙,不逆向)。分工:Agent 负责选题、撰写与整理文章包;
 * zhihu_save_article_draft 为 dangerLevel high(编排器审批门,存草稿前用户
 * 逐次确认),填进专栏编辑器后停在服务端自动保存的草稿 —— 发布永远由用户
 * 在知乎草稿箱人工完成,代码层面不存在发布调用。
 * 场景档案(ScenarioProfile)注入:长期人设优先级高于单次风格选择(scenario-loop §2)。
 */
import { buildProfileSection, type ScenarioProfile } from './scenario-profile';
import { TOPIC_RESEARCH_SOURCES } from './workshop-sources';

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
}

export function buildZhihuWorkshopPrompt({ topic, style, count, profile }: ZhihuWorkshopInput): string {
  const t = (topic || '').trim();
  const n = Math.min(3, Math.max(1, Math.round(count) || 1));
  const profileSection = profile ? buildProfileSection(profile) : null;
  const topicSection = t
    ? `主题:${t}`
    : `主题:未指定。请先调研热点选题——按以下数据源梯度调研(已连接哪个用哪个,数据来源必须真实;知乎官方 MCP 的搜索/热榜工具尤其适合本题库调研):
${TOPIC_RESEARCH_SOURCES}
综合调研结果选一个适合「${style}」、在知乎有讨论度的高共鸣主题,并注明选题数据来源。`;

  return `【知乎专栏内容工坊 · 草稿托管】
你负责选题、撰写知乎专栏文章并整理成结构化文章包;把满意的一篇存入我的知乎草稿用 zhihu_save_article_draft 工具,调用前我会收到审批确认;最终发布永远由我在知乎草稿箱人工完成,严禁调用任何发布类接口或点击发布按钮。
${profileSection ? `\n${profileSection}\n` : ''}
${topicSection}
文章风格:${style}
产出数量:${n} 篇

每篇文章是一个「文章包」= 可直接发布的成品,严格按以下字段顺序与字段头输出(字段头用【】,必须独占一行;除以下字段外不要输出寒暄、总结、备选方案或任何多余段落):
【标题】
仅一行:你拍板的最终标题(内部可先拟多个候选并自评,但交付物只输出终版这一个,不要把候选清单交给我挑);不超过 40 字,有信息增量、不标题党(知乎用户对标题党反感强烈)
【摘要】
必填,不超过 120 字;概括核心论点,让读者决定是否点开
【正文】
Markdown 格式,1500-3000 字;知乎专栏风格:论证严密、有专业纵深、允许适度个人观点但须讲清依据;存草稿时正文会以纯文本填入编辑器,Markdown 记号不会自动排版,复杂排版由我接管后调整,正文本身不必刻意规避 Markdown

篇与篇之间用单独一行的 --- 分隔(三个连字符,行内无其他字符)。

创作红线(必须遵守):
- 不得编造数据、事实或引用;不确定的信息要么不写,要么明确标注存疑
- 不得撰写医疗、金融等领域的违规断言;主观判断须注明是个人观点
- 不做夸大诱导;知乎社区规范对营销式内容有明确处罚规则

全部完成后提醒我:文章卡片上点「存入知乎草稿」即可把这篇成品填进知乎专栏编辑器——经我审批确认后停在草稿箱(每日有上限),发布由我在知乎草稿箱人工完成;标题不满意可让你重拟,不用给我候选清单。`;
}
