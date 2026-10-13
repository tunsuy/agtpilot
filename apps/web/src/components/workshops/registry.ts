/**
 * 工坊注册表 · 派生 re-export
 *
 * 定义已迁入 src/workshops/(工坊 skill 包重构 Phase 2):每个工坊一个自包含
 * 包目录,这里只保留旧 import 路径的兼容出口,components 内部引用零改动。
 * 新增工坊见 src/workshops/registry.ts 头注释。
 */
export {
  WORKSHOPS,
  WORKSHOP_CATEGORIES,
  getWorkshop,
  type WorkshopId,
  type WorkshopDef,
  type WorkshopAccent,
  type WorkshopDep,
  type ArtifactSpec,
} from '@/workshops/registry';
