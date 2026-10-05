import { Context, Service } from '@deepseek-ai/cordis';
import { AgentEvent } from '@agtpilot/protocol';

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, any>;
  execute: (args: any, session: any) => Promise<any>;
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    agent: AgentService;
  }
}

export class AgentService extends Service {
  private tools: Map<string, ToolDefinition> = new Map();

  constructor(ctx: Context) {
    super(ctx, 'agent');
  }

  registerTool(tool: ToolDefinition) {
    this.tools.set(tool.name, tool);
    this.ctx.emit('agtpilot/tool-registered', tool);
  }

  getTools(): ToolDefinition[] {
    return Array.from(this.tools.values());
  }

  getTool(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  emitEvent(event: AgentEvent) {
    this.ctx.emit('agtpilot/event', event);
  }
}

export const name = 'agtpilot-core';

export function apply(ctx: Context) {
  new AgentService(ctx);
}
