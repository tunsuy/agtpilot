import { describe, it, expect } from 'vitest';
import {
  buildFollowBuildersPrompt,
  FB_LANGUAGES,
  FB_RANGES,
  FB_CATEGORIES,
} from '../follow-builders-workshop';

describe('buildFollowBuildersPrompt · 缺省值(零输入可跑)', () => {
  it('不传参 = 中文 / 最近 24 小时 / 全类别', () => {
    const prompt = buildFollowBuildersPrompt();
    expect(prompt).toContain('输出语言:中文');
    expect(prompt).toContain('「最近 24 小时」');
    expect(prompt).toContain('rangeHours=24');
    expect(prompt).toContain('categories=["x","podcasts","blogs"]');
  });

  it('非法语言/范围回落默认值', () => {
    const prompt = buildFollowBuildersPrompt({ language: '法语', range: '99h' });
    expect(prompt).toContain('输出语言:中文');
    expect(prompt).toContain('rangeHours=24');
  });
});

describe('buildFollowBuildersPrompt · 工具契约', () => {
  it('第一步强制调用 follow_builders_fetch_feed,参数按表单映射', () => {
    const prompt = buildFollowBuildersPrompt({ range: '7d', categories: ['x', 'blogs'] });
    expect(prompt).toContain('follow_builders_fetch_feed');
    expect(prompt).toContain('rangeHours=168');
    expect(prompt).toContain('categories=["x","blogs"]');
  });

  it('覆盖范围如实标注:X 只有 24h;范围超 24h 时额外注明', () => {
    const d1 = buildFollowBuildersPrompt({ range: '24h' });
    expect(d1).toContain('X 动态上游只保留最近 24 小时');
    expect(d1).not.toContain('即使本次选了');

    const d7 = buildFollowBuildersPrompt({ range: '7d' });
    expect(d7).toContain('即使本次选了「最近 7 天」,X 部分也只有 24h 的量');
  });

  it('类别选择反映到分节指令与标题行', () => {
    const prompt = buildFollowBuildersPrompt({ categories: ['podcasts'] });
    expect(prompt).toContain('本次类别:播客');
    expect(prompt).not.toContain('「X 动态」:');
  });
});

describe('buildFollowBuildersPrompt · 输出结构与红线', () => {
  it('日报结构:总览开头 / 分类分节 / 结尾数据时间', () => {
    const prompt = buildFollowBuildersPrompt();
    expect(prompt).toContain('开头两句话总览');
    expect(prompt).toContain('「X 动态」');
    expect(prompt).toContain('「播客」');
    expect(prompt).toContain('「官方博客」');
    expect(prompt).toContain('generatedAt');
    expect(prompt).toContain('原文链接');
  });

  it('红线:不编造 / stale 提示 / 失败降级 / 不发布', () => {
    const prompt = buildFollowBuildersPrompt();
    expect(prompt).toContain('不得编造');
    expect(prompt).toContain('staleWarning');
    expect(prompt).toContain('数据可能过期');
    expect(prompt).toContain('success=false');
    expect(prompt).toContain('不要凭记忆编一份日报');
    expect(prompt).toContain('不做任何发布动作');
    expect(prompt).toContain('不调用任何发布类接口');
  });

  it('语言选择生效(英文输出)', () => {
    const prompt = buildFollowBuildersPrompt({ language: '英文' });
    expect(prompt).toContain('输出语言:英文');
    expect(prompt).toContain('产品名/模型名/人名保留原文');
  });
});

describe('FB_* 常量契约', () => {
  it('三种语言 / 三档范围(带小时数)/ 三个类别,互不重复', () => {
    expect(FB_LANGUAGES).toHaveLength(3);
    expect(new Set(FB_LANGUAGES).size).toBe(3);
    expect(FB_RANGES.map((r) => r.id)).toEqual(['24h', '72h', '7d']);
    expect(FB_RANGES.map((r) => r.hours)).toEqual([24, 72, 168]);
    expect(FB_CATEGORIES.map((c) => c.id)).toEqual(['x', 'podcasts', 'blogs']);
  });
});
