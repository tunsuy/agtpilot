import { AgentEvent } from '@agtpilot/protocol';

export interface PluginContext {
  emit: (event: AgentEvent) => void;
  registerTool: (tool: AgentTool) => void;
  requestApproval: (action: string, description: string, params: Record<string, any>) => Promise<boolean>;
}

export interface AgentTool {
  name: string;
  description: string;
  parameters: Record<string, any>;
  execute: (args: any, context: PluginContext) => Promise<any>;
}

export interface AgentPlugin {
  name: string;
  version: string;
  apply: (ctx: PluginContext) => void | Promise<void>;
}

export class AgentKernel {
  private plugins: Map<string, AgentPlugin> = new Map();
  private tools: Map<string, AgentTool> = new Map();

  async use(plugin: AgentPlugin) {
    this.plugins.set(plugin.name, plugin);
    const ctx: PluginContext = {
      emit: (event) => console.log(`[Event] ${event.type}:`, event.payload),
      registerTool: (tool) => this.tools.set(tool.name, tool),
      requestApproval: async (action, description, params) => {
        console.log(`[Approval Required] Action: ${action} - ${description}`);
        return true;
      }
    };
    await plugin.apply(ctx);
    console.log(`[Plugin Loaded] ${plugin.name} v${plugin.version}`);
  }

  getTools(): AgentTool[] {
    return Array.from(this.tools.values());
  }
}
