import { describe, it, expect } from 'vitest';
import { renderWechatMarkdown } from '../wechat-md-render';
import { WECHAT_MD_THEMES, DEFAULT_WECHAT_MD_THEME_ID } from '../wechat-md-themes';

const MD = [
  '# 标题一',
  '',
  '正文段落,包含**加粗**与*斜体*和 `inline_code`。',
  '',
  '## 二级标题',
  '',
  '> 引用块内容',
  '',
  '- 列表项 A',
  '- 列表项 B',
  '',
  '```js',
  'const x = "hello"; // 注释',
  '```',
  '',
  '参考[示例站点](https://example.com)与[同站](https://example.com)和[另一站](https://other.com)。',
].join('\n');

describe('renderWechatMarkdown · 主题与内联', () => {
  it('默认主题:样式全部内联,无残留 style 标签/class 依赖', () => {
    const html = renderWechatMarkdown(MD);
    expect(html).toContain('<section class="wr"');
    // 段落吃上主题内联样式(公众号编辑器剥 class,只认 style)
    expect(html).toMatch(/<p style="[^"]*font-size: ?15px/);
    // 主题选择器已内联:不再输出 <style> 块
    expect(html).not.toMatch(/<style/);
  });

  it('指定主题生效(科技蓝 h2 色值内联)', () => {
    const html = renderWechatMarkdown('## 标题', 'tech-blue');
    expect(html).toMatch(/<h2 style="[^"]*color: ?#174ea6/);
  });

  it('微信绿主题 h2 走左侧色条', () => {
    const html = renderWechatMarkdown('## 标题', 'classic-green');
    expect(html).toMatch(/<h2 style="[^"]*border-left: ?5px solid #07c160/);
  });

  it('未注册主题 id 兜底默认主题(排版不崩)', () => {
    const fallback = renderWechatMarkdown('## 标题', 'no-such-theme');
    const def = renderWechatMarkdown('## 标题', DEFAULT_WECHAT_MD_THEME_ID);
    expect(fallback).toBe(def);
  });

  it('全部主题 id 可用且各不相同', () => {
    const ids = WECHAT_MD_THEMES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      expect(renderWechatMarkdown('# x', id)).toContain('font-size: 15px');
    }
  });
});

describe('renderWechatMarkdown · 公众号特有处理', () => {
  it('外链转脚注:正文无 <a>,上标序号 + 文末参考链接段', () => {
    const html = renderWechatMarkdown(MD);
    expect(html).not.toMatch(/<a\s/);
    expect(html).toContain('参考链接');
    // 外链渲染为「文本[上标序号]」(sup 带 juice 内联样式);序号同 href 复用、不同 href 递增
    expect(html).toMatch(/<sup style="[^"]*">\[1\]<\/sup>/);
    expect(html).toMatch(/<sup style="[^"]*">\[2\]<\/sup>/);
    expect(html).not.toMatch(/<sup[^>]*>\[3\]<\/sup>/);
    // URL 以纯文本出现在脚注段
    expect(html).toContain('https://example.com');
    expect(html).toContain('https://other.com');
  });

  it('代码块:深色容器 + 语法高亮色值内联进 span', () => {
    const html = renderWechatMarkdown(MD);
    expect(html).toMatch(/<pre style="[^"]*background: ?#282c34/);
    // js 高亮:字符串字面量着色(hljs-string → #98c379 内联;span 带 class 在 style 前)
    expect(html).toMatch(/<span [^>]*color: ?#98c379/);
  });

  it('内联代码带背景色', () => {
    const html = renderWechatMarkdown('用 `pip install` 安装');
    expect(html).toMatch(/<code style="[^"]*background: ?#f0faf4/);
  });

  it('单换行成 <br>(公众号短段落习惯)', () => {
    const html = renderWechatMarkdown('第一行\n第二行');
    expect(html).toContain('<br>');
  });

  it('内嵌 HTML 被转义(防注入)', () => {
    const html = renderWechatMarkdown('看看 <script>alert(1)</script> 结束');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('引用块吃上主题背景色', () => {
    const html = renderWechatMarkdown('> 引用', 'tech-blue');
    expect(html).toMatch(/<blockquote style="[^"]*background: ?#eef4fd/);
  });

  it('表格渲染为带边框表格', () => {
    const html = renderWechatMarkdown('| a | b |\n| --- | --- |\n| 1 | 2 |');
    expect(html).toContain('<table style=');
    expect(html).toContain('<th style=');
  });
});
