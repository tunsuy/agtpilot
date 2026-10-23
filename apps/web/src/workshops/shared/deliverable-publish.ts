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
 * 解析器(article-package / note-package / oss-opportunity)从最终答复里抽出成品
 * (机会清单额外倒扫 steps:步数耗尽时最终答复可能是散文总结,清单留在中间 step),
 * 渲染成干净的 Markdown 交付文档;纯文本工坊(视频脚本/微博文案,text-deliverable)
 * 无包解析器,契约字段头文本本身即交付件,原样落库(同样倒扫 steps 取源)。
 * agent-backend 的 done 收尾据此调 ArtifactService
 * 发布一份 markdown 产物 —— 走的是与 artifact_render 完全相同的落地通路
 * (mission.artifact + 广播持久化),模型不必回显、不撑上下文,卡片与交付物同源同步。
 *
 * 纯函数,无 React/浏览器依赖,便于以固定样例做契约测试。
 */
import { parseArticlePackages, type ArticlePackage } from './article-package';
import { parseNotePackages, type NotePackage } from '../xhs/note-package';
import { parseOssOpportunities } from '../oss_radar/opportunities';

/** 可自动落交付库的交付物类型(与工坊 artifacts 声明的 kind 同一套字面量) */
export type DeliverableKind =
  | 'article-package'
  | 'note-package'
  | 'oss-opportunity'
  /** 纯文本成品(视频脚本/微博文案):无包解析器,最终答复本身即交付件 */
  | 'text-deliverable';

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
 * text-deliverable 入库最小长度(字符):短于此的答复不可能是完整脚本/文案
 * (拒答、失败说明、一句话总结),不落库凑数 —— 与包类「解析不出绝不发布」同原则。
 */
const TEXT_DELIVERABLE_MIN_CHARS = 80;

/** 契约锚检测:视频脚本带【标题】、微博文案带【正文】(prompt.main.md 输出契约) */
function hasTextContractAnchor(text: string): boolean {
  return /【(标题|正文)】/.test(text);
}

/** 包解析分发(article/note 共用):倒扫门槛与最终渲染吃同一批 packages,只解析一次 */
function parseContentPackages(kind: 'article-package' | 'note-package', text: string) {
  return kind === 'article-package'
    ? parseArticlePackages(text).packages
    : parseNotePackages(text).packages;
}

/**
 * 按交付物类型从最终答复抽取成品并渲染成一份交付文档。
 *
 * - kind='article-package' 走文章包解析器(知乎/公众号);'note-package' 走笔记包解析器
 *   (小红书);'oss-opportunity' 走机会清单解析器(开源雷达),交付正文即清单原文
 *   (卡片解析器同源契约格式),count=机会条数。
 * - kind='text-deliverable'(视频脚本/微博文案):无包解析器,契约字段头文本本身
 *   即交付件,原样落库不重渲染;必须含契约锚(【标题】/【正文】)且达到最小长度,
 *   否则视为非成品(拒答/散文总结/失败答复)→ null 绝不发布。步数耗尽强制总结时
 *   成品可能留在中间 step,与 oss 同款倒扫 stepAnswers 取源。
 * - 解析不出任何包(非成品格式:选题清单 / 自由文本 / 空答复)→ null,绝不发布
 *   (绝不把非成品当交付件,也绝不为凑数发布空文档)。
 * - fallbackTitle 用于多篇合并、或单篇标题缺失时的兜底标题(通常传任务名)。
 * - stepAnswers 为本轮各步答复(按序),各 kind 倒扫取源用:oss 无条件倒扫,
 *   text-deliverable 锚缺失才倒扫,article/note 最终答复解析不出包才倒扫。
 */
export function buildWorkshopDeliverable(
  kind: DeliverableKind,
  finalAnswer: string,
  fallbackTitle: string,
  stepAnswers?: ReadonlyArray<string | undefined>
): WorkshopDeliverable | null {
  // oss 机会清单:步数耗尽强制总结时最终答复是散文,真清单留在中间 step ——
  // 倒扫 stepAnswers 取最后一段能解析出清单的 answer;不命中回落 finalAnswer
  // (解析有效性门槛与卡片同源:解析不出清单绝不发布)。
  let source = finalAnswer || '';
  if (kind === 'oss-opportunity' && stepAnswers) {
    for (let i = stepAnswers.length - 1; i >= 0; i--) {
      const a = stepAnswers[i];
      if (a && parseOssOpportunities(a).opportunities.length > 0) {
        source = a;
        break;
      }
    }
  }
  if (kind === 'oss-opportunity') {
    const opportunities = parseOssOpportunities(source).opportunities;
    if (opportunities.length === 0) return null;
    // 清单原文即契约格式(卡片解析器同源),原样保留不重渲染
    return { title: fallbackTitle, content: source.trim(), count: opportunities.length };
  }
  if (kind === 'text-deliverable') {
    // 视频脚本/微博文案:契约字段头文本本身即交付件(【标题】/【正文】锚),
    // 原样落库不重渲染。锚缺失 = 非成品(拒答/散文总结),绝不发布。
    let text = (finalAnswer || '').trim();
    if (!hasTextContractAnchor(text) && stepAnswers) {
      // 步数耗尽强制总结时成品留在中间 step:倒扫取最后一段带锚的答复(oss 同款)
      for (let i = stepAnswers.length - 1; i >= 0; i--) {
        const a = (stepAnswers[i] || '').trim();
        if (a && hasTextContractAnchor(a) && a.length >= TEXT_DELIVERABLE_MIN_CHARS) {
          text = a;
          break;
        }
      }
    }
    if (!hasTextContractAnchor(text) || text.length < TEXT_DELIVERABLE_MIN_CHARS) return null;
    // 条数:契约约定条目间以 --- 分隔(视频「脚本之间」/微博「条与条之间」同一约定)
    const parts = text.split(/\n\s*---\s*\n/).filter((p) => p.trim());
    // 标题:单条视频脚本取【标题】锚行;多条或无标题字段(微博)回落任务名
    const firstTitle =
      parts.length === 1 ? text.match(/【标题】\s*\n?\s*([^\n【]+)/)?.[1]?.trim() || '' : '';
    return {
      title: firstTitle || fallbackTitle,
      content: text,
      count: Math.max(parts.length, 1),
    };
  }
  // 只解析一次:titles[0] 取标题、渲染取正文,复用同一批 packages。
  // 续聊轮步数耗尽强制总结时,最终答复可能是散文收尾,成稿留在中间 step ——
  // 仅当最终答复解析不出包才倒扫 stepAnswers(与 text-deliverable 的锚门槛同原则;
  // 解析得出不倒扫,绝不无谓改写取源)
  let packages = parseContentPackages(kind, source);
  if (packages.length === 0 && stepAnswers) {
    for (let i = stepAnswers.length - 1; i >= 0; i--) {
      const a = stepAnswers[i];
      if (a && parseContentPackages(kind, a).length > 0) {
        source = a;
        packages = parseContentPackages(kind, source);
        break;
      }
    }
  }
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
