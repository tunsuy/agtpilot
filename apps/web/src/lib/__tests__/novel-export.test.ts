/**
 * novel-export 导出测试(P1 · docs/design/novel-workshop.md §7)
 *
 * 锁三件事:
 * 1. TXT:书名行 + 逐章标题(「第N章 …」不重复前缀)+ 顺序 + 缺正文章跳过;
 * 2. EPUB 的 ZIP 二进制布局:store 法、mimetype 第一条目且无 extra field、
 *    local/central/EOCD 三段签名与偏移自洽、crc32 与独立朴素实现交叉对账;
 * 3. EPUB 内容:OPF manifest/spine 与章数一致、XML 转义(& < > 进正文不炸包)、
 *    段落切 <p>、零正文诚实抛错(不产半截包)。
 */
import { describe, it, expect } from 'vitest';
import { buildNovelTxt, buildNovelEpub, crc32, buildZip } from '../novel-export';
import type { NovelBook } from '../novel-context';

function makeBook(overrides: Partial<NovelBook> = {}): NovelBook {
  return {
    bookId: 'nv_test01_a1b2c3',
    title: '铁拳少年',
    genre: '都市',
    premise: '外卖骑手捡到预知差评的手机',
    style: '爽文快节奏',
    status: 'active',
    createdAt: 1,
    updatedAt: 1,
    progress: { chapterCount: 2, wordCount: 60, nextChapter: 3 },
    bible: '力量体系:青铜→白银。',
    characters: [{ name: '林凡', role: '主角' }],
    outline: '第一卷·崛起。',
    detailed: [],
    ledger: [],
    timeline: [],
    summaries: ['s1', 's2'],
    volumeSummary: '小人物崛起。',
    lastReviewedChapter: 0,
    chapters: [
      { index: 1, title: '雨夜差评', wordCount: 30, createdAt: 1 },
      { index: 2, title: '第2章 拜师', wordCount: 30, createdAt: 2 },
    ],
    ...overrides,
  };
}

const CH1 = '暴雨夜,林凡攥着手机狂奔。\n\n差评像追命的鼓点。';
const CH2 = '他拜入师门,右手骨折未愈。';

/** 章文件读取器:按 index 查表,缺文件返回 null(与 getChapterContent 同口径) */
function reader(map: Record<number, string | null>) {
  return (index: number) => (index in map ? map[index] : null);
}

// ---- TXT ----

describe('buildNovelTxt', () => {
  it('书名行 + 逐章标题与正文;meta.title 已是「第N章 …」不重复前缀', () => {
    const txt = buildNovelTxt(makeBook(), reader({ 1: CH1, 2: CH2 }));
    expect(txt.startsWith('《铁拳少年》\n\n')).toBe(true);
    expect(txt).toContain('第1章 雨夜差评\n\n暴雨夜,林凡攥着手机狂奔。');
    expect(txt).toContain('第2章 拜师\n\n他拜入师门'); // 不产「第2章 第2章 拜师」
    expect(txt).not.toContain('第2章 第2章');
    expect(txt.endsWith('\n')).toBe(true);
    // 顺序:第1章在第2章之前
    expect(txt.indexOf('第1章')).toBeLessThan(txt.indexOf('第2章'));
  });

  it('缺正文文件/空正文的章跳过,不产半章;无标题章用「第N章」兜底', () => {
    const book = makeBook({
      chapters: [
        { index: 1, title: '', wordCount: 30, createdAt: 1 },
        { index: 2, title: 't', wordCount: 0, createdAt: 2 },
        { index: 3, title: 't3', wordCount: 30, createdAt: 3 },
      ],
    });
    const txt = buildNovelTxt(book, reader({ 1: CH1, 2: '   ', 3: CH2 }));
    expect(txt).toContain('第1章\n\n'); // 无标题兜底
    expect(txt).not.toContain('第2章'); // 空正文跳过
    expect(txt).toContain('第3章 t3');
  });
});

// ---- ZIP 二进制布局 ----

/** 朴素逐位 crc32(独立实现,交叉对账查表法) */
function naiveCrc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return (c ^ 0xffffffff) >>> 0;
}

