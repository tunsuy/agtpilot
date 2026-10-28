/**
 * humanizer 去 AI 化自查清单 · 工坊内注入(单一出口)。
 *
 * 定位:像 PPT 工坊的技能一样是工坊内置能力——清单内容在渲染任务 prompt 时
 * 自动拼进末尾,对工坊用户完全不可见,不占用任何用户侧 skill 选择通道
 * (sanitizeSkillPackRefs / buildReferencedPacksBlock / skill_pack_read 均不涉及)。
 * 文件在仓库根 skills/humanizer/SKILL.md,与 apps/web 的 script-skill 目录
 * (apps/web/skills,运行时 COPY)是两回事——这里是构建期内联,不进 Docker 镜像。
 *
 * 注入走「代码侧拼接」先例(同 buildMaterialsSection):不新增模板变量、不动
 * 引擎,五个内容工坊的 context.ts 在 renderTemplate(...) 结果后追加本段。
 * 来源文件只保留正文:frontmatter 与「使用方式」及之后的小节是 skill 元信息,
 * 对工坊 agent 无意义,剥掉再注入,避免 prompt 膨胀与误导性指令。
 */
import skillBody from '../../../../../skills/humanizer/SKILL.md';

/** 剥掉 frontmatter(--- 围起来的元信息块)与「## 使用方式」起的元信息小节 */
function extractChecklist(raw: string): string {
  let body = raw.replace(/^---\n[\s\S]*?\n---\n/, '').trimStart();
  const metaIdx = body.indexOf('## 使用方式');
  if (metaIdx > 0) body = body.slice(0, metaIdx).trimEnd();
  return body;
}

/**
 * 拼进内容工坊 prompt 末尾的去 AI 化自查段(含 26 种痕迹清单与强制检查清单)。
 * 恒定内容、无开关——工坊声明了注入就是全量注入,与参考资料段(空数组为空串)
 * 不同,这里没有「不注入」形态:反 AI 语气规则从全局提示词移出(commit 69882a7)
 * 后,五个内容工坊的自查约束都靠这一段兜底。
 */
export function buildHumanizerSection(): string {
  return `\n\n【去 AI 化自查 · 26 种痕迹清单】\n${extractChecklist(skillBody)}`;
}
