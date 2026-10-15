import { describe, beforeAll, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DEFAULT_MCP_SERVERS } from '@agtpilot/plugin-subagent';

/**
 * 连接器目录 subagentOpen 标记红线回归(2026-10-14 目录标记方案):
 * - 每台服务器必须显式 boolean 表态(McpServerDef 必填字段 = 编译期强制,
 *   这里再运行时复核一道,防 `as` 绕过);
 * - 行情数字红线 / 写操作 / 现实副作用 / 按量计费未评审 → 永不开放;
 * - 检索类开放名单锁定,且与 plugin-subagent 内置默认名单同步回归;
 * - buildUserSubagentMcpServers = 用户已连接 ∩ 目录已标记。
 *
 * 环境隔离:USER_DATA_DIR 指向一次性临时目录(与 mcp-routing.test.ts 同模式),
 * 必须在动态 import 被测模块之前设置。
 */
let us: typeof import('@/lib/user-store');
let mc: typeof import('@/lib/mcp-connectors');

const UID = 'subagent-flag-user-a';
const UID_BARE = 'subagent-flag-user-bare'; // 一个连接器都没配的用户

const ALL_SERVERS = () => mc.MCP_CONNECTOR_DEFS.flatMap((d) => d.servers);

beforeAll(async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agtpilot-subagent-flag-'));
  process.env.USER_DATA_DIR = tmpDir;
  process.env.AGTPILOT_SECRET_KEY = 'subagent-flag-test-key';
  us = await import('@/lib/user-store');
  mc = await import('@/lib/mcp-connectors');
  // 用户 A:知乎(token)+ GitHub(token)+ Tushare(token,红线类,配了也不给)+ NewsNow(optIn 启用)
  us.saveUserConnector(UID, 'MCP_ZHIHU_SECRET', 'fake-secret');
  us.saveUserConnector(UID, 'MCP_GITHUB_PAT', 'fake-pat');
  us.saveUserConnector(UID, 'MCP_TUSHARE_TOKEN', 'fake-token');
  us.saveUserConnector(UID, 'MCP_NEWSNOW_OPTIN', '1');
});

describe('目录标记完整性', () => {
  it('每台服务器都显式 boolean 表态(新连接器不表态过不了编译 + 本测试)', () => {
    for (const def of mc.MCP_CONNECTOR_DEFS) {
      for (const s of def.servers) {
        expect(typeof s.subagentOpen, `${def.id}/${s.name} 缺少显式 subagentOpen 标记`).toBe('boolean');
      }
    }
  });
});

describe('红线:永不开放给子 agent', () => {
  const NEVER_OPEN = [
    // 行情数字红线:报告依据的价格必须主循环直拉,不过子 agent 转述
    'tushare',
    'alphavantage',
    'coingecko',
    'a_stock',
    'flyai', // 机票/酒店/火车票实时价格 = 行情数字,且涉购买决策上下文
    // 写操作 / 现实副作用
    'notion',
    'dida365',
    'ardot',
    'atlassian',
    'tencent_docs',
    'tencent_meeting',
    'didi',
    'tencent_weiyun',
    'tencent_lexiang',
    'youdao_note',
    'browser_auto',
    'lark_suite',
    'dingtalk_mcp',
    'yuque',
    // 按量计费成本未评审
    'twitterapi_io',
    'kuaidi100',
  ];

  it.each(NEVER_OPEN)('%s = false', (name) => {
    const s = ALL_SERVERS().find((x) => x.name === name);
    expect(s, `目录中未找到服务器 ${name}`).toBeDefined();
    expect(s!.subagentOpen, `${name} 被标为开放,违反红线`).toBe(false);
  });

  it('Finance 类连接器全量 false(整类红线,新增行情连接器默认落进本断言)', () => {
    const finance = mc.MCP_CONNECTOR_DEFS.filter((d) => d.category === 'Finance');
    expect(finance.length).toBeGreaterThan(0);
    for (const d of finance) {
      for (const s of d.servers) {
        expect(s.subagentOpen, `Finance 类 ${d.id}/${s.name} 不得开放`).toBe(false);
      }
    }
  });
});