interface ParsedEntry {
  name: string;
  data: Buffer;
  crc: number;
  method: number;
  extraLen: number;
  localOffset: number;
}

/** 按 local file header 逐条走查 store 法 ZIP;返回条目与中央目录/EOCD 信息 */
function parseZip(buf: Buffer) {
  const entries: ParsedEntry[] = [];
  let off = 0;
  while (off + 4 <= buf.length && buf.readUInt32LE(off) === 0x04034b50) {
    const method = buf.readUInt16LE(off + 8);
    const crc = buf.readUInt32LE(off + 14);
    const compSize = buf.readUInt32LE(off + 18);
    const uncompSize = buf.readUInt32LE(off + 22);
    const nameLen = buf.readUInt16LE(off + 26);
    const extraLen = buf.readUInt16LE(off + 28);
    const name = buf.toString('utf8', off + 30, off + 30 + nameLen);
    const dataStart = off + 30 + nameLen + extraLen;
    entries.push({
      name,
      data: buf.subarray(dataStart, dataStart + compSize),
      crc,
      method,
      extraLen,
      localOffset: off,
    });
    expect(uncompSize).toBe(compSize); // store 法两尺寸一致
    off = dataStart + compSize;
  }
  // 中央目录:逐条 46B + name,偏移必须指回对应 local header
  const cdStart = off;
  for (const e of entries) {
    expect(buf.readUInt32LE(off), `central sig @${off}`).toBe(0x02014b50);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOffset = buf.readUInt32LE(off + 42);
    expect(localOffset).toBe(e.localOffset);
    expect(buf.toString('utf8', off + 46, off + 46 + nameLen)).toBe(e.name);
    off += 46 + nameLen + extraLen + commentLen;
  }
  const cdSize = off - cdStart;
  // EOCD 紧跟中央目录,无注释
  expect(buf.readUInt32LE(off)).toBe(0x06054b50);
  expect(buf.readUInt16LE(off + 8)).toBe(entries.length);
  expect(buf.readUInt16LE(off + 10)).toBe(entries.length);
  expect(buf.readUInt32LE(off + 12)).toBe(cdSize);
  expect(buf.readUInt32LE(off + 16)).toBe(cdStart);
  expect(off + 22).toBe(buf.length);
  return entries;
}

describe('crc32 / buildZip', () => {
  it('crc32 标准校验向量 0xCBF43926,且与朴素逐位实现一致', () => {
    expect(crc32(Buffer.from('123456789', 'utf8'))).toBe(0xcbf43926);
    for (const s of ['', 'a', '暴雨夜,林凡攥着手机狂奔。', 'x'.repeat(1000)]) {
      const b = Buffer.from(s, 'utf8');
      expect(crc32(b)).toBe(naiveCrc32(b));
    }
  });

  it('buildZip:store 法、local/central/EOCD 自洽、每条目 crc 现场验算通过', () => {
    const zip = buildZip(
      [
        { name: 'a.txt', data: Buffer.from('hello', 'utf8') },
        { name: 'b/c.bin', data: Buffer.from([0, 1, 2, 255]) },
      ],
      new Date(2026, 9, 14, 12, 0, 0)
    );
    const entries = parseZip(zip);
    expect(entries.map((e) => e.name)).toEqual(['a.txt', 'b/c.bin']);
    for (const e of entries) {
      expect(e.method).toBe(0);
      expect(e.extraLen).toBe(0);
      expect(e.crc).toBe(naiveCrc32(e.data));
    }
  });
});

// ---- EPUB ----

