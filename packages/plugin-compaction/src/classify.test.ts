import { describe, it, expect } from 'vitest';
import { collectToolCalls, heuristicAsker, decideGroups, MATERIAL_RESULT_TOOLS } from './classify';

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

  it('read_reference_material 物证豁免:14k+ 大结果原样 keep,不进蒸馏(2026-10-23 双花事故)', async () => {
    const msgs = [
      { role: 'user', content: '按参考资料写文章' },
      {
        role: 'assistant',
        content: [{ type: 'tool-call', toolCallId: 'm1', toolName: 'read_reference_material', input: { materialId: 'upl_1', offset: 0 } }],
      },
      { role: 'tool', content: [{ toolCallId: 'm1', output: 'x'.repeat(14000) }] },
      { role: 'user', content: '继续' },
    ];
    const groups = collectToolCalls(msgs, 1);
    const scores = await heuristicAsker()(groups.filter((g) => !g.pinned));
    const verdicts = decideGroups(groups, scores, 0.5);
    expect(verdicts[0].action).toBe('keep');
    // keep 意味着 orchestrator 会把该 toolCallId 放进 keepToolCallIds,
    // compaction.ts 的消息级路径按 pinned 同语义原样保留
  });

  it('普通 read_ 大结果仍按旧启发式 drop_result(豁免只认物证型名单)', async () => {
    const msgs = [
      { role: 'user', content: '查一下' },
      {
        role: 'assistant',
        content: [{ type: 'tool-call', toolCallId: 'r1', toolName: 'read_file', input: { path: '/tmp/big' } }],
      },
      { role: 'tool', content: [{ toolCallId: 'r1', output: 'y'.repeat(9000) }] },
      { role: 'user', content: '继续' },
    ];
    const groups = collectToolCalls(msgs, 1);
    const scores = await heuristicAsker()(groups.filter((g) => !g.pinned));
    const verdicts = decideGroups(groups, scores, 0.5);
    expect(verdicts[0].action).toBe('drop_result');
  });

  it('MATERIAL_RESULT_TOOLS 大小写不敏感匹配(注册名恒小写,防漂移)', () => {
    expect(MATERIAL_RESULT_TOOLS.size).toBe(1);
    expect(MATERIAL_RESULT_TOOLS.has('read_reference_material')).toBe(true);
  });
});
