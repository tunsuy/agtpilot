/**
 * novel-card-state 派生矩阵(提交 4 · 卡片「已在书库」回填的显示层口径)
 *
 * 派生只吃书库摘要(NovelBookSummary),不触网不触盘;这里锁死三张卡各自的
 * 命中/不命中边界,尤其是续写包「后章抬高计数」的显示级误判口径(有意接受,
 * 数据面由服务端 append 恒按 nextChapter 落章兜底)。
 */
import { describe, expect, it } from 'vitest';
import {
  deriveBibleSaved,
  deriveContinueSaved,
  deriveOutlineSaved,
  derivePrologueSaved,
} from '../novel-card-state';
import type { NovelBookSummary } from '../novel-context';

function mkBook(over: Partial<NovelBookSummary> = {}): NovelBookSummary {
  return {
    bookId: 'nv_1',
    title: '书A',
    genre: '仙侠',
    premise: '',
    status: 'active',
    createdAt: 1000,
    updatedAt: 1000,
    progress: { chapterCount: 3, wordCount: 9000, nextChapter: 4 },
    openForeshadows: 0,
    reviewDue: false,
    hasOutline: false,
    ...over,
  };
}

describe('deriveBibleSaved(书名精确匹配 + 卖点一致性门槛)', () => {
  it('books 未加载(null)→ 不派生', () => {
    expect(deriveBibleSaved({ title: '书A' }, null)).toBeNull();
  });

  it('书名未命中 → 不派生', () => {
    expect(deriveBibleSaved({ title: '书B' }, [mkBook()])).toBeNull();
  });

  it('命中 → 回填进度快照', () => {
    const d = deriveBibleSaved({ title: '书A' }, [mkBook()]);
    expect(d).toEqual({ bookId: 'nv_1', chapterCount: 3, wordCount: 9000, nextChapter: 4 });
  });

  it('同名多本取 updatedAt 最新者(与服务端 findNovelBookByTitle 同口径)', () => {
    const books = [
      mkBook({ bookId: 'nv_old', updatedAt: 100 }),
      mkBook({ bookId: 'nv_new', updatedAt: 200 }),
      mkBook({ bookId: 'nv_mid', updatedAt: 150 }),
    ];
    expect(deriveBibleSaved({ title: '书A' }, books)?.bookId).toBe('nv_new');
  });

  it('两侧书名带空白仍算精确匹配;空书名不派生', () => {
    expect(deriveBibleSaved({ title: ' 书A ' }, [mkBook({ title: ' 书A' })])?.bookId).toBe('nv_1');
    expect(deriveBibleSaved({ title: '  ' }, [mkBook()])).toBeNull();
  });

  it('reviewDue 的书带出体检提醒字段', () => {
    expect(deriveBibleSaved({ title: '书A' }, [mkBook({ reviewDue: true })])?.reviewDue).toBe(true);
  });

  it('同名但卖点不一致 → 不派生(重跑开书的新设定包,库里旧书没有这份内容)', () => {
    const books = [mkBook({ premise: '旧卖点:凡人流修仙' })];
    expect(deriveBibleSaved({ title: '书A', premise: '新卖点:系统流修仙' }, books)).toBeNull();
  });

  it('同名且卖点一致 → 照常派生', () => {
    const books = [mkBook({ premise: '凡人流修仙' })];
    expect(deriveBibleSaved({ title: '书A', premise: ' 凡人流修仙 ' }, books)?.bookId).toBe('nv_1');
  });

  it('任一侧卖点为空 → 退回纯书名匹配(历史包/旧数据不误伤)', () => {
    expect(deriveBibleSaved({ title: '书A', premise: '新卖点' }, [mkBook({ premise: '' })])?.bookId).toBe('nv_1');
    expect(deriveBibleSaved({ title: '书A' }, [mkBook({ premise: '旧卖点' })])?.bookId).toBe('nv_1');
  });

  it('同名多本:卖点冲突的排除后,余下取 updatedAt 最新者', () => {
    const books = [
      mkBook({ bookId: 'nv_conflict', premise: '另一套设定', updatedAt: 300 }),
      mkBook({ bookId: 'nv_match_old', premise: '同一套设定', updatedAt: 100 }),
      mkBook({ bookId: 'nv_match_new', premise: '同一套设定', updatedAt: 200 }),
    ];
    expect(deriveBibleSaved({ title: '书A', premise: '同一套设定' }, books)?.bookId).toBe('nv_match_new');
  });
});

