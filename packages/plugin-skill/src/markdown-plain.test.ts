import { describe, it, expect } from 'vitest';
import { markdownToPlainText } from './markdown-plain';


/**
 * Markdown → 纯文本(知乎草稿投递,2026-10 生产实例:insertText 原样灌入
 * Markdown 源文,草稿里满屏井号/星号/连字符记号)。转换目标:记号剥除、
 * 结构保留为可读行 —— 列表转 •、链接保地址、代码块内容原样、连续空行压一行。
 */

describe('markdownToPlainText', () => {
  it('井号标题剥记号保留文字行', () => {
    expect(markdownToPlainText('## 为什么是架构\n正文')).toBe('为什么是架构\n正文');
    expect(markdownToPlainText('###### 六级也一样')).toBe('六级也一样');
    // 行中 # 不动(话题标签语义),行首无空格后跟文字才是标题
    expect(markdownToPlainText('话题 #标签 保留')).toBe('话题 #标签 保留');
  });

  it('无序列表转 •,嵌套缩进保留;有序列表保留编号', () => {
    expect(markdownToPlainText('- 第一项\n- 第二项')).toBe('• 第一项\n• 第二项');
    expect(markdownToPlainText('* 星号项\n+ 加号项')).toBe('• 星号项\n• 加号项');
    expect(markdownToPlainText('父项\n  - 嵌套项')).toBe('父项\n  • 嵌套项');
    expect(markdownToPlainText('1. 第一\n2. 第二')).toBe('1. 第一\n2. 第二');
  });

  it('加粗/斜体/行内代码记号剥除,文字保留', () => {
    expect(markdownToPlainText('这是**重点**内容')).toBe('这是重点内容');
    expect(markdownToPlainText('__粗体__与*斜体*')).toBe('粗体与斜体');
    expect(markdownToPlainText('调用 `npm run` 即可')).toBe('调用 npm run 即可');
    // 单下划线不剥(snake_case 词不误伤)
    expect(markdownToPlainText('变量 user_name 保留')).toBe('变量 user_name 保留');
  });

  it('链接转「文字(地址)」,图片转占位锚点', () => {
    expect(markdownToPlainText('见 [官方文档](https://example.com/docs)')).toBe(
      '见 官方文档(https://example.com/docs)',
    );
    expect(markdownToPlainText('前 ![架构图](https://x.com/a.png) 后')).toBe('前 (图片:架构图) 后');
  });

  it('引用剥 >,水平线转 ———,连续空行压成一行,首尾去空白', () => {
    expect(markdownToPlainText('> 引文一行')).toBe('引文一行');
    expect(markdownToPlainText('上段\n\n\n\n下段')).toBe('上段\n\n下段');
    expect(markdownToPlainText('  \n\n---\n\n  ')).toBe('———');
  });

  it('围栏代码块:栏行丢弃、块内容原样(行内记号不剥)', () => {
    const md = '说明\n\n```ts\nconst x = `t`;\nif (a ** b) {}\n```\n\n后续';
    expect(markdownToPlainText(md)).toBe('说明\n\nconst x = `t`;\nif (a ** b) {}\n\n后续');
  });

  it('整篇典型文章:所有记号清干净,结构可读', () => {
    const md = [
      '# 主标题',
      '',
      '**开篇**一句话,含 [引用](https://a.b/c)。',
      '',
      '## 第一节',
      '',
      '- 要点一',
      '- 要点二 `code`',
      '',
      '结尾段。',
    ].join('\n');
    const out = markdownToPlainText(md);
    expect(out).not.toMatch(/(^|\n)#|\*\*|\n- /);
    expect(out).toContain('• 要点一');
    expect(out).toContain('第一节');
    expect(out).toContain('引用(https://a.b/c)');
  });
});