describe('检索类开放名单', () => {
  const OPEN = [
    'openalex',
    'qcc',
    'amap',
    'baidu_map',
    'github_mcp',
    'zhihu_search',
    'zhihu_global',
    'zhihu_hot',
    'deepwiki',
    'alphaxiv',
    'huggingface',
    'deepl',
    'newsnow',
  ];

  it.each(OPEN)('%s = true', (name) => {
    const s = ALL_SERVERS().find((x) => x.name === name);
    expect(s, `目录中未找到服务器 ${name}`).toBeDefined();
    expect(s!.subagentOpen, `${name} 应标记开放(检索/查询类)`).toBe(true);
  });

  it('plugin-subagent 内置默认名单全部在目录中标记为 true(两处同步回归)', () => {
    const flagged = new Set(ALL_SERVERS().filter((s) => s.subagentOpen).map((s) => s.name));
    for (const name of DEFAULT_MCP_SERVERS) {
      expect(flagged.has(name), `内置默认 ${name} 未在目录标记开放`).toBe(true);
    }
  });
});

describe('buildUserSubagentMcpServers = 已连接 ∩ 已标记', () => {
  it('未配置任何连接器的用户:只剩免凭证非 opt-in 的 deepwiki', () => {
    expect(mc.buildUserSubagentMcpServers(UID_BARE)).toEqual(['deepwiki']);
  });

  it('用户 A:知乎×3 + GitHub + NewsNow + deepwiki;已配置的 Tushare 被红线排除', () => {
    const got = mc.buildUserSubagentMcpServers(UID);
    expect([...got].sort()).toEqual(
      ['deepwiki', 'github_mcp', 'newsnow', 'zhihu_global', 'zhihu_hot', 'zhihu_search'].sort()
    );
    expect(got).not.toContain('tushare');
  });
});

describe('subagentAvailability(详情页展示判定)', () => {
  it('逃生口前缀命中 → escape(免只读注解,实测背书)', () => {
    expect(mc.subagentAvailability('deepwiki', { flagged: true, toolCount: 3, readOnlyCount: 0 })).toBe('escape');
    expect(mc.subagentAvailability('newsnow', { flagged: true, toolCount: 1, readOnlyCount: 0 })).toBe('escape');
    // fanqie_radar:2026-10-15 annotations-report.mjs 实测 10 工具零注解(手写 JSON-RPC),
    // 语义对照上游源码核实纯查询 → 前缀入 plugin-subagent 默认逃生口(两处同步回归)
    expect(mc.subagentAvailability('fanqie_radar', { flagged: true, toolCount: 10, readOnlyCount: 0 })).toBe(
      'escape'
    );
  });

  it('已标记 + 有只读声明 → ready', () => {
    expect(mc.subagentAvailability('huggingface', { flagged: true, toolCount: 4, readOnlyCount: 4 })).toBe('ready');
  });

  it('已标记 + 已连接但零注解 → needs-measurement(待实测)', () => {
    expect(mc.subagentAvailability('github_mcp', { flagged: true, toolCount: 10, readOnlyCount: 0 })).toBe(
      'needs-measurement'
    );
  });

  it('未标记 → closed(即使工具全部只读,人工钥匙优先)', () => {
    expect(mc.subagentAvailability('tushare', { flagged: false, toolCount: 5, readOnlyCount: 5 })).toBe('closed');
  });

  it('未连接(toolCount=0)+ 已标记 → ready(UI 结合连接状态显示「连接后可用」)', () => {
    expect(mc.subagentAvailability('github_mcp', { flagged: false, toolCount: 0, readOnlyCount: 0 })).toBe('closed');
    expect(mc.subagentAvailability('openalex', { flagged: true, toolCount: 0, readOnlyCount: 0 })).toBe('ready');
  });

  it('env 显式设置优先:off 全关 / 名单覆盖目录标记(与插件同语义)', () => {
    process.env.AGTPILOT_SUBAGENT_MCP_ALLOW_TOOLS = 'off';
    process.env.AGTPILOT_SUBAGENT_MCP_SERVERS = 'off';
    try {
      expect(mc.subagentAvailability('deepwiki', { flagged: true, toolCount: 3, readOnlyCount: 3 })).toBe('closed');
      process.env.AGTPILOT_SUBAGENT_MCP_SERVERS = 'tushare';
      expect(mc.subagentAvailability('tushare', { flagged: false, toolCount: 5, readOnlyCount: 5 })).toBe('ready');
      expect(mc.subagentAvailability('github_mcp', { flagged: true, toolCount: 5, readOnlyCount: 5 })).toBe('closed');
    } finally {
      delete process.env.AGTPILOT_SUBAGENT_MCP_ALLOW_TOOLS;
      delete process.env.AGTPILOT_SUBAGENT_MCP_SERVERS;
    }
  });
});
