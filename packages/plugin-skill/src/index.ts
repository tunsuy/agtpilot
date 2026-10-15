/**
 * plugin-skill —— 统一技能插件(第一步:flow 注册表 + pack 注册表)
 *
 * 把散落的「技能」机制收进一个插件、一个服务面(ctx.skills):
 *
 * 形态一 flow(声明式浏览器流程脚本,自 apps/web script-skills.ts 迁入):
 *   技能 = JSON 数据文件(清单 + 固定动作词汇表步骤),运行时扫描目录热加载,
 *   按清单挂成标准 ToolDefinition。刻意不做任意脚本热加载——不把服务器执行面
 *   开放给「能放文件的人」;安全件由引擎统一提供,清单无法绕过:
 *   托管 opt-in 门 / 登录门前置 / 每日限频(成败都计) / 审计(成败都落) /
 *   dangerLevel 缺省 high(审批门) / 发布围栏三层(词汇表无发布动作 +
 *   加载校验拒收发布词 + clickOrFocus 运行时再拦)。
 *
 * 形态二 pack(沙箱技能包,/opt/skills 的 SKILL.md + 脚本,PPT 工坊在用):
 *   扫描目录读 SKILL.md frontmatter 出统一元数据(名字/描述/路径/就绪面),
 *   新技能包放进目录即被发现;消费方(ppt-workshop)不再各自硬编码路径。
 *
 * 形态三 card(TRS 技能卡,任务轨迹蒸馏的五字段结构化经验):
 *   引擎在 cards.ts(解析归一化/trigger 去重合并/关键词检索注入/命中反馈/
 *   任务末蒸馏),经 ctx.skills.buildCardsBlock / distillCards 暴露;卡片库
 *   留在宿主存储,经 SkillCardStore 适配注入。
 *
 * 存储不下沉:技能卡的库、浏览器审计、托管 opt-in 记录都在宿主(web)的
 * 用户空间;插件只定义 SkillStoreAdapter / SkillCardStore 接口,宿主在装配
 * 时注入实现(apps/web 见 lib/script-skills.ts 的 webSkillStore 与
 * lib/skill-cards.ts 的 webCardStore)。缺省无 store 时行为保守:带 gate 的
 * 技能不注入、卡服务面返回空(注入空串/蒸馏空结果)。
 *
 * 开关:AGTPILOT_SCRIPT_SKILLS=0 关闭 flow 形态;AGTPILOT_SKILL_CARDS=0 关闭 card 形态。
 */
import * as fs from 'fs';
import * as path from 'path';
import { Context, Service } from '@deepseek-ai/cordis';
import type { ToolDefinition } from '@agtpilot/core';
import {
  createSkillCardsEngine,
  isSkillCardsEnabled,
  type SkillCardModel,
  type SkillCardStore,
  type SkillCardsEngine,
  type SkillDistillOutcome,
  type TokenizeFn,
} from './cards';
import { markdownToPlainText } from './markdown-plain';

export * from './cards';
export { markdownToPlainText } from './markdown-plain';

export const name = 'agtpilot-plugin-skill';

// ---- 存储适配(宿主注入;插件不依赖任何宿主存储实现) ----

/** 审计条目形状(与 web user-store 的 BrowserAuditEntry 结构兼容) */
export interface SkillAuditEntry {
  at: number;
  tool: string;
  action: string;
  title?: string;
  imageCount?: number;
  result: 'success' | 'failure';
  error?: string;
  missionId?: string;
}

/** 托管 opt-in 记录的最小读面(enabled + riskAckAt 缺一不可) */
export interface ManagedGateRecord {
  enabled?: boolean;
  riskAckAt?: number;
}

export interface SkillStoreAdapter {
  /** 读平台托管记录(zhihu/xhs);无记录返回 undefined */
  getManagedRecord(userId: string, platform: 'zhihu' | 'xhs'): ManagedGateRecord | undefined;
  /** 浏览器操作审计(限频计数用) */
  listAudit(userId: string): SkillAuditEntry[];
  /** 追加审计(成败都落) */
  appendAudit(userId: string, entry: SkillAuditEntry): void;
}

// ---- flow 形态:类型 ----

/** 动作词汇表:引擎认识的全部步骤类型(闭集;新增动作 = 改代码走评审,不是放文件) */
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
  | {
      kind: 'fill';
      selector: string;
      param?: string;
      value?: string;
      timeoutMs?: number;
      /**
       * 填入前对文本做声明式转换(闭集;新增转换 = 改代码走评审):
       * 'markdown-plain' = Markdown 记号转纯文本(知乎草稿投递用:
       * 记号剥除、列表转 •、链接保地址、代码块内容原样)。
       */
      transform?: 'markdown-plain';
    }
  | { kind: 'clickOrFocus'; selector: string; clickTimeoutMs?: number; focusTimeoutMs?: number }
  | { kind: 'pressKeys'; keys: string }
  | {
      kind: 'insertText';
      param?: string;
      value?: string;
      /** 同 fill.transform:填入前的声明式文本转换 */
      transform?: 'markdown-plain';
    }
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
  /** 工具名(a-z0-9_);与宿主内置工具同名时本技能覆盖之 */
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

