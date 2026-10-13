/**
 * cron 任务的场景标记与触发时 prompt 重建(scenario-loop P2 模块 3)。
 *
 * 订阅类任务(如小红书每周选题、开源贡献雷达周扫)存的是 scenario 标记而非写死的 prompt 文本:
 * 用户改档案后,下一次触发自动用最新档案重建 —— 避免订阅里的 prompt 快照过期。
 * 普通任务(用户手输 prompt)不受影响,原样返回。
 *
 * 场景的单一事实源是各工坊包清单里的 cron 声明(src/workshops/<id>/skill.ts),
 * 注册表汇总为 CRON_SCENARIOS:本模块按 key 查表分发,不持有任何场景硬编码
 * (白名单、count 钳制区间、缺省值、档案槽位、重建函数全部来自声明)。
 */
import { CRON_SCENARIOS, type CronScenarioKey } from '@/workshops/registry';
import type { ScenarioProfile } from './scenario-profile';

/** cron 任务上的场景标记;key 必须在 CRON_SCENARIOS 白名单内才有效 */
export interface CronScenario {
  key: CronScenarioKey;
  /** 产出条数(钳制区间与缺省值见各场景声明),缺省按场景默认 */
  count?: number;
}

/** 入口清洗:白名单外的 key 一律无效(忽略而非报错,老任务/恶意输入都安全降级) */
export function normalizeCronScenario(input: any): CronScenario | null {
  if (!input || typeof input !== 'object') return null;
  const key = String((input as any).key);
  const spec = CRON_SCENARIOS[key as CronScenarioKey];
  if (!spec) return null;
  const rawCount = Number((input as any).count);
  const count =
    Number.isFinite(rawCount) && rawCount >= spec.countMin && rawCount <= spec.countMax
      ? Math.round(rawCount)
      : undefined;
  return { key: key as CronScenarioKey, count };
}

/**
 * 触发时解析任务真正要执行的 prompt:
 * - scenario 任务:按当前档案现读重建(档案读取由调用方注入,保持本函数纯可测);
 * - 普通任务:原样返回 job.prompt。
 */
export function resolveCronPrompt(
  job: { prompt?: string; scenario?: CronScenario | null },
  getProfile: (profileSlot: string) => ScenarioProfile | undefined
): string {
  const scenario = normalizeCronScenario(job.scenario);
  if (!scenario) return job.prompt || '';
  const spec = CRON_SCENARIOS[scenario.key];
  return spec.build(scenario.count ?? spec.defaultCount, getProfile(spec.profileSlot));
}
