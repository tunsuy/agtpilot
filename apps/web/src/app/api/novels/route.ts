import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import {
  listNovelBooks,
  getNovelBook,
  getChapterContent,
  createNovelBook,
  appendChapter,
  deleteNovelBook,
  type CreateNovelInput,
  type AppendChapterInput,
} from '@/lib/novel-store';

/**
 * 网文小说书库(docs/design/novel-workshop.md §6)
 *
 * GET  ?无参 → 书库列表(轻量摘要);?bookId= → 全书状态(不含正文,
 *      续写/审查表单的服务端现读同源数据);&chapter=N → 附该章正文。
 * POST action=create(开书包入库)/ append(续写包反思写回)/ delete。
 *
 * 边界:书号入库前按当前登录用户校验(getNovelBook 按 userId 隔离);
 * 章序号永远由 novel-store 按 progress.nextChapter 分配,请求体传什么不算什么;
 * 本路由只读写创作内容,不碰任何凭证。
 */

async function requireUser(): Promise<string | null> {
  const session = await auth();
  return session?.user?.id || null;
}

export async function GET(req: NextRequest) {
  try {
    const userId = await requireUser();
    if (!userId) {
      return NextResponse.json({ success: false, error: 'Unauthorized: 请先登录' }, { status: 401 });
    }
    const bookId = req.nextUrl.searchParams.get('bookId')?.trim();
    if (!bookId) {
      return NextResponse.json({ success: true, books: listNovelBooks(userId) });
    }
    const book = getNovelBook(userId, bookId);
    if (!book) {
      return NextResponse.json({ success: false, error: `书不存在: ${bookId}` }, { status: 404 });
    }
    const chapterParam = req.nextUrl.searchParams.get('chapter');
    let chapterContent: string | null = null;
    if (chapterParam) {
      const n = Number(chapterParam);
      if (Number.isInteger(n) && n >= 1) chapterContent = getChapterContent(userId, bookId, n);
    }
    return NextResponse.json({ success: true, book, ...(chapterContent !== null ? { chapterContent } : {}) });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}

/** 请求体是不可信输入:逐字段收敛类型,数组元素逐个校验(novel-store 再做一层防御) */
function toCreateInput(body: any): CreateNovelInput | null {
  const title = typeof body?.title === 'string' ? body.title.trim() : '';
  const chapters = Array.isArray(body?.chapters)
    ? body.chapters
        .filter((c: any) => c && typeof c.content === 'string' && c.content.trim())
        .map((c: any) => ({
          title: typeof c.title === 'string' ? c.title.trim() : '',
          content: String(c.content),
          ...(typeof c.summary === 'string' && c.summary.trim() ? { summary: c.summary.trim() } : {}),
        }))
    : [];
  if (!title || chapters.length === 0) return null;
  const strField = (v: unknown) => (typeof v === 'string' ? v : '');
  return {
    title,
    genre: strField(body.genre),
    premise: strField(body.premise),
    style: strField(body.style),
    bible: strField(body.bible),
    characters: Array.isArray(body.characters)
      ? body.characters
          .filter((c: any) => c && typeof c.name === 'string' && c.name.trim())
          .map((c: any) => ({
            name: String(c.name).trim(),
            ...(typeof c.role === 'string' ? { role: c.role } : {}),
            ...(typeof c.appearance === 'string' ? { appearance: c.appearance } : {}),
            ...(typeof c.personality === 'string' ? { personality: c.personality } : {}),
            ...(typeof c.motivation === 'string' ? { motivation: c.motivation } : {}),
            ...(typeof c.speech === 'string' ? { speech: c.speech } : {}),
            ...(typeof c.relations === 'string' ? { relations: c.relations } : {}),
            ...(typeof c.arc === 'string' ? { arc: c.arc } : {}),
            ...(typeof c.currentState === 'string' ? { currentState: c.currentState } : {}),
          }))
      : [],
    outline: strField(body.outline),
    detailed: Array.isArray(body.detailed)
      ? body.detailed
          .filter((d: any) => d && Number.isFinite(Number(d.index)))
          .map((d: any) => ({
            index: Math.max(1, Math.floor(Number(d.index))),
            events: typeof d.events === 'string' ? d.events : '',
            ...(typeof d.title === 'string' ? { title: d.title } : {}),
            ...(typeof d.hook === 'string' ? { hook: d.hook } : {}),
            ...(typeof d.emotion === 'string' ? { emotion: d.emotion } : {}),
            ...(typeof d.foreshadow === 'string' ? { foreshadow: d.foreshadow } : {}),
            ...(Number.isFinite(Number(d.targetWords)) ? { targetWords: Math.floor(Number(d.targetWords)) } : {}),
          }))
      : [],
    ledgerSeeds: Array.isArray(body.ledgerSeeds)
      ? body.ledgerSeeds
          .filter((s: any) => s && typeof s.content === 'string' && s.content.trim())
          .map((s: any) => ({ content: String(s.content).trim(), plantedChapter: Math.max(1, Math.floor(Number(s.plantedChapter)) || 1) }))
      : [],
    timelineSeeds: Array.isArray(body.timelineSeeds) ? body.timelineSeeds.filter((t: any) => typeof t === 'string') : [],
    ...(typeof body.volumeSummary === 'string' ? { volumeSummary: body.volumeSummary } : {}),
  };
}

function toAppendInput(body: any): AppendChapterInput | null {
  const content = typeof body?.content === 'string' ? body.content : '';
  const summary = typeof body?.summary === 'string' ? body.summary.trim() : '';
  if (!content.trim() || !summary) return null;
  return {
    title: typeof body.title === 'string' ? body.title.trim() : '',
    content,
    summary,
    characterUpdates: Array.isArray(body.characterUpdates)
      ? body.characterUpdates
          .filter((u: any) => u && typeof u.name === 'string' && u.name.trim() && typeof u.currentState === 'string')
          .map((u: any) => ({ name: String(u.name).trim(), currentState: String(u.currentState) }))
      : [],
    ledgerActions: Array.isArray(body.ledgerActions)
      ? body.ledgerActions
          .filter((a: any) => a && (a.action === 'plant' || a.action === 'pay'))
          .map((a: any) =>
            a.action === 'plant'
              ? { action: 'plant' as const, content: typeof a.content === 'string' ? a.content : '' }
              : {
                  action: 'pay' as const,
                  keyword: typeof a.keyword === 'string' ? a.keyword : '',
                  ...(typeof a.payMethod === 'string' && a.payMethod.trim() ? { payMethod: a.payMethod.trim() } : {}),
                }
          )
      : [],
    timelineAppend: Array.isArray(body.timelineAppend) ? body.timelineAppend.filter((t: any) => typeof t === 'string') : [],
    detailedAppend: Array.isArray(body.detailedAppend)
      ? body.detailedAppend
          .filter((d: any) => d && Number.isFinite(Number(d.index)))
          .map((d: any) => ({
            index: Math.max(1, Math.floor(Number(d.index))),
            events: typeof d.events === 'string' ? d.events : '',
            ...(typeof d.title === 'string' ? { title: d.title } : {}),
            ...(typeof d.hook === 'string' ? { hook: d.hook } : {}),
            ...(typeof d.emotion === 'string' ? { emotion: d.emotion } : {}),
            ...(typeof d.foreshadow === 'string' ? { foreshadow: d.foreshadow } : {}),
            ...(Number.isFinite(Number(d.targetWords)) ? { targetWords: Math.floor(Number(d.targetWords)) } : {}),
          }))
      : [],
    ...(typeof body.volumeSummary === 'string' && body.volumeSummary.trim() ? { volumeSummary: body.volumeSummary.trim() } : {}),
  };
}

export async function POST(req: NextRequest) {
  try {
    const userId = await requireUser();
    if (!userId) {
      return NextResponse.json({ success: false, error: 'Unauthorized: 请先登录' }, { status: 401 });
    }
    const body = await req.json();
    const action = typeof body?.action === 'string' ? body.action : '';

    if (action === 'create') {
      const input = toCreateInput(body);
      if (!input) {
        return NextResponse.json({ success: false, error: '开书包不完整:需要书名与至少一章正文' }, { status: 400 });
      }
      const book = createNovelBook(userId, input);
      return NextResponse.json({ success: true, bookId: book.bookId, progress: book.progress });
    }

    if (action === 'append') {
      const bookId = typeof body?.bookId === 'string' ? body.bookId.trim() : '';
      if (!bookId || !getNovelBook(userId, bookId)) {
        return NextResponse.json({ success: false, error: `书不存在或无权访问: ${bookId || '(缺 bookId)'}` }, { status: 404 });
      }
      const input = toAppendInput(body);
      if (!input) {
        return NextResponse.json(
          { success: false, error: '续写包不完整:需要正文与本章摘要(缺摘要拒绝入库,不落半截状态)' },
          { status: 400 }
        );
      }
      const book = appendChapter(userId, bookId, input);
      return NextResponse.json({ success: true, bookId, progress: book.progress });
    }

    if (action === 'delete') {
      const bookId = typeof body?.bookId === 'string' ? body.bookId.trim() : '';
      if (!bookId) {
        return NextResponse.json({ success: false, error: '缺少 bookId' }, { status: 400 });
      }
      deleteNovelBook(userId, bookId);
      return NextResponse.json({ success: true });
    }

    return NextResponse.json({ success: false, error: `未知 action: ${action || '(空)'}` }, { status: 400 });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
