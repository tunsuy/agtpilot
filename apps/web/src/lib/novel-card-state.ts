/**
 * 小说卡片「已在书库」派生(纯函数,客户端安全 —— 无 fs/网络,只吃书库列表摘要)
 *
 * 背景:卡片 saved 态此前只存组件内 useState,重挂载(重开聊天历史/刷新页面)即
 * 复位 —— 「存入书库」又能点、链式按钮(生成大纲/写下一章)和日更订阅入口全部
 * 消失。服务端已有 existed 幂等兜底(同名不重复建书),显示侧这里从书库列表把
 * 「本包内容已在库里」的事实派生出来,历史卡片直接呈现已入库态并可续操作。
 *
 * 派生只影响显示与操作入口,不引入任何新写路径;语义是「这本书已在库里且已
 * 覆盖本包内容」,而不是「本次点击成功」。
 */
import type { NovelBookSummary } from './novel-context';

/** 派生命中时回填 SaveState 用的进度快照(与 /api/novels 返回的 progress 同构) */
export interface DerivedBookState {
  bookId: string;
  chapterCount: number;
  wordCount: number;
  nextChapter: number;
  reviewDue?: boolean;
}

function toDerived(b: NovelBookSummary): DerivedBookState {
  return {
    bookId: b.bookId,
    chapterCount: b.progress.chapterCount,
    wordCount: b.progress.wordCount,
    nextChapter: b.progress.nextChapter,
    ...(b.reviewDue ? { reviewDue: true } : {}),
  };
}

/**
 * 设定包/旧开书包:书名精确匹配 → 已建书。
 * 同名多本取 updatedAt 最新者 —— 与服务端 findNovelBookByTitle 幂等键同一口径,
 * 保证卡片显示与「再点一次存入书库会发生什么」一致。
 *
 * 卖点(premise)一致性门槛:同名但卖点不同的书是「另一套设定」——重跑开书
 * 生成的新设定包,库里那本同名旧书并没有这份内容(create 幂等只回书号不写内容)。
 * 双方卖点都非空且不一致时不派生 saved(按钮保持可点,点击后由服务端 existed
 * 回执给出「未写入」的诚实提示),避免卡片谎称「已在书库」而书库躺着旧设定。
 * 任一侧卖点为空(历史包/旧数据)退回纯书名匹配,不误伤。
 */
export function deriveBibleSaved(
  pkg: { title: string; premise?: string },
  books: NovelBookSummary[] | null
): DerivedBookState | null {
  if (!books) return null;
  const title = String(pkg.title || '').trim();
  if (!title) return null;
  const premise = String(pkg.premise || '').trim();
  let best: NovelBookSummary | null = null;
  for (const b of books) {
    if (String(b.title || '').trim() !== title) continue;
    const bookPremise = String(b.premise || '').trim();
    if (premise && bookPremise && premise !== bookPremise) continue;
    if (!best || b.updatedAt > best.updatedAt) best = b;
  }
  return best ? toDerived(best) : null;
}

/**
 * 大纲包:书号命中书库且该书已合并大纲(hasOutline)→ 已入库。
 * 回显书号未命中(书被删/串书)时不派生 —— 归属未定绝不猜,仍走下拉指认流程。
 */
export function deriveOutlineSaved(
  pkg: { bookId: string },
  books: NovelBookSummary[] | null
): DerivedBookState | null {
  if (!books) return null;
  const bookId = String(pkg.bookId || '').trim();
  if (!bookId) return null;
  const hit = books.find((b) => b.bookId === bookId);
  return hit && hit.hasOutline ? toDerived(hit) : null;
}

/**
 * 续写包:书号命中且 chapterCount ≥ 自称章号 → 视为本章已入库
 * (无 claimedIndex 时退化为「书已有章节」)。
 *
 * 已知且有意接受的显示级误判:后续章节会抬高 chapterCount,让某章实际从未入库
 * 的历史卡片也显示「已在书库」。数据面无风险 —— 服务端 append 恒按
 * progress.nextChapter 落章,重复保存不可能写重内容;误判只影响徽标文案。
 * 卡片是历史入口,语义取「这本书已写到第 N 章之后」足够诚实。
 */
export function deriveContinueSaved(
  pkg: { bookId: string; claimedIndex?: number },
  books: NovelBookSummary[] | null
): DerivedBookState | null {
  if (!books) return null;
  const bookId = String(pkg.bookId || '').trim();
  if (!bookId) return null;
  const hit = books.find((b) => b.bookId === bookId);
  if (!hit) return null;
  const claimed = Number(pkg.claimedIndex) || 0;
  const covered = claimed > 0 ? hit.progress.chapterCount >= claimed : hit.progress.chapterCount > 0;
  return covered ? toDerived(hit) : null;
}

/**
 * 序章包:书号命中书库且该书已有序章(hasPrologue)→ 已入库。
 * 回显书号未命中(书被删/串书)时不派生 —— 归属未定绝不猜,仍走下拉指认流程。
 * 序章是一次性槽位(已存在即拒绝覆盖),不存在「后章抬高计数」的模糊地带。
 */
export function derivePrologueSaved(
  pkg: { bookId: string },
  books: NovelBookSummary[] | null
): DerivedBookState | null {
  if (!books) return null;
  const bookId = String(pkg.bookId || '').trim();
  if (!bookId) return null;
  const hit = books.find((b) => b.bookId === bookId);
  return hit && hit.hasPrologue ? toDerived(hit) : null;
}
