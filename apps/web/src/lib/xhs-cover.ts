/**
 * 小红书占位封面生成器(scenario-loop §5.4 适配 2026-10-11 改版后的发布页)。
 *
 * 背景:创作平台新版发布页(publish/publish)要求「先上传至少一张图」才会渲染
 * 标题/正文表单 —— 纯文字笔记没了入口。存草稿工具对无图笔记用一张纯色占位
 * 封面顶位:草稿本身可编辑,用户发布前在小红书 App 换掉封面即可(工具终点是
 * 草稿箱,发布永远人工,占位封面不会流出)。
 *
 * 实现是零依赖的最小 PNG 编码器(IHDR + 单 IDAT + IEND,逐行 filter=0,
 * RGB 8bit):纯色图 raw 数据高度可压缩,720×960 产物约 3.4KB。纯函数便于单测。
 */
import { deflateSync } from 'node:zlib';

/** 推荐封面尺寸:3:4(平台推荐比例内),720P 级清晰度 */
const COVER_WIDTH = 720;
const COVER_HEIGHT = 960;

/** 占位封面颜色:柔和暖灰,和平台 UI 背景接近,一眼可辨「待替换」 */
const PLACEHOLDER_RGB: [number, number, number] = [0xf4, 0xf1, 0xec];

/** CRC32(PNG chunk 校验用;查表法,无依赖) */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

/** 组装单个 PNG chunk:length(4BE) + type + data + crc32(type+data) */
function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

/** 生成宽×高纯色 RGB PNG */
export function buildSolidPng(
  width: number,
  height: number,
  rgb: [number, number, number] = PLACEHOLDER_RGB
): Buffer {
  if (width <= 0 || height <= 0) throw new Error(`invalid dimensions ${width}x${height}`);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: truecolor RGB
  ihdr[10] = 0; // compression: deflate
  ihdr[11] = 0; // filter: adaptive
  ihdr[12] = 0; // interlace: none

  // raw 数据:每行 filter 字节 0 + width 个 RGB 像素
  const row = Buffer.alloc(1 + width * 3);
  for (let x = 0; x < width; x++) {
    row[1 + x * 3] = rgb[0];
    row[2 + x * 3] = rgb[1];
    row[3 + x * 3] = rgb[2];
  }
  const raw = Buffer.concat(Array(height).fill(row));
  const idat = deflateSync(raw, { level: 9 });

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), // PNG signature
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** 3:4 占位封面(发布页表单解锁的最小可用图) */
export function buildPlaceholderCover(): Buffer {
  return buildSolidPng(COVER_WIDTH, COVER_HEIGHT);
}
