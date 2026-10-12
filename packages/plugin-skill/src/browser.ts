/**
 * browser shim —— 客户端 bundle 替换入口(package.json browser 字段)。
 *
 * 主入口(index.ts)顶层 import fs/path 扫描技能目录,被客户端组件链
 * (ppt-workshop → 工坊表单)拉进浏览器 bundle 时 webpack 解析 fs 即报
 * Module not found。经 browser 字段,客户端编译换用本 shim:pack 注册表
 * 恒为空 → 消费方(ppt-workshop.resolvePackDir)自然回落镜像固定路径;
 * 服务端编译(同源码两份产物)不受 browser 字段影响,仍走真实注册表。
 */
import type { SkillPluginConfig, SkillService } from './index';

/** 浏览器端技能服务:注册表空转,一切查询回落消费方兜底 */
export function createSkillService(_config?: SkillPluginConfig): SkillService {
  return {
    listSkills: () => [],
    listPacks: () => [],
    getPack: () => undefined,
    buildCardsBlock: () => '',
    distillCards: async () => ({ added: [], updated: [] }),
  } as unknown as SkillService;
}
