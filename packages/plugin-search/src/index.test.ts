/**
 * 免费聚合层开关与纯函数口径:
 * - Wikipedia 补抓取有 10s 超时闸;
 * - 境内部署免费源不稳时可 AGTPILOT_SEARCH_FREE_SOURCES=0 关层。
 * Bing HTML 抓取已移除,不再测 decodeBingUrl。
 */
import { describe, it, expect, vi } from 'vitest';
import {
  freeSourcesEnabled,
  stripHtml,
  isCjkQuery,
  extractQueryTokens,
  isRelevantSearchResult,
  filterRelevantResults,
} from './index';

describe('freeSourcesEnabled(免费聚合层总开关)', () => {
  it('缺省启用', () => {
    vi.stubEnv('AGTPILOT_SEARCH_FREE_SOURCES', '');
    try {
      expect(freeSourcesEnabled()).toBe(true);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('=0 停用', () => {
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
    expect(stripHtml('<p>a&nbsp;&amp;b</p>')).toBe('a &b');
    expect(stripHtml('  <div>x</div>  ')).toBe('x');
  });
});

describe('相关性过滤', () => {
  it('isCjkQuery / extractQueryTokens', () => {
    expect(isCjkQuery('极道特种兵')).toBe(true);
    expect(isCjkQuery('OpenAI GPT')).toBe(false);
    expect(extractQueryTokens('极道特种兵 小说')).toEqual(['极道特种兵', '小说']);
    expect(extractQueryTokens('OpenAI agent tools')).toEqual(['openai', 'agent', 'tools']);
  });

  it('假结果判不相关;真命中保留', () => {
    const q = '极道特种兵';
    expect(
      isRelevantSearchResult(q, { title: '极（汉语文字）_百度百科', snippet: '极的拼音', url: 'https://baike.baidu.com/x' })
    ).toBe(false);
    expect(
      isRelevantSearchResult(q, {
        title: '《极道特种兵》全集免费阅读',
        snippet: '都市兵王小说',
        url: 'https://fanqie.example/book/1',
      })
    ).toBe(true);
  });

  it('filterRelevantResults 剔除无关保留相关', () => {
    const kept = filterRelevantResults('极道特种兵', [
      { title: '极的解释', url: 'https://a.example/1', snippet: '', engine: 'wikipedia' },
      { title: '极道特种兵 - 番茄小说', url: 'https://a.example/2', snippet: '兵王回归', engine: 'wikipedia' },
    ]);
    expect(kept).toHaveLength(1);
    expect(kept[0].url).toBe('https://a.example/2');
  });
});
