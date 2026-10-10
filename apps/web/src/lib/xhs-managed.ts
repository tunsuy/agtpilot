/**
 * 小红书托管模式 · 用户级任务工具(scenario-loop P2 模块 2)
 *
 * 路线 A(结构化参数直填):审批门/限频/审计必须包在边界清晰的动作上,
 * Agent 自由组合 browser_fill 属于碎片化写操作,无法限频 —— 不走那条路。
 *
 * 两个工具(仿 wechat-mp 的 per-user 工厂,执行时才读 user-store):
 * - xhs_read_creator_data(只读,low):蒸馏创作中心数据页
 * - xhs_save_note_draft(high → 编排器审批门):填发布页,停在自动保存草稿
 *
 * 三层红线:① plugin-browser 的 browser_click/stagehand 发布围栏;
 * ② 本文件的选择器配置表里根本不存在发布按钮;
 * ③ 系统 prompt「托管终点是草稿箱」。Agent 永远不碰「发布」。
 */
import * as path from 'path';
import type { ToolDefinition } from '@agtpilot/core';
import {
  getXhsManaged,
  getBrowserAudit,
  appendBrowserAudit,
  type BrowserAuditEntry,
  type XhsManagedRecord,
} from './user-store';
import { XHS_CREATOR_HOME, XHS_LOGIN_COOKIE_NAMES } from './browser-login';
import { buildXhsReadGuardrail } from './xhs-read-guardrail';

/**
 * ⚠️ 发布页选择器配置表 —— 全部待真实账号实测(docs/design/workshop-scenario-loop.md §5.4)。
 * 实测后只改这里,不改逻辑。表里刻意没有「发布」按钮。
 */
export const XHS_PUBLISH_SELECTORS = {
  /** 图文发布页 */
  publishUrl: 'https://creator.xiaohongshu.com/publish/imgNote',
  // TODO 实测:标题输入框
  titleInput: 'input[placeholder*="标题"]',
  // TODO 实测:正文 contenteditable(发布页富文本)
  bodyEditor: '.ql-editor, [contenteditable="true"]',
  // TODO 实测:标签输入(输入 # 触发下拉)
  tagInput: 'input[placeholder*="标签"], input[placeholder*="话题"]',
  // TODO 实测:图片上传控件
  imageUpload: 'input[type="file"]',
  // TODO 实测:自动保存指示文案(等它出现 = 草稿已落)
  autosaveIndicator: /已(自动)?保存|存为草稿/,
};

// TODO 实测:创作中心数据页 URL(hot_topics 为 P1 新增的选题灵感/热门话题页,URL 待真实账号核实)
export const XHS_CREATOR_PAGES: Record<string, string> = {
  overview: XHS_CREATOR_HOME,
  notes: 'https://creator.xiaohongshu.com/new/note-manager',
  followers: 'https://creator.xiaohongshu.com/new/fans',
  hot_topics: 'https://creator.xiaohongshu.com/new/hot-topics',
};

/** 读工具页面白名单(单一事实源:参数 enum 与 execute 校验共用) */
export const XHS_READ_PAGES = ['overview', 'notes', 'followers', 'hot_topics'] as const;
export type XhsReadPage = (typeof XHS_READ_PAGES)[number];

/** 站内搜索页(客户端渲染的 SPA;web_session 作用域 .xiaohongshu.com,登录门同样有效) */
export const XHS_SEARCH_URL = 'https://www.xiaohongshu.com/search_result';

/** 读目标解析:query 非空即搜索(page 被忽略——模型忘传 page 也要落到搜索,防误用形态) */
export function resolveReadTarget(
  page: unknown,
  query: unknown
): { url: string; label: string; dynamic: boolean } {
  const q = typeof query === 'string' ? query.trim().slice(0, 40) : '';
  if (q) {
    return {
      url: `${XHS_SEARCH_URL}?keyword=${encodeURIComponent(q)}`,
      label: `search:${q}`,
      dynamic: true,
    };
  }
  const pageKey = (XHS_READ_PAGES as readonly string[]).includes(String(page)) ? String(page) : 'overview';
  return {
    url: XHS_CREATOR_PAGES[pageKey] || XHS_CREATOR_PAGES.overview,
    label: pageKey,
    dynamic: pageKey === 'hot_topics',
  };
}

/** 每日存草稿上限(opt-in 承诺的一部分;可用 env 调整) */
export function dailyDraftLimit(): number {
  const n = Number(process.env.AGTPILOT_XHS_DRAFT_DAILY_LIMIT);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 3;
}

