#!/usr/bin/env node
/**
 * MCP 注解覆盖率实测脚本(spec §4.3 双钥匙落地配套,2026-10-14)
 *
 * 逐台连接 MCP 服务器,listTools 后打印每个工具的 annotations
 * (readOnlyHint / destructiveHint / idempotentHint / openWorldHint),
 * 并按 plugin-mcp 的保守规则(mcpToolReadOnly)给出「是否会注册为 readOnly」
 * 与子 agent 双钥匙放行判定,用于负责人决定 AGTPILOT_SUBAGENT_MCP_SERVERS 白名单取值。
 *
 * 用法一(命令行直给,name=url 或 name=stdio://command arg1 arg2):
 *   node scripts/annotations-report.mjs deepwiki=https://mcp.deepwiki.com/mcp openalex=https://mcp.openalex.org/mcp
 * 用法二(JSON 文件,支持 headers/env):
 *   node scripts/annotations-report.mjs --json servers.json
 *   // [{ "name": "github_mcp", "url": "https://api.githubcopilot.com/mcp/", "headers": { "Authorization": "Bearer xx" } }]
 *
 * 只读操作:仅 initialize + tools/list,不调用任何工具。单台失败不影响其余。
 */
import { readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const TIMEOUT_MS = 20000;

/** 与 plugin-mcp sanitizeToolName 保持一致 */
function sanitizeToolName(name) {
  let s = name.replace(/[^a-zA-Z0-9_-]/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '');
  if (s.length > 64) s = s.slice(0, 64);
  return s || 'tool';
}

/** 与 plugin-mcp mcpToolReadOnly 保持一致:严格布尔判定,无注解 = 保守视为写 */
function mcpToolReadOnly(annotations) {
  return annotations?.readOnlyHint === true && annotations?.destructiveHint !== true;
}

function parseArgs(argv) {
  const servers = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') {
      const list = JSON.parse(readFileSync(argv[++i], 'utf8'));
      servers.push(...list);
    } else if (a.includes('=')) {
      const eq = a.indexOf('=');
      const name = a.slice(0, eq);
      const target = a.slice(eq + 1);
      if (target.startsWith('stdio://')) {
        const parts = target.slice('stdio://'.length).split(/\s+/).filter(Boolean);
        servers.push({ name, transport: 'stdio', command: parts[0], args: parts.slice(1) });
      } else {
        servers.push({ name, url: target });
      }
    }
  }
  return servers;
}

async function inspect(server) {
  const client = new Client({ name: 'agtpilot-annotations-report', version: '0.1.0' });
  const transport =
    server.transport === 'stdio'
      ? new StdioClientTransport({ command: server.command, args: server.args ?? [], env: { ...process.env, ...(server.env ?? {}) } })
      : new StreamableHTTPClientTransport(new URL(server.url), {
          requestInit: { headers: server.headers ?? {} },
        });
  const timer = new Promise((_, rej) => setTimeout(() => rej(new Error(`超时 ${TIMEOUT_MS}ms`)), TIMEOUT_MS));
  await Promise.race([
    (async () => {
      await client.connect(transport);
    })(),
    timer,
  ]);
  const { tools } = await Promise.race([client.listTools(), timer]);
  await client.close().catch(() => {});
  return tools;
}

const servers = parseArgs(process.argv.slice(2));
if (servers.length === 0) {
  console.error('用法: annotations-report.mjs <name=url|name=stdio://cmd args...>... 或 --json servers.json');
  process.exit(2);
}

let total = 0;
let readOnlyCount = 0;
const serverRows = [];

for (const server of servers) {
  const name = server.name;
  try {
    const tools = await inspect(server);
    console.log(`\n=== ${name} (${server.url ?? `${server.command} ${(server.args ?? []).join(' ')}`}) — ${tools.length} 个工具 ===`);
    let ro = 0;
    for (const t of tools) {
      const a = t.annotations ?? {};
      const isRO = mcpToolReadOnly(a);
      if (isRO) ro++;
      const fullName = sanitizeToolName(`mcp_${name}_${t.name}`);
      console.log(
        `  ${isRO ? '[只读]' : '[    ]'} ${fullName}` +
          `  (readOnlyHint=${a.readOnlyHint ?? '—'} destructiveHint=${a.destructiveHint ?? '—'}` +
          ` idempotentHint=${a.idempotentHint ?? '—'} openWorldHint=${a.openWorldHint ?? '—'})`,
      );
    }
    total += tools.length;
    readOnlyCount += ro;
    serverRows.push({ name, tools: tools.length, readOnly: ro, annotated: tools.filter((t) => t.annotations && Object.keys(t.annotations).length > 0).length });
    console.log(`  → ${name}: ${ro}/${tools.length} 会注册为 readOnly;加入 AGTPILOT_SUBAGENT_MCP_SERVERS 后可进子 agent 的工具即这 ${ro} 个`);
  } catch (err) {
    console.log(`\n=== ${name} — 连接/列举失败: ${err?.message ?? err} ===`);
    serverRows.push({ name, error: String(err?.message ?? err) });
  }
}

console.log('\n===== 汇总 =====');
for (const r of serverRows) {
  console.log(
    r.error
      ? `${r.name}: 失败(${r.error})`
      : `${r.name}: ${r.readOnly}/${r.tools} 只读(带注解 ${r.annotated}/${r.tools})`,
  );
}
console.log(`总计: ${readOnlyCount}/${total} 个工具会注册为 readOnly`);
