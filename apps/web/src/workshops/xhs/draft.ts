/**
 * 小红书笔记包「存草稿箱」投递指令(工域知识,归本工坊包)
 *
 * 两条投递路径,同一份定稿正文:
 * - 直连(首选,「文档+脚本」模式):buildXhsDraftPayload → 卡片按钮经
 *   POST /api/workshops/deliver 服务端直调 xhs_save_note_draft(浏览器托管),
 *   正文不过模型;HIL = 点击前 buildXhsDraftConfirm 确认弹窗。
 * - 续聊(保留给模型自主流程):指示 Agent 调 xhs_save_note_draft
 *   (dangerLevel high → 编排器审批门);终点是草稿箱,发布永远由用户在小红书 App
 *   人工完成。参数逐字内嵌(零漂移);纯执行边界句见 wechat_mp/draft.ts 的
 *   生产实例注释(公众号与小红书同款闭环,同款教训)。
 */
import type { NotePackage } from './note-package';

/** 选中标题(索引越界收敛到合法区间;与续聊指令同一套取法) */
function pickTitle(pkg: NotePackage, titleIndex: number): string {
  return pkg.titles[Math.min(Math.max(titleIndex, 0), pkg.titles.length - 1)] || '';
}

/** 工具契约:tags 至多 10 个、不带 #(上限在工具 schema,xhs-managed 侧也有每日频控) */
function pickTags(pkg: NotePackage): string[] {
  return (pkg.tags || []).slice(0, 10);
}

export function buildXhsDraftReplyText(pkg: NotePackage, titleIndex = 0): string {
  const title = pickTitle(pkg, titleIndex);
  const tags = pickTags(pkg).join(',');
  return `请把下面这篇小红书笔记存入草稿箱:调用 xhs_save_note_draft 工具(title/body/tags 严格按下文填写,标签不带 #)。这是对上一轮已定稿笔记的纯执行投递——调研与标题均已在上一轮定稿,直接组装参数调用工具即可,不要重新检索资料,也不要生成新的标题候选。调用前需经我审批确认;终点是草稿箱,绝不发布,不要触碰任何发布相关的按钮或接口。

title:${title}

body:
${pkg.body}

tags:${tags}`;
}

/**
 * 直连投递 payload(「文档+脚本」模式:正文前端→服务端托管浏览器→小红书,不过模型)。
 * tags 传数组(工具 schema 就是 array),服务端还会二次去 # / 截断到 10。
 */
export function buildXhsDraftPayload(pkg: NotePackage, titleIndex = 0): Record<string, unknown> {
  return {
    title: pickTitle(pkg, titleIndex),
    body: pkg.body,
    tags: pickTags(pkg),
  };
}

/** HIL 确认弹窗文案(等价旧编排审批门的逐次确认;点明配额与人工发布边界) */
export function buildXhsDraftConfirm(pkg: NotePackage, titleIndex = 0): string {
  return `将《${pickTitle(pkg, titleIndex)}》直接存入小红书草稿?\n\n• 直连投递:不经过 AI 对话,服务端托管浏览器直接填入,消耗今日 1 次投递配额\n• 需已在连接器页扫码登录小红书并开启托管写操作\n• 终点是草稿箱(2026-10 平台改版后网页草稿仅存本服务浏览器本地),发布由你经「接管浏览器」亲自完成`;
}
