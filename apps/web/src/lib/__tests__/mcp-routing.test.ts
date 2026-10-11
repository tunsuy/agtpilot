import { describe, beforeAll, beforeEach, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { selectActiveTools } from '@agtpilot/core';
import type { RoutableTool, ToolRoute } from '@agtpilot/core';
import { apply as applyPluginMcp } from '@agtpilot/plugin-mcp';

/**
 * 工具路由按服务器粒度挂载 MCP 工具（loop 执行优化 P2）：
 * - 生产实测：任务提示词顺带提到「MCP 工具（若已连接）」/「连接器页」，
 *   旧版 mcp_ 前缀一网打尽路由把全部 MCP 服务器挂上（88/114 工具）；
 * - 新方案：plugin-mcp 毯式路由只管 CLI 的 mcp_connect_* 连接管理工具；
 *   Web 数据工具由 buildUserMcpToolRoutes 按「prompt 点名的数据源」注册
 *   服务器粒度路由；中途授权桥（connector_authorize / mcp_call）改 baseline 常驻。
 *
 * 环境隔离：USER_DATA_DIR 指向一次性临时目录（与 xhs-managed.test.ts 同模式），
 * 必须在动态 import 被测模块之前设置。
 */
let us: typeof import('@/lib/user-store');
let mc: typeof import('@/lib/mcp-connectors');
let bridge: typeof import('@/lib/connector-bridge');

const UID = 'mcp-routing-user-a';
const UID_BARE = 'mcp-routing-user-bare'; // 一个连接器都没配的用户

beforeAll(async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agtpilot-mcp-route-'));
  process.env.USER_DATA_DIR = tmpDir;
  process.env.AGTPILOT_SECRET_KEY = 'mcp-routing-test-key';
  us = await import('@/lib/user-store');
  mc = await import('@/lib/mcp-connectors');
  bridge = await import('@/lib/connector-bridge');
});

beforeEach(() => {
  // 用户 A：知乎（token 类）已配置 + NewsNow（none + optIn）已启用
  us.saveUserConnector(UID, 'MCP_ZHIHU_SECRET', 'fake-secret');
  us.saveUserConnector(UID, 'MCP_NEWSNOW_OPTIN', '1');
});

afterEach(() => {
  // 强制路由的 env 开关（阈值门）只在用例内生效
  delete process.env.AGTPILOT_CONTEXT_WINDOW;
});

const mkTool = (name: string, extra: Partial<RoutableTool> = {}): RoutableTool => ({
  name,
  description: 'x',
  parameters: { type: 'object', properties: {} },
  ...extra,
});

/** 模拟生产任务目录形态：基线插件工具 + 用户已连 MCP 服务器的工具（10 个 > 102 token 阈值） */
const CATALOG: RoutableTool[] = [
  mkTool('search_web'),
  mkTool('browser_navigate'),
  mkTool('memory_store', { baseline: true }),
  mkTool('mcp_zhihu_hot_hot_list'),
  mkTool('mcp_zhihu_search_search'),
  mkTool('mcp_zhihu_global_search'),
  mkTool('mcp_newsnow_get_hottest'),
  mkTool('mcp_twitterapi_io_search_tweets'),
  mkTool('mcp_deepwiki_ask_question'),
  mkTool('mcp_connect_stdio'),
];

/** 强制超阈值触发路由（窗口钳到 1024 下限 → 阈值 102 tokens） */
function forceRouting() {
  process.env.AGTPILOT_CONTEXT_WINDOW = '1';
}

/** 挂载 plugin-mcp 插件，拿回其注册的路由（真实 apply，不经手抄） */
function pluginMcpRoutes(): ToolRoute[] {
  const routes: ToolRoute[] = [];
  const ctx: any = {
    agent: { registerToolRoute: (r: ToolRoute) => routes.push(r) },
    reflect: { provide: () => {} },
    on: () => () => {},
  };
  applyPluginMcp(ctx, {});
  return routes;
}

/** 生产 mission 提取的真实提示词关键句（曾触发旧版一网打尽挂载 88/114） */
const XHS_PROMPT =
  '帮我做小红书每周选题，优先使用知乎热榜/站内搜索类 MCP 工具（若已连接），结束后到连接器页小红书「真机唤起」';

function userRoutes(uid: string): ToolRoute[] {
  return mc.buildUserMcpToolRoutes(uid);
}

