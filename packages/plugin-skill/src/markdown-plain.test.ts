import { describe, it, expect } from 'vitest';
import { markdownToPlainText, markdownToSemanticHtml } from './markdown-plain';

/**
 * Markdown → 排版化纯文本(知乎草稿投递,2026-10 生产实例:insertText 原样
 * 灌入 Markdown 源文,草稿里满屏井号/星号/连字符记号)。
 *
 * 解析走 remark(react-markdown 同源),渲染是「纯文本里怎么好看」的排版
 * 约定:▍标题、「加粗」、•/◦/▪ 层级列表、❝引用、——— 分割线;代码块内容
 * 原样;链接保「文字(地址)」;块间空一行。
 */

describe('markdownToPlainText · 排版', () => {
  it('标题:▍ 前缀 + 前后空行(所有层级同档,层级靠正文表达)', () => {
    expect(markdownToPlainText('## 为什么是架构\n正文')).toBe('▍ 为什么是架构\n\n正文');
    expect(markdownToPlainText('开篇\n\n# 大标题\n\n结尾')).toBe('开篇\n\n▍ 大标题\n\n结尾');
  });

  it('加粗转「」中文强调,斜体/删除线/行内代码剥记号留字', () => {
    expect(markdownToPlainText('这是**重点**内容')).toBe('这是「重点」内容');
    expect(markdownToPlainText('**全句强调**')).toBe('「全句强调」');
    expect(markdownToPlainText('*斜体*与~~删除~~')).toBe('斜体与删除');
    expect(markdownToPlainText('调用 `npm run` 即可')).toBe('调用 npm run 即可');
  });

  it('无序列表按层级换弹头:• → ◦ → ▪,嵌套缩进可见', () => {
    expect(markdownToPlainText('- 第一项\n- 第二项')).toBe('• 第一项\n• 第二项');
    expect(
      markdownToPlainText('- 一级\n  - 二级\n    - 三级\n- 又一级'),
    ).toBe('• 一级\n◦ 二级\n▪ 三级\n• 又一级');
  });

  it('有序列表保留编号;松散列表(项间空行)压成紧凑行', () => {
    expect(markdownToPlainText('1. 第一\n2. 第二')).toBe('1. 第一\n2. 第二');
    expect(markdownToPlainText('- 甲\n\n- 乙')).toBe('• 甲\n• 乙');
  });

  it('引用 ❝ 前缀;分割线 ———;链接保地址,图片留锚点', () => {
    expect(markdownToPlainText('> 引文一行')).toBe('❝ 引文一行');
    expect(markdownToPlainText('上段\n\n---\n\n下段')).toBe(`上段\n\n———————————\n\n下段`);
    expect(markdownToPlainText('见 [官方文档](https://example.com/docs)')).toBe(
      '见 官方文档(https://example.com/docs)',
    );
    expect(markdownToPlainText('前![架构图](https://x.com/a.png)后')).toBe('前(图片:架构图)后');
  });

  it('代码块:栏行丢弃、内容原样独立成段(行内记号不剥)', () => {
    const md = '说明\n\n```ts\nconst x = `t`;\nif (a ** b) {}\n```\n\n后续';
    expect(markdownToPlainText(md)).toBe('说明\n\nconst x = `t`;\nif (a ** b) {}\n\n后续');
  });

  it('嵌套结构(标题里的行内记号/列表里的嵌套列表)正确吃下', () => {
    const md = '## **性能**三问\n\n- 吞吐:见 [基准](https://b.dev)\n  - 冷启动\n  - 稳态\n- 延迟';
    expect(markdownToPlainText(md)).toBe(
      '▍ 「性能」三问\n\n• 吞吐:见 基准(https://b.dev)\n◦ 冷启动\n◦ 稳态\n• 延迟',
    );
  });

  it('纯文本原样过(不是 md 的正文零扰动),首尾空白去掉', () => {
    expect(markdownToPlainText('普通一段话,没有任何记号。\n')).toBe('普通一段话,没有任何记号。');
    expect(markdownToPlainText('话题 #标签 保留')).toBe('话题 #标签 保留');
    expect(markdownToPlainText('变量 user_name 保留')).toBe('变量 user_name 保留');
  });

  it('GFM 任务列表与表格:☐/☑ 勾选框,表格单元格 | 连接', () => {
    expect(markdownToPlainText('- [ ] 待办\n- [x] 已完成')).toBe('• ☐ 待办\n• ☑ 已完成');
    expect(markdownToPlainText('| 项 | 值 |\n| --- | --- |\n| a | 1 |')).toBe('项 | 值\na | 1');
  });
});

