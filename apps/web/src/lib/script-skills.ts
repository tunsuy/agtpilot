/**
 * script-skill 注册表 —— 可热加载的声明式浏览器流程脚本
 *
 * 动机:工坊类「确定性操作段」(导航 → 等编辑器 → 填写 → 存草稿 → 截图审计)
 * 此前逐个硬编码成任务工具(zhihu-managed / xhs-managed),新增或修复一条流程
 * 都要改代码发版。注册表把这类流程抽成【清单 + 声明式步骤】的技能文件:
 *
 *   apps/web/skills/<name>.skill.json   (生产:AGTPILOT_SCRIPT_SKILL_DIR,镜像内 /app/skills)
 *
 * 运行时每次组装任务工具时扫描目录热加载,按清单挂成标准 ToolDefinition;
 * 同名工具覆盖注入列表里更早的内置工具(与 taskTools 覆盖全局注册同语义)——
 * 例如知乎编辑器选择器漂移时,放一个修正版技能文件即可生效,不用发版。
 *
 * 安全模型(为什么是声明式 DSL 而不是任意脚本热加载):
 * - 热加载任意 JS 等于把服务器执行面开放给「能放文件的人」;这里技能文件是
 *   纯数据,由编译好的执行器解释,动作词汇表固定且全部是浏览器白名单操作;
 * - 词汇表里【不存在发布动作】(三层红线之二),clickOrFocus 运行时再过一遍
 *   发布词围栏,文件加载时校验也拒收任何含「发布/publish」的选择器/URL(三层);
 * - 安全件由框架统一提供,技能作者想漏都漏不掉:托管 opt-in 门(enabled +
 *   riskAckAt 缺一不可)、登录门前置(未登录不开浏览器)、每日限频(成败都计)、
 *   浏览器审计(成败都落)、dangerLevel 缺省 high(编排器审批门);
 * - 文件只能由管理员放置(服务器文件系统),加载校验失败仅记日志跳过,绝不崩溃。
 *
 * 开关:AGTPILOT_SCRIPT_SKILLS=0 整体关闭(关闭后同名内置工具照常兜底)。
 */
import * as fs from 'fs';
import * as path from 'path';
import type { ToolDefinition } from '@agtpilot/core';
import {
  getZhihuManaged,
  getXhsManaged,
  getBrowserAudit,
  appendBrowserAudit,
  type BrowserAuditEntry,
} from './user-store';

// ---- 类型 ----

/** 动作词汇表:执行器认识的全部步骤类型(闭集;新增动作 = 改代码走评审,不是放文件) */
export type SkillStep =
  | { kind: 'goto'; url: string; waitUntil?: string; timeoutMs?: number }
  | {
      kind: 'waitForSelector';
      selector: string;
      /** 轮询次数(缺省 12)× intervalMs(缺省 2000) */
      retries?: number;
      intervalMs?: number;
      /** 轮询期间页面 URL 命中该正则 → 视为登录态失效,以 abortAs 落审计并返回登录引导 */
      abortIfUrl?: string;
      abortAs?: string;
      timeoutError?: string;
    }
  | { kind: 'fill'; selector: string; param?: string; value?: string; timeoutMs?: number }
  | { kind: 'clickOrFocus'; selector: string; clickTimeoutMs?: number; focusTimeoutMs?: number }
  | { kind: 'pressKeys'; keys: string }
  | { kind: 'insertText'; param?: string; value?: string }
  | {
      kind: 'waitForText';
      pattern: string;
      timeoutMs?: number;
      /** true = 等不到不算失败,只记 flag(如自动保存指示,仅附注不作成败判据) */
      optional?: boolean;
      /** 结果旗标名(供 successMessage 的 {note:flag} 与审计附注引用) */
      flag?: string;
    }
  | { kind: 'screenshot'; quality?: number };

