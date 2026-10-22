/**
 * 思考深度旋钮:单轮输出上限由思考与答复共用,思考不设防会把答复/工具调用
 * 的额度吃光(生产实例 2026-10-16:PPT 任务 reasoning 约 4 万 token,tool_call
 * 写到一半被截 → 零交付)。reasoning_effort 是本 SDK 各分支的通用旋钮,
 * 最终都映射到请求体的 reasoning_effort 字段。
 *
 * 缺省口径:openai 显式 'medium'(即厂商缺省,行为不变);deepseek 缺省
 * **不下发**(deepseek 分支只有 low/high/max 三档,medium 会被 SDK 转成
 * high 并刷 warning —— 缺省下发等于悄悄把行为改成 high);custom_llm/
 * local_llm 厂商未知(严格中转对未知参数可能 400)缺省**不下发**。
 * AGTPILOT_REASONING_EFFORT=low|medium|high 可显式覆盖各分支;其中 deepseek
 * 的 medium 按 SDK 口径预先映射为 high(与 SDK 内置映射一致,只是不刷 warning)。
 * custom/local 的 provider key 必须用 'openai-compatible'(带连字符的通用键,
 * SDK 会同时解析它;驼峰 openaiCompatible 不是合法 key,发了也会被静默丢弃)。
 * 返回 undefined = 不下发任何思考参数。
 *
 * 优先级(四层,resolveThinkingEffort 收口前两层):
 * 任务级(app 层合并进 configOverride.reasoningEffort,如 web 工坊思考深度)>
 * 连接器级配置(configOverride.reasoningEffort,用户在模型连接器卡片上选的
 * 低/中/高)> 全局 env AGTPILOT_REASONING_EFFORT(部署方兜底旋钮)> 上面的
 * 分支缺省。连接器「默认」= 不存键 = 回落全局配置,与未配置无区别
 * (saveUserConnector 对空值删键,存储层表达不出「显式关」与「未设置」之差)。
 */
type Effort = 'low' | 'medium' | 'high';

/**
 * 连接器级思考深度 → thinkingProviderOptions 的入参。
 * configValue 合法(low/medium/high)则用它;否则(未设置/空/非法)回落 env。
 * 显式传 undefined 时 JS 默认参数仍会读 env,两层口径一致、不会重复或漏读。
 */
export function resolveThinkingEffort(
  configValue: string | undefined,
  env: string | undefined = process.env.AGTPILOT_REASONING_EFFORT
): string | undefined {
  if (configValue === 'low' || configValue === 'medium' || configValue === 'high') return configValue;
  return env;
}

export function thinkingProviderOptions(
  branch: string,
  env: string | undefined = process.env.AGTPILOT_REASONING_EFFORT
): Record<string, { reasoningEffort: Effort }> | undefined {
  if (branch === 'openai') {
    const effort = env === undefined ? 'medium' : env;
    if (effort !== 'low' && effort !== 'medium' && effort !== 'high') return undefined;
    return { openai: { reasoningEffort: effort } };
  }
  if (branch === 'deepseek') {
    if (env === undefined) return undefined;
    if (env === 'medium') return { deepseek: { reasoningEffort: 'high' } };
    if (env !== 'low' && env !== 'high') return undefined;
    return { deepseek: { reasoningEffort: env } };
  }
  if (branch === 'custom_llm' || branch === 'local_llm') {
    if (env !== 'low' && env !== 'medium' && env !== 'high') return undefined;
    return { 'openai-compatible': { reasoningEffort: env } };
  }
  return undefined;
}
