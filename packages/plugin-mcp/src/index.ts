import { Context } from '@deepseek-ai/cordis';
import '@agtpilot/core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';

export const name = 'agtpilot-plugin-mcp';
export const inject = ['agent'];

export interface MCPServerConfig {
  name: string;
  transport: 'stdio' | 'sse';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
}

export interface MCPPluginConfig {
  servers?: MCPServerConfig[];
}

export function apply(ctx: Context, config: MCPPluginConfig = {}) {
  const activeClients = new Map<string, { client: Client; tools: string[] }>();

  // 连接单个 MCP Server 并将其工具自动注册至 Cordis 微内核
  async function connectServer(serverConfig: MCPServerConfig) {
    if (activeClients.has(serverConfig.name)) {
      return { success: false, error: `MCP Server [${serverConfig.name}] 已处于连接状态。` };
    }

    const client = new Client(
      {
        name: `agtpilot-${serverConfig.name}-client`,
        version: '0.1.0',
      },
      {
        capabilities: {},
      }
    );

    let transport: StdioClientTransport | SSEClientTransport;

    if (serverConfig.transport === 'stdio') {
      if (!serverConfig.command) {
        throw new Error(`stdio 类型的 MCP Server 必须提供 command 启动参数。`);
      }
      transport = new StdioClientTransport({
        command: serverConfig.command,
        args: serverConfig.args || [],
        env: Object.fromEntries(
          Object.entries({ ...process.env, ...(serverConfig.env || {}) }).filter(
            ([_, v]) => typeof v === 'string'
          )
        ) as Record<string, string>,
      });
    } else {
      if (!serverConfig.url) {
        throw new Error(`sse 类型的 MCP Server 必须提供 url 参数。`);
      }
      transport = new SSEClientTransport(new URL(serverConfig.url));
    }

    await client.connect(transport);

    // 获取并注册该 Server 提供的全部工具
    const { tools } = await client.listTools();
    const registeredToolNames: string[] = [];

    for (const tool of tools) {
      const toolName = `mcp_${serverConfig.name}_${tool.name}`;
      ctx.agent.registerTool({
        name: toolName,
        description: `[MCP: ${serverConfig.name}] ${tool.description || ''}`,
        parameters: (tool.inputSchema as any) || { type: 'object', properties: {} },
        dangerLevel: 'medium',
        execute: async (args: any) => {
          ctx.agent.emitEvent({
            type: 'tool_call',
            payload: { tool: toolName, mcpServer: serverConfig.name, args },
            timestamp: Date.now(),
          });

          const result = await client.callTool({
            name: tool.name,
            arguments: args,
          });

          return result;
        },
      });
      registeredToolNames.push(toolName);
    }

    activeClients.set(serverConfig.name, { client, tools: registeredToolNames });

    return {
      success: true,
      serverName: serverConfig.name,
      toolsCount: registeredToolNames.length,
      tools: registeredToolNames,
    };
  }

  // 1. 暴露 mcp_connect_stdio 工具供 Agent 自主挂载本地 MCP Server
  ctx.agent.registerTool({
    name: 'mcp_connect_stdio',
    description: '连接一个基于标准输入输出 (Stdio) 的 Anthropic 官方 MCP Server，并自动将其暴露的所有工具动态挂载到微内核中',
    dangerLevel: 'high',
    parameters: {
      type: 'object',
      properties: {
        serverName: { type: 'string', description: '为该 MCP Server 指定的唯一别名 (如: "sqlite", "github", "filesystem")' },
        command: { type: 'string', description: '启动命令可执行文件 (如: "npx", "node", "uvx", "docker")' },
        args: {
          type: 'array',
          items: { type: 'string' },
          description: '启动命令参数列表 (如: ["-y", "@modelcontextprotocol/server-sqlite", "--db-path", "app.db"])',
        },
      },
      required: ['serverName', 'command'],
    },
    execute: async ({ serverName, command, args = [] }) => {
      try {
        const result = await connectServer({
          name: serverName,
          transport: 'stdio',
          command,
          args,
        });
        return result;
      } catch (err: any) {
        return {
          success: false,
          serverName,
          error: err.message,
        };
      }
    },
  });

  // 2. 暴露 mcp_connect_sse 工具供 Agent 挂载远程 HTTP/SSE MCP Server
  ctx.agent.registerTool({
    name: 'mcp_connect_sse',
    description: '通过 Server-Sent Events (SSE) 连接远程托管的 MCP 服务端并动态挂载其工具',
    dangerLevel: 'medium',
    parameters: {
      type: 'object',
      properties: {
        serverName: { type: 'string', description: 'MCP 服务端别名标识' },
        url: { type: 'string', description: '远程 MCP SSE 端点 URL (如: "http://localhost:8000/sse")' },
      },
      required: ['serverName', 'url'],
    },
    execute: async ({ serverName, url }) => {
      try {
        const result = await connectServer({
          name: serverName,
          transport: 'sse',
          url,
        });
        return result;
      } catch (err: any) {
        return {
          success: false,
          serverName,
          error: err.message,
        };
      }
    },
  });

  // 3. 暴露 mcp_list_servers 工具查看当前已连接的 MCP 实例与挂载工具
  ctx.agent.registerTool({
    name: 'mcp_list_servers',
    description: '列出当前所有已成功连接的 MCP Server 及其已动态挂载至微内核的工具清单',
    dangerLevel: 'low',
    parameters: {
      type: 'object',
      properties: {},
    },
    execute: async () => {
      const servers = Array.from(activeClients.entries()).map(([name, info]) => ({
        name,
        toolsCount: info.tools.length,
        tools: info.tools,
      }));

      return {
        success: true,
        serversCount: servers.length,
        servers,
      };
    },
  });

  // 启动时自动连接配置文件中指定的预设 MCP Servers
  if (config.servers && config.servers.length > 0) {
    for (const s of config.servers) {
      connectServer(s).catch((err) => {
        console.error(`[MCP Plugin] 自动连接 MCP Server [${s.name}] 失败:`, err.message);
      });
    }
  }

  // 退出时妥善关闭所有已连接的 MCP 客户端
  ctx.on('dispose', async () => {
    for (const [name, info] of activeClients.entries()) {
      try {
        await info.client.close();
      } catch {
        // ignore
      }
    }
    activeClients.clear();
  });
}
