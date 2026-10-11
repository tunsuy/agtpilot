import { describe, it, expect, afterEach } from 'vitest';
import {
  estimateTextTokens,
  estimateToolTokens,
  toolSearchTokenThreshold,
  selectActiveTools,
  widenMountedTools,
  filterToolsByEnv,
  stableStringify,
} from './routing';
import type { RoutableTool, ToolRoute } from './contracts';

// 断言失败时 inline delete 不会执行 → env 泄漏会级联污染后续用例，
// 统一在 afterEach 兜底清理
afterEach(() => {
  delete process.env.AGTPILOT_CONTEXT_WINDOW;
  delete process.env.AGTPILOT_TOOL_SEARCH_THRESHOLD;
  delete process.env.AGTPILOT_TOOL_ROUTING;
  delete process.env.EXA_API_KEY;
  delete process.env.TAVILY_API_KEY;
  delete process.env.FIRECRAWL_API_KEY;
});

const mkTool = (name: string, extra: Partial<RoutableTool> = {}): RoutableTool => ({
  name,
  description: 'x',
  parameters: { type: 'object', properties: {} },
  ...extra,
});

const ROUTES: ToolRoute[] = [
  { id: 'browser', prefixes: ['browser_'], test: /(网页|浏览|browser)/i },
  { id: 'search', prefixes: ['search_'], test: /(搜索|search)/i },
  { id: 'sandbox', prefixes: ['sandbox_'], test: /(运行|execute)/i },
];

const TOOLS: RoutableTool[] = [
  mkTool('browser_navigate'),
  mkTool('search_web'),
  mkTool('sandbox_run_command'),
  mkTool('memory_store', { baseline: true }),
  mkTool('planner_create_plan', { baseline: true }),
];

describe('estimateTextTokens', () => {
  it('CJK 按约 1 token/字', () => {
    expect(estimateTextTokens('中文测试')).toBe(4);
  });
  it('ASCII 按约 4 字符/token', () => {
    expect(estimateTextTokens('abcdefgh')).toBe(2);
  });
  it('混合文本按两类分别计', () => {
    expect(estimateTextTokens('中文abcd')).toBeCloseTo(3, 5);
  });
});

describe('estimateToolTokens', () => {
  it('工具声明体积随 description 增长', () => {
    const small = estimateToolTokens([mkTool('a')]);
    const big = estimateToolTokens([mkTool('a', { description: '很长的描述'.repeat(50) })]);
    expect(big).toBeGreaterThan(small);
  });
});

describe('toolSearchTokenThreshold', () => {
  it('按上下文窗口百分比计算（下限 1024：窗口声明再小也会被抬到 1024）', () => {
    process.env.AGTPILOT_CONTEXT_WINDOW = '2048';
    process.env.AGTPILOT_TOOL_SEARCH_THRESHOLD = '10';
    expect(toolSearchTokenThreshold()).toBe(204); // floor(2048 * 10%)
  });
});

describe('selectActiveTools', () => {
  it('未超阈值时全量挂载（返回 undefined）', () => {
    expect(selectActiveTools('打开网页', TOOLS, ROUTES)).toBeUndefined();
  });

  it('超阈值时按插件注册的路由规则挂载对应工具组', () => {
    process.env.AGTPILOT_CONTEXT_WINDOW = '1'; // 强制超阈值
    const result = selectActiveTools('帮我浏览这个网页', TOOLS, ROUTES);
    expect(result).toContain('browser_navigate');
    expect(result).not.toContain('sandbox_run_command');
  });

  it('基线工具无论如何都挂载', () => {
    process.env.AGTPILOT_CONTEXT_WINDOW = '1';
    const result = selectActiveTools('帮我搜索一下', TOOLS, ROUTES);
    expect(result).toContain('search_web');
    expect(result).toContain('memory_store'); // baseline: true
    expect(result).toContain('planner_create_plan'); // baseline: true
  });

  it('prompt 里显式提到的工具名直接保留', () => {
    process.env.AGTPILOT_CONTEXT_WINDOW = '1';
    const result = selectActiveTools('运行 sandbox_run_command 这个工具', TOOLS, ROUTES);
    expect(result).toContain('sandbox_run_command');
  });

  it('未命中任何路由规则时全量兜底', () => {
    process.env.AGTPILOT_CONTEXT_WINDOW = '1';
    expect(selectActiveTools('讲个笑话', TOOLS, ROUTES)).toBeUndefined();
  });

  it('显式指定工具子集时直接生效', () => {
    expect(selectActiveTools('任意', TOOLS, ROUTES, ['search_web', '不存在的工具'])).toEqual(['search_web']);
  });

  it('路由开关关闭时全量挂载', () => {
    process.env.AGTPILOT_TOOL_ROUTING = '0';
    process.env.AGTPILOT_CONTEXT_WINDOW = '1';
    expect(selectActiveTools('帮我浏览这个网页', TOOLS, ROUTES)).toBeUndefined();
  });

  it('新插件注册路由无需改内核：未知前缀同样可路由', () => {
    process.env.AGTPILOT_CONTEXT_WINDOW = '1';
    const newPluginTools = [...TOOLS, mkTool('weather_query')];
    const newRoutes: ToolRoute[] = [...ROUTES, { id: 'weather', prefixes: ['weather_'], test: /天气|weather/i }];
    const result = selectActiveTools('查一下明天天气', newPluginTools, newRoutes);
    expect(result).toContain('weather_query');
  });
});

