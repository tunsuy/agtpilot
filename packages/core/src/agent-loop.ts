/**
 * Agent loop 共享外壳：父子 agent 共用的循环前后处理。
 *
 * 只收敛「每次进模型前 / 每次循环结束后」的横切机制：
 * - reasoning 部件剥离（闸2 循环内 + 闸3 收尾装配）
 * - 统一把剥离开销计数回传调用方
 *
 * 路由、压缩、看板催促、预算、强制收敛等策略仍留在各自 adapter：
 * 父 agent 与子 agent 的控制流确实不同，强行塞进一个巨型 harness 会让
 * 策略钩子比原代码更难读。共享的是机制，不是编排。
 */
import type {
  AgentLoopOptions,
  AgentLoopPrepareStep,
  AgentLoopResult,
  ModelGateway,
} from './contracts';
import { reasoningStripEnabled, stripReasoningParts } from './reasoning';

/**
 * 本外壳实际消费的最小模型面:只调 runAgentLoop(循环内不再碰网关的
 * 单步调用/偏好/预算方法)。比 ModelGateway 窄 —— 父 agent(orchestrator)
 * 传全量网关、子 agent(plugin-subagent)传窄接口 SubagentModel 都结构满足。
 */
export interface LoopGateway
  extends Pick<ModelGateway, 'runAgentLoop'> {}

export interface RunAgentLoopOptions extends Omit<AgentLoopOptions, 'prepareStep'> {
  gateway: LoopGateway;
  prepareStep?: AgentLoopPrepareStep;
  /** 缺省 true：循环内与收尾装配都剥离 reasoning */
  stripReasoning?: boolean;
}

export interface RunAgentLoopResult {
  result: AgentLoopResult;
  /** 本次循环剥离的 reasoning 部件数（循环内 + 收尾装配合计） */
  reasoningPartsStripped: number;
  /** 已按策略剥离 reasoning 的 responseMessages，可直接拼回会话历史 */
  responseMessages: any[];
}

export async function runAgentLoopWithHooks(
  options: RunAgentLoopOptions,
): Promise<RunAgentLoopResult> {
  const { gateway, prepareStep, stripReasoning = true, ...loopOptions } = options;
  const stripEnabled = stripReasoning && reasoningStripEnabled();
  let stripped = 0;

  const wrappedPrepareStep: AgentLoopPrepareStep = (ctx) => {
    let messages = ctx.messages || [];
    if (stripEnabled) {
      const r = stripReasoningParts(messages);
      stripped += r.stripped;
      messages = r.messages;
    }

    const finalize = (adjust: { activeTools?: string[]; messages?: any[] } | undefined) => {
      if (messages === ctx.messages) return adjust;
      if (!adjust) return { messages };
      if (adjust.messages) return adjust;
      return { ...adjust, messages };
    };

    const adjust = prepareStep?.({ ...ctx, messages });
    return adjust instanceof Promise ? adjust.then(finalize) : finalize(adjust);
  };

  const result = await gateway.runAgentLoop({
    ...loopOptions,
    prepareStep: wrappedPrepareStep,
  });

  let responseMessages = result.responseMessages || [];
  if (stripEnabled) {
    const r = stripReasoningParts(responseMessages);
    stripped += r.stripped;
    responseMessages = r.messages;
  }

  return { result, reasoningPartsStripped: stripped, responseMessages };
}
