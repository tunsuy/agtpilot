import { messageText, isToolCallMessage, truncateText } from '@agtpilot/core';

export type CompactionAction = 'keep' | 'drop_result' | 'drop_call';
export interface ToolCallGroup {
  id: string;
  toolCallId: string;
  toolName: string;
  inputPreview: string;
  resultChars: number;
  isError: boolean;
  pinned: boolean;
  callIndex: number;
  resultIndex: number;
}
export interface CallVerdict {
  id: string;
  action: CompactionAction;
  keepCall: number;
  keepResult: number;
  reason: string;
  mode: 'model' | 'heuristic-fallback';
}
export type Asker = (groups: ToolCallGroup[]) => Promise<Map<string, { keepCall: number; keepResult: number }>>;

export function collectToolCalls(
  messages: Array<{ role: string; content: any }>,
  preserveRecent = 6
): ToolCallGroup[] {
  const groups: ToolCallGroup[] = [];
  const byId = new Map<string, ToolCallGroup>();
  const total = messages.length;
  const isPinned = (i: number) => i === 0 || i >= total - preserveRecent;
  messages.forEach((m, idx) => {
    if (m.role === 'assistant' && isToolCallMessage(m)) {
      for (const part of (m.content as any[]) ?? []) {
        const toolCallId: string | undefined = part?.toolCallId ?? part?.id;
        if (!toolCallId) continue;
        const g: ToolCallGroup = {
          id: `t${groups.length + 1}`,
          toolCallId,
          toolName: part.toolName ?? part.name ?? '(unknown)',
          inputPreview: truncateText(messageText(part.input ?? part.args ?? ''), 200),
          resultChars: 0,
          isError: false,
          pinned: isPinned(idx),
          callIndex: idx,
          resultIndex: -1,
        };
        groups.push(g);
        byId.set(toolCallId, g);
      }
    } else if (m.role === 'tool') {
      const parts = Array.isArray(m.content) ? m.content : [m.content];
      for (const p of parts) {
        const toolCallId: string | undefined = p?.toolCallId ?? (m as any)?.toolCallId;
        if (!toolCallId) continue;
        const g = byId.get(toolCallId);
        if (!g) continue;
        const text = messageText(p?.output ?? p?.result ?? p?.text ?? p);
        g.resultChars = text.length;
        g.isError = /fail|error|timeout|exception/i.test(text.slice(0, 2000));
        g.resultIndex = idx;
        if (isPinned(idx)) g.pinned = true;
      }
    }
  });
  return groups;
}

export function heuristicAsker(): Asker {
  return async (groups) => {
    const out = new Map<string, { keepCall: number; keepResult: number }>();
    for (const g of groups) {
      const name = g.toolName.toLowerCase();
      let keepCall = 0.55;
      let keepResult = 0.4;
      if (g.isError) {
        keepCall = 0.8;
        keepResult = 0.95;
      } else if (name.startsWith('list_') || name.includes('dir')) {
        keepCall = 0.54;
        keepResult = 0.0;
      } else if (name.includes('legacy') || name.includes('printer')) {
        keepCall = 0.47;
        keepResult = 0.0;
      } else if (name.startsWith('read_') || name.startsWith('sandbox_')) {
        keepCall = 0.59;
        keepResult = g.resultChars > 4000 ? 0.35 : 0.69;
      }
      out.set(g.id, { keepCall, keepResult });
    }
    return out;
  };
}

export function decideGroups(
  groups: ToolCallGroup[],
  scores: Map<string, { keepCall: number; keepResult: number }>,
  threshold = 0.5
): CallVerdict[] {
  return groups.map((g) => {
    if (g.pinned) {
      return { id: g.id, action: 'keep' as const, keepCall: 1, keepResult: 1, reason: 'pinned', mode: 'heuristic-fallback' as const };
    }
    const s = scores.get(g.id) ?? { keepCall: 0, keepResult: 0 };
    if (s.keepResult >= threshold) {
      return { id: g.id, action: 'keep' as const, keepCall: s.keepCall, keepResult: s.keepResult, reason: 'kept', mode: 'heuristic-fallback' as const };
    }
    if (s.keepCall >= threshold) {
      return { id: g.id, action: 'drop_result' as const, keepCall: s.keepCall, keepResult: s.keepResult, reason: 'truncated', mode: 'heuristic-fallback' as const };
    }
    return { id: g.id, action: 'drop_call' as const, keepCall: s.keepCall, keepResult: s.keepResult, reason: 'dropped', mode: 'heuristic-fallback' as const };
  });
}
