import { Context, Service } from '@deepseek-ai/cordis';
import '@agtpilot/core';
import { collectToolCalls, heuristicAsker, decideGroups } from './classify';

export const name = 'agtpilot-plugin-compaction';
export const inject: string[] = [];

export class CompactionService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'compaction');
  }

  async classify(messages: Array<{ role: string; content: any }>, threshold = 0.5) {
    const groups = collectToolCalls(messages);
    const candidates = groups.filter((g) => !g.pinned);
    if (candidates.length === 0) return { groups, verdicts: [] as never[] };
    const scores = await heuristicAsker()(candidates);
    const verdicts = decideGroups(groups, scores, threshold);
    return { groups, verdicts };
  }

  async buildView(messages: Array<{ role: string; content: any }>, threshold = 0.5) {
    const { groups, verdicts } = await this.classify(messages, threshold);
    if (verdicts.length === 0) return { messages, verdicts, groups, truncated: false };
    const dropCall = new Set(verdicts.filter((v: any) => v.action === 'drop_call').map((v: any) => v.id));
    const dropResult = new Set(verdicts.filter((v: any) => v.action === 'drop_result').map((v: any) => v.id));
    const groupById = new Map(groups.map((g) => [g.id, g]));
    const dropCallIds = new Set(
      [...dropCall].map((id) => groupById.get(id)?.toolCallId).filter(Boolean) as string[]
    );
    const dropResultIds = new Set(
      [...dropResult].map((id) => groupById.get(id)?.toolCallId).filter(Boolean) as string[]
    );
    const out = messages
      .map((m) => {
        if (m.role === 'assistant' && Array.isArray(m.content)) {
          const kept = (m.content as any[]).filter((p) => !dropCallIds.has(p?.toolCallId ?? p?.id));
          if (kept.length === 0) return null;
          return { ...m, content: kept };
        }
        if (m.role === 'tool') {
          const parts = Array.isArray(m.content) ? m.content : [m.content];
          const kept = parts.filter((p: any) => !dropCallIds.has(p?.toolCallId ?? (m as any)?.toolCallId));
          if (kept.length === 0) return null;
          const mapped = kept.map((p: any) => {
            const id = p?.toolCallId ?? (m as any)?.toolCallId;
            if (id && dropResultIds.has(id)) return { ...p, output: '[已截断：调用保留，结果原文移入纪要，可重读/重跑] ' + String(p?.output ?? p?.result ?? '').slice(0, 300) };
            return p;
          });
          return { ...m, content: Array.isArray(m.content) ? mapped : mapped[0] };
        }
        return m;
      })
      .filter(Boolean) as typeof messages;
    this.ctx.emit('agtpilot/compaction', {
      verdicts: (verdicts as any[]).map((v) => ({ ...v })),
      before: messages.length,
      after: out.length,
    });
    return { messages: out, verdicts, groups, truncated: out.length !== messages.length };
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    compaction: CompactionService;
  }
  interface Events {
    'agtpilot/compaction'(payload: { verdicts: unknown[]; before: number; after: number }): void;
  }
}

export function apply(ctx: Context) {
  new CompactionService(ctx);
}
