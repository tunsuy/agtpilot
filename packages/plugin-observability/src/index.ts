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
  /** 事件流为瞬时广播（无开始/结束对），duration 恒为 0 */
  durationMs: number;
  status: 'ok' | 'error';
  /** 归属任务键（来自事件 payload.taskId，orchestrator 统一盖章） */
  taskId?: string;
  metadata: Record<string, any>;
}

/** 追踪窗口上限（环形保留最近 N 个事件） */
const SPAN_WINDOW = 500;

export class ObservabilityService extends Service {
  private spans: TraceSpan[] = [];

  constructor(ctx: Context) {
    super(ctx, 'observability');

    // 监听核心智能体流转事件（'agtpilot/event' 由 core 的 Events 增强声明）
    ctx.on('agtpilot/event', (event: AgentEvent) => {
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
      taskId: event.payload?.taskId,
      metadata: event.payload || {},
    };

    this.spans.push(span);
    if (this.spans.length > SPAN_WINDOW) {
      this.spans.shift(); // 环形保留最近 SPAN_WINDOW 个事件
    }
  }

  /** 近期调用追踪；传 taskId 时只看该任务的 span（多用户互不可见） */
  getRecentSpans(limit: number = 30, taskId?: string): TraceSpan[] {
    const scoped = taskId ? this.spans.filter((s) => s.taskId === taskId) : this.spans;
    return scoped.slice(-limit).reverse();
  }

  /** 运行指标 —— 注意：统计口径是「最近 SPAN_WINDOW 个事件的滑动窗口」，不是进程总量 */
  getMetrics(taskId?: string) {
    const scoped = taskId ? this.spans.filter((s) => s.taskId === taskId) : this.spans;
    const totalEvents = scoped.length;
    const toolCalls = scoped.filter((s) => s.type === 'tool_call').length;
    const thoughts = scoped.filter((s) => s.type === 'thought').length;
    const errors = scoped.filter((s) => s.status === 'error').length;
    const artifacts = scoped.filter((s) => s.type === 'artifact').length;
    const plans = scoped.filter((s) => s.type === 'plan').length;

    return {
      totalEvents,
      toolCalls,
      thoughts,
      errors,
      artifacts,
      plans,
      windowSize: SPAN_WINDOW,
      scope: taskId ? `taskId=${taskId}` : 'global (all tasks in window)',
      health: errors === 0 ? 'healthy' : 'warning',
    };
  }
}

export function apply(ctx: Context) {
  const obsService = new ObservabilityService(ctx);

  // 1. 获取全链路调用追踪 (observability_get_trace) —— 基线工具：路由启用时常驻
  ctx.agent.registerTool({
    name: 'observability_get_trace',
    baseline: true,
    description:
      '查看智能体当前任务的实时调用链追踪 (Trace Spans)，分析该任务最近执行的工具步骤、事件流转与异常状态（只含当前任务自己的事件）。',
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: '获取最近的 Span 数量，默认 20 条' },
      },
    },
    execute: async ({ limit = 20 }, session?: any) => {
      const spans = obsService.getRecentSpans(limit, session?.taskId);
      return {
        success: true,
        count: spans.length,
        spans,
      };
    },
  });

  // 2. 获取智能体运行质量与指标 (observability_get_metrics) —— 基线工具
  ctx.agent.registerTool({
    name: 'observability_get_metrics',
    baseline: true,
    description:
      '获取智能体运行指标（思考次数、工具调用数、产物数、报错数等）。统计口径为最近 500 个事件的滑动窗口，非进程启动以来的总量。',
    parameters: {
      type: 'object',
      properties: {},
    },
    execute: async (_args, session?: any) => {
      const metrics = obsService.getMetrics(session?.taskId);
      return {
        success: true,
        metrics,
      };
    },
  });
}
