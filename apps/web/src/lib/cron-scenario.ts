/**
 * cron 任务的场景标记与触发时 prompt 重建(scenario-loop P2 模块 3)。
 *
 * 订阅类任务(如小红书每周选题、开源贡献雷达周扫)存的是 scenario 标记而非写死的 prompt 文本:
 * 用户改档案后,下一次触发自动用最新档案重建 —— 避免订阅里的 prompt 快照过期。
 * 普通任务(用户手输 prompt)不受影响,原样返回。
 */
import { buildXhsWeeklyTopicsPrompt } from '@/workshops/xhs/context';
import { buildOssRadarPrompt } from '@/workshops/oss_radar/context';
import type { ScenarioProfile } from './scenario-profile';

/** cron 任务上的场景标记;key 白名单内才有效 */
export interface CronScenario {
  key: 'xhs_weekly_topics' | 'oss_radar_weekly';
  /** 产出条数(选题 3-10;机会清单同区间),缺省按场景默认 */
  count?: number;
}

const SCENARIO_KEYS: ReadonlySet<string> = new Set(['xhs_weekly_topics', 'oss_radar_weekly']);

/** 入口清洗:白名单外的 key 一律无效(忽略而非报错,老任务/恶意输入都安全降级) */
export function normalizeCronScenario(input: any): CronScenario | null {
  if (!input || typeof input !== 'object') return null;
  const key = String((input as any).key);
  if (!SCENARIO_KEYS.has(key)) return null;
  const rawCount = Number((input as any).count);
  const count = Number.isFinite(rawCount) && rawCount >= 3 && rawCount <= 10 ? Math.round(rawCount) : undefined;
  return { key: key as CronScenario['key'], count };
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
  if (scenario.key === 'oss_radar_weekly') {
    // 技术栈/排除项来自贡献者档案;关注方向与机会类型不在 cron 标记里存快照,触发时不限(档案优先)
    return buildOssRadarPrompt({
      count: scenario.count ?? 5,
      profile: getProfile('oss_radar'),
    });
  }
  return job.prompt || '';
}
