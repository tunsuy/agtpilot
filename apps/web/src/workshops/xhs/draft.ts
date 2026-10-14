/**
 * 小红书笔记包「存草稿箱」续聊指令(工域知识,归本工坊包)
 *
 * 续聊本 mission,指示 Agent 调 xhs_save_note_draft(dangerLevel high →
 * 编排器审批门,用户逐次确认);终点是草稿箱,发布永远由用户在小红书 App
 * 人工完成。参数逐字内嵌(零漂移);纯执行边界句见 wechat_mp/draft.ts 的
 * 生产实例注释(公众号与小红书同款闭环,同款教训)。
 */
import type { NotePackage } from './note-package';

export function buildXhsDraftReplyText(pkg: NotePackage, titleIndex = 0): string {
  const title = pkg.titles[Math.min(Math.max(titleIndex, 0), pkg.titles.length - 1)] || '';
  // 工具契约:tags 至多 10 个、不带 #(上限在工具 schema,xhs-managed 侧也有每日频控)
  const tags = pkg.tags.slice(0, 10).join(',');
  return `请把下面这篇小红书笔记存入草稿箱:调用 xhs_save_note_draft 工具(title/body/tags 严格按下文填写,标签不带 #)。这是对上一轮已定稿笔记的纯执行投递——调研与标题均已在上一轮定稿,直接组装参数调用工具即可,不要重新检索资料,也不要生成新的标题候选。调用前需经我审批确认;终点是草稿箱,绝不发布,不要触碰任何发布相关的按钮或接口。

title:${title}

body:
${pkg.body}

tags:${tags}`;
}
