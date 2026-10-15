/**
 * 知乎文章包「存入知乎草稿」续聊指令(工域知识,归本工坊包)
 *
 * 续聊本 mission,指示 Agent 调 zhihu_save_article_draft(浏览器托管,
 * dangerLevel high → 编排器审批门,用户逐次确认);参数逐字内嵌(零漂移,
 * 不依赖上下文回读)。纯执行边界句见 wechat_mp/draft.ts 的生产实例注释。
 */
import type { ArticlePackage } from '../shared/article-package';

export function buildZhihuDraftReplyText(pkg: ArticlePackage, titleIndex = 0): string {
  const title = pkg.titles[Math.min(Math.max(titleIndex, 0), pkg.titles.length - 1)] || '';
  return `请把下面这篇文章存入我的知乎草稿:调用 zhihu_save_article_draft 工具(title/body 严格按下文填写;body 传 Markdown 原文即可,工具会把正文转成富文本排版填进知乎编辑器,不要自行改写正文)。这是对上一轮已定稿文章的纯执行投递——调研与标题均已在上一轮定稿,直接组装参数调用工具即可,不要重新检索资料,也不要生成新的标题候选。调用前需经我审批确认;发布仍由我在知乎草稿箱人工完成,不要点击任何发布按钮或调用发布类接口。

title:${title}

body:
${pkg.body}`;
}
