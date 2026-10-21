/**
 * 知乎文章包「存入知乎草稿」投递指令(工域知识,归本工坊包)
 *
 * 两条投递路径,同一份定稿正文:
 * - 直连(首选,「文档+脚本」模式):buildZhihuDraftPayload → 卡片按钮经
 *   POST /api/workshops/deliver 服务端直调 zhihu_save_article_draft(浏览器托管),
 *   正文不过模型;HIL = 点击前 buildZhihuDraftConfirm 确认弹窗。
 * - 续聊(保留给模型自主流程):指示 Agent 调 zhihu_save_article_draft
 *   (dangerLevel high → 编排器审批门);参数逐字内嵌(零漂移,不依赖上下文回读)。
 * 纯执行边界句见 wechat_mp/draft.ts 的生产实例注释。
 */
import type { ArticlePackage } from '../shared/article-package';

/** 选中标题(索引越界收敛到合法区间;与续聊指令同一套取法) */
function pickTitle(pkg: ArticlePackage, titleIndex: number): string {
  return pkg.titles[Math.min(Math.max(titleIndex, 0), pkg.titles.length - 1)] || '';
}

export function buildZhihuDraftReplyText(pkg: ArticlePackage, titleIndex = 0): string {
  const title = pickTitle(pkg, titleIndex);
  return `请把下面这篇文章存入我的知乎草稿:调用 zhihu_save_article_draft 工具(title/body 严格按下文填写;body 传 Markdown 原文即可,工具会把正文转成富文本排版填进知乎编辑器,不要自行改写正文)。这是对上一轮已定稿文章的纯执行投递——调研与标题均已在上一轮定稿,直接组装参数调用工具即可,不要重新检索资料,也不要生成新的标题候选。调用前需经我审批确认;发布仍由我在知乎草稿箱人工完成,不要点击任何发布按钮或调用发布类接口。

title:${title}

body:
${pkg.body}`;
}

/**
 * 直连投递 payload(「文档+脚本」模式:正文前端→服务端托管浏览器→知乎,不过模型)。
 * body 传 Markdown 原文,工具侧转富文本粘贴(与续聊路径同一入参契约)。
 */
export function buildZhihuDraftPayload(pkg: ArticlePackage, titleIndex = 0): Record<string, unknown> {
  return {
    title: pickTitle(pkg, titleIndex),
    body: pkg.body,
  };
}

/** HIL 确认弹窗文案(等价旧编排审批门的逐次确认;点明配额与人工发布边界) */
export function buildZhihuDraftConfirm(pkg: ArticlePackage, titleIndex = 0): string {
  return `将《${pickTitle(pkg, titleIndex)}》直接存入知乎草稿?\n\n• 直连投递:不经过 AI 对话,服务端托管浏览器直接填入,消耗今日 1 次投递配额\n• 需已在连接器页扫码登录知乎并开启托管模式\n• 终点是知乎草稿箱(跨端可见),发布仍由你人工完成`;
}