describe('widenMountedTools（任务内只扩不缩）', () => {
  it('next 带新增工具 → 返回并集（扩容那一步才写回，provider 前缀缓存只破一次）', () => {
    const mounted = new Set(['search_web', 'memory_store']);
    const r = widenMountedTools(mounted, ['search_web', 'browser_navigate', 'memory_store']);
    expect(r).toEqual(['search_web', 'memory_store', 'browser_navigate']);
    expect(mounted.has('browser_navigate')).toBe(true); // 就地并入冻结集合
  });

  it('next 是子集（缩容）→ 返回 null 且集合不缩：挂载面不回退', () => {
    const mounted = new Set(['search_web', 'browser_navigate']);
    expect(widenMountedTools(mounted, ['search_web'])).toBeNull();
    expect(mounted.size).toBe(2);
  });

  it('next 与集合完全一致 → 返回 null：不写回即声明前缀不变，缓存命中保持', () => {
    const mounted = new Set(['search_web']);
    expect(widenMountedTools(mounted, ['search_web'])).toBeNull();
  });

  it('next 为 undefined（路由无意见/全量兜底）→ 返回 null，保持当前集合', () => {
    const mounted = new Set(['search_web']);
    expect(widenMountedTools(mounted, undefined)).toBeNull();
    expect(mounted.size).toBe(1);
  });

  it('模拟步进序列：第一步扩容写回、后续步骤集合稳定（不重不缩）', () => {
    // 初始路由：搜索任务挂 search_ + baseline
    const mounted = new Set<string>(['search_web', 'memory_store']);
    // 步骤 3：工具结果里出现 URL → 重算把浏览器组扩进来
    const w1 = widenMountedTools(mounted, ['search_web', 'memory_store', 'browser_navigate', 'browser_screenshot']);
    expect(w1).toEqual(['search_web', 'memory_store', 'browser_navigate', 'browser_screenshot']);
    // 步骤 4-6：话题不再命中浏览器关键词 → 重算缩回，但挂载面不回退
    expect(widenMountedTools(mounted, ['search_web'])).toBeNull();
    expect(widenMountedTools(mounted, ['search_web'])).toBeNull();
    expect([...mounted]).toHaveLength(4);
  });
});

describe('stableStringify', () => {
  it('对象 key 排序后同结构对象签名一致', () => {
    expect(stableStringify({ b: 1, a: 2 })).toEqual(stableStringify({ a: 2, b: 1 }));
  });
  it('字符串去空白标点并小写化（微调参数式重试归一为同签名）', () => {
    expect(stableStringify('Hello, World!')).toEqual(stableStringify('helloworld'));
  });
  it('数组递归处理', () => {
    expect(stableStringify([{ y: 1, x: 2 }])).toEqual(stableStringify([{ x: 2, y: 1 }]));
  });
});

describe('filterToolsByEnv（缺 Key 工具不挂载,P5）', () => {
  const tool = (name: string, requiredEnv?: string[]) => ({ name, requiredEnv }) as any;

  it('无 requiredEnv 声明的工具始终挂载（内部工具不受影响）', () => {
    const { mounted, missingKeyTools } = filterToolsByEnv([tool('search_web'), tool('browser_navigate')]);
    expect(mounted.map((t) => t.name)).toEqual(['search_web', 'browser_navigate']);
    expect(missingKeyTools).toEqual([]);
  });

  it('taskEnv 与 process.env 均无 Key → 剔除并进入 missingKeyTools（不再挂秒败的壳）', () => {
    const { mounted, missingKeyTools } = filterToolsByEnv(
      [tool('search_exa', ['EXA_API_KEY']), tool('search_web')],
      {},
    );
    expect(mounted.map((t) => t.name)).toEqual(['search_web']);
    expect(missingKeyTools.map((t) => t.name)).toEqual(['search_exa']);
  });

  it('用户个人空间（taskEnv）带 Key → 挂载（多用户隔离:他人无 Key 不影响本任务）', () => {
    const { mounted, missingKeyTools } = filterToolsByEnv(
      [tool('search_exa', ['EXA_API_KEY'])],
      { EXA_API_KEY: 'user-key' },
    );
    expect(mounted).toHaveLength(1);
    expect(missingKeyTools).toEqual([]);
  });

  it('process.env 带 Key → 挂载（服务级配置路径不受影响）', () => {
    process.env.FIRECRAWL_API_KEY = 'server-key';
    const { mounted } = filterToolsByEnv([tool('browser_firecrawl_scrape', ['FIRECRAWL_API_KEY'])]);
    expect(mounted).toHaveLength(1);
  });

  it('requiredEnv 为任一存在即满足（anyOf 语义,供别名/多 Key 兼容声明）', () => {
    const { mounted } = filterToolsByEnv([tool('search_tavily', ['TAVILY_API_KEY', 'TAVELY_KEY'])], {
      TAVELY_KEY: 'x',
    });
    expect(mounted).toHaveLength(1);
  });

  it('taskEnv 缺省(undefined)且 process.env 无 Key → 同样剔除', () => {
    const { missingKeyTools } = filterToolsByEnv([tool('search_tavily', ['TAVILY_API_KEY'])]);
    expect(missingKeyTools).toHaveLength(1);
  });
});