/**
 * markdownToSemanticHtml:语义 HTML(无内联样式),给编辑器粘贴富文本用 ——
 * Draft.js 类编辑器(知乎专栏)读粘贴 HTML 的语义标签转自己的富文本块。
 * 与 markdownToPlainText 同一 mdast 两套渲染,约定:
 * - 标签语义化:h1-h6/strong/em/del/ul/ol/blockquote/pre/code/a/img/table;
 * - 不掺任何 style(公众号通道才需要 juice 内联样式,这里是另一个形态);
 * - 转义文本、解析失败兜底转义原文包 <p>。
 */
describe('markdownToSemanticHtml · 语义 HTML', () => {
  it('块级:heading→h1-h6、paragraph→p、blockquote、hr', () => {
    expect(markdownToSemanticHtml('## 小节')).toBe('<h2>小节</h2>');
    expect(markdownToSemanticHtml('一段话')).toBe('<p>一段话</p>');
    expect(markdownToSemanticHtml('> 引文')).toBe('<blockquote><p>引文</p></blockquote>');
    expect(markdownToSemanticHtml('---')).toBe('<hr>');
  });

  it('行内:strong/em/del/code/a/img,文本经 HTML 转义', () => {
    expect(markdownToSemanticHtml('**粗**与*斜*')).toBe('<p><strong>粗</strong>与<em>斜</em></p>');
    expect(markdownToSemanticHtml('~~删~~ `x`')).toBe('<p><del>删</del> <code>x</code></p>');
    expect(markdownToSemanticHtml('见 [文档](https://a.dev)')).toBe(
      '<p>见 <a href="https://a.dev">文档</a></p>',
    );
    expect(markdownToSemanticHtml('![图](https://a.dev/x.png)')).toBe(
      '<p><img src="https://a.dev/x.png" alt="图"></p>',
    );
    expect(markdownToSemanticHtml('1 < 2 & x > y')).toBe('<p>1 &lt; 2 &amp; x &gt; y</p>');
  });

  it('列表:ul/ol,嵌套递归,GFM 任务列表项带勾选标记', () => {
    expect(markdownToSemanticHtml('- 甲\n- 乙')).toBe('<ul><li><p>甲</p></li><li><p>乙</p></li></ul>');
    expect(markdownToSemanticHtml('1. 一\n2. 二')).toBe('<ol><li><p>一</p></li><li><p>二</p></li></ol>');
    expect(markdownToSemanticHtml('- [ ] 待办\n- [x] 已办')).toBe(
      '<ul><li class="task-list-item"><p>待办</p></li><li class="task-list-item" checked><p>已办</p></li></ul>',
    );
  });

  it('代码块:pre>code,内容转义保留', () => {
    expect(markdownToSemanticHtml('```\nif (a<b) {}\n```')).toBe(
      '<pre><code>if (a&lt;b) {}</code></pre>',
    );
  });

  it('GFM 表格 → table>tbody>tr>td(知乎编辑器自行解释,接管后可调整)', () => {
    expect(markdownToSemanticHtml('| a | b |\n| --- | --- |\n| 1 | 2 |')).toBe(
      '<table><tbody><tr><td>a</td><td>b</td></tr><tr><td>1</td><td>2</td></tr></tbody></table>',
    );
  });
});