describe('buildNovelEpub', () => {
  const NOW = new Date(2026, 9, 14, 12, 0, 0);

  it('零正文诚实抛错,不产半截包', () => {
    expect(() => buildNovelEpub(makeBook(), reader({}), NOW)).toThrow(/无法导出 EPUB/);
    expect(() =>
      buildNovelEpub(makeBook({ chapters: [] }), reader({ 1: CH1 }), NOW)
    ).toThrow(/无法导出 EPUB/);
  });

  it('ZIP 结构:mimetype 第一条目且内容/尺寸合规,结构文件齐全,crc 全部验算通过', () => {
    const epub = buildNovelEpub(makeBook(), reader({ 1: CH1, 2: CH2 }), NOW);
    const entries = parseZip(epub);
    expect(entries.map((e) => e.name)).toEqual([
      'mimetype',
      'META-INF/container.xml',
      'OEBPS/content.opf',
      'OEBPS/nav.xhtml',
      'OEBPS/ch001.xhtml',
      'OEBPS/ch002.xhtml',
    ]);
    const mime = entries[0];
    expect(mime.data.toString('utf8')).toBe('application/epub+zip');
    expect(mime.method).toBe(0);
    expect(mime.extraLen).toBe(0); // EPUB 硬性要求:mimetype 无 extra field
    for (const e of entries) expect(e.crc).toBe(naiveCrc32(e.data));
  });

  it('content.opf:EPUB3 元数据、manifest/spine 与章数一致、modified 秒级', () => {
    const epub = buildNovelEpub(makeBook(), reader({ 1: CH1, 2: CH2 }), NOW);
    const entries = parseZip(epub);
    const opf = entries.find((e) => e.name === 'OEBPS/content.opf')!.data.toString('utf8');
    expect(opf).toContain('version="3.0"');
    expect(opf).toContain('unique-identifier="uid"');
    expect(opf).toContain('<dc:identifier id="uid">agtpilot-novel-nv_test01_a1b2c3</dc:identifier>');
    expect(opf).toContain('<dc:title>铁拳少年</dc:title>');
    expect(opf).toContain('<dc:subject>都市</dc:subject>');
    // dcterms:modified 秒级 UTC(不断言具体时刻——构建机时区不定,只锁格式)
    expect(opf).toMatch(/dcterms:modified">\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z</);
    expect(opf).not.toMatch(/dcterms:modified">[^<]*\.\d{3}/);
    expect(opf).toContain('<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>');
    expect(opf.match(/<item id="ch\d+"/g)).toHaveLength(2);
    expect(opf.match(/<itemref idref="ch\d+"\/>/g)).toHaveLength(2);
    // container 指向 opf
    const container = entries.find((e) => e.name === 'META-INF/container.xml')!.data.toString('utf8');
    expect(container).toContain('full-path="OEBPS/content.opf"');
  });

  it('章节 xhtml:标题 h2 + 段落切 <p> + XML 转义(& < > 不炸包);nav 目录逐章列出', () => {
    const dirty = '林凡&苏晚\n他吼道:"<滚开!>\n第二行。';
    const epub = buildNovelEpub(
      makeBook({ chapters: [{ index: 1, title: '雨夜差评', wordCount: 30, createdAt: 1 }] }),
      reader({ 1: dirty }),
      NOW
    );
    const entries = parseZip(epub);
    const ch = entries.find((e) => e.name === 'OEBPS/ch001.xhtml')!.data.toString('utf8');
    expect(ch).toContain('<h2>第1章 雨夜差评</h2>');
    expect(ch).toContain('<p>林凡&amp;苏晚</p>');
    expect(ch).toContain('<p>他吼道:&quot;&lt;滚开!&gt;</p>');
    expect(ch).not.toContain('<滚开'); // 裸 < 必须已转义
    const nav = entries.find((e) => e.name === 'OEBPS/nav.xhtml')!.data.toString('utf8');
    expect(nav).toContain('epub:type="toc"');
    expect(nav).toContain('<li><a href="ch001.xhtml">第1章 雨夜差评</a></li>');
  });

  it('书名含 XML 特殊字符:opf 标题转义,包仍合法', () => {
    const epub = buildNovelEpub(
      makeBook({ title: 'A&B < C', bookId: 'nv_x1_abc123' }),
      reader({ 1: CH1, 2: CH2 }),
      NOW
    );
    const opf = parseZip(epub).find((e) => e.name === 'OEBPS/content.opf')!.data.toString('utf8');
    expect(opf).toContain('<dc:title>A&amp;B &lt; C</dc:title>');
  });
});
