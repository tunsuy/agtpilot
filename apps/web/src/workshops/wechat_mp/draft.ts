/**
 * 公众号文章包「投草稿箱」投递指令(工域知识,归本工坊包)
 *
 * 两条投递路径,同一份定稿正文:
 * - 直连(首选,「文档+脚本」模式):buildWechatMpDraftPayload → 卡片按钮经
 *   POST /api/workshops/deliver 服务端直调 wechat_mp_create_draft,正文不过模型
 *   (token 成本归零);HIL = 点击前 buildWechatMpDraftConfirm 确认弹窗。
 * - 续聊(保留给模型自主流程):指示 Agent 调 wechat_mp_create_draft
 *   (dangerLevel high → 编排器审批门);参数逐字内嵌(零漂移,不依赖上下文回读)。
 *
 * 纯执行边界句为生产实例驱动(2026-10-11):投草稿续聊轮带完整会话上下文、
 * 定稿已逐字内嵌,模型仍跑了 4 次 search_web + 重生成标题候选(全部弃用)。
 * 只约束参数(「严格按下文填写」)挡不住对上轮工作流的模式补全,必须显式
 * 负向禁止过程。卡片与「投草稿」属同一任务的中间态,不是新任务。
 */
import type { ArticlePackage } from '../shared/article-package';

/** 选中标题(索引越界收敛到合法区间;与续聊指令同一套取法) */
function pickTitle(pkg: ArticlePackage, titleIndex: number): string {
  return pkg.titles[Math.min(Math.max(titleIndex, 0), pkg.titles.length - 1)] || '';
}

export function buildWechatMpDraftReplyText(pkg: ArticlePackage, titleIndex = 0): string {
  const title = pickTitle(pkg, titleIndex);
  return `请把下面这篇公众号文章投入我的草稿箱:调用 wechat_mp_create_draft 工具(title/digest/markdown 严格按下文填写,不传 cover_url,封面自动生成)。这是对上一轮已定稿文章的纯执行投递——调研与标题均已在上一轮定稿,直接组装参数调用工具即可,不要重新检索资料,也不要生成新的标题候选。调用前需经我审批确认;发布仍由我在公众平台后台人工完成,不要调用任何发布/群发类接口。

title:${title}

digest:${pkg.digest}

markdown:
${pkg.body}`;
}

/**
 * 直连投递 payload(「文档+脚本」模式:正文前端→服务端→微信,不过模型)。
 * theme 不在这里 —— 排版主题在任务原始 prompt 里(表单当次选择),由服务端
 * 从 mission 首个用户步骤的「排版主题:」行确定性提取,客户端不传(防漂移)。
 */
export function buildWechatMpDraftPayload(pkg: ArticlePackage, titleIndex = 0): Record<string, unknown> {
  return {
    title: pickTitle(pkg, titleIndex),
    digest: pkg.digest,
    markdown: pkg.body,
  };
}

/** HIL 确认弹窗文案(等价旧编排审批门的逐次确认;点明配额与人工发布边界) */
export function buildWechatMpDraftConfirm(pkg: ArticlePackage, titleIndex = 0): string {
  return `将《${pickTitle(pkg, titleIndex)}》直接写入公众号草稿箱?\n\n• 直连投递:不经过 AI 对话,服务端直接写入,消耗今日 1 次投递配额\n• 封面自动生成,排版主题按任务发起时的选择\n• 终点是草稿箱,发布仍由你在公众平台后台人工完成`;
}
