import type { DecisionPoint, DecisionQuestion, DecisionVerdict } from '@agtpilot/core';

export interface DecisionProvider {
  name: string;
  decide(point: DecisionPoint, state: string, questions: DecisionQuestion[]): Promise<DecisionVerdict[]>;
}

/** 本地启发式 provider：零外部依赖，默认兜底。 */
export function heuristicProvider(): DecisionProvider {
  return {
    name: 'heuristic',
    async decide(point, state, questions) {
      const t0 = Date.now();
      return questions.map((q) => {
        if (q.kind === 'choice' && q.options?.length) {
          let value = q.options[q.options.length - 1];
          let confidence = 0.5;
          if (point === 'tool-routing') {
            const hit = q.options.find((o) => o !== 'all' && state.toLowerCase().includes(o.split('_')[0]));
            if (hit) {
              value = hit;
              confidence = 0.62;
            } else {
              confidence = 0.4;
            }
          } else if (point === 'tier-routing') {
            value = q.options.includes('fast') ? 'fast' : q.options[0];
            confidence = 0.55;
          }
          return { kind: q.kind, value, confidence, latencyMs: Date.now() - t0, provider: 'heuristic', mode: 'heuristic-fallback' as const };
        }
        if (q.kind === 'score') {
          const bad = /fail|error|timeout|exception|空转|重复/i.test(state);
          return { kind: q.kind, value: bad ? 0.3 : 0.65, confidence: 0.5, latencyMs: Date.now() - t0, provider: 'heuristic', mode: 'heuristic-fallback' as const };
        }
        const risky = /rm -rf|delete|drop|revoke|扣款|~(\/|$)/i.test(state);
        return { kind: q.kind, value: risky, confidence: risky ? 0.7 : 0.45, latencyMs: Date.now() - t0, provider: 'heuristic', mode: 'heuristic-fallback' as const };
      });
    },
  };
}

/** OpenAI-compatible 自托管 provider 占位：Clef-flash / Kev 等走 vLLM 接入，P0 先返回不可用由上层降级。 */
export function openAiCompatProvider(opts: { baseUrl?: string; model?: string; apiKey?: string } = {}): DecisionProvider {
  return {
    name: 'openai-compat',
    async decide() {
      throw new Error(`openai-compat provider 未配置（baseUrl=${opts.baseUrl ?? '缺失'}），回退启发式`);
    },
  };
}
