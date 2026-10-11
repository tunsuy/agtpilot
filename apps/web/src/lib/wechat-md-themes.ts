/**
 * 公众号排版主题库(doocs/md 式主题体系在 AgtPilot 的落地)
 *
 * 公众号编辑器会剥掉 <style> 块与 class 样式,主题必须以「CSS 原文」描述、
 * 渲染时经 juice 内联到每个元素的 style 上才能存活——因此主题就是一段
 * 选择器全部以 .wr 作用域前缀的纯 CSS 字符串,由 wechat-md-render.ts 消费。
 *
 * 新增主题:在本文件加一个 WechatMdTheme 即可,工坊表单/工具入参自动带上。
 */

export interface WechatMdTheme {
  id: string;
  /** 展示名(工坊表单 chip 文案) */
  name: string;
  /** 主题 CSS;选择器一律以 .wr 前缀,渲染时内联进 HTML */
  css: string;
}

/** 深色代码块的语法高亮配色(各主题共享,公众号深色代码块是主流观感) */
const CODE_TOKENS_CSS = `
.wr .hljs { color: #abb2bf; }
.wr .hljs-comment, .wr .hljs-quote { color: #5c6370; font-style: italic; }
.wr .hljs-keyword, .wr .hljs-tag, .wr .hljs-selector-tag { color: #c678dd; }
.wr .hljs-string, .wr .hljs-doctag, .wr .hljs-regexp { color: #98c379; }
.wr .hljs-number, .wr .hljs-literal, .wr .hljs-symbol { color: #d19a66; }
.wr .hljs-title, .wr .hljs-name, .wr .hljs-selector-id, .wr .hljs-selector-class { color: #61afef; }
.wr .hljs-attr, .wr .hljs-attribute, .wr .hljs-variable, .wr .hljs-template-variable { color: #d19a66; }
.wr .hljs-built_in, .wr .hljs-builtin-name, .wr .hljs-type { color: #e6c07b; }
.wr .hljs-meta, .wr .hljs-section, .wr .hljs-emphasis { font-style: italic; }
.wr .hljs-strong { font-weight: bold; }
`;

/** 深色代码块容器(共享) */
const CODE_BLOCK_CSS = `
.wr pre {
  background: #282c34;
  color: #abb2bf;
  padding: 14px 16px;
  border-radius: 8px;
  font-size: 13px;
  line-height: 1.6;
  margin: 14px 0;
  overflow-x: auto;
  font-family: "SFMono-Regular", Consolas, "Liberation Mono", Menlo, Courier, monospace;
  white-space: pre;
}
.wr pre code {
  background: none;
  padding: 0;
  border-radius: 0;
  color: inherit;
  font-size: inherit;
}
`;

/** 脚注区(外链转脚注后追加的「参考链接」段,链接色已在 baseCss 以 .wx-link 落定) */
const FOOTNOTE_BASE_CSS = `
.wr sup { font-size: 12px; line-height: 0; }
.wr .footnote-title {
  font-size: 14px;
  font-weight: bold;
  margin: 20px 0 8px;
}
.wr .footnote-item {
  font-size: 13px;
  color: #888;
  line-height: 1.6;
  margin: 4px 0;
  word-break: break-all;
}
`;

/** 共享基础排版(段落/列表/表格/图/分割线),主题差异色以占位变量表达 */
function baseCss(vars: { link: string; hr: string }): string {
  return `
.wr {
  font-size: 15px;
  color: #3f3f3f;
  letter-spacing: 0.3px;
  line-height: 1.8;
  word-wrap: break-word;
}
.wr p { font-size: 15px; margin: 12px 0; }
.wr h1 { font-size: 20px; margin: 24px 0 12px; font-weight: bold; line-height: 1.4; }
.wr h2 { font-size: 18px; margin: 22px 0 10px; font-weight: bold; line-height: 1.4; }
.wr h3 { font-size: 16px; margin: 18px 0 8px; font-weight: bold; line-height: 1.4; }
.wr h4 { font-size: 15px; margin: 16px 0 6px; font-weight: bold; line-height: 1.4; }
.wr ul, .wr ol { margin: 12px 0; padding-left: 24px; }
.wr li { font-size: 15px; margin: 6px 0; }
.wr strong { font-weight: bold; }
.wr em { font-style: italic; }
.wr img { max-width: 100%; border-radius: 8px; display: block; margin: 12px auto; }
.wr hr { border: none; border-top: 1px solid ${vars.hr}; margin: 20px 0; }
.wr table { border-collapse: collapse; width: 100%; margin: 14px 0; font-size: 14px; }
.wr th, .wr td { border: 1px solid #e5e5e5; padding: 8px 10px; }
.wr th { background: #f7f7f7; font-weight: bold; }
.wx-link { color: ${vars.link}; }
${FOOTNOTE_BASE_CSS}
`;
}

