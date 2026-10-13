/**
 * 工坊 → Agent 任务的统一出口 · 派生 re-export
 *
 * 分发逻辑已迁入 src/workshops/registry.ts(工坊 skill 包重构 Phase 2):
 * 各工坊包自带 run(),本文件只保留旧 import 路径的兼容出口,
 * 表单(components/workshops/forms/*)与 page.tsx 的引用零改动。
 */
export {
  buildWorkshopRun,
  type WorkshopRun,
  type WorkshopRunContext,
  type WorkshopId,
} from '@/workshops/registry';
