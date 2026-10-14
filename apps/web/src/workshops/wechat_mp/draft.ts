/**
 * 公众号文章包「投草稿箱」续聊指令(工域知识,归本工坊包)
 *
 * 续聊本 mission,指示 Agent 调 wechat_mp_create_draft(dangerLevel high →
 * 编排器审批门,用户逐次确认);参数逐字内嵌(零漂移,不依赖上下文回读)。
 *
 * 纯执行边界句为生产实例驱动(2026-10-11):投草稿续聊轮带完整会话上下文、
 * 定稿已逐字内嵌,模型仍跑了 4 次 search_web + 重生成标题候选(全部弃用)。
 * 只约束参数(「严格按下文填写」)挡不住对上轮工作流的模式补全,必须显式
 * 负向禁止过程。卡片与「投草稿」属同一任务的中间态,不是新任务。
 */
import type { ArticlePackage } from '../shared/article-package';

export function buildWechatMpDraftReplyText(pkg: ArticlePackage, titleIndex = 0): string {
  const title = pkg.titles[Math.min(Math.max(titleIndex, 0), pkg.titles.length - 1)] || '';
  return `请把下面这篇公众号文章投入我的草稿箱:调用 wechat_mp_create_draft 工具(title/digest/markdown 严格按下文填写,不传 cover_url,封面自动生成)。这是对上一轮已定稿文章的纯执行投递——调研与标题均已在上一轮定稿,直接组装参数调用工具即可,不要重新检索资料,也不要生成新的标题候选。调用前需经我审批确认;发布仍由我在公众平台后台人工完成,不要调用任何发布/群发类接口。

title:${title}

digest:${pkg.digest}

markdown:
${pkg.body}`;
}
