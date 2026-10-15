/**
 * Markdown → 排版化的纯文本(知乎草稿投递用)。
 *
 * 解析用 remark(react-markdown 同源,处理模型任意 md 都稳),渲染自己写:
 * 纯文本没有字体/字号,「好看」全靠排版记号与留白 ——
 * - 标题:▍ 前缀 + 前后空行(知乎文章常见的强调头样式,层级折叠为同一档);
 * - 加粗:「」包裹(中文排版里最自然的强调,替代丢失的粗体);
 * - 无序列表:一级 •、二级 ◦、三级 ▪(缩进 + 换弹头表达层级);
 * - 引用:❝ 前缀;分割线 ——— 长划;链接保留「文字(地址)」;
 * - 代码块:内容原样独立成段(不剥内部记号);
 * - 表格:单元格 | 连接(纯文本里没有更好的形态,用户接管后调整)。
 *
 * 历史注记:第一版是手写正则(只剥记号不排版,标题层级/加粗/引用全丢),
 * 本版换 remark 解析 + 排版渲染,嵌套列表/行内嵌套/松散列表都能吃。
 */
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import { unified } from 'unified';

// GFM 与驾驶舱渲染 markdown(react-markdown + remark-gfm)同一套口径:
// 模型输出里的表格/删除线/任务列表都是 GFM 语法,基础解析器不认识
const parser = unified().use(remarkParse).use(remarkGfm);

type MdNode = any;

/** 无序列表弹头:按嵌套深度换形(• → ◦ → ▪) */
const BULLETS = ['•', '◦', '▪'];
const HEADING_MARK = '▍';
const QUOTE_MARK = '❝';
const HR = '———————————';

/** 行内节点 → 纯文本:strong 转「」中文强调,emphasis/delete 剥记号留字 */
function renderInline(nodes: MdNode[]): string {
  let out = '';
  for (const n of nodes || []) {
    switch (n.type) {
      case 'text':
        out += n.value;
        break;
      case 'strong':
        out += `「${renderInline(n.children)}」`;
        break;
      case 'emphasis':
      case 'delete':
        out += renderInline(n.children);
        break;
      case 'inlineCode':
        out += n.value;
        break;
      case 'link':
        out += `${renderInline(n.children)}(${n.url})`;
        break;
      case 'image':
        out += n.alt ? `(图片:${n.alt})` : '(图片)';
        break;
      case 'break':
        out += '\n';
        break;
      // 行内 html/未知节点:丢弃或递归,不出记号
      default:
        if (n.children) out += renderInline(n.children);
    }
  }
  return out;
}

/** 列表项 → 行:首个段落跟弹头同行,其余段落缩进续行,嵌套列表递归加深 */
function renderListItem(item: MdNode, marker: string, depth: number): string[] {
  const own: string[] = [];
  const nested: MdNode[] = [];
  for (const child of item.children || []) {
    if (child.type === 'list') {
      nested.push(child);
    } else if (child.type === 'paragraph') {
      own.push(renderInline(child.children));
    } else if (child.type === 'heading') {
      own.push(`${HEADING_MARK} ${renderInline(child.children)}`);
    } else if (child.type === 'code') {
      own.push(...String(child.value || '').replace(/\n$/, '').split('\n'));
    }
  }
  const [first, ...rest] = own;
  // GFM 任务列表:- [ ] / - [x] → ☐ / ☑(checked 仅任务列表项上有)
  const task = item.checked === true ? '☑ ' : item.checked === false ? '☐ ' : '';
  const out = [`${marker}${task}${first ?? ''}`];
  for (const line of rest) out.push(`  ${line}`);
  for (const sub of nested) out.push(...renderList(sub, depth + 1));
  return out;
}

function renderList(list: MdNode, depth = 0): string[] {
  const bullet = BULLETS[Math.min(depth, BULLETS.length - 1)];
  const out: string[] = [];
  (list.children || []).forEach((item: MdNode, i: number) => {
    const marker = list.ordered ? `${(list.start || 1) + i}. ` : `${bullet} `;
    out.push(...renderListItem(item, marker, depth));
  });
  return out;
}

/** 块级节点 → 行数组(块间空行由最终 join + 空行压缩统一) */
function renderBlocks(nodes: MdNode[], depth = 0): string[] {
  const out: string[] = [];
  for (const n of nodes || []) {
    switch (n.type) {
      case 'heading':
        out.push('', `${HEADING_MARK} ${renderInline(n.children)}`, '');
        break;
      case 'paragraph':
        out.push(renderInline(n.children));
        break;
      case 'list':
        out.push(...renderList(n, depth));
        break;
      case 'blockquote':
        out.push('');
        for (const line of renderBlocks(n.children, 0)) out.push(`${QUOTE_MARK} ${line}`.trimEnd());
        out.push('');
        break;
      case 'code':
        out.push('', ...String(n.value || '').replace(/\n$/, '').split('\n'), '');
        break;
      case 'thematicBreak':
        out.push('', HR, '');
        break;
      case 'table':
        for (const row of n.children || []) {
          const cells = (row.children || []).map((c: MdNode) => renderInline(c.children).replace(/\n/g, ' '));
          out.push(cells.join(' | '));
        }
        break;
      // html/根节点外的未知块:递归有 children 的,否则丢弃
      default:
        if (n.children) out.push(...renderBlocks(n.children, depth));
    }
  }
  return out;
}

/**
 * Markdown 原文 → 排版化纯文本。块间统一空一行、连续空行压成一行、首尾去空白。
 * 解析失败(理论上 remark 对任意文本都不抛)兜底原文返回,投递永不因转换失败而断。
 */
export function markdownToPlainText(md: string): string {
  try {
    const tree = parser.parse(String(md || ''));
    const lines = renderBlocks(tree.children);
    return lines
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  } catch {
    return String(md || '').trim();
  }
}
