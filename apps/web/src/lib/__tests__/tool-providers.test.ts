import { describe, it, expect } from 'vitest';
import type { ToolDefinition } from '@agtpilot/core';
import {
  TOOL_PROVIDERS,
  resolveProviderTools,
  type ToolProvider,
  type ToolProviderEntry,
  type ToolProviderDep,
} from '../tool-providers';

/**
 * 工具提供方注册表(skill 包重构 Phase 1)。
 * 此前 agent-backend 是约 200 行硬编码注入块;收敛为模块自带 TOOL_PROVIDER
 * 描述符 + 本注册表按序装载。锚定:注册表元数据完整性(id 唯一/依赖闭集/
 * 条目可装载)、单 provider 抛错的隔离性(不得中断其余 —— 原 per-block
 * try/catch 的语义平移)。
 */

/** 最小 ToolDefinition 替身(只用到 name;resolve 只读 name) */
const t = (name: string) => ({ name } as ToolDefinition);

const DEP_VOCAB = new Set<ToolProviderDep>(['uid', 'browser', 'artifact']);

describe('TOOL_PROVIDERS 注册表元数据', () => {
  it('八个提供方全部注册,顺序稳定(与旧硬编码块的语义顺序一致)', () => {
    expect(TOOL_PROVIDERS.map((p) => p.id)).toEqual([
      'ppt',
      'wechat_mp',
      'email_smtp',
      'email_imap',
      'follow_builders',
      'github_scan',
      'xhs',
      'zhihu',
    ]);
  });

  it('entry id 与模块内 TOOL_PROVIDER.id 一致,deps 全部在闭集内,build 是函数', async () => {
    for (const entry of TOOL_PROVIDERS) {
      const mod = await entry.load();
      const p = mod.TOOL_PROVIDER as ToolProvider;
      expect(p.id, entry.id).toBe(entry.id);
      expect(typeof p.build).toBe('function');
      for (const d of p.deps ?? []) {
        expect(DEP_VOCAB.has(d), `${entry.id} 的依赖 ${d} 不在闭集内`).toBe(true);
      }
    }
  });

  it('依赖 uid 的提供方,build 必须实际使用 ctx.uid(防描述符与实现漂移)', async () => {
    for (const entry of TOOL_PROVIDERS) {
      const mod = await entry.load();
      if (mod.TOOL_PROVIDER.deps.includes('uid')) {
        expect(String(mod.TOOL_PROVIDER.build)).toContain('uid');
      }
    }
  });
});

describe('resolveProviderTools 装载与隔离', () => {
  const ctx = { uid: 'u_test' };

  it('按序装载,产出工具并入列表;空数组 provider 不记日志', async () => {
    const logs: Array<[string, string]> = [];
    const providers: ToolProviderEntry[] = [
      {
        id: 'a',
        load: async () => ({
          TOOL_PROVIDER: {
            id: 'a',
            deps: [],
            build: () => [t('tool_a1'), t('tool_a2')],
          },
        }),
      },
      { id: 'empty', load: async () => ({ TOOL_PROVIDER: { id: 'empty', deps: [], build: () => [] } }) },
      {
        id: 'b',
        load: async () => ({
          TOOL_PROVIDER: { id: 'b', deps: [], build: async () => [t('tool_b1')] },
        }),
      },
    ];
    const tools = await resolveProviderTools(ctx, (l, m) => logs.push([l, m]), providers);

    expect(tools.map((t: any) => t.name)).toEqual(['tool_a1', 'tool_a2', 'tool_b1']);
    expect(logs).toEqual([
      ['system', '[REG] a 工具挂载: tool_a1 / tool_a2'],
      ['system', '[REG] b 工具挂载: tool_b1'],
    ]);
  });

  it('单个 provider 抛错只记 stderr,不中断其余(原 per-block try/catch 语义)', async () => {
    const logs: Array<[string, string]> = [];
    const providers: ToolProviderEntry[] = [
      {
        id: 'boom',
        load: async () => ({
          TOOL_PROVIDER: {
            id: 'boom',
            deps: [],
            build: () => {
              throw new Error('ECONNRESET');
            },
          },
        }),
      },
      {
        id: 'ok',
        load: async () => ({
          TOOL_PROVIDER: { id: 'ok', deps: [], build: () => [t('tool_ok')] },
        }),
      },
    ];
    const tools = await resolveProviderTools(ctx, (l, m) => logs.push([l, m]), providers);

    expect(tools.map((t: any) => t.name)).toEqual(['tool_ok']);
    expect(logs.find(([l]) => l === 'stderr')?.[1]).toContain('[REG] boom 挂载异常');
    expect(logs.find(([l]) => l === 'stderr')?.[1]).toContain('ECONNRESET');
  });

  it('entry.load 本身抛错(模块损坏)同样被隔离', async () => {
    const logs: Array<[string, string]> = [];
    const providers: ToolProviderEntry[] = [
      { id: 'broken', load: () => Promise.reject(new Error('module not found')) },
      {
        id: 'ok',
        load: async () => ({ TOOL_PROVIDER: { id: 'ok', deps: [], build: () => [] } }),
      },
    ];
    const tools = await resolveProviderTools(ctx, (l, m) => logs.push([l, m]), providers);
    expect(tools).toEqual([]);
    expect(logs.find(([l]) => l === 'stderr')?.[1]).toContain('[REG] broken 挂载异常');
  });
});
