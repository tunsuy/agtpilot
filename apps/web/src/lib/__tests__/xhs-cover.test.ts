import { describe, it, expect } from 'vitest';
import { buildSolidPng, buildPlaceholderCover } from '../xhs-cover';

/** 解析最小 PNG(IHDR 字段),用于断言编码正确性 */
function parseIhdr(buf: Buffer) {
  // 签名 8B + IHDR length 4B + type 4B
  const ihdr = buf.subarray(16, 16 + 13);
  return {
    width: ihdr.readUInt32BE(0),
    height: ihdr.readUInt32BE(4),
    bitDepth: ihdr[8],
    colorType: ihdr[9],
  };
}

describe('xhs-cover 占位封面生成', () => {
  it('PNG 签名与 IHDR 字段正确', () => {
    const png = buildPlaceholderCover();
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const ihdr = parseIhdr(png);
    expect(ihdr.width).toBe(720);
    expect(ihdr.height).toBe(960);
    expect(ihdr.bitDepth).toBe(8);
    expect(ihdr.colorType).toBe(2); // RGB
  });

  it('IEND 收尾存在(完整 PNG 结构)', () => {
    const png = buildPlaceholderCover();
    const tail = png.subarray(png.length - 12);
    expect(tail.subarray(4, 8).toString('ascii')).toBe('IEND');
  });

  it('纯色图高度可压缩(<8KB),不撑爆内存/上传', () => {
    const png = buildPlaceholderCover();
    expect(png.length).toBeLessThan(8192);
  });

  it('自定义尺寸/颜色生效', () => {
    const png = buildSolidPng(10, 20, [1, 2, 3]);
    const ihdr = parseIhdr(png);
    expect(ihdr.width).toBe(10);
    expect(ihdr.height).toBe(20);
  });

  it('非法尺寸直接抛错(调用方fail-fast)', () => {
    expect(() => buildSolidPng(0, 10)).toThrow();
    expect(() => buildSolidPng(10, -1)).toThrow();
  });
});
