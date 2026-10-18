import { describe, it, expect, afterEach } from 'vitest';
import {
  LOAD_TOOLS_NAME,
  toolCatalogEnabled,
  cardLine,
  groupCatalogTools,
  buildToolCatalogNote,
  createLoadToolsDefinition,
  type CatalogableTool,
} from './tool-catalog';

/**
 * 层0 目录卡片 + load_tools 元工具(菜单点菜制 B v1,
 * docs/design/token-consumption-and-tool-loading.md §9.4)纯函数单测。
 * 编排器集成行为见 orchestrator-catalog.test.ts。
 */

afterEach(() => {
  delete process.env.AGTPILOT_TOOL_CATALOG;
});

describe('toolCatalogEnabled 保险丝', () => {
  it('默认开启(未设 env)', () => {
    expect(toolCatalogEnabled()).toBe(true);
  });
  it('AGTPILOT_TOOL_CATALOG=0 关闭', () => {
    process.env.AGTPILOT_TOOL_CATALOG = '0';
    expect(toolCatalogEnabled()).toBe(false);
  });
  it('显式 1 / 其他值均视为开启', () => {
    process.env.AGTPILOT_TOOL_CATALOG = '1';
    expect(toolCatalogEnabled()).toBe(true);
  });
});

describe('cardLine 卡片行', () => {
  it('取描述首行并剥掉开头 [xx] 标签(分组头已带服务器名)', () => {
    expect(
      cardLine({ name: 'mcp_demo_alpha', description: '[MCP连接器: demo] 查询 Alpha 资料\n第二行被丢弃' })
    ).toBe('- mcp_demo_alpha: 查询 Alpha 资料');
  });
  it('超 60 字符截断加省略号', () => {
    const long = 'x'.repeat(100);
    const line = cardLine({ name: 't', description: long });
    expect(line).toBe(`- t: ${'x'.repeat(60)}…`);
  });
  it('无描述回退工具名;剥标签后为空回退原始首行', () => {
    expect(cardLine({ name: 'bare' })).toBe('- bare: bare');
    expect(cardLine({ name: 't2', description: '[tag]' })).toBe('- t2: [tag]');
  });
});

describe('groupCatalogTools 分组', () => {
  it('组按首见序、组内按声明序(输入不重排 → 输出字节稳定)', () => {
    const tools: CatalogableTool[] = [
      { name: 'b1', catalogGroup: 'beta' },
      { name: 'a1', catalogGroup: 'alpha' },
      { name: 'b2', catalogGroup: 'beta' },
      { name: 'x' }, // 无分组 → 兜底组(不出组头)
    ];
    const groups = groupCatalogTools(tools);
    expect(groups.map((g) => g.group)).toEqual(['beta', 'alpha', '']);
    expect(groups[0].tools.map((t) => t.name)).toEqual(['b1', 'b2']);
  });
});

describe('buildToolCatalogNote 目录段', () => {
  it('空目录返回 null', () => {
    expect(buildToolCatalogNote([])).toBeNull();
  });
  it('含工具总数、分组头、卡片行与 load_tools 指引', () => {
    const note = buildToolCatalogNote([
      { name: 'mcp_demo_alpha', description: '[MCP连接器: demo] 查 Alpha', catalogGroup: 'demo' },
      { name: 'mcp_news_pull', description: '[MCP连接器: news] 拉热榜', catalogGroup: 'news' },
    ])!;
    expect(note).toContain('【按需工具目录】');
    expect(note).toContain('以下 2 个工具');
    expect(note).toContain(LOAD_TOOLS_NAME);
    expect(note).toContain('## demo');
    expect(note).toContain('## news');
    expect(note).toContain('- mcp_demo_alpha: 查 Alpha');
    expect(note).toContain('- mcp_news_pull: 拉热榜');
  });
  it('同输入两次构建字节一致(跨步前缀缓存纪律)', () => {
    const tools: CatalogableTool[] = [
      { name: 'm1', description: '[MCP连接器: s] 用途一', catalogGroup: 's' },
      { name: 'm2', description: '[MCP连接器: s] 用途二', catalogGroup: 's' },
    ];
    expect(buildToolCatalogNote(tools)).toBe(buildToolCatalogNote(tools));
  });
});

describe('createLoadToolsDefinition / execute', () => {
  const catalog: CatalogableTool[] = [
    { name: 'mcp_demo_alpha', catalogGroup: 'demo' },
    { name: 'mcp_demo_beta', catalogGroup: 'demo' },
  ];
  function build(mounted = new Set<string>()) {
    const calls: Array<{ loaded: string[]; unknown: string[] }> = [];
    const def = createLoadToolsDefinition({
      catalog,
      isMounted: (n) => mounted.has(n),
      onLoad: (loaded, unknown) => calls.push({ loaded, unknown }),
    });
    return { def, calls, mounted };
  }

  it('工具定义:名字/低危/只读(纯挂载申报,并行门安全)', () => {
    const { def } = build();
    expect(def.name).toBe(LOAD_TOOLS_NAME);
    expect(def.dangerLevel).toBe('low');
    expect(def.readOnly).toBe(true);
    expect((def.parameters as any).required).toEqual(['tools']);
  });

  it('点名成功:loaded 回报 + onLoad 记账', async () => {
    const { def, calls } = build();
    const out: any = await def.execute({ tools: ['mcp_demo_alpha'] }, {} as any);
    expect(out.success).toBe(true);
    expect(out.loaded).toEqual(['mcp_demo_alpha']);
    expect(out.note).toContain('下一步');
    expect(calls).toEqual([{ loaded: ['mcp_demo_alpha'], unknown: [] }]);
  });

  it('目录外名字如实报 unknown,不放行;混合点名单独归档', async () => {
    const { def, calls } = build();
    const out: any = await def.execute(
      { tools: ['mcp_demo_alpha', 'mcp_ghost_tool', 'mcp_demo_beta'] },
      {} as any
    );
    expect(out.success).toBe(false);
    expect(out.loaded).toEqual(['mcp_demo_alpha', 'mcp_demo_beta']);
    expect(out.unknown).toEqual(['mcp_ghost_tool']);
    expect(out.hint).toContain('目录');
    expect(calls).toEqual([{ loaded: ['mcp_demo_alpha', 'mcp_demo_beta'], unknown: ['mcp_ghost_tool'] }]);
  });

  it('已挂载/已点名的工具归 alreadyMounted,不重复记账', async () => {
    const { def, calls } = build(new Set(['mcp_demo_alpha']));
    const out: any = await def.execute({ tools: ['mcp_demo_alpha', 'mcp_demo_beta'] }, {} as any);
    expect(out.loaded).toEqual(['mcp_demo_beta']);
    expect(out.alreadyMounted).toEqual(['mcp_demo_alpha']);
    expect(calls).toEqual([{ loaded: ['mcp_demo_beta'], unknown: [] }]);
  });

  it('tools 为空/非数组:如实报错,不触发 onLoad', async () => {
    const { def, calls } = build();
    const out: any = await def.execute({ tools: [] }, {} as any);
    expect(out.success).toBe(false);
    expect(out.error).toContain('tools 参数为空');
    const out2: any = await def.execute({}, {} as any);
    expect(out2.success).toBe(false);
    expect(calls).toEqual([]);
  });

  it('全 unknown 也发 onLoad(命中分布观测不丢失败样本)', async () => {
    const { def, calls } = build();
    await def.execute({ tools: ['ghost'] }, {} as any);
    expect(calls).toEqual([{ loaded: [], unknown: ['ghost'] }]);
  });
});
