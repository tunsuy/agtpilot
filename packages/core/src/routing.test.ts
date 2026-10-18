import { describe, it, expect, afterEach } from 'vitest';
import {
  estimateTextTokens,
  estimateToolTokens,
  toolSearchTokenThreshold,
  selectActiveTools,
  isSmalltalkPrompt,
  widenMountedTools,
  filterToolsByEnv,
  stableStringify,
} from './routing';
import type { RoutableTool } from './routing';
import type { ToolRoute } from './contracts';

// 断言失败时 inline delete 不会执行 → env 泄漏会级联污染后续用例，
// 统一在 afterEach 兜底清理
afterEach(() => {
  delete process.env.AGTPILOT_CONTEXT_WINDOW;
  delete process.env.AGTPILOT_TOOL_SEARCH_THRESHOLD;
  delete process.env.AGTPILOT_TOOL_ROUTING;
  delete process.env.AGTPILOT_ROUTE_FALLBACK;
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

  it('未命中任何路由规则时收敛兜底:baseline(+fallback)而非全量(§9.5)', () => {
    process.env.AGTPILOT_CONTEXT_WINDOW = '1';
    // TOOLS 无 fallback 标记 → 兜底档 = baseline 对,声明序
    expect(selectActiveTools('讲个笑话', TOOLS, ROUTES)).toEqual([
      'memory_store',
      'planner_create_plan',
    ]);
  });

  it('零命中兜底的保险丝:AGTPILOT_ROUTE_FALLBACK=full 恢复全量(undefined)', () => {
    process.env.AGTPILOT_CONTEXT_WINDOW = '1';
    process.env.AGTPILOT_ROUTE_FALLBACK = 'full';
    expect(selectActiveTools('讲个笑话', TOOLS, ROUTES)).toBeUndefined();
  });

  it('闲聊短路：全串问候/自我介绍只挂基线工具（「你是谁」不再背 135 个 MCP 工具）', () => {
    process.env.AGTPILOT_CONTEXT_WINDOW = '1';
    for (const hi of ['你是谁', '你好', '自我介绍', '你能做什么？', 'Hello!', '在吗', '谢谢！']) {
      const result = selectActiveTools(hi, TOOLS, ROUTES);
      expect(result).toEqual(['memory_store', 'planner_create_plan']); // 仅 baseline
    }
  });

  it('闲聊短路误伤防线：半截任务话不命中（全串锚定），该路由路由、该兜底兜底', () => {
    process.env.AGTPILOT_CONTEXT_WINDOW = '1';
    // 不是全串问候 → 不走闲聊短路;「搜索」命中 search 路由(正确,不是误伤)
    const hybrid = selectActiveTools('你好，帮我搜索一下', TOOLS, ROUTES);
    expect(hybrid).toContain('search_web');
    expect(hybrid).not.toContain('browser_navigate');
    // 无任何路由命中 → 收敛兜底(baseline 对,§9.5;不再全量)
    expect(selectActiveTools('你是谁的作者', TOOLS, ROUTES)).toEqual([
      'memory_store',
      'planner_create_plan',
    ]);
    expect(selectActiveTools('介绍一下 RAG 架构', TOOLS, ROUTES)).toEqual([
      'memory_store',
      'planner_create_plan',
    ]);
  });

  it('闲聊短路后转入真实任务：只扩不缩机制把工具扩回来', () => {
    process.env.AGTPILOT_CONTEXT_WINDOW = '1';
    // 第一步:闲聊 → 只挂基线
    const initial = selectActiveTools('你是谁', TOOLS, ROUTES)!;
    const mounted = new Set<string>(initial);
    // 续聊转入任务:步内重算命中 search 路由 → widen 扩容
    const next = selectActiveTools('帮我搜索一下', TOOLS, ROUTES)!;
    const widened = widenMountedTools(mounted, next);
    expect(widened).toContain('search_web');
    expect(widened).toContain('memory_store'); // 基线还在
  });

  it('显式白名单:精确名生效、未知名静默跳过、baseline 自动并入、按目录序返回', () => {
    expect(selectActiveTools('任意', TOOLS, ROUTES, ['search_web', '不存在的工具'])).toEqual([
      'search_web',
      'memory_store', // baseline 自动并入(工坊无需声明任务骨架工具)
      'planner_create_plan',
    ]);
  });

  it('显式白名单:前缀通配(mcp_deepwiki_*)整组匹配,精确名与通配可混用', () => {
    const mcpTools = [
      ...TOOLS,
      mkTool('mcp_deepwiki_ask_question'),
      mkTool('mcp_deepwiki_read_wiki'),
      mkTool('mcp_github_mcp_create_issue'),
      mkTool('mcp_github_mcp_search_issues'),
    ];
    const result = selectActiveTools('任意', mcpTools, ROUTES, [
      'mcp_deepwiki_*',
      'mcp_github_mcp_search_issues',
    ])!;
    expect(result).toContain('mcp_deepwiki_ask_question');
    expect(result).toContain('mcp_deepwiki_read_wiki');
    expect(result).toContain('mcp_github_mcp_search_issues');
    expect(result).not.toContain('mcp_github_mcp_create_issue'); // 未声明的同台写工具不进
    expect(result).not.toContain('browser_navigate');
  });

  it('显式白名单:结果与 prompt 无关且跨步字节稳定(重算不触发 widen,缓存不破)', () => {
    const explicit = ['mcp_deepwiki_*', 'search_web'];
    const tools = [...TOOLS, mkTool('mcp_deepwiki_ask_question')];
    const first = selectActiveTools('扫描 github 仓库并浏览网页', tools, ROUTES, explicit)!;
    const second = selectActiveTools('完全无关的后续步骤文本', tools, ROUTES, explicit)!;
    expect(second).toEqual(first);
    const mounted = new Set(first);
    expect(widenMountedTools(mounted, second)).toBeNull(); // 无新增可并 → 不写回
  });

  it('显式白名单零命中(全拼错且目录无 baseline)→ 保守回退全量', () => {
    const noBaseline = [mkTool('browser_navigate'), mkTool('search_web')];
    expect(selectActiveTools('任意', noBaseline, ROUTES, ['typo_*', 'also_typo'])).toBeUndefined();
  });

  it('显式白名单不受路由开关与阈值门影响(业务强约束,非路由启发式)', () => {
    process.env.AGTPILOT_TOOL_ROUTING = '0';
    expect(selectActiveTools('任意', TOOLS, ROUTES, ['search_web'])).toEqual([
      'search_web',
      'memory_store',
      'planner_create_plan',
    ]);
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

describe('零命中收敛兜底(§9.5 快速止血 A)', () => {
  // 检索组带 fallback 标记(生产口径:search 三件套/research_subagent/firecrawl/参考资料)
  const LEAN_TOOLS: RoutableTool[] = [
    mkTool('browser_navigate'),
    mkTool('search_web', { fallback: true }),
    mkTool('research_subagent', { fallback: true }),
    mkTool('cron_list'), // 无 route 也无标记:零命中时不该挂
    mkTool('memory_store', { baseline: true }),
  ];

  it('零命中 → baseline+fallback,声明序返回(不挂无关组、不挂无标记工具)', () => {
    process.env.AGTPILOT_CONTEXT_WINDOW = '1';
    expect(selectActiveTools('帮我把会议纪要整理成文章', LEAN_TOOLS, ROUTES)).toEqual([
      'search_web',
      'research_subagent',
      'memory_store',
    ]);
  });

  it('零命中但 prompt 显式提到工具名 → 点名工具并入兜底档', () => {
    process.env.AGTPILOT_CONTEXT_WINDOW = '1';
    const result = selectActiveTools('看看 cron_list 里有什么', LEAN_TOOLS, ROUTES)!;
    expect(result).toContain('cron_list');
    expect(result).toContain('memory_store'); // baseline 仍在
  });

  it('兜底档与 widen 兼容:后续步骤命中关键词 → 只扩不缩并入工具组', () => {
    process.env.AGTPILOT_CONTEXT_WINDOW = '1';
    const mounted = new Set(selectActiveTools('帮我整理点东西', LEAN_TOOLS, ROUTES)!);
    const next = selectActiveTools('打开网页看看这个链接', LEAN_TOOLS, ROUTES)!;
    const widened = widenMountedTools(mounted, next);
    expect(widened).toContain('browser_navigate'); // 浏览器组扩容进来
    expect(widened).toContain('search_web'); // 兜底档已挂的保留
  });

  it('目录无 baseline/fallback 可依赖 → 保守回退全量(undefined)', () => {
    process.env.AGTPILOT_CONTEXT_WINDOW = '1';
    const bare = [mkTool('browser_navigate'), mkTool('cron_list')];
    expect(selectActiveTools('帮我把会议纪要整理成文章', bare, ROUTES)).toBeUndefined();
  });

  it('命中分支不受 fallback 标记影响(命中 search 不会拖进 fallback 的其它工具)', () => {
    process.env.AGTPILOT_CONTEXT_WINDOW = '1';
    const result = selectActiveTools('帮我搜索一下', LEAN_TOOLS, ROUTES)!;
    expect(result).toContain('search_web'); // search 组本体
    expect(result).not.toContain('research_subagent'); // fallback 只在零命中档生效
  });
});

describe('isSmalltalkPrompt（闲聊短路判定）', () => {
  it('全串问候/自我介绍/简单问答命中', () => {
    for (const t of ['你是谁', '自我介绍', '介绍一下自己', '你能做什么', '你好', 'hello', '在吗', '谢谢', '再见！']) {
      expect(isSmalltalkPrompt(t)).toBe(true);
    }
  });
  it('长度超限不命中（任务话不会只剩闲聊形态）', () => {
    expect(isSmalltalkPrompt('你是谁'.repeat(10))).toBe(false);
  });
  it('多行 routingText（任务历史拼接）不命中', () => {
    expect(isSmalltalkPrompt('你是谁\n上一轮的任务结果很长很长很长很长很长很长')).toBe(false);
  });
  it('空串不命中', () => {
    expect(isSmalltalkPrompt('')).toBe(false);
    expect(isSmalltalkPrompt('   ')).toBe(false);
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