export interface ScriptSkillManifest {
  /** 工具名(a-z0-9_);与内置工具同名时本技能覆盖之 */
  name: string;
  description: string;
  /** 缺省 high:浏览器写操作一律走编排器审批门,想降级必须显式声明 */
  dangerLevel?: 'low' | 'medium' | 'high';
  compensation?: { kind: 'reversible' | 'partially-reversible' | 'irreversible'; undoHint?: string };
  /** JSON Schema(透传给模型) */
  parameters: Record<string, any>;
  /** 参数校验失败时的整句报错(缺省按缺失项生成) */
  paramError?: string;
  /** 额外参数校验(如正文最少字数) */
  checks?: Array<{ param: string; minLength?: number }>;
  /** 托管 opt-in 门:对应平台的 enabled + riskAckAt 缺一不可,否则不注入 */
  gate?: { managed: 'zhihu' | 'xhs' };
  /** 登录门:导航前查 cookie,未登录不开浏览器、审计 not_logged_in、返回扫码引导 */
  login?: { homeUrl: string; cookieNames: string[]; hint: string };
  /** 每日限频(成败都计);env 可运行时调整 */
  dailyLimit?: { default: number; env?: string };
  /** 审计 action 字段(缺省 = 工具名) */
  auditAction?: string;
  steps: SkillStep[];
  /** 成功消息模板:{参数名}(值 ≤100 字才替换)/ {todayCount} / {dailyLimit} / {note:flag} */
  successMessage?: string;
  /** 旗标文案:present/missing 进 {note:flag};auditMissing 进「成功但旗标缺失」的审计附注 */
  notes?: Record<string, { present: string; missing: string; auditMissing?: string }>;
}

/** 浏览器服务依赖(与 plugin-browser 的 ctx.browser 同构;测试可 mock) */
export interface ScriptSkillBrowserService {
  acquirePage(userId?: string): Promise<any>;
  hasCookies(userId: string | undefined, domain: string, names: string[]): Promise<boolean>;
}

export const SKILL_FILE_SUFFIX = '.skill.json';
/** 单次加载的技能文件数上限(防误放海量文件拖慢组装) */
const MAX_SKILL_FILES = 50;
/** 清单字段上限(数据文件不许无限膨胀) */
const LIMITS = { steps: 20, description: 600, successMessage: 800, selector: 300, hint: 400 } as const;

/** 发布围栏(与 plugin-browser hitPublishFence 同词表):步骤里出现即拒收/拒执行 */
const PUBLISH_FENCE = /发布|publish/i;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** 登录/限流等结构化中止:审计记 auditError,用户看到 userMessage */
class SkillAbort extends Error {
  constructor(
    public userMessage: string,
    public auditError: string
  ) {
    super(auditError);
  }
}

// ---- 目录与开关 ----

export function isScriptSkillsEnabled(): boolean {
  return process.env.AGTPILOT_SCRIPT_SKILLS !== '0';
}

/** 技能目录:env 优先;缺省 cwd/skills(dev/test = apps/web/skills,生产镜像 = /app/skills) */
export function scriptSkillsDir(): string {
  return process.env.AGTPILOT_SCRIPT_SKILL_DIR || path.join(process.cwd(), 'skills');
}

// ---- 校验(纯函数,契约测试友好) ----

const NAME_RE = /^[a-z][a-z0-9_]{2,63}$/;
const STEP_KINDS = new Set([
  'goto',
  'waitForSelector',
  'fill',
  'clickOrFocus',
  'pressKeys',
  'insertText',
  'waitForText',
  'screenshot',
]);

/**
 * 校验一份技能清单。任何不合格返回错误描述(null = 合格)——
 * 加载器据此跳过坏文件,绝不让一个坏文件炸掉整个注册表。
 */
