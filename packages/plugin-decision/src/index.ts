import { Context, Service } from '@deepseek-ai/cordis';
import '@agtpilot/core';
import type { DecisionGateway, DecisionPoint, DecisionQuestion, DecisionVerdict } from '@agtpilot/core';
import { heuristicProvider, openAiCompatProvider, type DecisionProvider } from './providers';

export const name = 'agtpilot-plugin-decision';
export const inject: string[] = [];

const CONFIDENCE = Math.min(0.95, Math.max(0.1, Number(process.env.AGTPILOT_DECISION_CONFIDENCE) || 0.7));
const TIMEOUT_MS = Math.max(20, Number(process.env.AGTPILOT_DECISION_TIMEOUT_MS) || 150);
const POINTS = new Set(
  (process.env.AGTPILOT_DECISION_POINTS || 'tool-routing').split(',').map((s) => s.trim()).filter(Boolean)
);

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('decision timeout')), ms);
    p.then((v) => {
      clearTimeout(t);
      resolve(v);
    }).catch((e) => {
      clearTimeout(t);
      reject(e);
    });
  });
}

export class DecisionService extends Service implements DecisionGateway {
  private primary: DecisionProvider;
  private fallback = heuristicProvider();

  constructor(ctx: Context) {
    super(ctx, 'decision');
    const provider = process.env.AGTPILOT_DECISION_PROVIDER || 'heuristic';
    this.primary =
      provider === 'openai-compat'
        ? openAiCompatProvider({
            baseUrl: process.env.AGTPILOT_DECISION_BASE_URL,
            model: process.env.AGTPILOT_DECISION_MODEL,
            apiKey: process.env.AGTPILOT_DECISION_API_KEY,
          })
        : heuristicProvider();
  }

  isAvailable(): boolean {
    return process.env.AGTPILOT_DECISION !== '0';
  }

  async decide(point: DecisionPoint, state: string, questions: DecisionQuestion[], opts?: { timeoutMs?: number; userId?: string }): Promise<DecisionVerdict[]> {
    const t0 = Date.now();
    if (!POINTS.has(point)) {
      return this.fallback.decide(point, state, questions);
    }
    const safeState = state.slice(0, 4000);
    try {
      const verdicts = await withTimeout(this.primary.decide(point, safeState, questions), opts?.timeoutMs ?? TIMEOUT_MS);
      const out = verdicts.map((v) => ({ ...v, latencyMs: Date.now() - t0 }));
      this.emitAudit(point, out, safeState, opts?.userId);
      return this.applyGuards(point, out, safeState);
    } catch {
      const verdicts = await this.fallback.decide(point, safeState, questions);
      const out = verdicts.map((v) => ({ ...v, latencyMs: Date.now() - t0 }));
      this.emitAudit(point, out, safeState, opts?.userId);
      return this.applyGuards(point, out, safeState);
    }
  }

  private applyGuards(point: DecisionPoint, verdicts: DecisionVerdict[], state: string): DecisionVerdict[] {
    return verdicts.map((v) => {
      if (v.confidence < CONFIDENCE) {
        if (point === 'tool-routing' && v.kind === 'choice') return { ...v, value: 'all' };
        if (point === 'tier-routing' && v.kind === 'choice') return { ...v, value: 'fast' };
        if (point === 'risk-assist' && v.kind === 'yes-no') return { ...v, value: true };
        if (point === 'loop-progress' && v.kind === 'score') return { ...v, value: 0.6 };
      }
      void state;
      return v;
    });
  }

  private emitAudit(point: DecisionPoint, verdicts: DecisionVerdict[], state: string, userId?: string) {
    try {
      const hash = (s: string) => {
        let h = 0;
        for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
        return h.toString(16);
      };
      this.ctx.emit('agtpilot/decision', {
        point,
        provider: verdicts[0]?.provider ?? 'unknown',
        mode: verdicts[0]?.mode ?? 'heuristic-fallback',
        latencyMs: verdicts[0]?.latencyMs ?? 0,
        confidence: verdicts[0]?.confidence ?? 0,
        stateHash: hash(state),
        userId: userId ?? 'default',
      });
    } catch {
      // 审计失败不影响裁决
    }
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    decision: DecisionService;
  }
  interface Events {
    'agtpilot/decision'(payload: { point: string; provider: string; mode: string; latencyMs: number; confidence: number; stateHash: string; userId: string }): void;
  }
}

export function apply(ctx: Context) {
  new DecisionService(ctx);
}
