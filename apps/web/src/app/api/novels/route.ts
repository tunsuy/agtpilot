import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import {
  listNovelBooks,
  getNovelBook,
  getChapterContent,
  getPrologueContent,
  createNovelBook,
  appendChapter,
  mergeNovelOutline,
  deleteNovelBook,
  markNovelReviewed,
  updateNovelStyle,
  updateNovelSynopsis,
  findNovelBookByTitle,
  isReviewDue,
  MAX_STYLE_CHARS,
  MAX_SYNOPSIS_CHARS,
  type CreateNovelInput,
  type AppendChapterInput,
} from '@/lib/novel-store';
import {
  maybeEnqueueFanqieBookCreate,
  maybeEnqueueFanqieChapter,
  setFanqieSyncEnabled,
  retryFanqieSync,
  bindFanqieBook,
} from '@/lib/fanqie-sync';
import { buildNovelTxt, buildNovelEpub } from '@/lib/novel-export';

/**
 * 网文小说书库(docs/design/novel-workshop.md §6)
 *
 * GET  ?无参 → 书库列表(轻量摘要);?bookId= → 全书状态(不含正文,
 *      续写/审查表单的服务端现读同源数据);&chapter=N → 附该章正文;
 *      &export=txt|epub → 全书导出直下(P1,附件流,不落 artifact-files)。
 * POST action=create(设定包建书,书名幂等)/ mergeOutline(大纲包并书)/ append(续写包反思写回) /
 *      delete / markReviewed(体检提醒落点)/ updateStyle(文风锚)/ updateSynopsis(作品简介)/
 *      setFanqieSync(书级同步开关)/ retryFanqieSync(显式重试)/ bindFanqieBook(手动绑定番茄书号)。
 *
 * 边界:书号入库前按当前登录用户校验(getNovelBook 按 userId 隔离);
 * 章序号永远由 novel-store 按 progress.nextChapter 分配,请求体传什么不算什么;
 * 本路由只读写创作内容,不碰任何凭证。
 *
 * 番茄自动同步(P2):create/append 成功后 fire-and-forget 记意图入队
 * (fanqie-sync 意图先落 book.json,响应不等浏览器;与 runMission detached 同模式)。
 */

async function requireUser(): Promise<string | null> {
  const session = await auth();
  return session?.user?.id || null;
}

/** 番茄同步入队(fire-and-forget):钩子失败绝不影响入库响应 —— 意图账本在
 *  book.json,sweeper 15min 兜底重排,这里吞错只记日志 */
function enqueueFanqie(fn: () => unknown): void {
  try {
    fn();
  } catch (err: any) {
    console.error('[novels] fanqie 同步入队失败(sweeper 会兜底):', err?.message || err);
  }
}

/** 导出文件名消毒:书名可能带路径/引号等字符,只留可读安全集(不消毒就是不信任边界) */
function safeExportName(title: string, ext: 'txt' | 'epub'): string {
  const base = String(title || '小说').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').trim().slice(0, 60) || '小说';
  return `《${base}》.${ext}`;
}

