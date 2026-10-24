/**
 * 免费聚合层开关与纯函数口径(2026-10-23 生产事故配套):
 * - Wikipedia 补抓取曾无超时,挂死把 search_web 拖到 400~500s(现在 10s 闸);
 * - 境内部署免费源整体不稳时需要一刀切的停用开关,调用返回诚实报错。
 * 网络函数本身(bing/gnews/wikipedia fetch)不做单测 —— fetch mock 无法证明
 * 境内可用性;这里钉的是开关语义与导出契约。
 */
import { describe, it, expect, vi } from 'vitest';
import { freeSourcesEnabled, stripHtml, decodeBingUrl } from './index';

describe('freeSourcesEnabled(免费聚合层总开关)', () => {
  it('缺省启用', () => {
    vi.stubEnv('AGTPILOT_SEARCH_FREE_SOURCES', '');
    try {
      expect(freeSourcesEnabled()).toBe(true);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('=0 停用(境内部署免费源不稳时关层,让调用方拿诚实报错)', () => {
    vi.stubEnv('AGTPILOT_SEARCH_FREE_SOURCES', '0');
    try {
      expect(freeSourcesEnabled()).toBe(false);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('其他值照旧启用(只认精确的 0)', () => {
    vi.stubEnv('AGTPILOT_SEARCH_FREE_SOURCES', '1');
    try {
      expect(freeSourcesEnabled()).toBe(true);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('纯函数回归锚点', () => {
  it('stripHtml:标签抹除不补空格,实体解码,CJK 两侧无空格', () => {
    expect(stripHtml('<em>词</em>')).toBe('词');
    // 实体解码按实现口径钉:&nbsp;→空格、&amp;→&,但 &amp; 后不补空格
    expect(stripHtml('<p>a&nbsp;&amp;b</p>')).toBe('a &b');
    expect(stripHtml('  <div>x</div>  ')).toBe('x');
  });

  it('decodeBingUrl:重定向链解出真实 URL;非重定向直链原样返回', () => {
    // base64url("https://example.com/a") 形态
    const b64 = Buffer.from('https://example.com/a').toString('base64url');
    expect(decodeBingUrl(`https://www.bing.com/ck/a?!&&p=x&u=a1${b64}`)).toBe('https://example.com/a');
    expect(decodeBingUrl('https://plain.example.com/page')).toBe('https://plain.example.com/page');
    expect(decodeBingUrl('javascript:alert(1)')).toBeNull();
  });
});
