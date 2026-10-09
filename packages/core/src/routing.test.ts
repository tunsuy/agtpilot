import { describe, it, expect, afterEach } from 'vitest';
import {
  estimateTextTokens,
  estimateToolTokens,
  toolSearchTokenThreshold,
  selectActiveTools,
  stableStringify,
} from './routing';
import type { RoutableTool, ToolRoute } from './contracts';

// 断言失败时 inline delete 不会执行 → env 泄漏会级联污染后续用例，
// 统一在 afterEach 兜底清理
afterEach(() => {
  delete process.env.AGTPILOT_CONTEXT_WINDOW;
  delete process.env.AGTPILOT_TOOL_SEARCH_THRESHOLD;
  delete process.env.AGTPILOT_TOOL_ROUTING;
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
