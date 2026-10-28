/**
 * prepareStep 中间件管线：把「每步进模型前的上下文/工具/预算决策」拆成
 * 可组合的 middleware，而不是一个巨型函数。
 *
 * - harness 只负责按序执行链，不决定链里有什么；
 * - 每个 agent 在自己的模块里声明自己的链（策略异构）；
 * - 共享的是管线形状与上下文对象，不是策略。
 */
export interface PrepareStepContext {
  stepNumber: number;
  /** 当前工作消息列表；middleware 可替换为新数组（如压缩后的消息） */
  messages: any[];
  /** 进入管线时的原始消息列表，用于判断是否被改写 */
  originalMessages: any[];
  /** 传递给模型网关的 adjust 对象 */
  adjust: { activeTools?: string[]; messages?: any[] };
}

export type PrepareMiddleware = (
  ctx: PrepareStepContext,
) => void | Promise<void>;

export type PrepareStepAdjust = { activeTools?: string[]; messages?: any[] };

export type PreparePipelineResult = PrepareStepAdjust | undefined;

export function runPreparePipeline(
  ctx: PrepareStepContext,
  middlewares: PrepareMiddleware[],
): PreparePipelineResult | Promise<PreparePipelineResult> {
  let index = 0;

  const finish = (): PreparePipelineResult => {
    if (ctx.messages !== ctx.originalMessages) {
      ctx.adjust.messages = ctx.messages;
    }
    return Object.keys(ctx.adjust).length > 0 ? ctx.adjust : undefined;
  };

  const step = (): PreparePipelineResult | Promise<PreparePipelineResult> => {
    while (index < middlewares.length) {
      const result = middlewares[index++](ctx);
      if (result instanceof Promise) return result.then(step);
    }
    return finish();
  };

  return step();
}
