/**
 * 工具提供方注册表(工坊 skill 包重构 Phase 1)
 *
 * 此前 agent-backend.runMission 里是一段约 200 行的硬编码注入块:每个工具
 * 模块一段 dynamic import + push + try/catch,新增/调整工具都要改主流程。
 * 收敛为:每个工具模块自带 `TOOL_PROVIDER` 描述符(id + 依赖声明 + build),
 * 本注册表按序装载,单个 provider 抛错只记日志不影响其余(与原 per-block
 * try/catch 同语义)。
 *
 * 约定:
 * - deps 声明 build 需要的上下文('uid' 用户分区 / 'browser' plugin-browser
 *   服务 / 'artifact' 中央画布+用户文件库闭包),闭包接线仍留在
 *   agent-backend(它持有 this.ctx.artifact 与 saveArtifactFile);
 * - 同名覆盖契约不变:script-skill 注册表(放 .skill.json 文件)最后装载,
 *   同名时注册表文件胜出 —— 本注册表产出的工具都在它之前。
 * - 基础设施类工具(用户记忆/定时巡航/MCP 连接器/授权桥)不属于工坊域,
 *   仍留在 agent-backend 主流程,不入本表。
 */
import type { ToolDefinition } from '@agtpilot/core';

export type ToolProviderDep = 'uid' | 'browser' | 'artifact';

export interface ToolProviderContext {
  uid: string;
  /** plugin-browser 的 ctx.browser(与登录通道共享 per-user Page);无浏览器插件时缺省 */
  browser?: unknown;
  /** 中央画布写入闭包(agent-backend 接线,artifact 服务缺失时调用才抛错) */
  createArtifact?: (data: any, taskId?: string) => any;
  /** 用户级文件库写入闭包(agent-backend 接线,已绑定 uid;saveArtifactFile 同步返回) */
  storeFile?: (input: any) => any;
}

export interface ToolProvider {
  id: string;
  deps: ToolProviderDep[];
  build: (ctx: ToolProviderContext) => Promise<ToolDefinition[]> | ToolDefinition[];
}

export interface ToolProviderEntry {
  id: string;
  load: () => Promise<{ TOOL_PROVIDER: ToolProvider }>;
}

/** 注册顺序即注入顺序(与旧硬编码块的语义顺序一致) */
export const TOOL_PROVIDERS: ToolProviderEntry[] = [
  { id: 'ppt', load: () => import('@/lib/ppt-deck') },
  { id: 'wechat_mp', load: () => import('@/lib/wechat-mp') },
  { id: 'email_smtp', load: () => import('@/lib/email-smtp') },
  { id: 'email_imap', load: () => import('@/lib/email-imap') },
  { id: 'follow_builders', load: () => import('@/lib/follow-builders') },
  { id: 'github_scan', load: () => import('@/lib/github-scan') },
  { id: 'xhs', load: () => import('@/lib/xhs-managed') },
  { id: 'zhihu', load: () => import('@/lib/zhihu-managed') },
  { id: 'reference', load: () => import('@/lib/reference-materials') },
];

export type ProviderLog = (level: 'system' | 'stderr', message: string) => void;

/**
 * 按序装载全部 provider:单个失败记 stderr 日志继续(不得让一个坏模块
 * 中断其余工具与 MCP 挂载 —— 原硬编码块 per-try/catch 的同语义平移)。
 * providers 参数仅供测试注入替身,生产走默认 TOOL_PROVIDERS。
 */
export async function resolveProviderTools(
  ctx: ToolProviderContext,
  log: ProviderLog,
  providers: ToolProviderEntry[] = TOOL_PROVIDERS
): Promise<ToolDefinition[]> {
  const tools: ToolDefinition[] = [];
  for (const entry of providers) {
    try {
      const mod = await entry.load();
      const built = await mod.TOOL_PROVIDER.build(ctx);
      if (built.length > 0) {
        tools.push(...built);
        log('system', `[REG] ${mod.TOOL_PROVIDER.id} 工具挂载: ${built.map((t) => t.name).join(' / ')}`);
      }
    } catch (e: any) {
      log('stderr', `[REG] ${entry.id} 挂载异常: ${e?.message || e}`);
    }
  }
  return tools;
}
