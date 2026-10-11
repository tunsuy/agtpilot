/**
 * 公众号 Markdown 排版渲染器(doocs/md 式:markdown-it + 主题 CSS + juice 内联)
 *
 * 公众号编辑器剥掉 <style> 与 class,只有内联样式能存活——渲染分四步:
 * ① markdown-it 解析(单换行成 <br>,符合公众号短段落习惯;禁内嵌 HTML 防注入)
 * ② 外链转脚注:公众号正文里 <a> 不可点击,渲染为「文本[1]」+ 文末参考链接段
 * ③ 代码块 highlight.js 语法高亮(输出 span class,下一步内联成色值)
 * ④ juice 把主题 CSS(wechat-md-themes.ts)内联到每个元素
 *
 * 纯函数、服务端执行(wechat_mp_create_draft 工具与邮件渲染共用),可单测。
 */
import MarkdownIt from 'markdown-it';
import hljs from 'highlight.js';
import juice from 'juice';
import { getWechatMdTheme } from './wechat-md-themes';

interface RenderEnv {
  // markdown-it 15 自带类型要求 Env 兼容 string|symbol 索引签名
  [key: string | symbol]: unknown;
  /** 外链脚注收集:href → 序号(从 1 起,同 href 复用序号) */
  links: Map<string, number>;
}

const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const md = new MarkdownIt({
  html: false, // Agent 产出按纯 Markdown 处理,防 HTML 注入
  linkify: true, // 裸 URL 自动成链接 → 统一走脚注
  breaks: true, // 单换行成 <br>(公众号段落习惯,与旧渲染器行为一致)
  highlight: (str: string, lang: string): string => {
    const language = (lang || '').trim().toLowerCase();
    if (language && hljs.getLanguage(language)) {
      try {
        return `<pre><code class="hljs language-${language}">${hljs.highlight(str, { language, ignoreIllegals: true }).value}</code></pre>`;
      } catch {
        // 高亮失败走纯文本转义
      }
    }
    return `<pre><code class="hljs">${escapeHtml(str)}</code></pre>`;
  },
});

// ---- 外链转脚注:覆盖 link 渲染规则(正文渲染为带色文本 + 上标序号) ----
// markdown 语法不允许链接嵌套,close 向前找最近的 link_open 取其序号即可配对
md.renderer.rules.link_open = (tokens, idx, _options, env: any) => {
  const e = env as RenderEnv | undefined;
  const links = (e && e.links) || new Map<string, number>();
  if (e && !e.links) e.links = links;
  // attrGet 自带类型返回 string|number|null,统一收窄成 string
  const href = String(tokens[idx].attrGet('href') || '');
  let n = links.get(href);
  if (!n) {
    n = links.size + 1;
    links.set(href, n);
  }
  tokens[idx].meta = { ...(tokens[idx].meta || {}), fn: n };
  return '<span class="wx-link">';
};
md.renderer.rules.link_close = (tokens, idx) => {
  for (let j = idx - 1; j >= 0; j--) {
    const fn = (tokens[j] as any)?.meta?.fn;
    if (tokens[j].type === 'link_open' && fn) {
      return `<sup>[${fn}]</sup></span>`;
    }
  }
  return '</span>';
};

/**
 * 渲染入口:Markdown → 带内联样式、可直贴公众号编辑器的 HTML。
 * themeId 未注册时兜底默认主题(getWechatMdTheme 保证,Agent 传错参数排版不崩)。
 */
export function renderWechatMarkdown(mdText: string, themeId?: string): string {
  const theme = getWechatMdTheme(themeId);
  const env: RenderEnv = { links: new Map() };
  let html = md.render(String(mdText || ''), env);

  // 外链脚注段:正文所有链接已转序号标记,文末列出真实 URL(纯文本,不可点)
  if (env.links.size > 0) {
    const items = Array.from(env.links.entries())
      .map(([url, n]) => `<p class="footnote-item">[${n}] ${escapeHtml(url)}</p>`)
      .join('');
    html += `<hr><p class="footnote-title">参考链接</p>${items}`;
  }

  // 作用域包裹 + juice 内联:主题 CSS 经 extraCss 注入,.wr 前缀选择器
  // 全部落成 style 属性(源 HTML 无 <style> 块,无需 removeStyleTags)
  const wrapped = `<section class="wr">${html}</section>`;
  return juice(wrapped, { extraCss: theme.css });
}