/** 今日(本地时区)已尝试的存草稿次数(成败都计,保守限频) */
export function countTodayDraftSaves(audit: BrowserAuditEntry[], now = new Date()): number {
  const dayKey = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}`;
  return audit.filter((e) => {
    if (e.tool !== 'xhs_save_note_draft') return false;
    const d = new Date(e.at);
    return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}` === dayKey;
  }).length;
}

/** 写工具注入门槛:显式 opt-in + 已阅读风险明示 */
export function shouldInjectWriteTool(record: XhsManagedRecord | undefined): boolean {
  return !!record?.enabled && !!record?.riskAckAt;
}

/** 读工具注入门槛:登录过(登录态有效性在 execute 时再验) */
export function shouldInjectReadTool(record: XhsManagedRecord | undefined): boolean {
  return !!record?.lastLoginAt;
}

/** 浏览器服务依赖(与 plugin-browser 的 ctx.browser 同构;测试可 mock) */
export interface XhsBrowserService {
  acquirePage(userId?: string): Promise<any>;
  navigateAndDistill(
    userId: string | undefined,
    url: string,
    offset?: number,
    opts?: { renderWaitMs?: number }
  ): Promise<{ url: string; title: string; content: string; nextOffset?: number; totalLength: number; screenshotBase64?: string }>;
  hasCookies(userId: string | undefined, domain: string, names: string[]): Promise<boolean>;
}

/** 图片路径围栏:工作区内 + 图片扩展名 + ≤9 张(与 plugin-browser 的 browser_upload 同规则) */
export function validateImagePaths(
  filePaths: string[],
  workspaceRoot: string
): { ok: true; paths: string[] } | { ok: false; error: string } {
  const list = filePaths.map(String);
  if (list.length === 0) return { ok: true, paths: [] };
  if (list.length > 9) return { ok: false, error: `一次至多 9 张图片(收到 ${list.length} 个)` };
  const root = path.resolve(workspaceRoot);
  for (const p of list) {
    const resolved = path.resolve(p);
    if (!resolved.startsWith(root + path.sep)) {
      return { ok: false, error: `文件路径越界(仅允许工作区内文件): ${p}` };
    }
    if (!/\.(jpe?g|png|webp|gif)$/i.test(resolved)) {
      return { ok: false, error: `仅支持图片文件(jpg/jpeg/png/webp/gif): ${p}` };
    }
  }
  return { ok: true, paths: list };
}

const NOT_LOGGED_IN_HINT =
  '小红书网页版尚未登录或登录态已失效。请引导用户到「连接器页 → 小红书 → 网页版扫码登录」,用小红书 App 扫码完成登录后重试。';

/**
 * 构建用户级小红书托管工具。
 * browser 服务由 agent-backend 传入(this.ctx.browser);缺省时(插件未就绪)不注入。
 */