describe('deriveOutlineSaved(书号命中 + 大纲已合并)', () => {
  it('books 未加载 / 书号空 → 不派生', () => {
    expect(deriveOutlineSaved({ bookId: 'nv_1' }, null)).toBeNull();
    expect(deriveOutlineSaved({ bookId: '' }, [mkBook()])).toBeNull();
  });

  it('书号未命中 → 不派生(归属未定绝不猜)', () => {
    expect(deriveOutlineSaved({ bookId: 'nv_x' }, [mkBook()])).toBeNull();
  });

  it('命中但 hasOutline=false → 不派生(这份大纲还没合进去)', () => {
    expect(deriveOutlineSaved({ bookId: 'nv_1' }, [mkBook({ hasOutline: false })])).toBeNull();
  });

  it('命中且 hasOutline=true → 已入库', () => {
    const d = deriveOutlineSaved({ bookId: 'nv_1' }, [mkBook({ hasOutline: true })]);
    expect(d?.bookId).toBe('nv_1');
    expect(d?.nextChapter).toBe(4);
  });
});

describe('deriveContinueSaved(书号命中 + 章数覆盖自称章号)', () => {
  it('books 未加载 / 书号未命中 → 不派生', () => {
    expect(deriveContinueSaved({ bookId: 'nv_1', claimedIndex: 2 }, null)).toBeNull();
    expect(deriveContinueSaved({ bookId: 'nv_x', claimedIndex: 2 }, [mkBook()])).toBeNull();
  });

  it('claimedIndex ≤ chapterCount → 已入库;> → 未入库', () => {
    expect(deriveContinueSaved({ bookId: 'nv_1', claimedIndex: 3 }, [mkBook()])?.bookId).toBe('nv_1');
    expect(deriveContinueSaved({ bookId: 'nv_1', claimedIndex: 2 }, [mkBook()])?.bookId).toBe('nv_1');
    expect(deriveContinueSaved({ bookId: 'nv_1', claimedIndex: 4 }, [mkBook()])).toBeNull();
  });

  it('无 claimedIndex → 退化为「书已有章节」', () => {
    expect(deriveContinueSaved({ bookId: 'nv_1' }, [mkBook()])?.bookId).toBe('nv_1');
    expect(
      deriveContinueSaved(
        { bookId: 'nv_1' },
        [mkBook({ progress: { chapterCount: 0, wordCount: 0, nextChapter: 1 } })]
      )
    ).toBeNull();
  });

  it('后章抬高计数 → 旧卡片显示已入库(有意接受的显示级口径)', () => {
    // 第2章从未入库,但书已写到第10章:卡片呈现已入库态。
    // 数据面无风险:服务端 append 恒按 progress.nextChapter 落章,不可能写重内容。
    const books = [mkBook({ progress: { chapterCount: 10, wordCount: 30000, nextChapter: 11 } })];
    expect(deriveContinueSaved({ bookId: 'nv_1', claimedIndex: 2 }, books)?.chapterCount).toBe(10);
  });
});

describe('derivePrologueSaved(书号命中 + 已落序章)', () => {
  it('books 未加载 / 书号空 → 不派生', () => {
    expect(derivePrologueSaved({ bookId: 'nv_1' }, null)).toBeNull();
    expect(derivePrologueSaved({ bookId: '' }, [mkBook()])).toBeNull();
  });

  it('书号未命中 → 不派生(归属未定绝不猜)', () => {
    expect(derivePrologueSaved({ bookId: 'nv_x' }, [mkBook()])).toBeNull();
  });

  it('命中但 hasPrologue 缺省/false → 不派生;hasPrologue=true → 已入库', () => {
    expect(derivePrologueSaved({ bookId: 'nv_1' }, [mkBook()])).toBeNull();
    const d = derivePrologueSaved({ bookId: 'nv_1' }, [mkBook({ hasPrologue: true })]);
    expect(d?.bookId).toBe('nv_1');
    // 序章不动 nextChapter:零章书 + 序章 → nextChapter 仍 1(链「写第 1 章」用)
    const zero = derivePrologueSaved(
      { bookId: 'nv_1' },
      [mkBook({ hasPrologue: true, progress: { chapterCount: 0, wordCount: 0, nextChapter: 1 } })]
    );
    expect(zero?.nextChapter).toBe(1);
  });
});
