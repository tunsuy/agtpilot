/**
 * 内容工坊成品 → 交付库落地(服务端收尾自动发布)。
 *
 * 背景(生产实测:知乎工坊成稿不进「交付物」库):内容工坊(知乎/公众号/小红书)
 * 的成品历来只由前端按【字段头】契约解析成「对话流里的包卡片」(CockpitView),
 * 全程不写 mission.artifact —— 而「交付物」库(DeliverablesView)与驾驶舱「最终
 * 交付物成果」画布只认 mission.artifact(仅 artifact_render 工具 / PPT 工坊发布
 * 会写)。于是内容工坊的成稿永远落不进交付库。
 *
 * 本模块把「收尾自动落地」的纯逻辑收在一处:任务结束时,服务端用与卡片同源的
 * 解析器(article-package / note-package)从最终答复里抽出成品,渲染成干净的
 * Markdown 交付文档。agent-backend 的 done 收尾据此调 ArtifactService 发布一份
 * markdown 产物 —— 走的是与 artifact_render 完全相同的落地通路(mission.artifact
 * + 广播持久化),模型不必回显、不撑上下文,卡片与交付物同源同步。
 *
 * 纯函数,无 React/浏览器依赖,便于以固定样例做契约测试。
 */
import { parseArticlePackages, type ArticlePackage } from './article-package';
import { parseNotePackages, type NotePackage } from '../xhs/note-package';

/** 可自动落交付库的包类型(与工坊 artifacts 声明的 kind 同一套字面量) */
export type DeliverableKind = 'article-package' | 'note-package';

/** 交付件发布结果(交给 ArtifactService.createOrUpdateArtifact 组装 ArtifactData) */
export interface WorkshopDeliverable {
  /** 交付文档标题:单篇 = 成品标题;多篇 = 任务名(集合) */
  title: string;
  /** 干净 Markdown 正文:单篇直出,多篇以 --- 分隔合并 */
  content: string;
  /** 成品篇数(>1 表示多篇合并为一份交付文档) */
  count: number;
}

/** 文章包 → 可读 Markdown(标题作 H1、摘要作引用块、正文原样;正文本身即 Markdown) */
function renderArticleMarkdown(pkg: ArticlePackage): string {
  const title = pkg.titles[0] || '';
  const parts: string[] = [];
  if (title) parts.push(`# ${title}`);
  if (pkg.digest) parts.push(`> ${pkg.digest}`);
  if (pkg.body) parts.push(pkg.body);
  return parts.join('\n\n');
}

/** 笔记包 → 可读 Markdown(标题作 H1、正文原样、标签串收尾) */
function renderNoteMarkdown(pkg: NotePackage): string {
  const title = pkg.titles[0] || '';
  const parts: string[] = [];
  if (title) parts.push(`# ${title}`);
  if (pkg.body) parts.push(pkg.body);
  if (pkg.tags.length > 0) parts.push(pkg.tags.map((t) => `#${t}`).join(' '));
  return parts.join('\n\n');
}

/**
 * 按交付物类型从最终答复抽取成品并渲染成一份交付文档。
 *
 * - kind='article-package' 走文章包解析器(知乎/公众号);'note-package' 走笔记包解析器(小红书)。
 * - 解析不出任何包(非成品格式:选题清单 / 自由文本 / 空答复)→ null,绝不发布
 *   (绝不把非成品当交付件,也绝不为凑数发布空文档)。
 * - fallbackTitle 用于多篇合并、或单篇标题缺失时的兜底标题(通常传任务名)。
 */
export function buildWorkshopDeliverable(
  kind: DeliverableKind,
  finalAnswer: string,
  fallbackTitle: string
): WorkshopDeliverable | null {
  const source = finalAnswer || '';
  // 只解析一次:titles[0] 取标题、渲染取正文,复用同一批 packages
  const packages =
    kind === 'article-package'
      ? parseArticlePackages(source).packages
      : parseNotePackages(source).packages;
  if (packages.length === 0) return null;

  const rendered =
    kind === 'article-package'
      ? (packages as ArticlePackage[]).map(renderArticleMarkdown)
      : (packages as NotePackage[]).map(renderNoteMarkdown);
  const firstTitle = packages[0]?.titles[0] || '';
  const title = rendered.length === 1 ? firstTitle || fallbackTitle : fallbackTitle;

  return {
    title,
    content: rendered.join('\n\n---\n\n'),
    count: rendered.length,
  };
}
