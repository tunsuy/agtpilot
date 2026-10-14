import { describe, it, expect } from 'vitest';
import type { Mission } from '@/types/agent';
import { settleToolStep, upsertToolStep } from '@/lib/tool-steps';

/**
 * 工具步骤 callId 关联(tool-steps.ts):同轮并行多工具 + 插件/编排器双广播下,
 * 步骤按物理调用 id 幂等落地与精确收尾。
 *
 * 生产实例(2026-10-14 mission_1791968561786)锚定的回归场景:同秒 4 个
 * tool_call 事件(2 个物理调用 × 双广播,插件层 payload 平铺无 args 字段),
 * 旧「工具名+末位位置」倒查产生成对重复步骤、真实结果落错步骤、孤儿步骤
 * 挂「执行中」百秒后被无关事件误关。此处按该事件序列逐字复现并断言修复。
 */

function makeMission(id = 'mission_test'): Mission {
  return { id, title: 'test', status: 'ACTIVE', progress: 5, startedAt: Date.now(), steps: [] };
}

describe('upsertToolStep · callId 路径', () => {
  it('双广播(编排器带 args / 插件层平铺)合并为一步,入参保持干净', () => {
    const m = makeMission();
    upsertToolStep(m, { tool: 'search_web', args: { query: '自驾', maxResults: 6 }, callId: 'call_a' });
    upsertToolStep(m, { tool: 'search_web', callId: 'call_a' }); // 插件层平铺事件:无 args 字段
    expect(m.steps).toHaveLength(1);
    expect(m.steps[0].callId).toBe('call_a');
    expect(m.steps[0].args).toEqual({ query: '自驾', maxResults: 6 });
    expect(m.steps[0].status).toBe('RUNNING');
  });

  it('带 args 的二次广播刷新入参(规整形状优先)', () => {
    const m = makeMission();
    upsertToolStep(m, { tool: 'mcp_zhihu', args: { query: '对比' }, callId: 'call_b' });
    upsertToolStep(m, { tool: 'mcp_zhihu', args: { query: '对比', count: 8 }, callId: 'call_b' });
    expect(m.steps).toHaveLength(1);
    expect(m.steps[0].args).toEqual({ query: '对比', count: 8 });
  });

  it('同轮并行的两个不同调用各自成步,交错到达不互相吞并', () => {
    const m = makeMission();
    // 生产实例的交错序列:search → zhihu → search(dup) → zhihu(dup)
    upsertToolStep(m, { tool: 'search_web', args: { query: '自驾' }, callId: 'call_1' });
    upsertToolStep(m, { tool: 'mcp_zhihu', args: { query: '对比' }, callId: 'call_2' });
    upsertToolStep(m, { tool: 'search_web', callId: 'call_1' });
    upsertToolStep(m, { tool: 'mcp_zhihu', callId: 'call_2' });
    expect(m.steps).toHaveLength(2); // 旧实现在此翻倍成 4 步
    expect(m.steps.map((s) => s.tool)).toEqual(['search_web', 'mcp_zhihu']);
    expect(m.steps.every((s) => s.status === 'RUNNING')).toBe(true);
  });
});

describe('settleToolStep · callId 路径', () => {
  it('精确收尾:同名工具并行时只关自己的步骤', () => {
    const m = makeMission();
    upsertToolStep(m, { tool: 'mcp_zhihu', args: { query: '对比' }, callId: 'call_1' });
    upsertToolStep(m, { tool: 'mcp_zhihu', args: { query: '动卧' }, callId: 'call_2' });
    const changed = settleToolStep(m, { tool: 'mcp_zhihu', output: { content: [] }, callId: 'call_2' });
    expect(changed).toBe(true);
    expect(m.steps[0].status).toBe('RUNNING'); // call_1 不被误关
    expect(m.steps[1].status).toBe('DONE');
    expect(m.steps[1].output).toEqual({ content: [] });
    expect(m.steps[1].duration).toMatch(/ms$/);
  });

  it('未知 callId 的事件不误关任何步骤(路过的无关 tool_result)', () => {
    const m = makeMission();
    upsertToolStep(m, { tool: 'mcp_zhihu', args: {}, callId: 'call_1' });
    const changed = settleToolStep(m, { tool: 'mcp_zhihu', output: null, callId: 'call_其他' });
    expect(changed).toBe(false);
    expect(m.steps[0].status).toBe('RUNNING');
  });

  it('浏览器插件层先收尾(无 output)→ 内核权威事件补洞', () => {
    const m = makeMission();
    upsertToolStep(m, { tool: 'browser_fill', args: { selector: '#a' }, callId: 'call_1' });
    settleToolStep(m, { tool: 'browser_fill', callId: 'call_1' }); // 插件层:不带 output
    expect(m.steps[0].status).toBe('DONE');
    expect(m.steps[0].output).toBeUndefined();
    const changed = settleToolStep(m, { tool: 'browser_fill', output: { success: true }, callId: 'call_1' });
    expect(changed).toBe(true);
    expect(m.steps[0].output).toEqual({ success: true });
  });

  it('同 callId 重复收尾幂等:不二次改时长/状态', () => {
    const m = makeMission();
    upsertToolStep(m, { tool: 'search_web', args: { query: 'x' }, callId: 'call_1' });
    settleToolStep(m, { tool: 'search_web', output: { a: 1 }, callId: 'call_1' });
    const dur = m.steps[0].duration;
    const changed = settleToolStep(m, { tool: 'search_web', output: { b: 2 }, callId: 'call_1' });
    expect(changed).toBe(false);
    expect(m.steps[0].duration).toBe(dur);
    expect(m.steps[0].output).toEqual({ a: 1 });
  });

  it('compensation 随收尾落盘', () => {
    const m = makeMission();
    upsertToolStep(m, { tool: 'xhs_save_note_draft', args: {}, callId: 'call_1' });
    settleToolStep(m, {
      tool: 'xhs_save_note_draft',
      output: { ok: true },
      compensation: { kind: 'reversible', undoHint: '删草稿' },
      callId: 'call_1',
    });
    expect(m.steps[0].compensation).toEqual({ kind: 'reversible', undoHint: '删草稿' });
  });
});

