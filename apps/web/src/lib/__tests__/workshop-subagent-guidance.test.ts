import { describe, it, expect } from 'vitest';
import { buildInvestPrompt, INVEST_MODES } from '@/lib/invest-workshops';
import { buildEduPrompt } from '@/lib/edu-workshops';

/**
 * 调研类工坊 Prompt 的 research_subagent 接入断言(spec §10 M2):
 * 广度网页调研显式引导派只读检索子 agent;连接器检索与行情数字留在主循环。
 */

describe('投研工坊:子 agent 引导注入', () => {
  it.each(INVEST_MODES.map((m) => m.id))('%s 模式的数据源规则含 research_subagent 引导', (mode) => {
    const prompt = buildInvestPrompt({
      mode,
      symbols: '600519',
      holdings: '600519 100股',
      markets: ['a_share'],
    });
    expect(prompt).toContain('research_subagent');
    expect(prompt).toContain('只读检索子 agent');
    expect(prompt).toContain('并行派发');
    // 行情数字红线:不得以子 agent 转述为据
    expect(prompt).toContain('不得以子 agent 转述的行情数据作为报告依据');
  });
});

describe('教研工坊:子 agent 引导注入', () => {
  it.each(['literature_review', 'paper_read'])('%s 模式的数据源规则含 research_subagent 引导', (mode) => {
    const prompt = buildEduPrompt({ mode, topic: 'RAG 评测', paper: '2506.13538' });
    expect(prompt).toContain('research_subagent');
    expect(prompt).toContain('只读检索子 agent');
    expect(prompt).toContain('并行派发');
    // 学术连接器检索留主循环
    expect(prompt).toContain('学术连接器检索');
  });

  it('备课/学习卡片(非广度调研)不注入子 agent 引导', () => {
    expect(buildEduPrompt({ mode: 'lesson_plan', topic: 't' })).not.toContain('research_subagent');
    expect(buildEduPrompt({ mode: 'flashcards', material: 'm' })).not.toContain('research_subagent');
  });
});
