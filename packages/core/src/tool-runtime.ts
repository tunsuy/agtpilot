/**
 * 工具执行运行时：父子 agent 共用的唯一工具包装层。
 *
 * 这一层只负责「一次工具调用怎么执行」，不负责「agent 循环怎么跑」：
 * - 只读结果 TTL 缓存（同签名复用，不重复执行）
 * - 死循环滑动窗口熔断（同签名窗口计数，超限跳过）
 * - 连续失败守卫（同工具连续失败注入换思路提示）
 * - 高危审批策略（hitl = 宿主审批；deny = fail-closed）
 * - 只读并行 / 写操作独占门控
 * - 超长输出 spill（全量落盘换预览指针）与头尾截断
 * - 调用统计与 tool_call/tool_result 事件
 *
 * 父 agent 与子 agent 的差异只通过 ToolRuntimePolicy 表达，不再各写一套。
 */
import type { AgentEvent, ApprovalRequest } from '@agtpilot/protocol';
import type { ToolDefinition, ToolSession } from './contracts';
import { stableStringify } from './routing';
import {
  buildSpillPointer,
  effectiveOutputLimit,
  truncateToolOutput,
} from './text';
import { ToolGate } from './tool-gate';

/** 死循环统计窗口：最近 N 次工具调用 */
export const TOOL_LOOP_WINDOW_SIZE = 20;
/** 窗口内同一签名出现次数达到该值即熔断 */
export const TOOL_LOOP_TRIGGER_COUNT = 4;
/** 只读结果复用窗口 */
export const TOOL_RESULT_CACHE_TTL_MS = 5 * 60_000;
/** 只读结果缓存条数上限（FIFO） */
export const TOOL_RESULT_CACHE_MAX = 32;
/** 同一工具连续失败达到该值注入换思路提示 */
export const TOOL_FAILURE_GUARD_THRESHOLD = 3;

export type ToolApprovalMode = 'hitl' | 'deny';

export interface ToolRuntimePolicy {
  /** 高危工具审批策略。hitl = 调用宿主审批；deny = 直接 fail-closed */
  approval: ToolApprovalMode;
  /** 只读并行 / 写操作独占门控 */
  readonlyGate: boolean;
  /** 只读结果 TTL 缓存 */
  cache: boolean;
  /** 死循环熔断 */
  deadLoop: boolean;
  /** 死循环触发阈值（窗口内同签名出现次数） */
  deadLoopTriggerCount: number;
  /** 连续失败守卫 */
  failureGuard: boolean;
  /** 连续失败阈值 */
  failureGuardThreshold: number;
  /** 超长输出 spill（需要宿主提供 spill 回调） */
  spill: boolean;
  /** 超长输出头尾截断 */
  truncate: boolean;
}

export const DEFAULT_TOOL_RUNTIME_POLICY: ToolRuntimePolicy = {
  approval: 'deny',
  readonlyGate: true,
  cache: true,
  deadLoop: true,
  deadLoopTriggerCount: TOOL_LOOP_TRIGGER_COUNT,
  failureGuard: true,
  failureGuardThreshold: TOOL_FAILURE_GUARD_THRESHOLD,
  spill: true,
  truncate: true,
};

export type ToolRuntimeEvent = Pick<AgentEvent, 'type' | 'payload'>;

export interface ToolRuntimeOptions {
  policy?: Partial<ToolRuntimePolicy>;
  emit?: (event: ToolRuntimeEvent) => void;
  /**
   * 高危审批。缺省 = 直接拒绝（fail-closed）。
   * 审批 UI、超时、挂起恢复全部由宿主实现，运行时只等待布尔结果。
   */
  approve?: (request: ApprovalRequest, signal?: AbortSignal) => Promise<boolean>;
  /** 超长输出全量落盘。返回非空引用则换预览指针，否则回退截断 */
  spill?: (input: {
    taskId: string;
    callId: string;
    toolName: string;
    fullText: string;
  }) => string | null | Promise<string | null>;
  gate?: ToolGate;
  now?: () => number;
}

export interface ToolRuntimeStats {
  toolCalls: number;
  failedCalls: number;
  skippedCalls: number;
  approvalRejected: number;
  emptyCalls: number;
  dedupedCalls: number;
  spilledOutputs: number;
  spilledChars: number;
}

export type ToolRuntimeStatus =
  | 'ok'
  | 'error'
  | 'skipped'
  | 'rejected'
  | 'deduped'
  | 'empty';

