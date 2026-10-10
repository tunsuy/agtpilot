import { describe, it, expect } from 'vitest';
import { heuristicProvider } from './providers';

describe('plugin-decision guards', () => {
  it('低置信 tool-routing 回全量，risk-assist 保守为 true', async () => {
    const p = heuristicProvider();
    const routed = await p.decide('tool-routing', '毫无关键词的闲聊', [
      { kind: 'choice', prompt: '选路由', options: ['browser', 'search', 'all'] },
    ]);
    expect(routed[0].mode).toBe('heuristic-fallback');
    expect(['all', 'browser', 'search']).toContain(routed[0].value);
    const risk = await p.decide('risk-assist', 'rm -rf ~/docs', [{ kind: 'yes-no', prompt: '是否不可逆' }]);
    expect(risk[0].value).toBe(true);
    expect(risk[0].confidence).toBeGreaterThanOrEqual(0.5);
  });
});