export function validateScriptSkill(raw: any): string | null {
  if (!raw || typeof raw !== 'object') return '清单不是对象';
  if (typeof raw.name !== 'string' || !NAME_RE.test(raw.name)) return 'name 缺失或非法(小写字母开头,仅 a-z0-9_)';
  if (typeof raw.description !== 'string' || !raw.description.trim()) return 'description 缺失';
  if (raw.description.length > LIMITS.description) return 'description 超长';
  if (!raw.parameters || typeof raw.parameters !== 'object') return 'parameters 缺失';
  if (!Array.isArray(raw.steps) || raw.steps.length === 0) return 'steps 缺失或为空';
  if (raw.steps.length > LIMITS.steps) return `steps 超过上限 ${LIMITS.steps}`;
  if (raw.dangerLevel !== undefined && !['low', 'medium', 'high'].includes(raw.dangerLevel)) {
    return 'dangerLevel 非法';
  }
  if (raw.gate !== undefined && !['zhihu', 'xhs'].includes(raw.gate?.managed)) {
    return 'gate.managed 仅支持 zhihu/xhs';
  }
  if (raw.login !== undefined) {
    const l = raw.login;
    if (typeof l?.homeUrl !== 'string' || !l.homeUrl.startsWith('https://')) return 'login.homeUrl 必须为 https';
    if (!Array.isArray(l?.cookieNames) || l.cookieNames.length === 0) return 'login.cookieNames 缺失';
    if (typeof l?.hint !== 'string' || !l.hint.trim()) return 'login.hint 缺失';
    if (l.hint.length > LIMITS.hint) return 'login.hint 超长';
  }
  if (raw.dailyLimit !== undefined) {
    const d = raw.dailyLimit?.default;
    if (!Number.isFinite(d) || d < 1 || d > 50) return 'dailyLimit.default 必须在 1~50';
  }
  if (raw.successMessage !== undefined && String(raw.successMessage).length > LIMITS.successMessage) {
    return 'successMessage 超长';
  }

  const props = raw.parameters?.properties || {};
  for (let i = 0; i < raw.steps.length; i++) {
    const s = raw.steps[i];
    const at = `steps[${i}]`;
    if (!s || typeof s !== 'object') return `${at} 不是对象`;
    if (!STEP_KINDS.has(s.kind)) return `${at} 未知动作 ${String(s.kind)}(词汇表是闭集)`;
    // 发布围栏(加载时):任何步骤字符串里出现发布词即拒收 —— 词汇表本无发布动作,这里是双保险
    const strings = [s.url, s.selector, s.value, s.pattern, s.keys, s.abortIfUrl]
      .filter((v) => typeof v === 'string') as string[];
    for (const str of strings) {
      if (PUBLISH_FENCE.test(str)) return `${at} 含发布词,拒收(托管终点是草稿箱)`;
      if (str.length > LIMITS.selector && s.kind !== 'waitForText') return `${at} 字段超长`;
    }
    switch (s.kind) {
      case 'goto':
        if (typeof s.url !== 'string' || !/^https:\/\//.test(s.url)) return `${at} goto.url 必须为 https`;
        break;
      case 'waitForSelector':
        if (typeof s.selector !== 'string' || !s.selector.trim()) return `${at} selector 缺失`;
        break;
      case 'fill':
        if (typeof s.selector !== 'string' || !s.selector.trim()) return `${at} selector 缺失`;
        if (!s.param && !s.value) return `${at} fill 需要 param 或 value`;
        break;
      case 'clickOrFocus':
        if (typeof s.selector !== 'string' || !s.selector.trim()) return `${at} selector 缺失`;
        break;
      case 'pressKeys':
        if (typeof s.keys !== 'string' || !s.keys.trim()) return `${at} keys 缺失`;
        break;
      case 'insertText':
        if (!s.param && !s.value) return `${at} insertText 需要 param 或 value`;
        break;
      case 'waitForText':
        if (typeof s.pattern !== 'string' || !s.pattern.trim()) return `${at} pattern 缺失`;
        try {
          new RegExp(s.pattern);
        } catch {
          return `${at} pattern 不是合法正则`;
        }
        break;
      case 'screenshot':
        break;
    }
    // param 引用必须在 parameters.properties 里声明(防手滑引用不存在的参数)
    if (typeof s.param === 'string' && !props[s.param]) return `${at} 引用了未声明的参数 ${s.param}`;
  }
  for (const c of raw.checks || []) {
    if (typeof c?.param !== 'string' || !props[c.param]) return 'checks 引用了未声明的参数';
  }
  return null;
}

// ---- 加载(热更新点:每次组装任务工具时扫描,放文件即生效) ----

export interface ScriptSkillLoadResult {
  skills: ScriptSkillManifest[];
  /** 每个被跳过文件的错误描述(带文件名;供挂载日志,绝不抛出) */
  errors: string[];
}

/** 扫描目录加载技能文件:坏 JSON/坏清单只记错误并跳过;同名文件先到先得 */
export function loadScriptSkills(dir: string = scriptSkillsDir()): ScriptSkillLoadResult {
  const out: ScriptSkillLoadResult = { skills: [], errors: [] };
  let files: string[];
  try {
    files = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(SKILL_FILE_SUFFIX))
      .sort()
      .slice(0, MAX_SKILL_FILES);
  } catch {
    return out; // 目录不存在/不可读 = 没有技能,不是错误(内置工具兜底)
  }
  const seen = new Set<string>();
  for (const f of files) {
    const full = path.join(dir, f);
    let raw: any;
    try {
      raw = JSON.parse(fs.readFileSync(full, 'utf-8'));
    } catch (e: any) {
      out.errors.push(`${f}: JSON 解析失败(${e?.message || e})`);
      continue;
    }
    const err = validateScriptSkill(raw);
    if (err) {
      out.errors.push(`${f}: ${err}`);
      continue;
    }
    if (seen.has(raw.name)) {
      out.errors.push(`${f}: 技能名 ${raw.name} 重复,已忽略(先到先得)`);
      continue;
    }
    seen.add(raw.name);
    out.skills.push(raw as ScriptSkillManifest);
  }
  return out;
}