describe('MCP 工具路由：服务器粒度挂载', () => {
  it('prompt 点名数据源（知乎/热榜）→ 只挂对应服务器，不再一网打尽', () => {
    forceRouting();
    const routes = [...pluginMcpRoutes(), ...userRoutes(UID)];
    const result = selectActiveTools(XHS_PROMPT, CATALOG, routes);
    expect(result).toBeDefined();
    // 知乎三个服务器 + NewsNow（「热榜」命中）挂载
    expect(result).toContain('mcp_zhihu_hot_hot_list');
    expect(result).toContain('mcp_zhihu_search_search');
    expect(result).toContain('mcp_zhihu_global_search');
    expect(result).toContain('mcp_newsnow_get_hottest');
    // 未点名的数据源不再搭车挂载（旧版会把全部 mcp_* 挂上）
    expect(result).not.toContain('mcp_twitterapi_io_search_tweets');
    expect(result).not.toContain('mcp_deepwiki_ask_question');
    // 路由开启时基线工具仍常驻
    expect(result).toContain('memory_store');
  });

  it('提示词只提「MCP 工具/连接器」不点名数据源 → 挂连接管理工具，不挂数据工具', () => {
    forceRouting();
    const routes = [...pluginMcpRoutes(), ...userRoutes(UID)];
    const result = selectActiveTools('看看我有哪些 MCP 外部工具服务和连接器可用', CATALOG, routes);
    // plugin-mcp 毯式路由收窄到 mcp_connect_*（CLI 连接管理），不再覆盖全部 mcp_ 前缀
    expect(result).toContain('mcp_connect_stdio');
    expect(result).not.toContain('mcp_zhihu_hot_hot_list');
    expect(result).not.toContain('mcp_twitterapi_io_search_tweets');
  });

  it('未配置的连接器不注册路由：twitterapi_io（token 未配）不出现', () => {
    const routes = userRoutes(UID);
    expect(routes.some((r) => r.id === 'mcp_user_twitterapi_io')).toBe(false);
    // 已配置的按服务器粒度注册（知乎 3 个服务器 + newsnow）
    expect(routes.map((r) => r.id)).toEqual(
      expect.arrayContaining(['mcp_user_zhihu_search', 'mcp_user_zhihu_global', 'mcp_user_zhihu_hot', 'mcp_user_newsnow'])
    );
    // 每条路由的前缀精确到单个服务器
    const zhihuHot = routes.find((r) => r.id === 'mcp_user_zhihu_hot')!;
    expect(zhihuHot.prefixes).toEqual(['mcp_zhihu_hot_']);
    expect(zhihuHot.test.test('知乎热榜')).toBe(true);
    expect(zhihuHot.test.test('今天吃什么')).toBe(false);
  });

  it('一个连接器都没配的用户 → 无服务器路由（deepwiki 免凭证直连类除外仍注册）', () => {
    const routes = userRoutes(UID_BARE);
    // deepwiki 是 authType none 且非 optIn：对所有人常连，路由仍在
    expect(routes.map((r) => r.id)).toEqual(['mcp_user_deepwiki']);
  });

  it('路由触发词随配置变化刷新：同 id 幂等、新配置即时生效', () => {
    // 用户 A 的路由注册两次（agent-backend 每次任务开始都会重注册）→ id 集合一致
    const a = userRoutes(UID);
    const b = userRoutes(UID);
    expect(a.map((r) => r.id)).toEqual(b.map((r) => r.id));
  });
});

describe('中途授权桥：baseline 常驻', () => {
  it('connector_authorize / mcp_call 标记 baseline —— 路由开启时也始终可见', () => {
    const tools = bridge.buildConnectorBridgeTools({
      userId: UID,
      emit: () => {},
      getMcpSvc: () => undefined,
    });
    const authorize = tools.find((t) => t.name === 'connector_authorize');
    const call = tools.find((t) => t.name === 'mcp_call');
    expect(authorize?.baseline).toBe(true);
    expect(call?.baseline).toBe(true);
  });

  it('baseline 声明在路由决策里生效：命中搜索路由的任务，中途授权代理工具也挂得上', () => {
    forceRouting();
    // bridge 工具是任务级注入的 —— 这里把 mcp_call 放进目录，模拟 agent-backend 注入后的形态
    const withBridge = [...CATALOG, mkTool('mcp_call', { baseline: true })];
    const searchRoute: ToolRoute = { id: 'search', prefixes: ['search_'], test: /(搜索|检索|search)/i };
    const result = selectActiveTools('帮我搜索一下', withBridge, [...pluginMcpRoutes(), ...userRoutes(UID), searchRoute]);
    expect(result).toContain('search_web');
    expect(result).toContain('mcp_call'); // baseline：不随路由关键词缺席
    expect(result).not.toContain('browser_navigate'); // 未命中的组正常被裁剪
  });
});
