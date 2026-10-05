import { Context, Service } from '@deepseek-ai/cordis';
import { AgentEvent } from '@agtpilot/protocol';
import '@agtpilot/core';

export const name = 'agtpilot-plugin-observability';
export const inject = ['agent'];

export interface TraceSpan {
  id: string;
  name: string;
  type: string;
  startTime: number;
  durationMs: number;
  status: 'ok' | 'error';
  metadata: Record<string, any>;
}

export class ObservabilityService extends Service {
  private spans: TraceSpan[] = [];
  private activeSpanStarts: Map<string, number> = new Map();

  constructor(ctx: Context) {
    super(ctx, 'observability');

    // 监听核心智能体流转事件
    (this.ctx as any).on('agtpilot/event', (event: AgentEvent) => {
      this.recordEvent(event);
    });
  }

  private recordEvent(event: AgentEvent) {
    const span: TraceSpan = {
      id: `span_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      name: `event:${event.type}`,
      type: event.type,
      startTime: event.timestamp || Date.now(),
      durationMs: 0,
      status: event.type === 'error' ? 'error' : 'ok',
      metadata: event.payload || {},
    };

    this.spans.push(span);
    if (this.spans.length > 500) {
      this.spans.shift(); // 环形保留最近 500 个事件
    }
  }

  getRecentSpans(limit: number = 30): TraceSpan[] {
    return this.spans.slice(-limit).reverse();
  }

  getMetrics() {
    const totalEvents = this.spans.length;
    const toolCalls = this.spans.filter((s) => s.type === 'tool_call').length;
    const thoughts = this.spans.filter((s) => s.type === 'thought').length;
    const errors = this.spans.filter((s) => s.status === 'error').length;
    const artifacts = this.spans.filter((s) => s.type === 'artifact').length;
    const plans = this.spans.filter((s) => s.type === 'plan').length;

    return {
      totalEvents,
      toolCalls,
      thoughts,
      errors,
      artifacts,
      plans,
      health: errors === 0 ? 'healthy' : 'warning',
    };
  }
}

export function apply(ctx: Context) {
  const obsService = new ObservabilityService(ctx);

  // 1. 获取全链路调用追踪 (observability_get_trace)
  ctx.agent.registerTool({
    name: 'observability_get_trace',
    description: '查看全自主智能体当前的实时调用链瀑布流 (Trace Spans)，分析最近执行的工具步骤、事件流转与异常状态。',
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: '获取最近的 Span 数量，默认 20 条' },
      },
    },
    execute: async ({ limit = 20 }) => {
      const spans = obsService.getRecentSpans(limit);
      return {
        success: true,
        count: spans.length,
        spans,
      };
    },
  });

  // 2. 获取智能体运行质量与指标 (observability_get_metrics)
  ctx.agent.registerTool({
    name: 'observability_get_metrics',
    description: '获取系统运行整体指标（思考次数、工具调用总量、产物生成数、报错率等监控指标）。',
    parameters: {
      type: 'object',
      properties: {},
    },
    execute: async () => {
      const metrics = obsService.getMetrics();
      return {
        success: true,
        metrics,
      };
    },
  });
}
