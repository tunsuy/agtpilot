/**
 * 思考深度中转容错(reasoning_effort 降级重试)。
 *
 * 生产实测(2026-10-19,ai.ctaigw.cn 多渠道网关):同一个模型 ID 背后挂多个
 * 上游渠道做负载均衡,其中一个渠道只认 low/high/max,发 reasoning_effort=medium
 * 时【随机】400("must be one of low, high, or max",5 发中 2 发被拒)。
 * 这种错误发生在 HTTP 请求层,若不兜底,agent loop 里约 1/3 的模型调用会
 * 随机失败打断整个任务——比"完全不支持"更阴险。
 *
 * 策略:fetch 层拦截「400 + 错误体点名 reasoning_effort + 请求体确实带了
 * reasoning_effort」三条件同时命中的请求,剥掉该参数原地重试一次并记
 * warning(退化回"不下发思考参数",任务不中断)。三条件任一不满足就原样
 * 透传:普通请求零开销(不 clone 不读体),非思考参数的 400 不误伤。
 *
 * 只重试一次不循环:重试仍 400 说明另有原因,原样返回交给上层报错。
 * 挂在 resolveActiveModel 四个分支的 provider fetch 上,对所有档位/中转
 * 通用(官方端点合法档位不会 400,兜底自然不触发)。
 */

type FetchLike = typeof globalThis.fetch;

let downgradeCount = 0;

/** 测试辅助:清空累计计数 */
export function __resetEffortFallbackCount() {
  downgradeCount = 0;
}

/** 累计降级次数(观测用) */
export function effortFallbackCount(): number {
  return downgradeCount;
}

export function fetchWithEffortFallback(baseFetch?: FetchLike): FetchLike {
  const doFetch: FetchLike = (input, init) => (baseFetch ?? globalThis.fetch)(input as any, init as any);
  return async (input, init) => {
    const res = await doFetch(input, init);
    // 廉价前置:只处理「400 + JSON 字符串体 + 带 reasoning_effort」,其余零开销透传
    if (res.status !== 400 || typeof init?.body !== 'string' || !init.body.includes('reasoning_effort')) {
      return res;
    }
    let errText = '';
    try {
      errText = await res.clone().text();
    } catch {
      return res; // 错误体不可读(流已消耗等),不猜,原样返回
    }
    if (!/reasoning[_-]?effort/i.test(errText)) return res;
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(init.body);
    } catch {
      return res;
    }
    if (!body || typeof body !== 'object' || !('reasoning_effort' in body)) return res;
    delete body.reasoning_effort;
    downgradeCount += 1;
    console.warn(
      `[plugin-model] 中转拒绝 reasoning_effort 参数(HTTP 400),已自动降级为不下发思考参数重试(累计 ${downgradeCount} 次)。` +
        '该连接器的思考深度档位中转可能不支持,建议在连接器设置里改档或留默认。'
    );
    return doFetch(input, { ...init, body: JSON.stringify(body) });
  };
}

/** 挂到各 provider 的共享实例(调用时才取 globalThis.fetch,兼容运行期补丁) */
export const effortFallbackFetch: FetchLike = fetchWithEffortFallback();