export function buildXhsManagedTools(userId: string, browser?: XhsBrowserService): ToolDefinition[] {
  const record = getXhsManaged(userId);
  const tools: ToolDefinition[] = [];

  // 只读数据工具:登录过即注入
  if (shouldInjectReadTool(record)) {
    tools.push({
      name: 'xhs_read_creator_data',
      description:
        '读取小红书真实数据(只读,不点击不填写):创作中心数据页(概览/笔记管理/粉丝)、' +
        '本周热门话题页(page=hot_topics),或按关键词搜索站内笔记热度(query=关键词,如赛道词)。' +
        '返回蒸馏后的 Markdown 与页面截图,用于选题调研与账号复盘。' +
        '注意:本工具每任务读取次数有上限,收到上限拒绝提示后请基于已读取的资料继续,不要重试。',
      dangerLevel: 'low',
      parameters: {
        type: 'object',
        properties: {
          page: {
            type: 'string',
            enum: [...XHS_READ_PAGES],
            description: '数据页(可选,默认 overview;hot_topics = 热门话题/选题灵感页)',
          },
          query: {
            type: 'string',
            description: '站内搜索关键词(可选;传了则搜索该关键词相关笔记热度,page 被忽略)',
          },
          offset: { type: 'number', description: '内容续读偏移量(可选)' },
        },
      },
      execute: async (args: any, session: any) => {
        if (!browser) return { success: false, error: '浏览器服务未就绪' };
        try {
          const target = resolveReadTarget(args?.page, args?.query);
          const missionId = session?.taskId;

          // ① 读侧护栏:每任务上限(拒绝不开浏览器);同用户最小间隔(等待后继续)
          const guard = buildXhsReadGuardrail().check(missionId, userId);
          if (!guard.allowed) {
            return { success: false, rejected: true, error: guard.reason, used: guard.used, cap: guard.cap };
          }
          if (guard.waitMs > 0) {
            await new Promise((r) => setTimeout(r, guard.waitMs));
          }

          if (!(await browser.hasCookies(userId, XHS_CREATOR_HOME, XHS_LOGIN_COOKIE_NAMES))) {
            // 登录门在导航前:不烧任务上限、不落审计(与存草稿的 not_logged_in 同语义,引导扫码)
            return { success: false, page: target.label, error: NOT_LOGGED_IN_HINT };
          }

          // ② 导航(动态页带 SPA 渲染等待);真实导航才计入护栏
          const result = await browser.navigateAndDistill(
            userId,
            target.url,
            Number(args?.offset) || 0,
            target.dynamic ? { renderWaitMs: 6000 } : undefined
          );
          buildXhsReadGuardrail().record(missionId, userId);

          // ③ 读审计(复用 title 字段放页名/搜索词;不计入 countTodayDraftSaves——其按 tool 过滤)
          appendBrowserAudit(userId, {
            at: Date.now(),
            tool: 'xhs_read_creator_data',
            action: 'read',
            title: target.label,
            result: 'success',
            missionId,
          });

          return {
            success: true,
            page: target.label,
            url: result.url,
            title: result.title,
            content: result.content,
            nextOffset: result.nextOffset,
            totalLength: result.totalLength,
            screenshotBase64: result.screenshotBase64
              ? `data:image/jpeg;base64,${result.screenshotBase64}`
              : undefined,
          };
        } catch (err: any) {
          // 导航失败的审计 + 护栏计数也认(真实打开过页面)
          try {
            const target = resolveReadTarget(args?.page, args?.query);
            buildXhsReadGuardrail().record(session?.taskId, userId);
            appendBrowserAudit(userId, {
              at: Date.now(),
              tool: 'xhs_read_creator_data',
              action: 'read',
              title: target.label,
              result: 'failure',
              error: err?.message || String(err),
              missionId: session?.taskId,
            });
          } catch {}
          return { success: false, error: err?.message || String(err) };
        }
      },
    });
  }

  // 存草稿工具:显式 opt-in + 风险已读 → 注入;dangerLevel high = 编排器审批门
  if (shouldInjectWriteTool(record) && browser) {
    tools.push({
      name: 'xhs_save_note_draft',
      description:
        '把一篇小红书笔记(标题/正文/标签/可选图片)填进网页版发布页,停在平台自动保存 —— ' +
        '终点是草稿箱,绝不发布(发布按钮被代码级围栏永久拦截)。' +
        '调用前需要用户审批确认。每次调用计入每日上限。',
      dangerLevel: 'high',
      compensation: {
        kind: 'partially-reversible',
        undoHint: '草稿可在小红书 App 或创作平台的草稿箱中编辑/删除;未保存前可直接清空页面表单',
      },
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: '笔记标题' },
          body: { type: 'string', description: '笔记正文(300-600 字)' },
          tags: { type: 'array', items: { type: 'string' }, description: '标签列表(可选,至多 10 个,不带 #)' },
          image_paths: { type: 'array', items: { type: 'string' }, description: '本地图片路径(可选,至多 9 张)' },
        },
        required: ['title', 'body'],
      },
      execute: async (args: any, session: any) => {
        const title = String(args?.title || '').trim();
        const body = String(args?.body || '');
        if (!title || body.length < 20) {
          return { success: false, error: 'title 与 body 必填(正文至少 20 字)' };
        }

        // ① 限频前置:今日尝试次数(成败都计)达到上限直接拒绝,不开浏览器
        const todayCount = countTodayDraftSaves(getBrowserAudit(userId));
        if (todayCount >= dailyDraftLimit()) {
          return {
            success: false,
            rejected: true,
            error: `已达今日存草稿上限(${dailyDraftLimit()} 次)。明天再试,或复制笔记内容手动粘贴。`,
          };
        }

        const missionId = session?.taskId;
        const auditFailure = (error: string, imageCount?: number) =>
          appendBrowserAudit(userId, {
            at: Date.now(),
            tool: 'xhs_save_note_draft',
            action: 'save_note_draft',
            title,
            imageCount,
            result: 'failure',
            error,
            missionId,
          });

        try {
          const page = await browser.acquirePage(userId);

          // ② 打开发布页 & 登录态检查
          await page.goto(XHS_PUBLISH_SELECTORS.publishUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
          if (!(await browser.hasCookies(userId, XHS_CREATOR_HOME, XHS_LOGIN_COOKIE_NAMES))) {
            auditFailure('not_logged_in');
            return { success: false, error: NOT_LOGGED_IN_HINT };
          }

          // ③ 图片(可选):路径围栏 + 上传
          const imageCount = Array.isArray(args?.image_paths) ? args.image_paths.length : 0;
          if (imageCount > 0) {
            const check = validateImagePaths(args.image_paths, process.cwd());
            if (!check.ok) {
              auditFailure(check.error, imageCount);
              return { success: false, error: check.error };
            }
            await page.setInputFiles(XHS_PUBLISH_SELECTORS.imageUpload, check.paths, { timeout: 30000 });
            // 等图片处理渲染
            await page.waitForTimeout(2000);
          }

          // ④ 标题(普通 input)
          await page.fill(XHS_PUBLISH_SELECTORS.titleInput, title, { timeout: 15000 });

          // ⑤ 正文(contenteditable:先聚焦再整体插入)
          try {
            await page.click(XHS_PUBLISH_SELECTORS.bodyEditor, { timeout: 10000 });
          } catch {
            await page.locator(XHS_PUBLISH_SELECTORS.bodyEditor).first().focus({ timeout: 5000 });
          }
          await page.keyboard.insertText(body);

          // ⑥ 标签:输入 # 触发下拉后回车;失败降级为拼在正文尾部并注明
          const tags: string[] = (Array.isArray(args?.tags) ? args.tags : [])
            .map((t: any) => String(t).replace(/^#/, '').trim())
            .filter(Boolean)
            .slice(0, 10);
          const tagsFallback: string[] = [];
          if (tags.length > 0) {
            const tagText = tags.map((t) => `#${t}`).join(' ');
            let tagged = false;
            try {
              await page.click(XHS_PUBLISH_SELECTORS.tagInput, { timeout: 5000 });
              await page.keyboard.insertText(tagText);
              await page.keyboard.press('Enter');
              await page.waitForTimeout(800);
              tagged = true;
            } catch {
              tagged = false;
            }
            if (!tagged) tagsFallback.push(tagText);
          }

          // ⑦ 等自动保存指示出现 = 草稿已落(终点;绝不触碰发布)
          let saved = false;
          try {
            await page
              .getByText(XHS_PUBLISH_SELECTORS.autosaveIndicator)
              .first()
              .waitFor({ timeout: 30000 });
            saved = true;
          } catch {
            saved = false;
          }

          // 截图随结果返回(用户在审批/任务页可肉眼核对)
          let screenshotBase64 = '';
          try {
            const buffer = await page.screenshot({ type: 'jpeg', quality: 65 });
            screenshotBase64 = `data:image/jpeg;base64,${buffer.toString('base64')}`;
          } catch {}

          // ⑧ 审计(成败都落)
          appendBrowserAudit(userId, {
            at: Date.now(),
            tool: 'xhs_save_note_draft',
            action: 'save_note_draft',
            title,
            imageCount: imageCount || undefined,
            result: saved ? 'success' : 'failure',
            error: saved
              ? undefined
              : tagsFallback.length > 0
              ? '自动保存指示未出现(可能仍在保存);标签降级拼入正文'
              : '自动保存指示未出现(可能仍在保存)',
            missionId,
          });

          return {
            success: saved,
            title,
            imageCount,
            tagsFallback: tagsFallback.length > 0 ? tagsFallback : undefined,
            message: saved
              ? `笔记已填入发布页并停在自动保存 —— 请在草稿箱核对(发布由你本人完成)。今日已用 ${todayCount + 1}/${dailyDraftLimit()} 次。`
              : '笔记已填入发布页,但未等到自动保存指示。请到草稿箱确认是否已存;若未存,用页面截图手动核对后自行保存。',
            screenshotBase64: screenshotBase64 || undefined,
          };
        } catch (err: any) {
          const message = err?.message || String(err);
          auditFailure(message, Array.isArray(args?.image_paths) ? args.image_paths.length : undefined);
          return { success: false, error: `存草稿失败:${message}` };
        }
      },
    });
  }

  return tools;
}
