import { Context, Service } from '@deepseek-ai/cordis';
import { AgentEvent } from '@agtpilot/protocol';
import { ToolDefinition, ToolRoute } from './contracts';

/**
 * Agent 原子工具管理服务：全局工具注册表 + 插件自注册的工具路由规则。
 * 路由规则（关键词 → 工具前缀）由各插件在 apply() 里声明，
 * 内核侧不再维护任何插件专属知识。
 */
export class AgentService extends Service {
  private tools: Map<string, ToolDefinition> = new Map();
  private routes: ToolRoute[] = [];

  constructor(ctx: Context) {
    super(ctx, 'agent');
  }

  registerTool(tool: ToolDefinition) {
    this.tools.set(tool.name, tool);
    this.ctx.emit('agtpilot/tool-registered', tool);
  }

  /** 反注册全局工具（连接器断开等场景，避免已断连工具残留注册表） */
  unregisterTool(name: string): boolean {
    return this.tools.delete(name);
  }

  getTools(): ToolDefinition[] {
    return Array.from(this.tools.values());
  }

  getTool(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  /** 插件注册路由规则：任务 prompt 命中 test 时挂载 prefixes 对应的工具组 */
  registerToolRoute(route: ToolRoute) {
    // 同 id 规则幂等覆盖（插件重载场景）
    this.routes = this.routes.filter((r) => r.id !== route.id);
    this.routes.push(route);
  }

  getToolRoutes(): ToolRoute[] {
    return [...this.routes];
  }

  emitEvent(event: AgentEvent) {
    this.ctx.emit('agtpilot/event', event);
  }
}
