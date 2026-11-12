import { describe, expect, it, vi } from 'vitest';
import type { ToolDefinition } from './contracts';
import { ToolRuntime } from './tool-runtime';

function tool(overrides: Partial<ToolDefinition> & Record<string, any> = {}): ToolDefinition {
  return {
    name: 'search',
    description: 'search',
    parameters: { type: 'object', properties: {} },
    readOnly: true,
    execute: async () => 'ok',
    ...overrides,
  } as ToolDefinition;
}

const session = { taskId: 't1', step: 1 };

describe('ToolRuntime', () => {
  it('只读同参数命中缓存,不重复执行;写操作不缓存', async () => {
    const readonly = vi.fn(async () => 'r');
    const write = vi.fn(async () => 'w');
    const runtime = new ToolRuntime();
    const readTool = tool({ execute: readonly });
    const writeTool = tool({ name: 'email_send', readOnly: false, execute: write });

    expect((await runtime.execute(readTool, { q: 1 }, session)).output).toBe('r');
    expect((await runtime.execute(readTool, { q: 1 }, session)).status).toBe('deduped');
    expect(readonly).toHaveBeenCalledTimes(1);

    expect((await runtime.execute(writeTool, { q: 1 }, session)).output).toBe('w');
    expect((await runtime.execute(writeTool, { q: 1 }, session)).output).toBe('w');
    expect(write).toHaveBeenCalledTimes(2);
    expect(runtime.getStats().dedupedCalls).toBe(1);
  });

  it('关闭缓存后,同签名第 4 次调用被死循环熔断跳过', async () => {
    const execute = vi.fn(async () => 'r');
    const runtime = new ToolRuntime({ policy: { cache: false } });
    const t = tool({ execute });

    for (let i = 0; i < 3; i++) {
      expect((await runtime.execute(t, { q: 1 }, session)).status).toBe('ok');
    }
    const skipped = await runtime.execute(t, { q: 1 }, session);
    expect(skipped.status).toBe('skipped');
    expect(skipped.output).toMatchObject({ skipped: true, repeated: true });
    expect(execute).toHaveBeenCalledTimes(3);
    expect(runtime.getStats().skippedCalls).toBe(1);
  });

  it('同一工具连续失败达阈值时注入 guardHint', async () => {
    const runtime = new ToolRuntime();
    const t = tool({
      execute: async () => {
        throw new Error('net down');
      },
    });

    await runtime.execute(t, { q: 1 }, session);
    await runtime.execute(t, { q: 2 }, session);
    const third = await runtime.execute(t, { q: 3 }, session);
    expect(third.status).toBe('error');
    expect(third.output.guardHint).toContain('连续失败 3 次');
    expect(runtime.getStats().failedCalls).toBe(3);
  });

  it('高危工具 deny 策略直接 fail-closed,不执行工具', async () => {
    const execute = vi.fn(async () => 'ok');
    const runtime = new ToolRuntime({ policy: { approval: 'deny' } });
    const t = tool({ dangerLevel: 'high', execute });

    const result = await runtime.execute(t, { q: 1 }, session);
    expect(result.status).toBe('rejected');
    expect(result.output.rejected).toBe(true);
    expect(execute).not.toHaveBeenCalled();
    expect(runtime.getStats().approvalRejected).toBe(1);
  });

  it('hitl 策略由宿主审批决定是否执行', async () => {
    const execute = vi.fn(async () => 'ok');
    const approve = vi.fn(async () => true);
    const runtime = new ToolRuntime({ policy: { approval: 'hitl' }, approve });
    const t = tool({ name: 'sandbox_run', dangerLevel: 'high', execute });

    expect((await runtime.execute(t, { q: 1 }, session)).status).toBe('ok');
    expect(execute).toHaveBeenCalledTimes(1);
    expect(approve).toHaveBeenCalledTimes(1);

    approve.mockResolvedValueOnce(false);
    const denied = await runtime.execute(t, { q: 2 }, session);
    expect(denied.status).toBe('rejected');
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('超长输出优先走 spill 指针,失败则回退截断', async () => {
    const long = 'x'.repeat(20000);
    const runtime = new ToolRuntime({
      spill: async () => 'spill_1',
    });
    const t = tool({ outputCap: 100, execute: async () => long });

    const spilled = await runtime.execute(t, { q: 1 }, session);
    expect(String(spilled.output)).toContain('全量已保存');
    expect(String(spilled.output)).toContain('doc_read(source="tool_output"');
    expect(spilled.spilled).toMatchObject({ originalChars: 20000 });
    expect(runtime.getStats().spilledOutputs).toBe(1);

    const fallback = new ToolRuntime({
      spill: async () => {
        throw new Error('disk full');
      },
    });
    const truncated = await fallback.execute(t, { q: 2 }, session);
    expect(String(truncated.output).length).toBeLessThan(long.length);
  });
});
