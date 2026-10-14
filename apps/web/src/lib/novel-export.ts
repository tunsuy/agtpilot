/**
 * 全书导出(P1 · docs/design/novel-workshop.md §7):TXT + EPUB。
 *
 * - TXT:投稿/阅读通用的朴素格式(书名行 + 逐章标题 + 正文)。
 * - EPUB:EPUB 3 最小合法结构(mimetype + container.xml + content.opf +
 *   nav.xhtml + 逐章 xhtml)。ZIP 用 store 法(不压缩)自实现——仓库无 zip
 *   依赖,书稿是文本,压缩收益不值得引第三方库;实现只覆盖 EPUB 所需子集
 *   (无 extra field、无 zip64、无目录项),测试逐字段校验二进制布局。
 *
 * 服务端专属(node:Buffer),不进客户端 bundle。不读 fs——章节内容由调用方
 * 注入(novel-store 的 getChapterContent),保持本模块纯函数可测。
 */
import type { NovelBook } from './novel-context';

export type ChapterReader = (index: number) => string | null;

/** 章标题展示口径:meta.title 已形如「第N章 …」则不重复前缀 */
function chapterHeading(book: NovelBook, index: number): string {
  const meta = book.chapters.find((c) => c.index === index);
  const title = String(meta?.title || '').trim() || `第${index}章`;
  return /^第\s*[0-9一二三四五六七八九十百千]+\s*章/.test(title) ? title : `第${index}章 ${title}`;
}

/** 按 meta 顺序取全部有正文的章(缺文件跳过,不产半章) */
function collectChapters(book: NovelBook, readChapter: ChapterReader): Array<{ index: number; heading: string; content: string }> {
  const out: Array<{ index: number; heading: string; content: string }> = [];
  for (const meta of book.chapters) {
    const content = readChapter(meta.index);
    if (content == null || !content.trim()) continue;
    out.push({ index: meta.index, heading: chapterHeading(book, meta.index), content });
  }
  return out;
}

// ---- TXT ----

export function buildNovelTxt(book: NovelBook, readChapter: ChapterReader): string {
  const parts: string[] = [`《${book.title}》`];
  for (const ch of collectChapters(book, readChapter)) {
    parts.push(`${ch.heading}\n\n${ch.content.trim()}`);
  }
  return parts.join('\n\n') + '\n';
}

// ---- EPUB ----

function xmlEscape(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
    // XML 1.0 非法控制字符直接剔除(正文里的脏字节不进包)
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
}

/** 正文 → <p> 段(按空行/换行切段;段内不再嵌套标记) */
function paragraphsToXhtml(content: string): string {
  return content
    .split(/\n+/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p>${xmlEscape(p)}</p>`)
    .join('\n');
}

// ---- store 法 ZIP 写入器(EPUB 所需最小子集) ----

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

export function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

interface ZipEntry {
  name: string; // ASCII(EPUB 结构文件路径全是 ASCII)
  data: Buffer;
}

/** DOS 时间/日期(取构建时刻;EPUB 阅读器不依赖它,仅需字段合法) */
function dosDateTime(d: Date): { time: number; date: number } {
  const year = Math.max(1980, d.getFullYear());
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

export function buildZip(entries: ZipEntry[], now: Date = new Date()): Buffer {
  const { time, date } = dosDateTime(now);
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8');
    const crc = crc32(e.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // flags: UTF-8 名称
    local.writeUInt16LE(0, 8); // method: store
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(e.data.length, 18);
    local.writeUInt32LE(e.data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28); // extra len
    locals.push(local, nameBuf, e.data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(e.data.length, 20);
    central.writeUInt32LE(e.data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk start
    central.writeUInt16LE(0, 36); // internal attrs
    central.writeUInt32LE(0, 38); // external attrs
    central.writeUInt32LE(offset, 42); // local header offset
    centrals.push(central, nameBuf);

    offset += local.length + nameBuf.length + e.data.length;
  }
  const cdSize = centrals.reduce((n, b) => n + b.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, ...centrals, eocd]);
}

/** dcterms:modified 口径:UTC 秒级(EPUB 3 规范) */
function epubModified(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export function buildNovelEpub(book: NovelBook, readChapter: ChapterReader, now: Date = new Date()): Buffer {
  const chapters = collectChapters(book, readChapter);
  if (chapters.length === 0) throw new Error('这本书还没有任何正文,无法导出 EPUB');

  const uid = `agtpilot-novel-${book.bookId}`;
  const title = xmlEscape(book.title);

  const opfManifest = chapters
    .map((ch, i) => `    <item id="ch${i + 1}" href="ch${String(i + 1).padStart(3, '0')}.xhtml" media-type="application/xhtml+xml"/>`)
    .join('\n');
  const opfSpine = chapters.map((_, i) => `    <itemref idref="ch${i + 1}"/>`).join('\n');
  const navItems = chapters
    .map((ch, i) => `      <li><a href="ch${String(i + 1).padStart(3, '0')}.xhtml">${xmlEscape(ch.heading)}</a></li>`)
    .join('\n');

  const containerXml = `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>
`;

  const contentOpf = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid" xml:lang="zh-CN">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="uid">${xmlEscape(uid)}</dc:identifier>
    <dc:title>${title}</dc:title>
    <dc:language>zh-CN</dc:language>
    <dc:creator>AgtPilot 书库导出</dc:creator>
    <meta property="dcterms:modified">${epubModified(now)}</meta>
${book.genre ? `    <dc:subject>${xmlEscape(book.genre)}</dc:subject>\n` : ''}  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
${opfManifest}
  </manifest>
  <spine>
${opfSpine}
  </spine>
</package>
`;

  const navXhtml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="zh-CN">
<head><title>目录</title></head>
<body>
  <nav epub:type="toc" id="toc">
    <h1>目录</h1>
    <ol>
${navItems}
    </ol>
  </nav>
</body>
</html>
`;

  const entries: ZipEntry[] = [
    // mimetype 必须是第一个条目、store 法、无 extra field(buildZip 全满足)
    { name: 'mimetype', data: Buffer.from('application/epub+zip', 'utf8') },
    { name: 'META-INF/container.xml', data: Buffer.from(containerXml, 'utf8') },
    { name: 'OEBPS/content.opf', data: Buffer.from(contentOpf, 'utf8') },
    { name: 'OEBPS/nav.xhtml', data: Buffer.from(navXhtml, 'utf8') },
  ];
  chapters.forEach((ch, i) => {
    const xhtml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" lang="zh-CN">
<head><title>${xmlEscape(ch.heading)}</title></head>
<body>
<h2>${xmlEscape(ch.heading)}</h2>
${paragraphsToXhtml(ch.content)}
</body>
</html>
`;
    entries.push({ name: `OEBPS/ch${String(i + 1).padStart(3, '0')}.xhtml`, data: Buffer.from(xhtml, 'utf8') });
  });
  return buildZip(entries, now);
}