// ---- 框架统一安全件 ----

/** 每日上限:env 覆盖清单缺省值(非法 env 回落缺省) */
export function skillDailyLimit(skill: ScriptSkillManifest): number {
  if (!skill.dailyLimit) return 0; // 0 = 不限频(只读类技能可不配)
  const envVal = skill.dailyLimit.env ? Number(process.env[skill.dailyLimit.env]) : NaN;
  if (Number.isFinite(envVal) && envVal > 0) return Math.floor(envVal);
  return skill.dailyLimit.default;
}

/** 今日(本地时区)该技能的执行次数(成败都计,保守限频;与 countTodayDraftSaves 同语义) */
export function countTodaySkillRuns(audit: BrowserAuditEntry[], toolName: string, now = new Date()): number {
  const dayKey = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}`;
  return audit.filter((e) => {
    if (e.tool !== toolName) return false;
    const d = new Date(e.at);
    return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}` === dayKey;
  }).length;
}

/** 托管 opt-in 门:对应平台 enabled + riskAckAt 缺一不可(与 shouldInjectWriteTool 同规则) */
export function skillGateAllows(skill: ScriptSkillManifest, userId: string): boolean {
  if (!skill.gate) return true;
  const rec = skill.gate.managed === 'zhihu' ? getZhihuManaged(userId) : getXhsManaged(userId);
  return !!rec?.enabled && !!rec?.riskAckAt;
}

// ---- 消息模板 ----

/**
 * 渲染成功消息模板:{key} 依次尝试 运行变量(todayCount/dailyLimit)→ 参数值
 * (≤100 字才替换,防止把整篇正文灌进消息);{note:flag} 按旗标取 notes 文案。
 */
export function renderSkillMessage(
  skill: ScriptSkillManifest,
  args: Record<string, any>,
  vars: { todayCount: number; dailyLimit: number },
  flags: Record<string, boolean>
): string {
  const tpl = skill.successMessage || '操作完成。';
  let msg = tpl.replace(/\{note:(\w+)\}/g, (_m, flag: string) => {
    const note = skill.notes?.[flag];
    if (!note) return '';
    return flags[flag] ? note.present : note.missing;
  });
  msg = msg.replace(/\{(\w+)\}/g, (m, key: string) => {
    if (key === 'todayCount') return String(vars.todayCount);
    if (key === 'dailyLimit') return String(vars.dailyLimit);
    const v = args?.[key];
    if (typeof v === 'string' && v.length <= 100) return v;
    return m; // 未知占位符原样保留,便于发现清单笔误
  });
  return msg;
}

/** 「成功但旗标缺失」的审计附注(如:未等到自动保存指示) */
function auditNotesForFlags(skill: ScriptSkillManifest, flags: Record<string, boolean>): string | undefined {
  for (const [flag, note] of Object.entries(skill.notes || {})) {
    if (flags[flag] === false && note.auditMissing) return note.auditMissing;
  }
  return undefined;
}

// ---- 执行器(白名单动作,逐步解释) ----

