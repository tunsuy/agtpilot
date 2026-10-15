/**
 * Markdown → 干净纯文本(知乎草稿投递用)。
 *
 * 生产实例(2026-10):文章包正文是 Markdown 源文,zhihu_save_article_draft
 * 直接 insertText 进知乎专栏编辑器 —— 草稿里满屏 ##、**、- 记号(知乎
 * 编辑器不解析 Markdown)。填入前先过本转换器:记号剥除、结构保留为
 * 可读的纯文本行(列表转 •、链接转「文字(地址)」、代码块内容原样保留)。
 * 表格没有好的纯文本形态,保留原文(用户接管后调整,与复杂格式的既有
 * 约定一致)。
 */

/** 行内记号剥除:加粗/斜体/行内代码/图片/链接(保留文字与地址) */
function stripInline(s: string): string {
  return s
    // 图片:![alt](url) → (图片:alt) —— 文字留锚点,占位提醒配图在原文
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, (_m, alt: string) => (alt ? `(图片:${alt})` : '(图片)'))
    // 链接:[text](url) → text(url)
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '$1($2)')
    // 行内代码:`x` → x
    .replace(/`([^`]+)`/g, '$1')
    // 加粗/斜体:**x**、__x__、*x* → x(单下划线不剥,防误伤 snake_case 词)
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/\*(?!\s)([^*\n]+?)\*/g, '$1');
}

/**
 * Markdown 原文 → 纯文本:
 * - 井号标题 → 剥记号保留文字行(层级丢失是纯文本的固有代价);
 * - 无序列表(连字符/星号/加号)→ • ;有序列表保留编号;
 * - 引用 > 剥记号;围栏代码块 ``` 剥栏保留内容原文;
 * - 连续空行压成一行;行内记号见 stripInline。
 */
export function markdownToPlainText(md: string): string {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  let inCode = false;

  for (const line of lines) {
    // 围栏代码块:栏行丢弃,块内容原样保留(不剥行内记号)
    if (/^\s*```/.test(line)) {
      inCode = !inCode;
      continue;
    }
    if (inCode) {
      out.push(line);
      continue;
    }

    let s = line;
    // 井号标题(仅行首合法):# 标题 → 标题
    s = s.replace(/^#{1,6}\s+/, '');
    // 无序列表:-/*/+ 项 → • 项(缩进保留,嵌套层级仍可读)
    s = s.replace(/^(\s*)[-*+]\s+/, '$1• ');
    // 引用:> 引文 → 引文(多层引用逐层剥)
    s = s.replace(/^(\s*)>\s?/, '$1');
    // 水平分割线:--- / *** → ———
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(s)) {
      s = '———';
    }
    out.push(stripInline(s));
  }

  // 连续空行压成一行 + 首尾去空白
  return out
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