describe('无 callId 兜底(旧事件源,行为不变)', () => {
  it('tool_call:末位同名 RUNNING 去重,无匹配新建;payload 整包当入参', () => {
    const m = makeMission();
    upsertToolStep(m, { tool: 'search_web', payload: { tool: 'search_web', query: 'q' } });
    upsertToolStep(m, { tool: 'search_web', payload: { tool: 'search_web', query: 'q2' } });
    expect(m.steps).toHaveLength(1);
    expect(m.steps[0].args).toEqual({ tool: 'search_web', query: 'q2' });
    upsertToolStep(m, { tool: 'mcp_zhihu', args: { query: 'z' } });
    expect(m.steps).toHaveLength(2);
  });

  it('tool_result:倒查最后一个 RUNNING 同名步骤收尾', () => {
    const m = makeMission();
    upsertToolStep(m, { tool: 'search_web', payload: { tool: 'search_web', query: 'q' } });
    upsertToolStep(m, { tool: 'mcp_zhihu', args: {} });
    const changed = settleToolStep(m, { tool: 'mcp_zhihu', output: { r: 1 } });
    expect(changed).toBe(true);
    expect(m.steps[1].status).toBe('DONE');
    expect(m.steps[0].status).toBe('RUNNING');
  });
});

describe('生产实例复现(2026-10-14 交错双广播序列)', () => {
  it('2 个物理调用 × 双广播交错 → 恰好 2 步、结果各归其位、无孤儿「执行中」', () => {
    const m = makeMission();
    // 17:03:00 实录事件序:编排器 search → 编排器 zhihu → 插件 search(平铺) → 插件 zhihu(带 args)
    upsertToolStep(m, { tool: 'search_web', args: { query: '自驾', maxResults: 6 }, callId: 'call_s' });
    upsertToolStep(m, { tool: 'mcp_zhihu', args: { query: '对比', count: 8 }, callId: 'call_z' });
    upsertToolStep(m, { tool: 'search_web', callId: 'call_s' });
    upsertToolStep(m, { tool: 'mcp_zhihu', args: { query: '对比', count: 8 }, callId: 'call_z' });
    // 结果:search 487ms 真结果归 call_s;zhihu 16KB 真结果归 call_z;
    // 路过的无关 tool_result(旧序里会误关孤儿)不再产生任何影响
    settleToolStep(m, { tool: 'search_web', output: { success: true, query: '自驾' }, callId: 'call_s' });
    settleToolStep(m, { tool: 'mcp_zhihu', output: { content: ['<result 16KB>'] }, callId: 'call_z' });
    settleToolStep(m, { tool: 'mcp_zhihu', output: null, callId: 'call_无关' });

    expect(m.steps).toHaveLength(2); // 旧实录:4 步,其中 2 步孤儿 RUNNING
    expect(m.steps.every((s) => s.status === 'DONE')).toBe(true);
    expect(m.steps[0].args).toEqual({ query: '自驾', maxResults: 6 }); // 入参不交叉
    expect(m.steps[0].output).toEqual({ success: true, query: '自驾' }); // 出参各归其位
    expect(m.steps[1].output).toEqual({ content: ['<result 16KB>'] });
  });
});