/** 内联代码样式(主题差异) */
const inlineCode = (bg: string, color: string) => `
.wr code {
  background: ${bg};
  color: ${color};
  padding: 2px 5px;
  border-radius: 4px;
  font-size: 14px;
  font-family: "SFMono-Regular", Consolas, "Liberation Mono", Menlo, Courier, monospace;
}
`;

export const WECHAT_MD_THEMES: WechatMdTheme[] = [
  {
    id: 'classic-green',
    name: '微信绿',
    css: `${baseCss({ link: '#07c160', hr: '#d9f2e3' })}${inlineCode('#f0faf4', '#c7254e')}${CODE_BLOCK_CSS}${CODE_TOKENS_CSS}
.wr h1 { border-left: 5px solid #07c160; padding-left: 12px; }
.wr h2 { border-left: 5px solid #07c160; padding-left: 12px; color: #1a7a43; }
.wr h3 { color: #1a7a43; }
.wr strong { color: #1a7a43; }
.wr blockquote {
  background: #f0faf4;
  border-left: 4px solid #07c160;
  border-radius: 0 8px 8px 0;
  padding: 10px 14px;
  color: #5b6f62;
  margin: 14px 0;
}
.wr blockquote p { margin: 0; line-height: 1.7; }
.wr .footnote-title { color: #1a7a43; border-left: 3px solid #07c160; padding-left: 8px; }
`,
  },
  {
    id: 'tech-blue',
    name: '科技蓝',
    css: `${baseCss({ link: '#1f6fd6', hr: '#e3edfb' })}${inlineCode('#eef4fd', '#1f6fd6')}${CODE_BLOCK_CSS}${CODE_TOKENS_CSS}
.wr h1 { color: #174ea6; border-bottom: 2px solid #1f6fd6; padding-bottom: 8px; }
.wr h2 { color: #174ea6; border-bottom: 1px solid #d5e3f8; padding-bottom: 6px; }
.wr h3 { color: #1f6fd6; }
.wr strong { color: #174ea6; }
.wr blockquote {
  background: #eef4fd;
  border-left: 4px solid #1f6fd6;
  border-radius: 0 8px 8px 0;
  padding: 10px 14px;
  color: #4a5b76;
  margin: 14px 0;
}
.wr blockquote p { margin: 0; line-height: 1.7; }
.wr .footnote-title { color: #174ea6; }
`,
  },
  {
    id: 'warm-orange',
    name: '暖橙',
    css: `${baseCss({ link: '#d4821a', hr: '#f7e8d4' })}${inlineCode('#fdf3e7', '#c05a10')}${CODE_BLOCK_CSS}${CODE_TOKENS_CSS}
.wr h1 { color: #b35c0a; }
.wr h2 { color: #d4821a; border-left: 5px solid #f0a24b; padding-left: 12px; }
.wr h3 { color: #b35c0a; }
.wr strong { color: #b35c0a; }
.wr blockquote {
  background: #fdf5ec;
  border-left: 4px solid #f0a24b;
  border-radius: 0 8px 8px 0;
  padding: 10px 14px;
  color: #7a6248;
  margin: 14px 0;
}
.wr blockquote p { margin: 0; line-height: 1.7; }
.wr .footnote-title { color: #b35c0a; }
`,
  },
  {
    id: 'ink-minimal',
    name: '极简黑白',
    css: `${baseCss({ link: '#576b95', hr: '#e5e5e5' })}${inlineCode('#f5f5f5', '#c7254e')}${CODE_BLOCK_CSS}${CODE_TOKENS_CSS}
.wr h1 { text-align: center; letter-spacing: 2px; margin: 28px 0 16px; color: #111; }
.wr h2 { text-align: center; letter-spacing: 1px; color: #111; margin: 26px 0 12px; }
.wr h3 { color: #111; }
.wr strong { color: #111; }
.wr blockquote {
  border-left: 3px solid #c9c9c9;
  padding: 8px 14px;
  color: #888;
  margin: 14px 0;
  background: #fafafa;
}
.wr blockquote p { margin: 0; line-height: 1.7; }
.wr .footnote-title { color: #111; }
`,
  },
];

export const DEFAULT_WECHAT_MD_THEME_ID = 'classic-green';

/** 按 id 取主题;未注册 id 兜底默认主题(Agent 传错参数不致排版崩坏) */
export function getWechatMdTheme(id?: string): WechatMdTheme {
  const t = (id || '').trim().toLowerCase();
  return WECHAT_MD_THEMES.find((x) => x.id === t) || WECHAT_MD_THEMES[0];
}