export interface ToolRuntimeResult {
  output: any;
  status: ToolRuntimeStatus;
  callId: string;
  durationMs: number;
  spilled?: { callId: string; originalChars: number };
}

/** 工具「空返回」判定：null/undefined、空白串、空数组、无任何键的对象。 */
export function isEmptyToolOutput(out: any): boolean {
  if (out == null) return true;
  if (typeof out === 'string') return out.trim().length === 0;
  if (Array.isArray(out)) return out.length === 0;
  if (typeof out === 'object') return Object.keys(out).length === 0;
  return false;
}

function signatureOf(toolName: string, args: any): string {
  return `${toolName}:${JSON.stringify(stableStringify(args))}`;
}

export class ToolRuntime {
  private readonly policy: ToolRuntimePolicy;
  private readonly gate: ToolGate;
  private readonly now: () => number;
  private readonly stats: ToolRuntimeStats = {
    toolCalls: 0,
    failedCalls: 0,
    skippedCalls: 0,
    approvalRejected: 0,
    emptyCalls: 0,
    dedupedCalls: 0,
    spilledOutputs: 0,
    spilledChars: 0,
  };

  private readonly signatureWindow: string[] = [];
  private readonly signatureCounts = new Map<string, number>();
  private readonly resultCache = new Map<string, { at: number; output: any }>();
  private lastFailedTool = '';
  private consecutiveFailures = 0;

  constructor(private readonly options: ToolRuntimeOptions = {}) {
    this.policy = { ...DEFAULT_TOOL_RUNTIME_POLICY, ...(options.policy || {}) };
    this.gate = options.gate || new ToolGate();
    this.now = options.now || Date.now;
  }

  getStats(): ToolRuntimeStats {
    return { ...this.stats };
  }

