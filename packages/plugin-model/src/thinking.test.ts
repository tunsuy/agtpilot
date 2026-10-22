import { describe, it, expect } from 'vitest';
import { thinkingProviderOptions, resolveThinkingEffort } from './thinking';

describe('thinkingProviderOptions(思考深度旋钮 → providerOptions)', () => {
  it('openai 缺省显式 medium(厂商缺省,行为不变);deepseek 缺省不下发(medium 会被 SDK 转成 high,缺省下发等于悄悄改行为)', () => {
    expect(thinkingProviderOptions('openai', undefined)).toEqual({ openai: { reasoningEffort: 'medium' } });
    expect(thinkingProviderOptions('deepseek', undefined)).toBeUndefined();
  });

  it('custom_llm/local_llm 缺省不下发(厂商未知,严格中转对未知参数可能 400)', () => {
    expect(thinkingProviderOptions('custom_llm', undefined)).toBeUndefined();
    expect(thinkingProviderOptions('local_llm', undefined)).toBeUndefined();
  });

  it('env 显式指定 → 各分支均下发,覆盖缺省(compat 用 openai-compatible 通用键;deepseek 的 medium 预映射为 high)', () => {
    expect(thinkingProviderOptions('openai', 'low')).toEqual({ openai: { reasoningEffort: 'low' } });
    expect(thinkingProviderOptions('openai', 'high')).toEqual({ openai: { reasoningEffort: 'high' } });
    expect(thinkingProviderOptions('deepseek', 'low')).toEqual({ deepseek: { reasoningEffort: 'low' } });
    expect(thinkingProviderOptions('deepseek', 'high')).toEqual({ deepseek: { reasoningEffort: 'high' } });
    expect(thinkingProviderOptions('deepseek', 'medium')).toEqual({ deepseek: { reasoningEffort: 'high' } });
    expect(thinkingProviderOptions('custom_llm', 'low')).toEqual({ 'openai-compatible': { reasoningEffort: 'low' } });
    expect(thinkingProviderOptions('custom_llm', 'medium')).toEqual({ 'openai-compatible': { reasoningEffort: 'medium' } });
    expect(thinkingProviderOptions('local_llm', 'high')).toEqual({ 'openai-compatible': { reasoningEffort: 'high' } });
  });

  it('env 空串 = 显式关闭(即便分支缺省是 medium 也不下发)', () => {
    expect(thinkingProviderOptions('openai', '')).toBeUndefined();
    expect(thinkingProviderOptions('deepseek', 'high')).toEqual({ deepseek: { reasoningEffort: 'high' } });
    expect(thinkingProviderOptions('deepseek', '')).toBeUndefined();
  });

  it('关闭档 none:openai/custom_llm/local_llm 显式下发 reasoning_effort=none;deepseek 无此档不下发(模型自决)', () => {
    expect(thinkingProviderOptions('openai', 'none')).toEqual({ openai: { reasoningEffort: 'none' } });
    expect(thinkingProviderOptions('custom_llm', 'none')).toEqual({ 'openai-compatible': { reasoningEffort: 'none' } });
    expect(thinkingProviderOptions('local_llm', 'none')).toEqual({ 'openai-compatible': { reasoningEffort: 'none' } });
    expect(thinkingProviderOptions('deepseek', 'none')).toBeUndefined();
  });

  it('env 非法值不下发(不猜测、不回落缺省;deepseek 只认 low/high,medium 走上面的显式映射)', () => {
    expect(thinkingProviderOptions('openai', 'MEDIUM')).toBeUndefined();
    expect(thinkingProviderOptions('openai', 'minimal')).toBeUndefined();
    expect(thinkingProviderOptions('deepseek', 'minimal')).toBeUndefined();
    expect(thinkingProviderOptions('deepseek', 'MEDIUM')).toBeUndefined();
    expect(thinkingProviderOptions('deepseek', 'max')).toBeUndefined();
    expect(thinkingProviderOptions('custom_llm', '')).toBeUndefined();
    expect(thinkingProviderOptions('local_llm', 'minimal')).toBeUndefined();
  });

  it('未知分支即便 env 合法也不下发(没有 provider 键可挂)', () => {
    expect(thinkingProviderOptions('anthropic', 'low')).toBeUndefined();
  });
});

describe('resolveThinkingEffort(连接器级配置 > 全局 env > 分支缺省)', () => {
  it('连接器/工坊档位合法(low/medium/high/none)→ 压过全局 env', () => {
    expect(resolveThinkingEffort('high', 'low')).toBe('high');
    expect(resolveThinkingEffort('low', 'high')).toBe('low');
    expect(resolveThinkingEffort('medium', undefined)).toBe('medium');
    // none(关闭档)同样压过 env:连接器/工坊显式关思考,全局低档不抢回
    expect(resolveThinkingEffort('none', 'low')).toBe('none');
  });

  it('连接器未设置/空串/非法值 → 回落全局 env(含 env 未设置的 undefined)', () => {
    expect(resolveThinkingEffort(undefined, 'high')).toBe('high');
    expect(resolveThinkingEffort('', 'medium')).toBe('medium');
    expect(resolveThinkingEffort('MAX', 'low')).toBe('low');
    expect(resolveThinkingEffort(undefined, undefined)).toBeUndefined();
    // env 空串 = 部署方显式关闭,原样透传(thinkingProviderOptions 对 '' 不下发)
    expect(resolveThinkingEffort(undefined, '')).toBe('');
  });

  it('端到端:连接器 deepseek medium 仍走 SDK 口径预映射为 high', () => {
    const effort = resolveThinkingEffort('medium', 'low');
    expect(thinkingProviderOptions('deepseek', effort)).toEqual({ deepseek: { reasoningEffort: 'high' } });
  });

  it('端到端:连接器未设置时 env 与分支缺省行为不变(openai 缺省 medium、custom_llm 缺省不下发)', () => {
    expect(thinkingProviderOptions('openai', resolveThinkingEffort(undefined, undefined))).toEqual({
      openai: { reasoningEffort: 'medium' },
    });
    expect(thinkingProviderOptions('custom_llm', resolveThinkingEffort(undefined, undefined))).toBeUndefined();
    expect(thinkingProviderOptions('custom_llm', resolveThinkingEffort('high', undefined))).toEqual({
      'openai-compatible': { reasoningEffort: 'high' },
    });
  });

  it('端到端:工坊/连接器关思考(none)→ openai 口径显式下发 none,deepseek 分支不下发', () => {
    expect(thinkingProviderOptions('openai', resolveThinkingEffort('none', 'medium'))).toEqual({
      openai: { reasoningEffort: 'none' },
    });
    expect(thinkingProviderOptions('deepseek', resolveThinkingEffort('none', undefined))).toBeUndefined();
  });
});
