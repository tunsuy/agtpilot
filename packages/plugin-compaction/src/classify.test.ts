import { describe, it, expect } from 'vitest';
import { collectToolCalls, heuristicAsker, decideGroups } from './classify';

function sampleMessages() {
  return [
    { role: 'user', content: '修订单导出超时，不要破坏鉴权' },
    { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'c1', toolName: 'list_dir', input: { path: '/' } }] },
    { role: 'tool', content: [{ toolCallId: 'c1', output: 'dir tree ' + 'x'.repeat(5000) }] },
    { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'c3', toolName: 'sandbox_exec', input: { cmd: 'npm test' } }] },
    { role: 'tool', content: [{ toolCallId: 'c3', output: 'FAIL order-export.test.ts Timeout of 5000ms exceeded authorization header missing' }] },
    { role: 'user', content: '继续' },
  ];
}

describe('plugin-compaction', () => {
  it('失败日志 keep，长目录树 drop_result', async () => {
    const msgs = sampleMessages();
    const groups = collectToolCalls(msgs, 1);
    const scores = await heuristicAsker()(groups.filter((g) => !g.pinned));
    const verdicts = decideGroups(groups, scores, 0.5);
    const byTool = new Map(groups.map((g, i) => [g.toolName, verdicts[i].action]));
    expect(byTool.get('list_dir')).toBe('drop_result');
    expect(byTool.get('sandbox_exec')).toBe('keep');
  });
});
