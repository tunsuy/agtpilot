import { describe, it, expect } from 'vitest';
import { markdownToPlainText } from './markdown-plain';

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