// ---- flow 形态:目录与开关 ----

export function isScriptSkillsEnabled(): boolean {
  return process.env.AGTPILOT_SCRIPT_SKILLS !== '0';
}

/** 技能目录:env 优先;缺省 cwd/skills(web dev/test = apps/web/skills,生产镜像 = /app/skills) */
export function scriptSkillsDir(): string {
  return process.env.AGTPILOT_SCRIPT_SKILL_DIR || path.join(process.cwd(), 'skills');
}

// ---- flow 形态:校验(纯函数,契约测试友好) ----

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
        if (s.transform !== undefined && s.transform !== 'markdown-plain') return `${at} fill.transform 仅支持 markdown-plain`;
        break;
      case 'clickOrFocus':
        if (typeof s.selector !== 'string' || !s.selector.trim()) return `${at} selector 缺失`;
        break;
      case 'pressKeys':
        if (typeof s.keys !== 'string' || !s.keys.trim()) return `${at} keys 缺失`;
        break;
      case 'insertText':
        if (!s.param && !s.value) return `${at} insertText 需要 param 或 value`;
        if (s.transform !== undefined && s.transform !== 'markdown-plain') return `${at} insertText.transform 仅支持 markdown-plain`;
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

// ---- flow 形态:加载(热更新点:每次组装任务工具时扫描,放文件即生效) ----

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
    return out; // 目录不存在/不可读 = 没有技能,不是错误(宿主内置工具兜底)
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

// ---- flow 形态:安全件 ----

/** 每日上限:env 覆盖清单缺省值(非法 env 回落缺省) */
export function skillDailyLimit(skill: ScriptSkillManifest): number {
  if (!skill.dailyLimit) return 0; // 0 = 不限频(只读类技能可不配)
  const envVal = skill.dailyLimit.env ? Number(process.env[skill.dailyLimit.env]) : NaN;
  if (Number.isFinite(envVal) && envVal > 0) return Math.floor(envVal);
  return skill.dailyLimit.default;
}

/** 今日(本地时区)该技能的执行次数(成败都计,保守限频) */
export function countTodaySkillRuns(audit: SkillAuditEntry[], toolName: string, now = new Date()): number {
  const dayKey = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}`;
  return audit.filter((e) => {
    if (e.tool !== toolName) return false;
    const d = new Date(e.at);
    return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}` === dayKey;
  }).length;
}

/**
 * 托管 opt-in 门:对应平台 enabled + riskAckAt 缺一不可。
 * 无 store 时保守拒绝(带 gate 的技能拿不到托管记录 = 不允许注入)。
 */
export function skillGateAllows(
  skill: ScriptSkillManifest,
  userId: string,
  store?: SkillStoreAdapter
): boolean {
  if (!skill.gate) return true;
  const rec = store?.getManagedRecord(userId, skill.gate.managed);
  return !!rec?.enabled && !!rec?.riskAckAt;
}

// ---- flow 形态:消息模板 ----

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

// ---- flow 形态:执行器(白名单动作,逐步解释) ----

/**
 * 声明式文本转换(闭集)。填入编辑器前把文本转成目标形态;未知值不炸,
 * 原文返回(加载校验已拒收,这是防御性兜底)。
 */
function stepTransform(step: any, text: string): string {
  if (step.transform === 'markdown-plain') return markdownToPlainText(text);
  return text;
}