function stepValue(step: any, args: Record<string, any>): string {
  if (typeof step.param === 'string') return String(args?.[step.param] ?? '');
  return String(step.value ?? '');
}

/**
 * 在页面上顺序执行步骤序列。失败抛 Error(消息即审计内容);
 * 登录态失效抛 SkillAbort(结构化:审计码 + 用户引导文案)。
 */
export async function runSkillSteps(
  page: any,
  skill: ScriptSkillManifest,
  args: Record<string, any>
): Promise<{ flags: Record<string, boolean>; screenshotBase64?: string }> {
  const flags: Record<string, boolean> = {};
  let screenshotBase64: string | undefined;

  for (const step of skill.steps) {
    switch (step.kind) {
      case 'goto':
        await page.goto(step.url, { waitUntil: step.waitUntil || 'domcontentloaded', timeout: step.timeoutMs || 30000 });
        break;

      case 'waitForSelector': {
        // SPA 首屏渲染数秒:轮询等待(缺省 12×2s,与内置知乎流程同节奏)
        const retries = step.retries ?? 12;
        const interval = step.intervalMs ?? 2000;
        let ready = false;
        for (let i = 0; i < retries; i++) {
          await sleep(interval);
          if ((await page.locator(step.selector).count()) > 0) {
            ready = true;
            break;
          }
          // 轮询期间被重定向回登录页 = 登录态在导航后才失效
          if (step.abortIfUrl && new RegExp(step.abortIfUrl, 'i').test(String(page.url?.() || ''))) {
            throw new SkillAbort(
              skill.login?.hint || '登录态已失效,请重新扫码登录后重试。',
              step.abortAs || 'not_logged_in'
            );
          }
        }
        if (!ready) {
          throw new Error(step.timeoutError || `等待选择器超时: ${step.selector}(页面改版或结构变化,需人工核查)`);
        }
        break;
      }

      case 'fill':
        await page.fill(step.selector, stepValue(step, args), { timeout: step.timeoutMs || 20000 });
        break;

      case 'clickOrFocus': {
        // 发布围栏(运行时):双保险,加载校验之后这里再拦一道
        if (PUBLISH_FENCE.test(step.selector)) {
          throw new Error(`发布围栏拦截: 选择器含发布词(${step.selector})`);
        }
        try {
          await page.click(step.selector, { timeout: step.clickTimeoutMs || 10000 });
        } catch {
          await page.locator(step.selector).first().focus({ timeout: step.focusTimeoutMs || 5000 });
        }
        break;
      }

      case 'pressKeys':
        await page.keyboard.press(step.keys);
        break;

      case 'insertText':
        await page.keyboard.insertText(stepValue(step, args));
        break;

      case 'waitForText': {
        const flag = step.flag || 'textFound';
        try {
          await page.getByText(new RegExp(step.pattern)).first().waitFor({ timeout: step.timeoutMs || 10000 });
          flags[flag] = true;
        } catch {
          if (!step.optional) throw new Error(`等待文案超时: ${step.pattern}`);
          flags[flag] = false; // 仅作附注不是成败判据
        }
        break;
      }

      case 'screenshot':
        // 截图随结果返回(用户在审批/任务页可肉眼核对);失败静默,不影响成败
        try {
          const buffer = await page.screenshot({ type: 'jpeg', quality: step.quality || 65 });
          screenshotBase64 = `data:image/jpeg;base64,${buffer.toString('base64')}`;
        } catch {}
        break;
    }
  }
  return { flags, screenshotBase64 };
}

// ---- 清单 → 工具 ----

function paramFailure(skill: ScriptSkillManifest, args: Record<string, any>): string | null {
  const required: string[] = Array.isArray(skill.parameters?.required) ? skill.parameters.required : [];
  for (const p of required) {
    if (!String(args?.[p] ?? '').trim()) return skill.paramError || `缺少必填参数 ${p}`;
  }
  for (const c of skill.checks || []) {
    const v = String(args?.[c.param] ?? '');
    if (c.minLength && v.length < c.minLength) {
      return skill.paramError || `参数 ${c.param} 至少 ${c.minLength} 字`;
    }
  }
  return null;
}

