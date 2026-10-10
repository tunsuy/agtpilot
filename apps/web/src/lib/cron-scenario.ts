/**
 * cron 任务的场景标记与触发时 prompt 重建(scenario-loop P2 模块 3)。
 *
 * 订阅类任务(如小红书每周选题)存的是 scenario 标记而非写死的 prompt 文本:
 * 用户改档案后,下一次触发自动用最新档案重建 —— 避免订阅里的 prompt 快照过期。
 * 普通任务(用户手输 prompt)不受影响,原样返回。
 */
import { buildXhsWeeklyTopicsPrompt } from './xhs-workshop';
import type { ScenarioProfile } from './scenario-profile';

/** cron 任务上的场景标记;key 白名单内才有效 */
export interface CronScenario {
  key: 'xhs_weekly_topics';
  /** 选题条数,缺省 7 */
  count?: number;
}

const SCENARIO_KEYS: ReadonlySet<string> = new Set(['xhs_weekly_topics']);

/** 入口清洗:白名单外的 key 一律无效(忽略而非报错,老任务/恶意输入都安全降级) */
export function normalizeCronScenario(input: any): CronScenario | null {
  if (!input || typeof input !== 'object') return null;
  const key = String((input as any).key);
  if (!SCENARIO_KEYS.has(key)) return null;
  const rawCount = Number((input as any).count);
  const count = Number.isFinite(rawCount) && rawCount >= 3 && rawCount <= 10 ? Math.round(rawCount) : undefined;
  return { key: 'xhs_weekly_topics', count };
}

/**
 * 触发时解析任务真正要执行的 prompt:
 * - scenario 任务:按当前档案现读重建(档案读取由调用方注入,保持本函数纯可测);
 * - 普通任务:原样返回 job.prompt。
 */
export function resolveCronPrompt(
  job: { prompt?: string; scenario?: CronScenario | null },
  getProfile: (scenarioKey: string) => ScenarioProfile | undefined
): string {
  const scenario = normalizeCronScenario(job.scenario);
  if (!scenario) return job.prompt || '';
  if (scenario.key === 'xhs_weekly_topics') {
    return buildXhsWeeklyTopicsPrompt({
      count: scenario.count ?? 7,
      profile: getProfile('xhs'),
    });
  }
  return job.prompt || '';
}