  async execute(
    tool: ToolDefinition,
    args: any,
    session: ToolSession,
  ): Promise<ToolRuntimeResult> {
    const startedAt = this.now();
    const callId =
      session.callId ||
      `call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const signature = signatureOf(tool.name, args);

    if (tool.readOnly && this.policy.cache) {
      const hit = this.resultCache.get(signature);
      if (hit && this.now() - hit.at < TOOL_RESULT_CACHE_TTL_MS) {
        this.stats.dedupedCalls++;
        this.emit({ type: 'tool_call', payload: { tool: tool.name, args, callId } });
        this.emit({
          type: 'tool_result',
          payload: { tool: tool.name, output: hit.output, deduplicated: true, callId },
        });
        return {
          output: hit.output,
          status: 'deduped',
          callId,
          durationMs: this.now() - startedAt,
        };
      }
    }

    this.stats.toolCalls++;

    if (this.policy.deadLoop) {
      this.signatureWindow.push(signature);
      this.signatureCounts.set(signature, (this.signatureCounts.get(signature) || 0) + 1);
      if (this.signatureWindow.length > TOOL_LOOP_WINDOW_SIZE) {
        const evicted = this.signatureWindow.shift()!;
        const remaining = (this.signatureCounts.get(evicted) || 1) - 1;
        if (remaining <= 0) this.signatureCounts.delete(evicted);
        else this.signatureCounts.set(evicted, remaining);
      }
      const occurrences = this.signatureCounts.get(signature) || 1;
      if (occurrences >= this.policy.deadLoopTriggerCount) {
        this.stats.skippedCalls++;
        return {
          output: {
            skipped: true,
            repeated: true,
            message: `[Loop Detector] 工具 [${tool.name}] 在最近 ${TOOL_LOOP_WINDOW_SIZE} 次调用中以相同（归一化后）参数出现了 ${occurrences} 次，疑似空转循环，本次已被跳过。请更换思路（调整参数、改用其他工具，或基于已有信息直接总结给出最终回答），不要重复相同调用。`,
          },
          status: 'skipped',
          callId,
          durationMs: this.now() - startedAt,
        };
      }
    }

    if (tool.dangerLevel === 'high') {
      const approved = await this.requestApproval(tool, args, session);
      if (!approved) {
        this.stats.approvalRejected++;
        return {
          output: {
            rejected: true,
            message:
              this.policy.approval === 'deny'
                ? `工具 [${tool.name}] 属于高危操作，当前执行上下文不允许人工审批，已按 fail-closed 策略拒绝。`
                : `用户拒绝了执行工具 [${tool.name}] 的请求。`,
          },
          status: 'rejected',
          callId,
          durationMs: this.now() - startedAt,
        };
      }
    }

    this.emit({ type: 'tool_call', payload: { tool: tool.name, args, callId } });

    const invoke = async (): Promise<any> => {
      try {
        return await tool.execute(args, { ...session, callId });
      } catch (err: any) {
        return { error: err?.message ?? String(err) };
      }
    };

    let output: any;
    if (!this.policy.readonlyGate) {
      output = await invoke();
    } else if (tool.readOnly) {
      output = await this.gate.runReadonly(invoke);
    } else {
      output = await this.gate.runExclusive(invoke);
    }

    const callFailed = Boolean(output && typeof output === 'object' && 'error' in output);
    const callSkippedOrRejected = Boolean(
      output && typeof output === 'object' && (output.skipped || output.rejected),
    );
    const callEmpty = !callFailed && !callSkippedOrRejected && isEmptyToolOutput(output);

    if (callEmpty) this.stats.emptyCalls++;

    if (callFailed) {
      this.stats.failedCalls++;
      if (tool.name === this.lastFailedTool) {
        this.consecutiveFailures++;
      } else {
        this.lastFailedTool = tool.name;
        this.consecutiveFailures = 1;
      }
      if (
        this.policy.failureGuard &&
        this.consecutiveFailures >= this.policy.failureGuardThreshold
      ) {
        output = {
          ...output,
          guardHint: `[Efficiency Guard] 工具 [${tool.name}] 已连续失败 ${this.consecutiveFailures} 次。请停止简单重试：检查参数是否正确、改用其他工具，或基于已有信息直接总结。`,
        };
      }
    } else {
      this.lastFailedTool = '';
      this.consecutiveFailures = 0;
    }

    const serialized = typeof output === 'string' ? output : JSON.stringify(output);
    const outputLimit = effectiveOutputLimit(tool.outputCap);
    let finalOutput: any = output;
    let spilled: { callId: string; originalChars: number } | undefined;

    if (serialized.length > outputLimit) {
      let storedRef: string | null = null;
      if (this.policy.spill && this.options.spill) {
        try {
          const ref = await this.options.spill({
            taskId: session.taskId,
            callId,
            toolName: tool.name,
            fullText: serialized,
          });
          if (typeof ref === 'string' && ref.length > 0) storedRef = ref;
        } catch {
          storedRef = null;
        }
      }
      if (storedRef !== null) {
        this.stats.spilledOutputs++;
        this.stats.spilledChars += serialized.length;
        spilled = { callId, originalChars: serialized.length };
        finalOutput = buildSpillPointer(serialized, tool.name, callId);
      } else if (this.policy.truncate) {
        finalOutput = truncateToolOutput(serialized, tool.name, outputLimit);
      }
    }

    this.emit({
      type: 'tool_result',
      payload: {
        tool: tool.name,
        output,
        callId,
        ...(tool.compensation ? { compensation: tool.compensation } : {}),
        ...(spilled ? { spilled } : {}),
      },
    });

    if (
      tool.readOnly &&
      this.policy.cache &&
      !callFailed &&
      !callSkippedOrRejected &&
      !callEmpty
    ) {
      if (this.resultCache.size >= TOOL_RESULT_CACHE_MAX) {
        this.resultCache.delete(this.resultCache.keys().next().value as string);
      }
      this.resultCache.set(signature, { at: this.now(), output: finalOutput });
    }

    const status: ToolRuntimeStatus = callFailed
      ? 'error'
      : callSkippedOrRejected
        ? output?.skipped
          ? 'skipped'
          : 'rejected'
        : callEmpty
          ? 'empty'
          : 'ok';

    return {
      output: finalOutput,
      status,
      callId,
      durationMs: this.now() - startedAt,
      ...(spilled ? { spilled } : {}),
    };
  }

  private async requestApproval(
    tool: ToolDefinition,
    args: any,
    session: ToolSession,
  ): Promise<boolean> {
    if (this.policy.approval !== 'hitl' || !this.options.approve) return false;
    const request: ApprovalRequest = {
      id: `approval_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      action: tool.name,
      description: `Agent 正在尝试执行高危操作: ${tool.description}`,
      dangerLevel: 'high',
      params: args,
      taskId: session.taskId,
      ...(session.userId ? { userId: session.userId } : {}),
    };
    try {
      return await this.options.approve(request, undefined);
    } catch {
      return false;
    }
  }

  private emit(event: ToolRuntimeEvent): void {
    try {
      this.options.emit?.(event);
    } catch {
      // 观测事件失败不影响工具执行
    }
  }
}
