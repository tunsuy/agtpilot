/**
 * 工坊任务 · 服务端权威渲染(services 端专属)
 *
 * /api/agent/run 接受可选 {workshopId, params}:服务端用同一注册表渲染,
 * 档案从 user-store 现读(顺带修复客户端拼 prompt 的档案过期问题)。
 * 与客户端实时预览走同一个 buildWorkshopRun,但档案是服务端当前值,
 * 且存在覆盖文件时以覆盖全文为准 —— 该请求忽略客户端拼好的 prompt;
 * 普通手输 prompt(不带 workshopId)不受影响,原样走旧路径。
 */
import { getWorkshop, getWorkshopSkill, type WorkshopId } from './registry';
import { getWorkshopOverrides } from './overrides';
import { getUserScenarioProfiles } from '@/lib/user-store';
import type { WorkshopRun } from './types';

export interface ServerWorkshopRun extends WorkshopRun {
  /** 服务端覆盖目录存在该工坊的覆盖文件(prompt 已替换为覆盖全文) */
  overridden: boolean;
}

/**
 * 服务端渲染一次工坊任务:未知 workshopId 返回 null(调用方 400,
 * 绝不静默回落客户端 prompt —— 那等于让过期模板混进权威路径)。
 * opts.overrideDir 供测试指覆盖目录(缺省 workshopOverridesDir(),env 可覆盖)。
 */
export function renderWorkshopRunServer(
  userId: string,
  workshopId: string,
  params: Record<string, unknown>,
  opts: { overrideDir?: string } = {}
): ServerWorkshopRun | null {
  if (!getWorkshop(workshopId)) return null;
  const skill = getWorkshopSkill(workshopId as WorkshopId);
  // 档案现读:客户端预览用的可能是几分钟前的档案快照,触发那一刻才是准的
  const slot = skill.meta.profileSlot;
  const profile = slot ? getUserScenarioProfiles(userId)[slot] : undefined;
  const run = skill.run(params || {}, profile ? { scenarioProfile: profile } : undefined);
  const override = getWorkshopOverrides(opts.overrideDir).byId[workshopId];
  if (override !== undefined) {
    return { ...run, prompt: override, overridden: true };
  }
  return { ...run, overridden: false };
}
