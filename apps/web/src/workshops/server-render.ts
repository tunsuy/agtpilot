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
import { getNovelBook } from '@/lib/novel-store';
import type { WorkshopRun, WorkshopRunContext } from './types';

/**
 * 工坊状态 loader(服务端专属;放这里而非各包 skill.ts —— skill.ts 进客户端
 * bundle,不得引 fs)。与档案现读同理:触发那一刻现读状态库,客户端只传 id。
 * 抛错 = 权威渲染拒绝(调用方 500 带明确原因),绝不静默降级用客户端拼的 prompt。
 */
const STATE_LOADERS: Partial<Record<WorkshopId, (userId: string, params: Record<string, unknown>) => WorkshopRunContext>> = {
  novel: (userId, params) => {
    const mode = typeof params.mode === 'string' ? params.mode : 'genesis';
    if (mode !== 'continue' && mode !== 'review') return {};
    const bookId = typeof params.bookId === 'string' ? params.bookId.trim() : '';
    const book = bookId ? getNovelBook(userId, bookId) : null;
    if (!book) throw new Error(`小说不存在或无权访问: ${bookId || '(缺 bookId)'}`);
    return { novelState: book };
  },
};

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
  // 状态 loader 现读(novel 续写/审查的书状态等;抛错 = 拒绝渲染,不静默降级)
  const loaded = STATE_LOADERS[workshopId as WorkshopId]?.(userId, params || {}) || {};
  const run = skill.run(params || {}, {
    ...loaded,
    ...(profile ? { scenarioProfile: profile } : {}),
  });
  const override = getWorkshopOverrides(opts.overrideDir).byId[workshopId];
  if (override !== undefined) {
    return { ...run, prompt: override, overridden: true };
  }
  return { ...run, overridden: false };
}
