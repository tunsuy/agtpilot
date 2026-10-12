/**
 * script-skill 注册表 —— web 侧薄壳(引擎已迁至 @agtpilot/plugin-skill)
 *
 * 引擎本体(清单校验/目录热加载/声明式执行器/发布围栏/限频/审计)现在住在
 * 统一技能插件 packages/plugin-skill(服务面 ctx.skills);本文件只保留两件
 * web 独有的事:
 *
 * 1. webSkillStore():把本仓 user-store(托管 opt-in 记录 + 浏览器审计)
 *    适配成插件的 SkillStoreAdapter 注入 —— 存储不下沉,插件不依赖 web;
 * 2. 原 API 的兼容转发(buildScriptSkillTools / skillGateAllows / 纯函数与
 *    类型再导出),既有调用方与测试不用改导入路径。
 *
 * agent-backend 优先走 ctx.skills.buildTaskTools(装配时已注入同一个
 * webSkillStore);插件加载失败时回落这里的本地构建,行为一致。
 *
 * 安全模型说明见 packages/plugin-skill/src/index.ts 头注(声明式 DSL 而非
 * 任意脚本热加载、框架统一安全件、三层发布红线)。
 * 开关:AGTPILOT_SCRIPT_SKILLS=0 整体关闭(关闭后同名内置工具照常兜底)。
 */
import {
  createSkillService,
  skillGateAllows as engineGateAllows,
  type ManagedGateRecord,
  type ScriptSkillToolsResult,
  type SkillAuditEntry,
  type SkillStoreAdapter,
} from '@agtpilot/plugin-skill';
import {
  getZhihuManaged,
  getXhsManaged,
  getBrowserAudit,
  appendBrowserAudit,
  type BrowserAuditEntry,
} from './user-store';

// ---- 引擎再导出(既有导入路径不变) ----
export {
  SKILL_FILE_SUFFIX,
  isScriptSkillsEnabled,
  scriptSkillsDir,
  validateScriptSkill,
  loadScriptSkills,
  skillDailyLimit,
  countTodaySkillRuns,
  renderSkillMessage,
  runSkillSteps,
  buildScriptSkillTool,
  type SkillStep,
  type ScriptSkillManifest,
  type ScriptSkillBrowserService,
  type ScriptSkillLoadResult,
  type SkillAuditEntry,
  type SkillStoreAdapter,
} from '@agtpilot/plugin-skill';

/** web 存储适配器:托管记录按平台分流,审计直连 user-store(滚动 200 条) */
export function webSkillStore(): SkillStoreAdapter {
  return {
    getManagedRecord(userId: string, platform: 'zhihu' | 'xhs'): ManagedGateRecord | undefined {
      const rec = platform === 'zhihu' ? getZhihuManaged(userId) : getXhsManaged(userId);
      if (!rec) return undefined;
      return { enabled: rec.enabled, riskAckAt: rec.riskAckAt };
    },
    listAudit(userId: string): SkillAuditEntry[] {
      return getBrowserAudit(userId) as SkillAuditEntry[];
    },
    appendAudit(userId: string, entry: SkillAuditEntry) {
      appendBrowserAudit(userId, entry as BrowserAuditEntry);
    },
  };
}

/** 托管 opt-in 门(绑定 web 存储;引擎纯函数版在插件里) */
export function skillGateAllows(
  skill: import('@agtpilot/plugin-skill').ScriptSkillManifest,
  userId: string
): boolean {
  return engineGateAllows(skill, userId, webSkillStore());
}

/**
 * 构建用户级脚本技能工具(每次任务组装时调用 = 热加载点)。
 * browser 缺省(插件未就绪)→ 全部不注入(词汇表全是浏览器动作);
 * gate 不满足(未 opt-in/未读风险)→ 该技能不注入。
 */
export function buildScriptSkillTools(
  userId: string,
  browser?: import('@agtpilot/plugin-skill').ScriptSkillBrowserService,
  opts: { dir?: string } = {}
): ScriptSkillToolsResult {
  return createSkillService({ store: webSkillStore() }).buildTaskTools(userId, browser, opts);
}