/** 取步骤要填的值:param 引用参数,value 字面量;转换(如 markdown-plain)在取值后生效 */
function stepValue(step: any, args: Record<string, any>): string {
  const raw = typeof step.param === 'string' ? String(args?.[step.param] ?? '') : String(step.value ?? '');
  return stepTransform(step, raw);
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
        // SPA 首屏渲染数秒:轮询等待(缺省 12×2s)
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

// ---- flow 形态:清单 → 工具 ----

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
  browser: ScriptSkillBrowserService,
  store?: SkillStoreAdapter
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
        todayCount = countTodaySkillRuns(store?.listAudit(userId) || [], skill.name);
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
        store?.appendAudit(userId, {
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
  /** 因托管 opt-in 门(或浏览器服务缺失)未注入的技能名(供挂载日志) */
  gated: string[];
}

// ---- pack 形态:沙箱技能包注册表(/opt/skills 的 SKILL.md + 脚本) ----

export interface SkillPackInfo {
  /** frontmatter name,缺省 = 目录名 */
  name: string;
  description: string;
  /** 技能包根目录(绝对路径) */
  dir: string;
  hasSkillMd: boolean;
  /** 是否存在 scripts/ 子目录(可执行脚本面) */
  hasScripts: boolean;
}

/** pack 目录清单:env AGTPILOT_SKILL_PACK_DIRS(path.delimiter 分隔)覆盖,缺省 /opt/skills */
export function skillPackDirs(): string[] {
  const env = process.env.AGTPILOT_SKILL_PACK_DIRS;
  if (env && env.trim()) return env.split(path.delimiter).map((s) => s.trim()).filter(Boolean);
  return ['/opt/skills'];
}

/** 解析 SKILL.md 头部 YAML frontmatter(最小实现:只取 name/description 单行值) */
export function parseSkillMdFrontmatter(text: string): Record<string, string> {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) return {};
  const out: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line.trim());
    if (kv) out[kv[1]] = kv[2].replace(/^["']|["']$/g, '').trim();
  }
  return out;
}

/** 扫描 pack 目录:含 SKILL.md 的一级子目录 = 一个技能包;坏目录跳过不抛 */
export function scanSkillPacks(dirs: string[] = skillPackDirs()): SkillPackInfo[] {
  const packs: SkillPackInfo[] = [];
  for (const root of dirs) {
    let entries: string[];
    try {
      entries = fs.readdirSync(root);
    } catch {
      continue; // 目录不存在(如 dev 机没有 /opt/skills)= 没有 pack,不是错误
    }
    for (const entry of entries.sort()) {
      const dir = path.join(root, entry);
      const skillMd = path.join(dir, 'SKILL.md');
      let text: string;
      try {
        text = fs.readFileSync(skillMd, 'utf-8');
      } catch {
        continue; // 无 SKILL.md 的目录不是技能包
      }
      const fm = parseSkillMdFrontmatter(text);
      let hasScripts = false;
      try {
        hasScripts = fs.statSync(path.join(dir, 'scripts')).isDirectory();
      } catch {}
      packs.push({
        name: fm.name || entry,
        description: fm.description || '',
        dir,
        hasSkillMd: true,
        hasScripts,
      });
    }
  }
  return packs;
}

// ---- 统一服务面(ctx.skills) ----

export type SkillInventoryItem =
  | { form: 'flow'; name: string; description: string }
  | { form: 'pack'; name: string; description: string; dir: string; hasScripts: boolean };

export interface BuildTaskToolsOptions {
  /** 覆盖技能目录(测试用;缺省 config.skillDir → scriptSkillsDir()) */
  dir?: string;
}

export interface SkillService {
  /** 统一清单:flow 技能文件 + pack 沙箱技能包 */
  listSkills(): SkillInventoryItem[];
  /** flow 形态 → 用户级任务工具(opt-in 门/限频/审计/围栏全在引擎内) */
  buildTaskTools(
    userId: string,
    browser?: ScriptSkillBrowserService,
    opts?: BuildTaskToolsOptions
  ): ScriptSkillToolsResult;
  /** 加载 flow 技能文件(含逐文件错误,供热加载点与调试) */
  loadSkills(dir?: string): ScriptSkillLoadResult;
  /** pack 注册表(60s 缓存) */
  listPacks(): SkillPackInfo[];
  getPack(packName: string): SkillPackInfo | undefined;
  /** card 形态 → system prompt 技能卡注入块(任务开始一次;无达标卡/无存储返回空串) */
  buildCardsBlock(userId: string, goal: string): string;
  /** card 形态 → 任务末蒸馏(旁路,失败静默;model 取 config.getModel,缺省 ctx.model) */
  distillCards(opts: SkillDistillOptions): Promise<SkillDistillOutcome>;
}

/** distillCards 的入参(与引擎 distillCards 的 opts 同型) */
export interface SkillDistillOptions {
  userId: string;
  goal: string;
  taskSucceeded: boolean;
  mission: {
    id?: string;
    steps?: Array<{ tool?: string; args?: any; output?: any; status?: string; duration?: string; role?: string; answer?: string }>;
  };
  efficiency?: { stepsCount?: number; toolCalls?: number; failedCalls?: number; skippedCalls?: number; effectiveRate?: number };
  missionId?: string;
  configOverride?: any;
}

export interface SkillPluginConfig {
  /** 宿主存储适配·flow(缺省无 store:带 gate 的技能保守不注入,审计写入丢弃) */
  store?: SkillStoreAdapter;
  /** flow 技能目录(缺省 scriptSkillsDir()) */
  skillDir?: string;
  /** pack 目录清单(缺省 skillPackDirs()) */
  packDirs?: string[];
  /** 宿主存储适配·card(缺省无 store:卡服务面空转——注入空串、蒸馏空结果) */
  cards?: SkillCardStore;
  /** 分词器注入(缺省用插件自带 defaultTokenize,与 web memory-service 同型) */
  tokenize?: TokenizeFn;
  /** 蒸馏用模型来源(cordis 装配缺省取 ctx.model;工厂形态可显式注入) */
  getModel?: () => SkillCardModel | undefined;
}

/** pack 清单缓存 TTL(目录扫描很便宜,但一次任务组装可能查多次) */
const PACK_CACHE_TTL_MS = 60_000;

/**
 * 创建技能服务(纯工厂,不依赖 cordis —— 宿主可脱离微内核直接使用,
 * 如 web 侧适配器/测试;cordis 装配走 apply → SkillServiceImpl)。
 */
export function createSkillService(config: SkillPluginConfig = {}): SkillService {
  let packCache: { at: number; packs: SkillPackInfo[] } | null = null;
  const listPacks = (): SkillPackInfo[] => {
    if (packCache && Date.now() - packCache.at < PACK_CACHE_TTL_MS) return packCache.packs;
    const packs = scanSkillPacks(config.packDirs);
    packCache = { at: Date.now(), packs };
    return packs;
  };

  // card 形态引擎:仅在宿主注入卡片存储时可用(无 store → 空转,绝不半吊子读写)
  const cardsEngine: SkillCardsEngine | null = config.cards
    ? createSkillCardsEngine({ store: config.cards, tokenize: config.tokenize })
    : null;
  const emptyDistill: SkillDistillOutcome = { added: [], updated: [] };

  return {
    listSkills() {
      const flows: SkillInventoryItem[] = loadScriptSkills(config.skillDir).skills.map((s) => ({
        form: 'flow',
        name: s.name,
        description: s.description,
      }));
      const packs: SkillInventoryItem[] = listPacks().map((p) => ({
        form: 'pack',
        name: p.name,
        description: p.description,
        dir: p.dir,
        hasScripts: p.hasScripts,
      }));
      return [...flows, ...packs];
    },
    loadSkills(dir?: string) {
      return loadScriptSkills(dir || config.skillDir);
    },
    buildTaskTools(userId, browser, opts) {
      const out: ScriptSkillToolsResult = { tools: [], errors: [], gated: [] };
      if (!isScriptSkillsEnabled()) return out;
      const loaded = loadScriptSkills(opts?.dir || config.skillDir);
      out.errors = loaded.errors;
      if (!browser) {
        // 词汇表全是浏览器动作:browser 服务缺失(插件未就绪)→ 全部不注入
        if (loaded.skills.length > 0) out.gated = loaded.skills.map((s) => s.name);
        return out;
      }
      for (const skill of loaded.skills) {
        if (!skillGateAllows(skill, userId, config.store)) {
          out.gated.push(skill.name);
          continue;
        }
        out.tools.push(buildScriptSkillTool(skill, userId, browser, config.store));
      }
      return out;
    },
    listPacks,
    getPack(packName: string) {
      return listPacks().find((p) => p.name === packName);
    },
    buildCardsBlock(userId: string, goal: string) {
      if (!cardsEngine || !isSkillCardsEnabled()) return '';
      return cardsEngine.buildCardsBlock(userId, goal);
    },
    distillCards(opts: SkillDistillOptions) {
      if (!cardsEngine || !isSkillCardsEnabled()) return Promise.resolve(emptyDistill);
      return cardsEngine.distillCards(config.getModel?.(), opts);
    },
  };
}

class SkillServiceImpl extends Service implements SkillService {
  private inner: SkillService;

  constructor(ctx: Context, config: SkillPluginConfig = {}) {
    super(ctx, 'skills');
    // cordis 装配形态:蒸馏模型缺省取同一 ctx 上的 model 服务(懒取,装配顺序无关)
    this.inner = createSkillService({
      ...config,
      getModel: config.getModel || (() => (this.ctx as any)?.model),
    });
  }

  listSkills(): SkillInventoryItem[] {
    return this.inner.listSkills();
  }
  buildTaskTools(
    userId: string,
    browser?: ScriptSkillBrowserService,
    opts?: BuildTaskToolsOptions
  ): ScriptSkillToolsResult {
    return this.inner.buildTaskTools(userId, browser, opts);
  }
  loadSkills(dir?: string): ScriptSkillLoadResult {
    return this.inner.loadSkills(dir);
  }
  listPacks(): SkillPackInfo[] {
    return this.inner.listPacks();
  }
  getPack(packName: string): SkillPackInfo | undefined {
    return this.inner.getPack(packName);
  }
  buildCardsBlock(userId: string, goal: string): string {
    return this.inner.buildCardsBlock(userId, goal);
  }
  distillCards(opts: SkillDistillOptions): Promise<SkillDistillOutcome> {
    return this.inner.distillCards(opts);
  }
}

export function apply(ctx: Context, config: SkillPluginConfig = {}) {
  new SkillServiceImpl(ctx, config);
}