/** 单个清单 → ToolDefinition(安全件全部包在 execute 外层,清单无法绕过) */
export function buildScriptSkillTool(
  skill: ScriptSkillManifest,
  userId: string,
  browser: ScriptSkillBrowserService
): ToolDefinition {
  return {
    name: skill.name,
    description: skill.description,
    parameters: skill.parameters,
    dangerLevel: skill.dangerLevel || 'high',
    compensation: skill.compensation,
    execute: async (args: any, session: any) => {
      // ① 参数校验:不合格直接拒绝,不开浏览器、不落审计
      const pErr = paramFailure(skill, args || {});
      if (pErr) return { success: false, error: pErr };

      const limit = skillDailyLimit(skill);
      // ② 限频前置:今日尝试次数(成败都计)达到上限直接拒绝
      let todayCount = 0;
      if (limit > 0) {
        todayCount = countTodaySkillRuns(getBrowserAudit(userId), skill.name);
        if (todayCount >= limit) {
          return {
            success: false,
            rejected: true,
            error: `已达今日执行上限(${limit} 次)。明天再试,或「接管浏览器」人工完成。`,
          };
        }
      }

      const missionId = session?.taskId;
      const audit = (result: 'success' | 'failure', error?: string) =>
        appendBrowserAudit(userId, {
          at: Date.now(),
          tool: skill.name,
          action: skill.auditAction || skill.name,
          title: typeof args?.title === 'string' ? args.title.slice(0, 80) : undefined,
          result,
          error,
          missionId,
        });

      try {
        // ③ 登录门在导航前:未登录不开浏览器、不烧流程,引导扫码
        if (skill.login) {
          const ok = await browser.hasCookies(userId, skill.login.homeUrl, skill.login.cookieNames);
          if (!ok) {
            audit('failure', 'not_logged_in');
            return { success: false, error: skill.login.hint };
          }
        }

        const page = await browser.acquirePage(userId);
        // ④ 逐步执行声明式步骤(白名单动作;发布围栏见 runSkillSteps)
        const { flags, screenshotBase64 } = await runSkillSteps(page, skill, args || {});

        // ⑤ 审计(步骤走完即成功;旗标缺失只是附加信息)
        audit('success', auditNotesForFlags(skill, flags));

        const result: any = {
          success: true,
          message: renderSkillMessage(skill, args || {}, { todayCount: todayCount + 1, dailyLimit: limit }, flags),
          screenshotBase64: screenshotBase64 || undefined,
        };
        if (typeof args?.title === 'string') result.title = args.title;
        return result;
      } catch (err: any) {
        if (err instanceof SkillAbort) {
          audit('failure', err.auditError);
          return { success: false, error: err.userMessage };
        }
        const message = err?.message || String(err);
        audit('failure', message);
        return { success: false, error: `执行失败:${message}(可「接管浏览器」人工完成)` };
      }
    },
  };
}

export interface ScriptSkillToolsResult {
  tools: ToolDefinition[];
  /** 加载/校验错误(供挂载日志) */
  errors: string[];
  /** 因托管 opt-in 门未注入的技能名(供挂载日志) */
  gated: string[];
}

/**
 * 构建用户级脚本技能工具(每次任务组装时调用 = 热加载点)。
 * browser 缺省(插件未就绪)→ 全部不注入(词汇表全是浏览器动作);
 * gate 不满足(未 opt-in/未读风险)→ 该技能不注入。
 */
export function buildScriptSkillTools(
  userId: string,
  browser?: ScriptSkillBrowserService,
  opts: { dir?: string } = {}
): ScriptSkillToolsResult {
  const out: ScriptSkillToolsResult = { tools: [], errors: [], gated: [] };
  if (!isScriptSkillsEnabled()) return out;
  const loaded = loadScriptSkills(opts.dir);
  out.errors = loaded.errors;
  if (!browser) {
    if (loaded.skills.length > 0) out.gated = loaded.skills.map((s) => s.name);
    return out;
  }
  for (const skill of loaded.skills) {
    if (!skillGateAllows(skill, userId)) {
      out.gated.push(skill.name);
      continue;
    }
    out.tools.push(buildScriptSkillTool(skill, userId, browser));
  }
  return out;
}