/** Content-Disposition:ASCII fallback + RFC 5987 filename*(中文书名) */
function attachmentHeaders(name: string, contentType: string): Record<string, string> {
  const ascii = 'novel-export.' + name.split('.').pop();
  return {
    'Content-Type': contentType,
    'Content-Disposition': `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`,
    'Cache-Control': 'no-store',
  };
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
    // 全书导出(P1):txt | epub 直下;非法值当没传,走 JSON 分支
    const exportFmt = req.nextUrl.searchParams.get('export');
    if (exportFmt === 'txt' || exportFmt === 'epub') {
      // 序章占 0 号位(导出在最前):getChapterContent 钳制 [1,9999],必须先特判,
      // 否则静默把第 1 章当序章导出
      const readChapter = (index: number) => (index === 0 ? getPrologueContent(userId, bookId) : getChapterContent(userId, bookId, index));
      if (exportFmt === 'txt') {
        const txt = buildNovelTxt(book, readChapter);
        return new NextResponse(txt, {
          headers: attachmentHeaders(safeExportName(book.title, 'txt'), 'text/plain; charset=utf-8'),
        });
      }
      try {
        const epub = buildNovelEpub(book, readChapter);
        return new NextResponse(new Uint8Array(epub), {
          headers: attachmentHeaders(safeExportName(book.title, 'epub'), 'application/epub+zip'),
        });
      } catch (err: any) {
        // 「没有正文无法导出」是业务态(400),其余如实 500
        return NextResponse.json({ success: false, error: err.message }, { status: 400 });
      }
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

/** 请求体是不可信输入:逐字段收敛类型,数组元素逐个校验(novel-store 再做一层防御)。
 *  开书三段化:设定包建书不带章正文(chapters 可为空——第二步大纲、逐章续写在后面);
 *  旧开书包带章照收。书名必填。 */
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
  if (!title) return null;
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
    ...(strField(body.synopsis).trim() ? { synopsis: strField(body.synopsis).trim() } : {}),
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
        return NextResponse.json({ success: false, error: '设定包不完整:需要书名' }, { status: 400 });
      }
      // 幂等:同名书已在库 → 不重复建书,返回既有书号(existed 供卡片区分)。
      // 「存入书库」双击/重挂载重放从这里死透;番茄开书意图按幂等守卫补排。
      const existing = findNovelBookByTitle(userId, input.title);
      if (existing) {
        enqueueFanqie(() => maybeEnqueueFanqieBookCreate(userId, existing.bookId));
        return NextResponse.json({
          success: true,
          bookId: existing.bookId,
          progress: existing.progress,
          existed: true,
        });
      }
      const book = createNovelBook(userId, input);
      // fire-and-forget:意图先落 book.json(fanqie-sync 内部),响应不等浏览器
      enqueueFanqie(() => maybeEnqueueFanqieBookCreate(userId, book.bookId));
      return NextResponse.json({ success: true, bookId: book.bookId, progress: book.progress });
    }

    if (action === 'mergeOutline') {
      const bookId = typeof body?.bookId === 'string' ? body.bookId.trim() : '';
      if (!bookId || !getNovelBook(userId, bookId)) {
        return NextResponse.json({ success: false, error: `书不存在或无权访问: ${bookId || '(缺 bookId)'}` }, { status: 404 });
      }
      const outline = typeof body?.outline === 'string' ? body.outline.trim() : '';
      if (!outline) {
        return NextResponse.json({ success: false, error: '大纲包不完整:缺粗纲(拒绝合并半截规划)' }, { status: 400 });
      }
      const detailed = Array.isArray(body?.detailed)
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
        : [];
      const ledgerSeeds = Array.isArray(body?.ledgerSeeds)
        ? body.ledgerSeeds
            .filter((s: any) => s && typeof s.content === 'string' && s.content.trim())
            .map((s: any) => ({ content: String(s.content).trim(), plantedChapter: Math.max(1, Math.floor(Number(s.plantedChapter)) || 1) }))
        : [];
      const timelineSeeds = Array.isArray(body?.timelineSeeds)
        ? body.timelineSeeds.filter((t: any) => typeof t === 'string')
        : [];
      const book = mergeNovelOutline(userId, bookId, { outline, detailed, ledgerSeeds, timelineSeeds });
      return NextResponse.json({ success: true, bookId, progress: book.progress });
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
      // 自动存草稿钩子:手动续写与日更 cron 产出的入库都经本 action,一处覆盖两条路
      const synced = book.progress.chapterCount;
      enqueueFanqie(() => maybeEnqueueFanqieChapter(userId, bookId, synced));
      return NextResponse.json({ success: true, bookId, progress: book.progress, reviewDue: isReviewDue(book) });
    }

    if (action === 'setFanqieSync') {
      const bookId = typeof body?.bookId === 'string' ? body.bookId.trim() : '';
      if (!bookId || !getNovelBook(userId, bookId)) {
        return NextResponse.json({ success: false, error: `书不存在或无权访问: ${bookId || '(缺 bookId)'}` }, { status: 404 });
      }
      const enabled = body?.enabled !== false; // 缺省视为开(全自动是默认姿态)
      const fanqie = setFanqieSyncEnabled(userId, bookId, enabled);
      return NextResponse.json({ success: true, bookId, fanqie });
    }

    if (action === 'retryFanqieSync') {
      const bookId = typeof body?.bookId === 'string' ? body.bookId.trim() : '';
      if (!bookId || !getNovelBook(userId, bookId)) {
        return NextResponse.json({ success: false, error: `书不存在或无权访问: ${bookId || '(缺 bookId)'}` }, { status: 404 });
      }
      const chapterIndex = Number.isFinite(Number(body?.chapterIndex)) ? Math.floor(Number(body.chapterIndex)) : undefined;
      const retried = retryFanqieSync(userId, bookId, chapterIndex);
      return NextResponse.json({ success: true, bookId, retried });
    }

    if (action === 'bindFanqieBook') {
      const bookId = typeof body?.bookId === 'string' ? body.bookId.trim() : '';
      if (!bookId || !getNovelBook(userId, bookId)) {
        return NextResponse.json({ success: false, error: `书不存在或无权访问: ${bookId || '(缺 bookId)'}` }, { status: 404 });
      }
      const fanqieBookId = typeof body?.fanqieBookId === 'string' ? body.fanqieBookId.trim() : '';
      const out = bindFanqieBook(userId, bookId, fanqieBookId);
      if (!out.ok) {
        return NextResponse.json({ success: false, error: out.error }, { status: 400 });
      }
      return NextResponse.json({ success: true, bookId, fanqieBookId });
    }

    if (action === 'markReviewed') {
      const bookId = typeof body?.bookId === 'string' ? body.bookId.trim() : '';
      if (!bookId || !getNovelBook(userId, bookId)) {
        return NextResponse.json({ success: false, error: `书不存在或无权访问: ${bookId || '(缺 bookId)'}` }, { status: 404 });
      }
      const book = markNovelReviewed(userId, bookId);
      return NextResponse.json({ success: true, bookId, lastReviewedChapter: book.lastReviewedChapter });
    }

    if (action === 'updateStyle') {
      const bookId = typeof body?.bookId === 'string' ? body.bookId.trim() : '';
      if (!bookId || !getNovelBook(userId, bookId)) {
        return NextResponse.json({ success: false, error: `书不存在或无权访问: ${bookId || '(缺 bookId)'}` }, { status: 404 });
      }
      const style = typeof body?.style === 'string' ? body.style.trim() : '';
      if (!style) {
        return NextResponse.json({ success: false, error: '文风锚不能为空' }, { status: 400 });
      }
      if (style.length > MAX_STYLE_CHARS) {
        return NextResponse.json({ success: false, error: `文风锚超长(> ${MAX_STYLE_CHARS} 字)` }, { status: 400 });
      }
      const book = updateNovelStyle(userId, bookId, style);
      return NextResponse.json({ success: true, bookId, style: book.style });
    }

    if (action === 'updateSynopsis') {
      const bookId = typeof body?.bookId === 'string' ? body.bookId.trim() : '';
      if (!bookId || !getNovelBook(userId, bookId)) {
        return NextResponse.json({ success: false, error: `书不存在或无权访问: ${bookId || '(缺 bookId)'}` }, { status: 404 });
      }
      const synopsis = typeof body?.synopsis === 'string' ? body.synopsis.trim() : '';
      if (!synopsis) {
        return NextResponse.json({ success: false, error: '作品简介不能为空' }, { status: 400 });
      }
      if (synopsis.length > MAX_SYNOPSIS_CHARS) {
        return NextResponse.json({ success: false, error: `作品简介超长(> ${MAX_SYNOPSIS_CHARS} 字)` }, { status: 400 });
      }
      const book = updateNovelSynopsis(userId, bookId, synopsis);
      return NextResponse.json({ success: true, bookId, synopsis: book.synopsis });
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
