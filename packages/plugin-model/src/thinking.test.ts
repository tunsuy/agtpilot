import { describe, it, expect } from 'vitest';
import { thinkingProviderOptions } from './thinking';

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
